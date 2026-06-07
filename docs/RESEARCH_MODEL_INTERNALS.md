# AI 모델은 어떻게 GPU 위에서 돌아가는가 — Deep Dive

> 다음 영상 주제 학습 자료. 이번 버전은 **"왜?"** 와 **"어떻게 계산?"** 에 집중. 한 챕터 끝낼 때마다 직관 체크.

---

## 목차
0. 사전 지식: 컴퓨터가 숫자를 저장하는 법 (부동소수점 vs 정수)
1. 파라미터란 무엇인가 (학습 후 고정되는 숫자들)
2. 학습(Training) vs 추론(Inference) — 무엇이 다른가
3. Mixture of Experts (MoE) 완전 해부
4. Precision 깊게 — FP32 / FP16 / BF16 / FP8 / FP4 / INT
5. KV Cache 완전 해부
6. TFLOPS 와 연산 속도 — GPU 성능 지표 읽는 법
7. 추론 1회에 필요한 전체 메모리
8. GPU vs NPU
9. NVLink / NVSwitch / InfiniBand
10. Vision Language Models (VLM)
11. 케이스 스터디 — 단계별 계산
12. 영상 시각화 매핑
13. 영상 구조 초안

---

## 0. 사전 지식: 컴퓨터가 숫자를 저장하는 법

이걸 먼저 알아야 FP32 / BF16 / FP8 / INT4 같은 게 다 이해됨.

### 0-1. 정수 (Integer) — "소수점 없는 숫자"

`3`, `-7`, `42`, `1000` 같은 숫자. 컴퓨터에서는 **이진수 비트 N개**로 저장.

| 형식 | 비트 | 표현 가능 범위 |
|---|---|---|
| INT8 | 8 | -128 ~ +127 |
| INT16 | 16 | -32,768 ~ +32,767 |
| INT32 | 32 | 약 ±21억 |

**핵심**: 정수는 **정확함**. 표현되는 모든 값이 딱 떨어진 정수. 다만 **소수**나 **아주 작은/큰 값** 은 표현 불가.

### 0-2. 부동소수점 (Floating Point) — "과학 표기법의 이진수 버전"

`3.14`, `0.000001`, `1.5e10` 같은 숫자.

과학 표기법: `123,000` = `1.23 × 10^5`
- `1.23` ← **가수(mantissa)**, 정확도 담당
- `5` ← **지수(exponent)**, 범위 담당
- 부호(sign) 1비트

컴퓨터는 이진수 버전으로 저장:

```
[ 부호 1비트 ] [ 지수 N비트 ] [ 가수 M비트 ]
```

비트 분배가 달라지면 → 표현 가능한 범위와 정밀도가 달라짐.

### 0-3. 주요 부동소수점 형식 비교

| 형식 | 총 비트 | 부호 | 지수 | 가수 | 범위 | 정밀도 (유효숫자) |
|---|---|---|---|---|---|---|
| **FP32** (single precision) | 32 | 1 | 8 | 23 | ±3.4×10³⁸ | ~7자리 |
| **FP16** (half precision, IEEE) | 16 | 1 | **5** | 10 | ±65,504 (좁음!) | ~3자리 |
| **BF16** (brain float, Google) | 16 | 1 | **8** | 7 | ±3.4×10³⁸ (FP32 동급!) | ~2자리 |
| **FP8 E4M3** (정밀도 우선) | 8 | 1 | 4 | 3 | ±448 | ~1자리 |
| **FP8 E5M2** (범위 우선) | 8 | 1 | 5 | 2 | ±57344 | ~1자리 |
| **FP4 E2M1** | 4 | 1 | 2 | 1 | ±6 | 0.5자리 |

### 0-4. "FP", "BF", "INT" 의미

- **FP** = **F**loating **P**oint (부동소수점) — IEEE 표준
- **BF** = **B**rain **F**loat — Google Brain 팀이 AI 전용으로 만든 변종
  - **왜 BF16 이 AI 에 좋은가?**
    - FP16 은 지수 5비트라 범위가 좁아서 학습 중 **자주 overflow / underflow** 발생 (gradient 가 너무 작거나 큼)
    - BF16 은 지수 8비트라 **FP32 와 같은 범위** → overflow 안 남
    - 정밀도는 떨어지지만, AI 학습엔 범위가 정밀도보다 중요
    - 그래서 **NVIDIA A100 부터 BF16 이 사실상 표준**
- **INT** = **Int**eger — 정수. 양자화(quantization) 때 사용
- **E4M3** = **E**xponent **4** bits, **M**antissa **3** bits 의미

### 0-5. 메모리에서 비트 → 바이트

- 1 byte = 8 bits
- FP32 = 4 bytes / 1 param
- FP16 / BF16 = 2 bytes / 1 param
- FP8 = 1 byte / 1 param
- FP4 / INT4 = 0.5 bytes / 1 param

**70B 모델을 FP32 로 저장하면**: 70,000,000,000 × 4 = **280 GB**
**70B 모델을 INT4 로 저장하면**: 70,000,000,000 × 0.5 = **35 GB**

같은 모델, 그냥 숫자 표현 방식만 바꿨는데 메모리 **8배 차이**.

### 0-6. 직관 체크 ✅
- 같은 숫자 `3.14159` 를 FP32 로 저장하면 `3.14159` 그대로
- FP8 로 저장하면 `3.0` 또는 `3.5` 정도로 **반올림** 됨 (정확도 손실)
- 이게 양자화 (quantization). 정확도를 약간 포기하고 메모리 / 속도를 얻는 거래.

---

## 1. 파라미터란 무엇인가

### 1-1. 정의
**파라미터(parameter) = 학습 후 모델 안에 저장된 숫자들 = 가중치(weight)**

신경망은 결국 거대한 **행렬 곱셈** 의 연속:
```
output = input × Weight + bias
```
여기서 `Weight` 와 `bias` 안의 모든 숫자가 **파라미터**.

### 1-2. 파라미터는 언제 바뀌나?

```
[학습 단계]                          [추론 단계]
파라미터를 조정해서 정답에 가깝게      파라미터는 절대 안 바뀜.
만드는 과정. gradient descent 로       그냥 곱셈 / 덧셈만 함.
조금씩 업데이트.
```

**핵심**: 추론(=서비스) 중에는 파라미터가 **절대 안 바뀜**. 그냥 메모리에 통째로 올려놓고 곱하기만 함.

질문하셨던 "활성 파라미터는 고정인가 바뀌는가?" 의 답:
- **가중치 자체는 학습 후 고정**. 절대 안 바뀜.
- 다만 MoE 모델에서는 토큰마다 **사용하는 가중치의 부분집합** 이 달라짐. (다음 챕터에서 자세히)

### 1-3. 주요 모델 파라미터

| 모델 | 총 파라미터 | 활성 파라미터 | 구조 |
|---|---|---|---|
| Llama 3.1 8B | 8B | 8B | Dense (전부 활성) |
| Llama 3.1 70B | 70B | 70B | Dense |
| Llama 3.1 405B | 405B | 405B | Dense |
| Mixtral 8x7B | 47B | 13B | MoE (8 experts) |
| Mixtral 8x22B | 141B | 39B | MoE |
| DeepSeek V3 | 671B | 37B | MoE (256 experts) |
| Llama 4 Scout | 109B | 17B | MoE (16 experts) |
| Llama 4 Maverick | 400B | 17B | MoE (128 experts) |
| GPT-4 (추정) | ~1.8T | ~220B | MoE (8 experts) |

---

## 2. 학습(Training) vs 추론(Inference)

이게 헷갈리면 모든 게 헷갈림. 분리부터 명확히.

### 2-1. 추론(Inference) — 모델을 "쓰는" 단계

```
1. 사용자가 질문
2. 모델이 토큰을 1개씩 예측
3. 끝
```

필요한 것:
- 가중치 (메모리에 통째로 로드)
- KV cache (현재 대화의 attention 캐시)
- 임시 activation (한 layer 통과 후 사라짐)

**가중치는 바뀌지 않음.** 그냥 거대한 행렬 곱셈.

### 2-2. 학습(Training) — 모델을 "만드는" 단계

세 가지 단계로 나뉨:

#### (a) Pretraining (사전 학습)
- 수조 개 토큰의 인터넷 텍스트로 "다음 단어 예측" 무한 반복
- 가장 비싸고 오래 걸림 (수개월, 수천만 달러)
- 결과: "텍스트의 통계적 분포를 아는 모델"

#### (b) SFT (Supervised Fine-Tuning, 지도 미세조정)
- 사람이 쓴 "질문-답변" 데이터로 instruction following 학습
- 며칠~몇 주, 비교적 저렴
- 결과: "지시 따르는 모델"

#### (c) RLHF / DPO (인간 피드백 정렬)
- 사람이 좋아하는 답변을 더 잘 내도록 조정
- 결과: 안전하고 사람 같은 톤의 모델 (ChatGPT, Claude 의 친절함)

### 2-3. 학습 한 스텝의 흐름

```
입력 (배치)
   ↓
Forward pass:  output = model(input)              ← 가중치 사용
   ↓
Loss = (output - target) 의 차이
   ↓
Backward pass: dLoss/dWeight 계산 (gradient)      ← 메모리 폭증 시작
   ↓
Optimizer:     W_new = W_old - learning_rate × grad
   ↓
다시 처음으로 (수십만 ~ 수억 번)
```

### 2-4. 학습은 왜 추론보다 메모리가 훨씬 더 필요한가

추론은 가중치만 있으면 됨. 학습은:

1. **가중치 (Weights)** — 메모리에 로드 (P × 2 bytes BF16)
2. **그래디언트 (Gradients)** — 가중치와 같은 크기 (P × 2 bytes)
3. **옵티마이저 상태 (Optimizer State)** — Adam 의 경우 `m` 과 `v` 두 개 더 (P × 8 bytes FP32)
4. **Activations** — backward 때 필요해서 forward 중간 결과를 다 저장 (가변, 보통 수십~수백 GB)

**Llama 3 70B 학습 메모리 계산**:
```
Weights (BF16):      70B × 2 = 140 GB
Gradients (BF16):    70B × 2 = 140 GB
Adam state (FP32):   70B × 8 = 560 GB         ← 가장 큼!
Activations:         약 300-500 GB (배치 따라)
───────────────────────────────────────────
합계:                약 1.2 - 1.5 TB
```

→ H100 80GB **18-20장** 분량을 한 학습 인스턴스가 먹음.
→ 더 많은 GPU 로 모델을 쪼개 분산 학습 필요.

### 2-5. 학습 분산 방식 (간단)

| 방식 | 약자 | 원리 |
|---|---|---|
| Data Parallel | **DP** | 모델은 GPU 마다 똑같이 복사, 데이터 배치를 쪼갬 |
| Tensor Parallel | **TP** | 한 layer 안의 행렬을 GPU 간 쪼갬 |
| Pipeline Parallel | **PP** | 모델의 layer 를 GPU 간 쪼갬 |
| FSDP / ZeRO | **ZeRO** | 가중치+grad+optimizer 모두 GPU 간 분산 (Microsoft DeepSpeed) |
| Expert Parallel | **EP** | MoE expert 를 GPU 간 분산 |

실제로는 이 중 여러 개를 동시에 씀 (3D parallelism).

### 2-6. 학습 비용 감각

| 모델 | 학습 비용 (추정) | 사용 GPU |
|---|---|---|
| Llama 3 70B | ~$50M | 24K H100 × 30일 |
| Llama 3 405B | ~$120M | 16K H100 × 54일 |
| GPT-4 | ~$100M+ | 비공개 |
| Claude 3 Opus | 비공개 | 비공개 |
| DeepSeek V3 | ~$5.5M (!) | 2K H800 × 53일 (놀랄만큼 효율적) |

DeepSeek 가 충격이었던 이유: GPT-4 급 모델을 **1/20 비용** 으로 만들었음. MoE + 알고리즘 혁신 덕분.

### 2-7. 학습 vs 추론 한 줄 요약
- **학습**: 가중치를 **만드는** 과정 (수개월, 수천만 달러)
- **추론**: 그 가중치를 **쓰는** 과정 (1초 미만, 토큰당 ~0.001원)

---

## 3. Mixture of Experts (MoE) 완전 해부

이게 질문하신 핵심. 천천히 가자.

### 3-1. 먼저 Dense 모델의 구조

Transformer 의 한 layer 는 두 부분으로 구성:
```
입력
  ↓
[ Attention ]            ← 토큰들끼리 정보 교환
  ↓
[ FFN (Feed-Forward) ]   ← 큰 행렬 곱셈 2번. 모델의 "지식" 저장소.
  ↓
출력
```

**FFN 이 layer 파라미터의 대략 2/3 차지**. 모델이 클수록 FFN 비중도 큼.

### 3-2. MoE 의 아이디어

> "FFN 을 거대한 1개로 만드는 대신, 작은 FFN(=expert) 을 여러 개 만들고, 토큰마다 어울리는 것 몇 개만 켜자."

```
[ Dense 모델 ]                     [ MoE 모델 ]

   토큰                                토큰
    ↓                                   ↓
[ Attention ]                       [ Attention ]   ← 똑같음
    ↓                                   ↓
[ FFN (큰 거 1개) ]                 [ Router ]      ← 어느 expert?
    ↓                                   ↓
   출력                             [ FFN #15 ]  [ FFN #87 ]  [ FFN #142 ]
                                        ↓
                                    이 결과들 합침
                                        ↓
                                       출력
                                    (나머지 253개 expert: 메모리엔 있지만 계산 X)
```

### 3-3. 질문 1: "활성 파라미터는 고정된 가중치인가, 항상 바뀌는 가중치인가?"

**답: 가중치 자체는 학습 후 영원히 고정. 다만 토큰마다 "어떤 가중치를 쓸지" 가 달라짐.**

구체적으로:
- DeepSeek V3 는 256 개의 expert FFN 가중치를 가지고 있음 (다 학습된 후 고정)
- 토큰 A 가 들어오면 Router 가 "expert {5, 17, 89, ...}" 8개를 골라서 계산
- 토큰 B 가 들어오면 Router 가 "expert {12, 45, 88, ...}" 다른 8개를 골라서 계산
- 가중치 숫자는 절대 안 바뀜. **선택만 토큰마다 바뀜.**

비유:
> 도서관에 책 256권이 있고 (= 모든 expert 가중치),
> 도서관 사서(= Router) 가 손님(= 토큰) 의 질문에 따라
> "이 8권만 보세요" 하고 골라주는 것.
> 책 내용은 안 바뀌고, 어떤 책을 펼지만 그때그때 다름.

### 3-4. 질문 2: "왜 활성 파라미터의 양이 더 적은가?"

DeepSeek V3 계산을 풀어보자.

총 파라미터: **671B**
- Attention 등 always-on 부분: 약 17B
- MoE 부분의 모든 expert: 약 654B (256 expert 분량)

활성 파라미터: **37B**
- Attention 등 always-on 부분: 17B (그대로)
- MoE 부분에서 활성: top-8 routed + 1 shared = 9개 expert × (expert 1개 크기 ≈ 2.5B) = 약 20B

```
17B (always-on)  +   20B (8 expert 활성)   =  37B  ← 활성
17B (always-on)  +  654B (256 expert 전부) = 671B  ← 총
```

**그래서 활성이 적은 이유**:
- Attention 등은 모든 토큰에 대해 항상 동작 → 17B
- FFN 부분만 expert 로 쪼개졌고, 256 개 중 9 개만 켜짐 → 20B 만 활성
- 합해서 37B

비율: 활성 / 총 = 37/671 = **약 5.5%**. **95% 가 매 토큰 메모리에는 있지만 계산엔 안 쓰임.**

### 3-5. 질문 3: "MoE 는 모든 파라미터 다 로드해놓고 일부만 쓰는 거? 메모리는 더, 속도는 더 빠른?"

**정확히 그렇습니다.**

```
DeepSeek V3 vs Llama 3 70B (같은 정밀도 FP8 가정)

                       메모리              토큰당 계산
DeepSeek V3 (671B/37B)  671 GB             37B 만 계산  →  빠름
Llama 3 70B (70B/70B)    70 GB             70B 다 계산  →  덜 빠름
```

직관:
- **메모리**: DeepSeek V3 가 Llama 3 70B 의 약 **10 배**
- **속도 (토큰 생성)**: DeepSeek V3 가 Llama 3 70B 보다 **약 2 배 빠름** (37B 만 계산하니까)
- **모델 품질**: DeepSeek V3 가 훨씬 똑똑함 (전체 671B 의 지식을 가짐)

### 3-6. 트레이드오프 정리

| 항목 | Dense | MoE |
|---|---|---|
| 메모리 | 작음 | 큼 (모든 expert 로드) |
| 토큰당 계산 | 큼 | 작음 (top-K 만) |
| 추론 속도 | 느림 | 빠름 |
| 모델 품질 (같은 활성 파라미터 기준) | 낮음 | 높음 |
| 학습 난이도 | 쉬움 | 어려움 (load balancing 등) |
| 분산 학습 | 표준 | EP (expert parallel) 추가 필요 |

**한 줄 결론**: MoE = "메모리는 비싸지만 속도와 똑똑함을 둘 다 얻는 방법".

### 3-7. Router 의 역할

Router 는 작은 신경망 (보통 1개 linear layer). 입력 토큰 벡터를 받아 "각 expert 에 대한 점수" 를 출력. Top-K 골라서 softmax 가중합:

```
scores = Router(token)             # [num_experts] 점수 벡터
top_k_indices = argtop_k(scores)   # 예: [5, 17, 89, ...]
top_k_weights = softmax(top_k_scores)

output = sum(top_k_weights[i] × Expert_i(token) for i in top_k_indices)
```

Router 가 1 layer 마다 있음. 80 layer 모델이면 Router 80 번 결정.

### 3-8. MoE 함정: Load Balancing

학습 중 모든 토큰이 같은 expert 1-2 개로 몰리면 나머지는 학습이 안됨 → "expert collapse". 이걸 막으려고 학습 중 **auxiliary loss** 를 추가해서 토큰이 expert 들 사이에 골고루 분산되게 강제. DeepSeek 는 auxiliary loss 없는 방식 ("aux-loss-free balancing") 으로 화제가 됨.

---

## 4. Precision 깊게

### 4-1. 같은 70B 모델, 정밀도만 바꿨을 때 메모리

| Precision | Bytes/param | 70B 모델 메모리 | 필요 GPU |
|---|---|---|---|
| FP32 | 4 | 280 GB | 4×H100 (80GB 4장) |
| BF16/FP16 | 2 | 140 GB | 2×H100 |
| FP8 | 1 | 70 GB | 1×H100 |
| INT4 | 0.5 | 35 GB | 1×RTX 4090 24GB + 여유 |
| INT2 (실험) | 0.25 | 17.5 GB | 1×RTX 4070 12GB |

같은 모델인데 **메모리가 16 배 차이**.

### 4-2. 정밀도와 정확도의 트레이드오프

**놀라운 사실**: INT4 양자화 해도 모델 정확도는 1~3% 만 떨어짐. 왜?

이유:
- 가중치 분포가 보통 0 근처에 집중되어 있음
- 그래서 -1 ~ 1 사이에 16 단계만 있어도 충분히 표현됨
- **outlier (큰 값) 만 따로 처리** 하는 기법 (GPTQ, AWQ, SmoothQuant) 도 있음

학습용 vs 추론용 정밀도:
- **학습**: BF16 forward/backward + FP32 optimizer (mixed precision) 표준
- **추론**: FP8 / INT8 / INT4 로 양자화 가능
- 왜? 학습은 작은 gradient 변화도 누적되어야 해서 정밀도 중요. 추론은 1회 곱셈뿐.

### 4-3. 양자화 방식

| 방식 | 원리 |
|---|---|
| **PTQ** (Post-Training Quantization) | 학습 끝난 모델을 후처리로 양자화 |
| **QAT** (Quantization-Aware Training) | 학습 중부터 양자화 시뮬레이션 |
| **GPTQ** | 한 layer 씩 quantize 하며 reconstruction error 최소화 |
| **AWQ** | "중요한 가중치는 정확하게, 덜 중요한 건 거칠게" |
| **GGUF** | llama.cpp 의 양자화 포맷 (Q4_K_M, Q5_K_S 등) |
| **MLX** | Apple Silicon 전용 양자화 |

### 4-4. 정밀도와 속도

정밀도가 낮으면 **메모리만 줄어드는 게 아니라 계산도 빨라짐**:
- FP16 곱셈기 회로 1개 ≈ FP8 곱셈기 2개 분량
- 그래서 H100 의 BF16 = 약 1000 TFLOPS, FP8 = 약 2000 TFLOPS
- B200 의 FP4 = 약 9000 TFLOPS (!)

같은 칩, 정밀도 낮출수록 throughput 폭증.

---

## 5. KV Cache 완전 해부

### 5-1. 왜 KV cache 가 필요한가

Transformer attention 의 핵심 공식:
```
Attention(Q, K, V) = softmax( Q × K^T / √d ) × V
```

- **Q** (Query): "내가 지금 뭘 찾고 있냐"
- **K** (Key): "내가 가지고 있는 정보들의 색인"
- **V** (Value): "그 정보들의 실제 내용"

자기회귀 (autoregressive) 생성:
```
1번째 토큰 생성: 입력 1개 → Q1, K1, V1 만들기 → Q1 이 K1 보고 V1 합침
2번째 토큰 생성: 입력 2개 → Q2 만들고, [K1, K2], [V1, V2] 전부 봐야 함
3번째 토큰 생성: 입력 3개 → Q3 만들고, [K1, K2, K3], [V1, V2, V3] 전부 봐야 함
...
N번째 토큰 생성: [K1, ..., KN], [V1, ..., VN] 전부 봐야 함
```

매번 K, V 를 처음부터 다시 계산하면 → **O(N²) 의 시간 낭비**.

**해법**: 이전 step 의 K, V 를 **GPU 메모리에 저장 (캐시)**. 새 토큰 들어오면 새 K, V 만 계산해서 캐시에 추가.

→ 이게 **KV Cache**.

### 5-2. KV cache 크기 공식

```
KV cache 크기 (bytes) = 
    2 (K, V 따로)
  × num_layers           (Transformer layer 수)
  × num_kv_heads         (KV 헤드 수, GQA 면 줄어듦)
  × head_dim             (헤드 1개의 벡터 차원)
  × seq_len              (현재까지의 토큰 수)
  × bytes_per_element    (BF16=2, FP8=1)
  × batch_size           (동시 사용자 수, 보통 1)
```

### 5-3. Llama 3 70B 케이스 단계별 계산

Llama 3 70B 스펙:
- num_layers = **80**
- num_attention_heads = 64 (Query head)
- num_kv_heads = **8** (GQA, 8개 묶음으로 K/V 공유)
- head_dim = **128**
- BF16 (2 bytes/elem)

**토큰 1 개당 KV cache 크기**:
```
= 2 × 80 × 8 × 128 × 2
= 327,680 bytes
≈ 320 KB / 토큰
```

**Context 길이 별 cache 크기 (1 사용자)**:

| Context (tokens) | KV cache 크기 |
|---|---|
| 1,000 | 320 MB |
| 4,000 (4K) | 1.3 GB |
| 32,000 (32K) | 10.5 GB |
| 128,000 (128K) | **42 GB** ← 거의 모델 1/3! |

**다중 사용자 시 폭발**:
- 동시 사용자 100 명 × 4K context = 130 GB (모델보다 큼)
- 동시 사용자 1000 명 × 128K context = **42 TB** (현실적으로 불가능)

### 5-4. KV cache 줄이는 기술들

#### (a) MHA → MQA → GQA → MLA 의 진화

원래 **MHA** (Multi-Head Attention):
- num_q_heads = num_k_heads = num_v_heads = 64 (각 head 마다 독립적 K, V)
- KV cache 가 너무 큼

**MQA** (Multi-Query Attention):
- num_k_heads = num_v_heads = **1** (모든 query head 가 한 쌍의 K/V 공유)
- KV cache 64 배 감소
- 단점: 품질 약간 손해

**GQA** (Grouped-Query Attention) — Llama 2 70B 부터 표준:
- num_kv_heads = **8** (8 개 query head 마다 한 쌍의 K/V 공유)
- KV cache 8 배 감소
- 품질 거의 손해 없음

**MLA** (Multi-head Latent Attention) — DeepSeek V2/V3:
- K, V 를 작은 latent vector 로 압축해서 캐시
- KV cache **약 90% 감소**
- DeepSeek 가 긴 컨텍스트를 싸게 서비스할 수 있는 비결

#### (b) Quantized KV cache
- KV cache 도 FP8 또는 INT8 로 저장 → 메모리 절반
- 약간의 품질 손해

#### (c) PagedAttention (vLLM)
- KV cache 를 페이지 단위로 관리 (OS 의 virtual memory 와 비슷)
- 메모리 단편화 방지, 같은 GPU 로 더 많은 사용자 서빙

#### (d) Sliding Window / StreamingLLM
- 오래된 토큰의 KV 를 버림 (최근 N 개만 유지)
- 무한 길이 생성 가능하지만 오래된 정보 잊음

### 5-5. KV cache 가 왜 LLM 서비스 비용의 핵심인가

- 모델 가중치는 **모든 사용자가 공유** (1 번만 메모리에 로드)
- KV cache 는 **사용자마다 따로** (대화별 다름)
- 그래서 동시 사용자 N 명 = KV cache × N
- 긴 컨텍스트 = KV cache 폭증

OpenAI 가 128K 컨텍스트 가격을 비싸게 받는 이유: KV cache 메모리 비용.

### 5-6. 직관 체크 ✅
- "1 사용자, 128K context" 의 KV cache (Llama 70B 기준) = **42 GB**
- 모델 자체 BF16 = 140 GB
- 합 = 182 GB → H100 1 장 (80GB) 으로는 불가, 최소 3 장 필요
- 대신 INT4 양자화 + 4K context → 35 + 1.3 = **36 GB** → RTX 4090 1.5 장이면 OK

---

## 6. TFLOPS 와 연산 속도

### 6-1. FLOPS 의 의미

**FLOPS** = **FL**oating point **O**perations **P**er **S**econd
= 초당 부동소수점 연산 횟수

| 단위 | 의미 |
|---|---|
| KFLOPS | 천 (10³) |
| MFLOPS | 백만 (10⁶) |
| GFLOPS | 십억 (10⁹) |
| **TFLOPS** | **조 (10¹²)** |
| PFLOPS | 천조 (10¹⁵) — 슈퍼컴퓨터 |
| EFLOPS | 백경 (10¹⁸) — 최첨단 슈퍼컴 (Frontier, El Capitan) |

H100 의 BF16 = 약 **1,979 TFLOPS** = 초당 약 2조 번의 BF16 곱셈/덧셈.

비교:
- 인텔 i9 CPU: 약 1 TFLOPS (FP32)
- M3 Max GPU: 약 14 TFLOPS (FP32)
- RTX 4090: 약 83 TFLOPS (FP32)
- H100: 약 67 TFLOPS (FP32), **1979 TFLOPS (BF16)**, **3958 TFLOPS (FP8)**
- B200: 약 80 TFLOPS (FP32), **2250 TFLOPS (BF16)**, **4500 TFLOPS (FP8)**, **9000 TFLOPS (FP4)**

### 6-2. 정밀도 별 TFLOPS 가 다른 이유

같은 칩의 트랜지스터 면적은 정해져 있음. 같은 면적에서:
- FP32 곱셈기 1개 vs FP16 곱셈기 2개 vs FP8 곱셈기 4개 가 들어감

그래서 정밀도가 낮을수록 **같은 칩에서 더 많은 ops/sec** 가능.

| 정밀도 | H100 TFLOPS | B200 TFLOPS |
|---|---|---|
| FP32 | 67 | 80 |
| TF32 | 989 | 1100 |
| BF16/FP16 | 1979 | 2250 |
| FP8 | 3958 | 4500 |
| FP4 | — (지원 X) | 9000 |

**Sparse** 가속도 있음 (가중치의 절반이 0 인 경우): 위 숫자 × 2.

### 6-3. 한 모델이 토큰 1 개 만드는 데 필요한 FLOPS

**대략의 공식**: 1 forward pass FLOPS ≈ 2 × P (P = 활성 파라미터 수)

이유: 행렬 곱셈에서 가중치 1개당 곱셈 1번 + 덧셈 1번 = 2 ops.

Llama 3 70B (Dense):
- 1 토큰 = 2 × 70B = **140 GFLOPS** (10⁹)

DeepSeek V3 (MoE, 활성 37B):
- 1 토큰 = 2 × 37B = **74 GFLOPS**

GPT-4 (MoE, 활성 ~220B):
- 1 토큰 = 2 × 220B = **440 GFLOPS**

### 6-4. 이론상 최대 토큰 속도 (Compute-bound)

H100 = 1979 TFLOPS BF16 가정.

Llama 3 70B:
- 1979 × 10¹² / 140 × 10⁹ = **14,135 토큰/초** (이론상)

근데 실제로는 50~100 토큰/초 정도. 왜?

### 6-5. 메모리 대역폭이 진짜 병목 (Memory-bound)

토큰 1개 만들려면 **모든 가중치를 메모리에서 한 번 읽어야 함** (HBM → 코어).

H100 메모리 대역폭 = 3.35 TB/s
Llama 70B FP16 = 140 GB

**최대 토큰 속도 (메모리)**: 3350 GB/s ÷ 140 GB = **약 24 토큰/초**

→ 실제로 약 20-50 토큰/초 나오는 이유.

**핵심**: LLM 추론은 대부분 **메모리 대역폭 병목** (memory-bound) 임. 그래서 H100 의 HBM3, B200 의 HBM3e 속도가 토큰 속도를 좌우.

### 6-6. 배치 사이즈를 키우면?

여러 사용자를 한 번에 처리하면:
- 가중치는 1번만 메모리에서 읽음
- 그 가중치로 N 개 토큰 동시 계산
- → throughput 폭증 (TFLOPS 한계까지 사용)
- → 사용자당 latency 는 약간 늘어남

이게 서비스 운영의 핵심 trade-off. 배치 키우면 비용 ↓ latency ↑.

### 6-7. NPU 의 TOPS

NPU 는 보통 INT8 기준으로 **TOPS** (Tera **O**perations Per Second) 사용:
- Apple A17 Pro Neural Engine: 35 TOPS (INT8)
- iPhone 16 A18: 35-40 TOPS
- Qualcomm Snapdragon 8 Gen 3: 45 TOPS
- Google Tensor G3: 40 TOPS

이 정도면 ~3B 모델을 INT4 로 토큰 30-50 개/초 생성 가능.

### 6-8. 직관 체크 ✅
- TFLOPS = 칩의 "raw 처리 능력"
- 메모리 대역폭 = 칩의 "데이터 공급 능력"
- LLM 추론은 보통 **메모리 대역폭 병목**
- 그래서 H100 → H200 (HBM3e 4.8 TB/s) 이 추론에 더 좋음
- 학습은 보통 **TFLOPS 병목** (배치가 커서)

---

## 7. 추론 1회에 필요한 전체 메모리 (요약)

```
Total GPU Memory =
    Model Weights     # P × bytes
  + KV Cache          # 위 공식 × 동시 사용자
  + Activations       # 보통 weights 의 10-20%
  + CUDA / Driver     # 1-2 GB 오버헤드
```

위 내용 다시 한번 정리 — 다음 챕터의 케이스 계산이 이걸 적용함.

---

## 8. GPU vs NPU

### 8-1. GPU (Graphics Processing Unit)
범용. 수만 개 코어 병렬 연산. AI 표준.

| 칩 | 메모리 | 대역폭 | BF16 TFLOPS | FP8 TFLOPS | 발매 |
|---|---|---|---|---|---|
| NVIDIA H100 | 80 GB HBM3 | 3.35 TB/s | 1,979 | 3,958 | 2023 |
| NVIDIA H200 | 141 GB HBM3e | 4.8 TB/s | 1,979 | 3,958 | 2024 |
| NVIDIA B100 | 192 GB HBM3e | 8 TB/s | 1,800 | 3,500 | 2024 |
| NVIDIA B200 | 192 GB HBM3e | 8 TB/s | 2,250 | 4,500 | 2024 |
| NVIDIA GB200 | 384 GB (2×B200) | 16 TB/s | 4,500 | 9,000 | 2024 |
| AMD MI300X | 192 GB HBM3 | 5.3 TB/s | 1,307 | 2,614 | 2023 |
| AMD MI325X | 256 GB HBM3e | 6 TB/s | 1,307 | 2,614 | 2024 |

### 8-2. NPU / 전용 AI 칩 (ASIC)
모델 1개 / 1종류에 특화. 전력당 성능 높음. 범용 X.

| 칩 | 누가 | 특징 |
|---|---|---|
| TPU v5p / v6 (Trillium) | Google | 클라우드 전용, Gemini 학습/추론 |
| Trainium 2 / Inferentia 2 | AWS | AWS 자체 모델 학습 + Bedrock 서비스 |
| Maia 100 | Microsoft | Azure 자체 데이터센터 |
| Apple Neural Engine | Apple | iPhone, Mac 내장. ~35 TOPS |
| Tesla Dojo D1 | Tesla | FSD 학습 |
| Cerebras WSE-3 | Cerebras | 4조 트랜지스터 한 장 칩, 웨이퍼 그대로 |
| Groq LPU | Groq | 초고속 추론 전용, on-chip SRAM |
| SambaNova SN40L | SambaNova | 메모리 큰 추론 칩 |
| Meta MTIA v2 | Meta | 추천 시스템 + LLM 추론 |

### 8-3. 핵심 차이
- **GPU**: 학습 + 추론 모두. 어떤 모델이든 OK. 비쌈.
- **NPU**: 추론 위주. 특정 모델 / 워크로드 최적화. 효율 ↑ 비용 ↓ 유연성 ↓.

---

## 9. NVLink / NVSwitch / InfiniBand — GPU 간 통신

### 9-1. 통신 계층 (느린 것 → 빠른 것)

```
                                속도          용도
일반 Ethernet                  100 Gbps      사무실 네트워크
RoCE Ethernet (AI 전용)        400-800 Gbps  Meta 데이터센터
InfiniBand HDR/NDR/XDR         400-800 Gbps  대부분 AI 데이터센터
NVLink 4 (H100)                900 GB/s      GPU 직결
NVLink 5 (B200)                1.8 TB/s      GPU 직결
                                  ↓
                              GPU 메모리 내부 (HBM)
H100 HBM3                      3.35 TB/s
B200 HBM3e                     8 TB/s
```

### 9-2. NVLink — NVIDIA 의 GPU 직결 케이블
- GPU 1장 ↔ GPU 1장 직접 연결 (PCIe 우회)
- NVLink 4 (H100): GPU 당 900 GB/s = PCIe 5.0 의 약 28 배
- NVLink 5 (B200): 1.8 TB/s

### 9-3. NVSwitch — NVLink 의 스위치
- 8 ~ 72 개 GPU 를 모두 NVLink 로 풀 메쉬 연결
- DGX H100: 8 GPU 모두 NVSwitch 로 묶임 (any-to-any 900 GB/s)
- **NVL72** (Blackwell): 72 GPU 가 한 랙 안에서 모두 NVLink 연결 → 마치 한 거대 GPU 처럼 보임

### 9-4. InfiniBand / RoCE Ethernet — 랙 사이 통신
- 노드 (서버) 간 통신
- 400 Gbps (NDR), 800 Gbps (XDR)
- Latency 마이크로초 단위
- Meta 같은 곳은 InfiniBand 대신 RoCE Ethernet (싸지만 미세하게 느림)

### 9-5. 왜 이렇게 빨라야 하나
**Tensor Parallelism** 예시 (Llama 70B 를 2 GPU 에 쪼개면):
- 매 layer 마다 GPU 끼리 결과를 합쳐야 함 (all-reduce)
- 80 layer × 매번 수 GB 통신
- NVLink 없으면 GPU 가 통신 대기로 놀고 있음 → 학습/추론 10 배 느려짐

---

## 10. Vision Language Models (VLM)

### 10-1. 구조
```
이미지
  ↓
Vision Encoder (CLIP-style ViT 보통)
  ↓
이미지 → ~256 ~ 1024 개의 "이미지 토큰" 벡터
  ↓
LLM 의 토큰 시퀀스에 텍스트 토큰과 섞어서 입력
  ↓
LLM 이 텍스트처럼 처리해서 답변 생성
```

### 10-2. 핵심 직관
- 이미지를 작은 패치 (예: 14×14 픽셀) 로 자름
- 각 패치를 벡터로 변환 (Vision Transformer)
- 이 벡터들이 LLM 입장에선 그냥 "토큰"
- 그래서 텍스트와 자유롭게 섞임

### 10-3. 메모리 추가 비용
- 이미지 1 장 = ~1000 토큰 추가 → 컨텍스트 길어짐 → KV cache 더 필요
- 고해상도 이미지 = 더 많은 토큰
- 동영상 = 프레임마다 이미지 → 폭발적 증가

### 10-4. 주요 VLM

| 모델 | Vision Encoder | 특징 |
|---|---|---|
| GPT-4V / GPT-4o | 내부 | 미공개 |
| Claude 3.5 Sonnet | 내부 | 미공개 |
| Gemini 1.5/2.0 | 내부 | Native multimodal (텍스트/이미지/오디오/비디오 동시 학습) |
| Llama 3.2 11B/90B Vision | ViT-H/14 | 오픈 |
| Qwen2-VL | ViT 변형 | 오픈, 강력 |
| LLaVA / LLaVA-NeXT | CLIP ViT-L | 오픈 연구용 |
| Pixtral 12B | Mistral 자체 | 오픈 |

---

## 11. 케이스 스터디 — 단계별로 계산해보기

### Case A: 개인이 Llama 3 70B 를 로컬에서 INT4 로 돌리기

**목표**: 본인 노트북/PC 로 GPT-4 급 모델 1 사용자 추론.

**Step 1: 모델 가중치 메모리**
- 70B 파라미터 × INT4 (0.5 bytes) = **35 GB**
- 양자화 메타데이터 (scale, zero-point) 추가: 약 +1 GB → **36 GB**

**Step 2: KV cache 메모리 (1 사용자, 4K context)**
- 5-3 절에서 계산: 토큰당 320 KB (BF16 KV)
- 4096 토큰 × 320 KB = **1.3 GB**
- INT8 KV cache 면 0.65 GB

**Step 3: Activations + 오버헤드**
- Forward pass 중간 결과: ~1 GB
- CUDA / driver / 시스템: ~1.5 GB

**합계**:
```
36 + 1.3 + 1 + 1.5 ≈ 40 GB
```

**가능한 하드웨어**:
| 옵션 | 비용 | 속도 |
|---|---|---|
| Mac Studio M3 Ultra 128GB | $5,000 | ~25 토큰/초 |
| RTX 4090 24GB × 2 | $3,500 | ~30 토큰/초 |
| RTX 4090 + RTX 3090 | $2,500 | ~25 토큰/초 |
| Mac mini M4 Pro 64GB | $2,500 | ~20 토큰/초 |

### Case B: 스타트업이 DeepSeek V3 671B 자체 호스팅

**목표**: 사내 100 명 동시 사용 (각자 평균 8K context).

**Step 1: 모델 가중치 (FP8)**
- 671B × 1 byte = **671 GB**

**Step 2: KV cache (100 사용자 × 8K context, MLA 적용)**
- DeepSeek V3 는 MLA → 일반 KV 대비 ~95% 감소
- 일반 attention 토큰당 가정 ~1 MB → MLA 적용 시 ~50 KB
- 100 × 8000 × 50 KB = **40 GB**
- (참고: 일반 attention 이라면 800 GB 였음. MLA 가 게임체인저)

**Step 3: Activations + 오버헤드**
- Activations: ~5 GB
- 시스템 / KV 페이지 관리: ~10 GB

**합계**:
```
671 + 40 + 15 ≈ 726 GB
```

**가능한 하드웨어**:
| 옵션 | 메모리 | 비용 |
|---|---|---|
| **8 × H200 (141GB)** = 1.128 TB | 여유 충분 | DGX H200 약 $400K |
| **8 × B200 (192GB)** = 1.536 TB | 더 많은 사용자 가능 | DGX B200 약 $500K |
| **8 × MI300X (192GB)** = 1.536 TB | AMD 대안 | 약 $300K |

NVLink 5 + NVSwitch 필수 (MoE 라우팅으로 GPU 간 통신 폭발적).

### Case C: OpenAI 가 GPT-4 를 전 세계 서비스

**목표**: 전 세계 100M DAU, 동시 ~100K 사용자.

**Step 1: 모델 가중치 (1.8T MoE, FP8 추정)**
- 1,800B × 1 byte = **1.8 TB**
- 단일 클러스터에 모델 1 인스턴스 = 1.8 TB
- 그런데 1 인스턴스로 100K 사용자 서빙 불가 → **N 인스턴스 복제** 필요

**Step 2: KV cache (사용자당 ~5 GB × 동시 100K = 500 TB)**
- 사용자당 평균 컨텍스트 ~20K + 활성 220B 의 attention head 수 가정
- 500 TB → 한 데이터센터에 다 못 둠

**Step 3: 분산 전략**
- 지역별 데이터센터 분산 (us-east, eu-west, asia 등)
- 각 데이터센터마다 모델 인스턴스 수십~수백 개
- 사용자 라우팅 (가까운 지역으로)

**필요 하드웨어**:
- **수만~수십만 GPU** (Microsoft Azure / OpenAI 데이터센터)
- NVL72 시스템 다수 (랙당 72 B200)
- 다국가 분산

**비용**:
- 추정 연 수십억 달러 (CapEx + 전력 + 쿨링)
- 토큰당 비용: 입력 ~$0.005/1K tokens, 출력 ~$0.015/1K tokens
- 1억 사용자 × 평균 1000 토큰/일 = 매일 약 $1.5M 매출 (GPT-4 단가 기준)

### Case D: iPhone 에서 Apple Intelligence 돌리기

**목표**: iPhone 15 Pro 에서 텍스트 요약 / 답장 추천.

**Step 1: 모델 (Apple Foundation Model)**
- 약 3B 파라미터
- INT4 양자화: 3B × 0.5 = **1.5 GB**
- + adapter (LoRA 어댑터 여러 종류, 각 ~50 MB)

**Step 2: KV cache**
- 짧은 컨텍스트 (~2K)
- 토큰당 ~30 KB (작은 모델) × 2000 = **60 MB**

**Step 3: 시스템**
- iPhone 15 Pro 통합 RAM: 8 GB (iOS + 앱과 공유)
- AI 가용 메모리: ~2-3 GB

**하드웨어**: Apple A17 Pro Neural Engine — 35 TOPS (INT8)

**속도**: 약 30 토큰/초 (체감 즉시 응답)

**재밌는 점**:
- 네트워킹 0 (오프라인)
- 프라이버시 우수 (서버 안 보냄)
- 복잡한 쿼리는 Private Cloud Compute (Apple 자체 데이터센터) 로 위임

---

## 12. 영상 만들 때 활용할 시각화 매핑

| 컨텐츠 | 씬 타입 | 비고 |
|---|---|---|
| 부동소수점 비트 구조 (FP32/BF16/FP8) | `stackDiagram` 또는 `flowDiagram` | 비트 분배 비주얼 |
| 12 개 모델 비교 (param) | `animatedChart` | bar chart |
| 활성 vs 총 파라미터 | `animatedChart` | 두 그룹 막대 |
| Precision 별 메모리 | `animatedChart` | "같은 모델 다른 양" |
| MoE 라우팅 흐름 | `flowDiagram` | 입력 → Router → 8 experts |
| KV cache 토큰 누적 | `countUpStat` | 1 GB → 42 GB |
| TFLOPS 비교 (FP32/FP16/FP8/FP4) | `animatedChart` | 정밀도-속도 |
| GPU 비교 (H100/B200/MI300X) | `logoGrid` + `marketShare` | |
| NVLink 속도 비교 | `animatedChart` | Ethernet vs IB vs NVLink |
| Case A/B/C/D 메모리 | `countUpStat` × 4 | "1.5 GB" → "1.8 TB" |
| 전체 stack | `flowDiagram` | 사용자 → ... → GPU |

---

## 13. 영상 구조 초안 (3-4 분)

| # | 타입 | 내용 |
|---|---|---|
| 1 | title | "What Actually Runs Inside ChatGPT" |
| 2 | countUpStat | "1.8 TB" (GPT-4 모델 추정) — hook |
| 3 | flowDiagram | 사용자 입력 → 토큰화 → Transformer → 출력 |
| 4 | stackDiagram | 부동소수점 비트 구조 (FP32/BF16/FP8) |
| 5 | animatedChart | Precision 별 같은 70B 메모리 (280 → 35 GB) |
| 6 | animatedChart | 12 개 모델 파라미터 비교 (총 vs 활성) |
| 7 | flowDiagram | MoE 작동 원리 (Router + Top-K experts) |
| 8 | flowDiagram | KV Cache 의 메모리 폭탄 |
| 9 | animatedChart | TFLOPS — FP32 vs BF16 vs FP8 vs FP4 |
| 10 | logoGrid | 6 대 GPU/NPU (H100/B200/MI300X/TPU/Trainium/Apple) |
| 11 | animatedChart | NVLink vs InfiniBand vs Ethernet 속도 |
| 12 | fact | "DeepSeek V3 한 번 돌리려면 H200 8 장 = $400K" |
| 13 | countUpStat × 4 | Case A/B/C/D 한 화면에 |
| 14 | outro | "Next: 직접 로컬에서 Llama 돌려보기" |

---

## 14. 후속 시리즈 토픽
1. Quantization 의 비밀 — FP8 / FP4 가 어떻게 정확도 유지하는지
2. vLLM / TensorRT-LLM 비교 — 추론 엔진 종류
3. MoE Router 의 함정 — load balancing, expert collapse
4. NVL72 vs Tesla Dojo — 차세대 컴퓨터 아키텍처 비교
5. 로컬 PC 에서 Llama 70B 돌리기 실전 — Mac vs RTX, GGUF vs MLX
6. 학습 비용 deep dive — Llama 3 405B 의 $120M 어디에 쓰였나
7. RLHF / DPO / GRPO — 모델 정렬 (alignment) 의 진화

---

## 15. 출처 / 정확도 점검

이 문서는 2025 후반 기준 공개 정보 + 추정 종합. 영상 만들기 전 다음 확인:

- **DeepSeek V3 671B / MLA**: DeepSeek 공식 paper (arXiv 2412.19437)
- **Llama 3 / Llama 4**: Meta 공식 발표, model card
- **NVLink 5 / B200 / NVL72**: NVIDIA GTC 2024 발표
- **KV cache 공식**: vLLM 문서, GQA paper (Ainslie et al. 2023)
- **GPT-4 1.8T MoE**: SemiAnalysis 추정 (공식 X)
- **TFLOPS 수치**: NVIDIA / AMD 공식 datasheet
- **양자화 방식**: GPTQ paper (Frantar 2022), AWQ paper (Lin 2023)
- **각 GPU 가격**: 데이터센터 거래가 (변동성 큼)

영상에서 추정치 쓸 때는 "estimated" / "rumored" 명시.

---

## 다음 단계

이 버전은 질문하셨던 7 가지 (학습 / 활성 파라미터 / MoE 메모리·속도 / 부동소수점-FP-BF / KV cache / 케이스 계산 / TFLOPS) 를 모두 풀어 설명함.

읽으면서 막히는 부분 있으면 알려주세요. 그 다음:
1. 정확한 영상 outline 잡기 (14 씬 또는 본인이 원하는 길이)
2. 영문 narration 작성
3. Memoji 녹화 + 자동 영상 빌드

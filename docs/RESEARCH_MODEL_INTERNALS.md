# AI 모델은 어떻게 GPU 위에서 돌아가는가 — Research

> 다음 영상 주제 정리. 모델 1개를 실제로 돌리려면 **무엇이, 얼마나, 어떻게 연결되어** 있어야 하는지.

---

## 0. 큰 그림 한 장

모델이 한 번의 답변(=inference)을 만들기 위해 일어나는 일:

```
사용자 입력 (text or image)
   ↓
토큰화 (Tokenizer)
   ↓
임베딩 (벡터로 변환)
   ↓
┌────────────────────────────────────────────┐
│  Transformer Layers (80~120개) — 반복      │
│   ├─ Attention (이전 토큰 다 보기)         │  → KV Cache
│   ├─ MoE Router (어느 전문가가 처리?)      │  → MoE 일 때만
│   └─ Feed-Forward (계산)                  │
└────────────────────────────────────────────┘
   ↓
다음 토큰 1개 예측
   ↓
이걸 N번 반복해서 응답 완성
```

이 전체가 **GPU(또는 NPU) 메모리 안에** 다 들어가야 합니다. 안 들어가면 → 여러 GPU 로 쪼개야 → 그래서 GPU 간 통신 (NVLink/InfiniBand) 이 필요.

---

## 1. 파라미터 (Parameters) — 모델의 "크기"

**파라미터 = 학습된 숫자들 (가중치 = weights)**

| 모델 | 총 파라미터 | 활성 파라미터 | 구조 |
|---|---|---|---|
| Llama 3.1 8B | 8B | 8B | Dense |
| Llama 3.1 70B | 70B | 70B | Dense |
| Llama 3.1 405B | 405B | 405B | Dense |
| Mixtral 8x7B | 47B | 13B | MoE (8 experts) |
| Mixtral 8x22B | 141B | 39B | MoE |
| DeepSeek V3 | 671B | 37B | MoE (256 experts) |
| Llama 4 Scout | 109B | 17B | MoE (16 experts) |
| Llama 4 Maverick | 400B | 17B | MoE (128 experts) |
| GPT-4 (추정) | ~1.8T | ~220B | MoE (8 experts of 220B) |
| Claude / Gemini | 미공개 | 미공개 | 미공개 |

**핵심**:
- **"총 파라미터"** = GPU 메모리에 항상 로드되어야 하는 양
- **"활성 파라미터"** = 1개 토큰 만들 때 실제 계산되는 양 (속도와 직결)

---

## 2. Mixture of Experts (MoE) — 똑똑한 파라미터 절약법

### 문제
모델이 똑똑해지려면 파라미터가 많아야 함. 근데 많으면 계산 느림 + GPU 비쌈.

### 해법
**"전문가" 여러 개를 두고, 토큰마다 가장 잘 처리할 전문가 1-2개만 켠다.**

### 예시: DeepSeek V3 동작 원리

```
입력 토큰 "한국어"
   ↓
Router (작은 신경망)
   ↓  "음, 256명 전문가 중 8명만 부르자"
   ↓
전문가 #15, #87, #142, #201, ... (8개) → 계산
다른 248명은 → 메모리에는 있지만 계산 X
   ↓
8명의 결과를 합쳐서 → 다음 단계로
```

### 결과
| | 총 파라미터 | 활성 (1토큰당) | 비유 |
|---|---|---|---|
| Dense (Llama 3 70B) | 70B | 70B | 모두가 항상 일함 |
| MoE (DeepSeek V3) | 671B | 37B | 671명 직원 중 37명만 그때그때 출근 |

**메모리에는 671B 다 올려야 하지만, 1초당 계산은 37B 어치로 끝남** → 속도 = Llama 70B 수준, 똑똑함 = 700B 모델 수준.

### 트레이드오프
- ✅ 추론 (inference) 빠름
- ✅ 같은 GPU 시간으로 더 많은 토큰
- ❌ 메모리 더 많이 필요 (모든 expert 다 로드)
- ❌ 라우팅 오버헤드 (어느 expert 부를지 결정)
- ❌ 학습 어려움 (load balancing 문제)

---

## 3. Precision — 같은 숫자를 더 적게 표현하기

### 부동소수점 형식
| Format | Bits | Bytes | 표현 가능 범위 | 정확도 |
|---|---|---|---|---|
| FP32 (single) | 32 | 4 | ±3.4×10³⁸ | 7자리 |
| FP16 (half) | 16 | 2 | ±65,504 | 3자리 |
| BF16 (brain) | 16 | 2 | ±3.4×10³⁸ | 2~3자리 |
| FP8 (E4M3) | 8 | 1 | ±448 | 2자리 |
| FP4 | 4 | 0.5 | ±6 | 1자리 |

### 정수 형식 (Quantization)
| | Bits | Bytes |
|---|---|---|
| INT8 | 8 | 1 |
| INT4 | 4 | 0.5 |
| INT2 (실험적) | 2 | 0.25 |

### 핵심 직관
- **학습 (Training)**: FP32 또는 BF16 필요 (정확도 중요)
- **추론 (Inference)**: FP16 / BF16 표준
- **최신**: FP8 (NVIDIA H100+, Blackwell), FP4 (B200)
- **로컬 PC**: INT8 / INT4 양자화 (Llama.cpp, GGUF)

### 같은 모델, 메모리 차이
**Llama 3.1 70B**:
| Precision | 모델 메모리 | 필요 GPU |
|---|---|---|
| FP32 | 280 GB | 4×H100 (80GB) |
| BF16/FP16 | 140 GB | 2×H100 |
| FP8 | 70 GB | 1×H100 |
| INT4 | 35 GB | 1×RTX 4090 (24GB) + 약간 |

**대단한 점**: INT4 양자화 해도 정확도는 1~3% 만 떨어짐. 그래서 로컬에서 큰 모델 돌리는 게 가능.

---

## 4. KV Cache — Attention 의 메모리 폭탄

### 왜 필요한가
Transformer 는 답변할 때 **이전 모든 토큰을 다시 봐야** 함. 매번 다시 계산하면 너무 느림 → 이전 계산 결과를 캐싱.

### 크기 계산
```
KV cache size (bytes) = 
  2 (K + V)
  × num_layers
  × hidden_size  
  × num_heads / num_kv_heads (GQA 인 경우 작아짐)
  × seq_len
  × bytes_per_param
  × batch_size
```

### Llama 3.1 70B 예시 (BF16, 128k context)
```
= 2 × 80 × 8192 × (8/64) × 128_000 × 2
≈ 41 GB  (1 사용자, 128k context 가득 차면)
```

**문제**: 사용자 1000명에게 동시 서빙 = KV cache 만 41 TB → GPU 수십 대 필요.

**해결책**:
- **Paged Attention** (vLLM 가 유명): 가변 길이 효율 관리
- **GQA (Grouped Query Attention)**: KV head 줄이기 (Llama 3 가 적용)
- **MLA (Multi-head Latent Attention)**: DeepSeek 의 신기술, KV cache 90% 절감
- **FP8 / INT8 KV cache**: 메모리 절반

---

## 5. 추론 1회에 필요한 메모리 (전체)

```
Total GPU Memory = 
  Model Weights        # 모델 크기 × precision
+ KV Cache            # 위 공식
+ Activations         # 중간 계산 (~10-20% of weights)
+ CUDA / Driver       # 1-2 GB 오버헤드
```

### 실제 케이스

**개인이 로컬에서 Llama 3 70B 돌리기**:
- INT4 양자화: 35 GB 모델
- KV cache: 4k context → 2 GB
- 총 ~40 GB → **RTX 4090 (24GB) 2장 또는 1×Mac M3 Max (128GB unified)**

**기업이 DeepSeek V3 (671B) 서비스하기**:
- FP8: 671 GB 모델
- KV cache: 사용자당 ~5 GB (128k context)
- 1000 사용자 동시: 모델 671 GB + KV 5 TB
- → **80~100 × H100 (80GB)** 필요

**OpenAI 가 GPT-4 서비스하기 (추정)**:
- 1.8T params × MoE 라우팅 + ~100M 동시 사용자
- → **수십만 H100/B200** (Microsoft 데이터센터 전체)

---

## 6. GPU vs NPU — 누가 모델을 돌리나

### GPU (Graphics Processing Unit)
범용. 수만 개 코어 병렬 연산. AI 사실상 표준.

| 칩 | 메모리 | 대역폭 | BF16 성능 | 발매 |
|---|---|---|---|---|
| NVIDIA H100 | 80 GB HBM3 | 3.35 TB/s | 1,979 TFLOPS | 2023 |
| NVIDIA H200 | 141 GB HBM3e | 4.8 TB/s | 1,979 TFLOPS | 2024 |
| NVIDIA B100 | 192 GB HBM3e | 8 TB/s | 1,800 TFLOPS | 2024 |
| NVIDIA B200 | 192 GB HBM3e | 8 TB/s | 2,250 TFLOPS | 2024 |
| AMD MI300X | 192 GB HBM3 | 5.3 TB/s | 1,307 TFLOPS | 2023 |
| AMD MI325X | 256 GB HBM3e | 6 TB/s | 1,307 TFLOPS | 2024 |

### NPU / 전용 AI 칩 (ASIC)
모델 1개 / 1종류에 특화. 전력당 성능 높음. 범용 X.

| 칩 | 누가 | 특징 |
|---|---|---|
| TPU v5p | Google | 클라우드 전용, Gemini 학습 |
| Trainium / Inferentia | AWS | 자사 클라우드 전용 |
| Maia 100 | Microsoft | 자사 데이터센터 전용 |
| Apple Neural Engine | Apple | iPhone, Mac 내장 |
| Tesla Dojo | Tesla | FSD 학습 |
| Cerebras WSE-3 | Cerebras | 4조 트랜지스터 한 장 칩 |
| Groq LPU | Groq | 초고속 추론 전용 |
| SambaNova SN40L | SambaNova | 메모리 큰 추론 칩 |

### 핵심 차이
- **GPU**: 학습 + 추론 모두. 어떤 모델이든 OK. 비쌈.
- **NPU**: 추론 위주. 특정 모델 / 워크로드 최적화. 효율 ↑ 비용 ↓ 유연성 ↓.

---

## 7. NVLink / NVSwitch / InfiniBand — GPU 끼리 어떻게 대화하나

큰 모델은 GPU 1장에 안 들어감 → 여러 GPU 가 한 모델을 나눠 가짐 → GPU 끼리 빠르게 통신해야 함.

### 통신 계층 (느린 것 → 빠른 것)

```
                                     속도
  Ethernet (일반)                 100 Gbps
  RoCE Ethernet (AI 전용)         400-800 Gbps
  InfiniBand HDR/NDR              400-800 Gbps
  NVLink 4 (H100)                 900 GB/s (7,200 Gbps)
  NVLink 5 (B200)                 1.8 TB/s (14,400 Gbps)
                                     ↓
                                  GPU 메모리 내부
```

### NVLink — NVIDIA 의 GPU 직결 케이블
- GPU 1장 ↔ GPU 1장 직접 연결 (PCIe 우회)
- NVLink 4 (H100): GPU 당 900 GB/s = PCIe 5.0 의 28배
- NVLink 5 (B200): 1.8 TB/s

### NVSwitch — NVLink 의 "스위치"
- 8 ~ 72개 GPU 를 모두 NVLink 로 풀 메쉬 연결
- DGX H100: 8 GPU 모두 NVSwitch 로 묶임 (any-to-any 900 GB/s)
- NVL72 (Blackwell): **72 GPU 가 한 랙 안에서 모두 NVLink 연결** (마치 한 거대 GPU)

### InfiniBand — 랙 사이 통신
- 노드 (서버) 간 통신
- 400 Gbps (NDR), 800 Gbps (XDR)
- Latency 마이크로초 단위

### Ethernet (RoCE) — 더 싼 옵션
- 일반 데이터센터 케이블 이용
- 400-800 Gbps 가능
- Meta 같은 곳이 InfiniBand 대신 사용

### 왜 이렇게 빨라야 하나
**Tensor Parallelism** 예시: Llama 70B 를 2 GPU 에 쪼개면
- 매 layer 마다 GPU 끼리 결과를 합쳐야 함
- 80개 layer × 매번 ~수 GB 통신
- NVLink 없으면 GPU 가 통신 대기로 놀고 있음 → 학습/추론 10배 느려짐

---

## 8. Vision Language Models (VLM) — 이미지를 어떻게 보나

### 구조
```
이미지
  ↓
Vision Encoder (CLIP-style ViT 보통)
  ↓
이미지 → ~256 ~ 1024개의 "이미지 토큰" 벡터
  ↓
LLM 의 토큰 시퀀스에 텍스트 토큰과 섞어서 입력
  ↓
LLM 이 텍스트처럼 처리해서 답변 생성
```

### 핵심 직관
- 이미지를 작은 패치 (예: 14×14 픽셀) 로 자름
- 각 패치를 벡터로 변환 (Vision Transformer)
- 이 벡터들이 LLM 입장에선 그냥 "토큰"
- 그래서 텍스트와 자유롭게 섞임

### 메모리 추가 비용
- 이미지 1장 = ~1000 토큰 추가 → 컨텍스트 길어짐 → KV cache 더 필요
- 고해상도 이미지 = 더 많은 토큰
- 동영상 = 프레임 마다 이미지 → 폭발적 증가

### 주요 VLM
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

## 9. 케이스 스터디 — 구체적으로 "이거 돌리려면 뭐가 필요해?"

### Case A: 개인 개발자가 Llama 3.1 70B 로컬 추론
- 모델 INT4 양자화: **35 GB**
- KV cache (4k context): 2 GB
- 총: **~40 GB**
- **필요 하드웨어**:
  - Mac Studio M3 Ultra 128 GB unified → 1대로 OK
  - RTX 4090 24 GB × 2장 + 좋은 마더보드
  - NVLink 불필요 (PCIe 로도 됨, 살짝 느림)
- **속도**: ~10-20 tokens/sec (사람 읽는 속도)

### Case B: 스타트업이 DeepSeek V3 자체 호스팅
- 모델 FP8: **671 GB**
- KV cache (사용자 100명 × 128k context): ~500 GB
- 총: **~1.2 TB**
- **필요 하드웨어**:
  - **8 × H200 (141 GB each = 1.128 TB)** = 1 DGX H200 노드
  - NVLink 5 + NVSwitch 필수 (MoE 라우팅 트래픽 폭발적)
  - InfiniBand 도 필요 (다중 노드 확장 시)
- **비용**: DGX H200 1대 = 약 $400K + 전기 + 쿨링

### Case C: OpenAI 가 GPT-4 를 전 세계 서비스
- 모델 ~1.8 T (MoE), FP8: **~1.8 TB**
- 동시 사용자 ~100M (DAU)
- KV cache: 사용자당 ~5 GB × 100K 동시 = 500 TB
- **필요 하드웨어**:
  - **수만~수십만 GPU** (Microsoft Azure / OpenAI 데이터센터)
  - NVL72 시스템 다수 (랙당 72 B200)
  - 다국가 분산 (us-east, eu-west, 등)
- **비용**: 추정 연 수십억 달러 (Capex + 전력)

### Case D: 본인 iPhone 에서 Apple Intelligence 돌리기
- 모델 ~3B (Apple 자체 SLM)
- INT4 양자화 → ~1.5 GB
- KV cache: 작음 (짧은 컨텍스트)
- **하드웨어**: Apple Neural Engine (NPU) on A17 Pro / M2+
- **재밌는 점**: 칩 1개로 끝, 네트워킹 0

---

## 10. 영상 만들 때 활용할 시각화 매핑

이 리서치를 다음에 영상화할 때, **우리가 이미 만든 씬 타입들** 에 매핑:

| 컨텐츠 | 씬 타입 | 비고 |
|---|---|---|
| 12개 모델 비교 (param) | `stackDiagram` 또는 `animatedChart` | bar chart 형태 |
| 활성 vs 총 파라미터 | `animatedChart` (두 그룹 막대) | 시각적 임팩트 큼 |
| Precision 별 메모리 | `animatedChart` (5개 막대) | "같은 모델, 다른 양" |
| MoE 라우팅 흐름 | `flowDiagram` | 입력 → Router → 8 experts |
| GPU 비교 (H100/B200/MI300X) | `logoGrid` + `marketShare` | 시장 점유율 도넛 |
| NVLink 속도 비교 | `animatedChart` | Ethernet vs IB vs NVLink |
| Case A/B/C/D 메모리 | `countUpStat` 4개 | "1.2 TB" 같은 임팩트 |
| 전체 stack (사용자 → ... → GPU) | `flowDiagram` | 우리 12-layer 영상의 응용 |

---

## 11. 영상 구조 초안 (3분 분량)

| 씬 | 타입 | 내용 |
|---|---|---|
| 1 | title | "What Actually Runs Inside ChatGPT" |
| 2 | countUpStat | "1.8 TB" (GPT-4 모델 크기 추정) |
| 3 | flowDiagram | 사용자 입력 → 토큰화 → Transformer → 출력 |
| 4 | animatedChart | 12개 모델 파라미터 비교 (총 vs 활성) |
| 5 | stackDiagram | MoE 작동 원리 (Router + Experts) |
| 6 | animatedChart | Precision 별 같은 70B 모델 메모리 (FP32 280GB → INT4 35GB) |
| 7 | flowDiagram | KV Cache 가 왜 메모리 폭탄인지 |
| 8 | logoGrid | 6대 GPU/NPU (H100/B200/MI300X/TPU/Trainium/Apple) |
| 9 | animatedChart | NVLink vs InfiniBand vs Ethernet 속도 비교 |
| 10 | fact | "DeepSeek V3 한 번 돌리려면 H200 8장 = $400K" |
| 11 | outro | "Next: 직접 로컬에서 Llama 돌려보기" |

---

## 12. 더 깊이 들어가고 싶으면 (옵션 후속 영상)

이 영상 이후에 시리즈로 만들 수 있는 후속 주제:
1. **Quantization 의 비밀** — FP8 / FP4 가 어떻게 정확도 유지하는지
2. **vLLM / TensorRT-LLM 비교** — 추론 엔진 종류
3. **MoE Router 의 함정** — load balancing, expert collapse
4. **NVL72 vs Tesla Dojo** — 차세대 컴퓨터 아키텍처 비교
5. **로컬 PC 에서 Llama 70B 돌리기 실전** — Mac vs RTX, GGUF vs MLX

---

## 13. 정확도 / 출처 점검 권장

이 문서는 2025 후반 기준 공개 정보 + 추정 종합. 영상 만들기 전 다음 확인 권장:

- **DeepSeek V3 671B** : 공식 paper / 모델 카드
- **Llama 4 Scout/Maverick** : Meta 공식 발표
- **NVLink 5 / B200 / NVL72** : NVIDIA GTC 2024 발표
- **KV cache 공식** : vLLM 문서, GQA 논문
- **GPT-4 1.8T MoE** : SemiAnalysis 추정 (공식 X)
- **각 GPU 가격** : NVIDIA / AMD / 데이터센터 거래가 (변동성 큼)

영상에서 추정치 쓸 때는 "estimated" / "rumored" 명시.

---

## 다음 단계

본인이 위 내용을 한 번 정독 → 이해 안 가는 부분 / 더 알고 싶은 부분 / 추가하고 싶은 부분 알려주세요. 그 다음:

1. 정확한 영상 outline 잡기 (11씬 또는 본인이 원하는 길이)
2. 본인이 정답·숫자 확인 / 최신 데이터로 업데이트
3. 영문 narration 작성
4. Memoji 녹화 + 자동 영상 빌드 (기존 파이프라인 그대로 사용)

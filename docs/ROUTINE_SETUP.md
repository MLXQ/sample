# Claude Code Routine 셋업 가이드

이 문서는 데일리 자동 영상 생성을 위한 Claude Code Routine 셋업 방법을 정리합니다.

## 사전 조건

- [ ] Claude Pro / Max / Team / Enterprise 플랜 (무료 X)
- [ ] GitHub repo (`MLXQ/sample`) 가 Claude Code 에 연결됨
- [ ] `.env` 에 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 설정 (라우틴 머신에 secret 으로 등록)
- [ ] Slack 워크스페이스 (옵션, 알림용)

## 셋업 (5분)

1. Claude Code 웹 또는 `/schedule` 명령어 → `claude.ai/code/routines`
2. **Create routine** 클릭
3. **Repo**: `MLXQ/sample` 선택 (branch: `claude/video-animation-generator-h0ssH` 또는 main)
4. **Schedule**: `Daily`, 시간 03:00 (한국 기준 — 미국 시청자가 출근 전 영상 발견하기 좋은 시간)
5. **Connectors**: GitHub (필수) + Slack (옵션)
6. **Prompt**: 아래 "루틴 프롬프트" 그대로 붙여넣기
7. Save & enable

## 루틴 프롬프트

````
You are running the daily video pipeline for our cinematic AI/tech YouTube channel. Today's task: pick the best content source available, build a finished episode, and push it to git for the host to review and upload.

## Step 1: Scout for content

Run all five scouts in parallel:

```
npm run scout-arxiv -- --category cs.AI --days 1 --top 10
npm run scout-cspan -- --query "artificial intelligence" --top 10
npm run scout-cspan -- --query "semiconductor" --top 10
npm run scout-edgar -- --days 3 --types 10-Q,8-K
npm run scout-whitehouse -- --days 3
npm run scout-voa -- --days 3
```

## Step 2: Pick today's topic

Look at the top results from each scout. Pick ONE topic that:

  a) Has the highest score (interestScore for arXiv, promiseScore for cspan)
  b) Is NOT already covered — check `data/episodes/` for existing episode JSONs
  c) Would make a strong 60-120 second explainer

Prefer C-SPAN hearings on Mondays/Wednesdays/Fridays (more "newsworthy" feel) and arXiv papers on Tuesdays/Thursdays (technical days). On Saturday/Sunday, lean toward whichever has the highest score.

## Step 3: Build the episode

### If you picked an arXiv paper:

```
npm run arxiv-episode -- <paper-id>
```

This is fully automated — fetches the paper, drafts a script, synthesizes TTS narration, builds the final video.

### If you picked a C-SPAN hearing:

1. Download the source video:
   ```
   npm run download-cspan -- "<c-span URL>"
   ```
   If the downloader fails (page layout changed), abort and post the URL to Slack so the host can download manually.

2. Transcribe with Whisper:
   ```
   npm run transcribe -- out/cspan/<id>/source.mp4
   ```

3. Translate to Korean (for bilingual subs):
   ```
   npm run translate-transcript -- out/transcripts/source/transcript.json
   ```

4. Find the most clippable moments:
   ```
   npm run find-moments -- out/transcripts/source/transcript.json --top 4
   ```

5. Generate a SILENT BILINGUAL episode (no host narration needed):
   ```
   npm run draft-cspan-episode -- out/transcripts/source --silent --bilingual
   ```

6. Build the final video:
   ```
   npm run episode -- data/episodes/cspan-<slug>.json
   ```

## Step 4: Generate upload assets

```
npm run upload-assets         # SRT + chapters + metadata
npm run thumbnail             # 1280x720 JPEG
npm run shorts                # 9:16 60s cut
```

## Step 5: Commit + push to a new branch

```
DATE=$(date +%Y-%m-%d)
git checkout -b daily/$DATE
git add demo/episodes/ data/episodes/
git commit -m "Daily auto-build $DATE: <topic title>"
git push -u origin daily/$DATE
```

## Step 6: Notify (Slack — if configured)

Post a message:
```
✅ New video draft ready — $DATE
Topic: <title>
Length: <duration>s
Branch: daily/$DATE
Preview: <github URL to final.mp4>
```

## Failure handling

If any step fails:
  - Retry once with the same command
  - If still failing, capture the error message, post to Slack with the failing command + last 50 lines of output, and exit with status 1
  - Do NOT push a half-built video
  - Do NOT continue past a failure

## What NOT to do

  - Don't pick topics already covered (check `data/episodes/` first)
  - Don't push directly to `main` — always a `daily/YYYY-MM-DD` branch
  - Don't auto-publish to YouTube (host reviews manually)
  - Don't burn through retries — one retry per command, then escalate
````

## 첫 실행 후 점검

라우틴이 처음 돌고 나면:

1. Slack 알림 또는 GitHub 이메일 알림 받음
2. 새 `daily/YYYY-MM-DD` 브랜치의 `demo/episodes/<id>/final.mp4` 다운로드
3. 플레이해서 품질 확인
4. 괜찮으면 YouTube Studio 업로드 (메타데이터는 `metadata.md` 복붙)
5. 별로면 그 브랜치 머지 안 하고 무시 → 다음날 또 시도

## 점진적 개선

- 처음 1주: 매일 결과 검토, 어떤 소스가 좋은지 패턴 파악
- 2주차: 라우틴 프롬프트 튜닝 (예: "Sam Altman 류 영상은 피하기" 같은 사용자 취향 반영)
- 3주차: YouTube Data API 통합 추가 → 자동 Drafts 업로드
- 1개월: 광고 수익 / 채널 분석 보고 컨텐츠 방향 조정

## 비용 추정

| 항목 | 일/회 | 월 추정 |
|---|---|---|
| Claude API (스크립트 작성) | ~$0.30 | $9 |
| OpenAI Whisper (자막 추출) | ~$0.20 | $6 |
| OpenAI TTS (arXiv 영상) | ~$0.05 | $1.50 |
| Claude Pro (라우틴 호스팅) | — | $20 |
| **합계** | — | **~$36 / 월** |

영상 30편 자동 생성 비용 $36 = **편당 $1.20**. 손익분기점: 채널 광고 수익으로 월 $36+ 벌면 흑자.

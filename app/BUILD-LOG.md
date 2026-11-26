# Build log — AgentDesk MVP skeleton

**Date:** 2026-11-26 · **Environment:** Node v24.22.1, zero npm dependencies
(plain `http` server + global `fetch`). Built per
`../hidden_files/tech-build-plan.md` §2 (SDK spec) and §3/§5 (PiNet-safe
landing, MVP architecture).

## Verification run (demo mode)

Server started with no `.env` → `sandbox=true, serverDemoMode=true
(PI_API_KEY EMPTY)`, listening on port 3100 for the test.

| # | Step | Result |
|---|------|--------|
| 1 | `GET /` | 200 — landing page, `<title>AgentDesk — Hire an AI agent, pay with Pi</title>` |
| 2 | `GET /api/config` | 200 — `sandbox:true`, `serverDemoMode:true`, catalog with prices 1 / 0.5 / 1.5 Pi |
| 3 | `GET /validation-key.txt` | 200 — placeholder file contents served at domain root |
| 4 | `POST /api/verify` with wrong token | **401** (as expected) |
| 5 | `POST /api/verify` with `demo-access-token` | 200 — session issued for `demo_pioneer` (`demo-uid`) |
| 6 | `POST /api/tasks` (research, brief "Summarise solar panel prices…") | 201 — `task_0fded4d9a0a1`, price 1, status `awaiting_payment` |
| 7 | `POST /api/payments/approve` (`demo-pay-test1`) | `{"ok":true}` |
| 8 | `POST /api/payments/complete` (`demo-tx-test1`) | `{"ok":true}` — task flipped to `in_progress`, worker enqueued |
| 9 | `POST /api/payments/complete` **again** (SDK retry simulation) | `{"ok":true,"alreadyCompleted":true}` — idempotent, no double delivery |
| 10 | `GET /api/tasks?user=demo-uid` after ~3 s | task `completed` with the stub worker's placeholder Research Summary result, `paidAt` + `completedAt` set |
| 11 | Second task (content, 0.5 Pi): approve with session, then `POST /api/payments/complete` with **no session token** (incomplete-payment path) | `{"ok":true}` — authorised via server-side payment lookup; task completed normally |
| 12 | `GET /app.js` | 200, 12,971 bytes |

All JS files pass `node --check`. Server stopped after the test;
`data/tasks.json` reset to `[]` so the skeleton ships clean.

## Notes / known skeleton limits

- Sessions are in-memory (lost on restart) — fine for MVP; move to signed
  tokens/DB before production.
- Task store is a JSON file — swap for SQLite/Postgres at scale (store API is
  isolated in `lib/store.js`).
- The agent worker is a stub returning clearly-labelled placeholder results;
  the real LLM seam is `generateWithLLM()` in `lib/worker.js`.
- Frontend demo payment uses `demo-pay-*` / `demo-tx-*` ids; the backend only
  simulates Pi API calls while `PI_API_KEY` is empty, so demo ids can never
  reach the real Platform API.

## 2026-11-26 — LLM worker wired (Groq free tier)
- Provider decision: Xingchi relay REJECTED as backend (station disables /v1/chat/completions and returns 403 client_not_allowed for non-whitelisted clients; scripts/SDK/backend calls explicitly unsupported). DeepSeek official deferred (Bro has no top-up funds yet). CHOSEN: Groq free tier, key connected via custom.groq connector and verified (11 models; generation model openai/gpt-oss-120b; chat completion OK in <1s).
- lib/worker.js: generateWithLLM implemented — OpenAI-compatible chat completions, per-type system prompts, 30s per-attempt timeout, max 2 retries with backoff (retry on network/timeout/429/5xx only). generateResult returns {text, engine}; runWorker stores resultEngine on the task. Fallback chain: LLM error after retries -> placeholder result with engine 'fallback-after-llm-error' (visible, never silent); no key -> engine 'placeholder'.
- config.js llm block: provider/baseUrl/model/timeoutMs/maxRetries from env; defaults target Groq (https://api.groq.com/openai/v1, openai/gpt-oss-120b). .env.example updated.
- Smoke tests passed: demo mode completes with engine 'placeholder'; dead-LLM config completes with engine 'fallback-after-llm-error'. NOTE: the live LLM path from Node needs the raw Groq key in the host env at deploy time (the vault copy serves Muse's connector calls only).

## 2026-11-26 — A/B test: Groq vs Gemini (worker provider chain)
- Gemini key connected via custom.gemini (AI Studio could not auto-create a Cloud project; Bro created one in Cloud Console first, then the key in AI Studio). 65 models visible.
- A/B (hidden_files/ab-test.py, exact worker prompts + config briefHints, results in hidden_files/ab-results/): Groq openai/gpt-oss-120b — research 2.8s, content 1.5s, business 4.1s, 3/3 OK. Gemini gemini-3.8-flash — content 5.8s (best caption quality), business 42.6s (strong local Surabaya flavor), research TIMEOUT >90s. gemini-2.5-flash 404 (no longer served on this route), gemini-flash-latest research 43.6s, gemini-3.5-flash 503 overload.
- DECISION: Groq = primary (speed + reliability), Gemini 3.8 Flash = fallback (quality reserve), placeholder = last resort. Worker now supports the chain via config.llmFallback (LLM_FALLBACK_* env); chain smoke test passed (dead primary -> dead fallback -> placeholder, engine 'fallback-after-llm-error').
- Privacy note: Gemini free tier may use content for Google product improvement — must be disclosed in the app privacy policy.

## 2026-11-26 — Prompt/budget calibration (post A/B)
- Findings from the A/B outputs: (1) Groq content invented a price/promo not in the brief; (2) business hit the flat 1200 max_tokens cap; (3) gpt-oss hidden reasoning tokens can consume the whole budget (content at 800 returned an EMPTY completion).
- Fixes in lib/worker.js: content system prompt now forbids inventing prices/discounts/dates/promo mechanics (marked placeholders instead); per-type MAX_TOKENS {research 1500, content 1200, business 2000}; empty completion is treated as an error (existing guard) so it retries/falls back instead of delivering blank.
- Verified: content re-run uses "[promo: description]" placeholder, 419 tokens, 1.5s; business completes at 1504/2000 with a clean ending; research clean at 983 tokens.

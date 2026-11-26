# AgentDesk (working name) — Pi Next Hackathon 2026 flagship app

A Pi App where Pioneers sign in with **Pi Authentication only** and hire an AI
agent for digital tasks, paying a fixed price **in Pi only**, per task.

Task types (MVP): Research Summary (1 Pi) · Content Draft (0.5 Pi) ·
Business Pack (1.5 Pi). Prices live in one place: `config.js` → `taskTypes`.

> Status: **MVP skeleton, fully runnable in demo mode.** No real Pi
> credentials exist yet — nothing here has been registered anywhere.

## Architecture

```
Pi Browser / PiNet / regular browser
        │
        ▼
┌──────────────────────────── frontend (public/) ────────────────────────────┐
│ index.html + app.js (vanilla JS) + style.css                               │
│ - Landing/catalog renders with NO SDK call (PiNet-safe)                    │
│ - Pi.init + Pi.authenticate(['username','payments']) only on user action   │
│ - Pi.createPayment(...) with metadata { taskId }                           │
│ - DEMO MODE when window.Pi is absent: fake auth + fake payment sheet       │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │  our REST API (Bearer session token)
                                 ▼
┌──────────────────────────── backend (server.js) ───────────────────────────┐
│ POST /api/verify             Bearer accessToken -> GET api.minepi.com/v2/me│
│ POST /api/tasks              create order (status: awaiting_payment)       │
│ GET  /api/tasks?user=<uid>   my tasks (session is authoritative)           │
│ GET  /api/tasks/:id          status polling                                │
│ POST /api/payments/approve   verify amount/metadata vs order, then         │
│                              POST /v2/payments/:id/approve   (Key auth)    │
│ POST /api/payments/complete  POST /v2/payments/:id/complete {txid}         │
│                              -> mark paid ONCE -> enqueue agent worker     │
│ POST /api/payments/cancelled user cancelled / payment errored              │
│ GET  /api/config             sandbox flag + catalog for the frontend       │
│ GET  /validation-key.txt     domain ownership validation (keep forever)    │
│ lib/store.js   JSON-file task store (data/tasks.json)                      │
│ lib/piapi.js   Pi Platform API client (Bearer vs Key auth kept separate)   │
│ lib/worker.js  STUB agent worker + TODO seam for the real LLM provider     │
└────────────────────────────────────────────────────────────────────────────┘
```

Payment integrity rules (from the tech plan, enforced in `server.js`):
- Work is delivered **only after** our backend confirms completion
  server-side — never on a frontend signal alone.
- Approve/complete are **idempotent** (the SDK retries callbacks ~every 10s);
  delivery is guarded by `task.developerCompleted`, so it happens exactly once.
- Before approving, the backend fetches the payment from the Platform API and
  checks the **amount and `metadata.taskId`** against the order.
- `/api/payments/complete` also serves the **incomplete-payment path**: the
  SDK's `onIncompletePaymentFound` fires before `Pi.authenticate` resolves, so
  there is no session — that route then authorises via a server-side payment
  lookup with the Server API Key.

## Run it locally

Requires Node 18+ (uses the global `fetch`). **Zero npm dependencies.**

```bash
cd app
cp .env.example .env      # optional — with no .env / empty PI_API_KEY it runs in demo mode
node server.js            # http://localhost:3000  (PORT env to change)
```

### Demo mode (no Pi account, no credentials)
- **Backend** demo mode = `PI_API_KEY` empty: Pi API calls are simulated,
  and `POST /api/verify` accepts the literal token `demo-access-token`
  (user `demo_pioneer`). Any other token gets a 401.
- **Frontend** demo mode = Pi SDK script didn't load (any regular browser):
  a yellow DEMO banner appears, sign-in is simulated, and paying opens a
  clearly-labelled fake payment sheet. The full flow — sign in → create task
  → approve → complete → agent delivers — works end to end for screenshots
  and the demo video.
- Inside **Pi Browser / Pi Sandbox**, the same build runs the real flow.

## Environment variables (`.env`, see `.env.example`)

| Var | Meaning |
| --- | --- |
| `PORT` | Listen port (default 3000) |
| `SANDBOX` | `true` = Testnet/Staging app, `false` = Mainnet/Production |
| `PI_API_KEY` | Server API Key from the Developer Portal/Console. **Different per network.** Empty = demo mode |
| `PI_WALLET_PRIVATE_KEY` | **Not used by this backend** (U2A approve/complete needs only the API key). Placeholder name only — the real key stays in the owner's secret store |
| `SESSION_SECRET` | Signs our own session tokens |
| `DOMAIN_VALIDATION_KEY` | Value served at `/validation-key.txt` (or edit the `validation-key.txt` file) |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` | For the real agent worker — TODO seam in `lib/worker.js`, not wired yet |

## What remains (in order)

1. **Console/portal values** (owner's hands): register the Testnet app, then
   the Mainnet app (network choice is permanent — two separate apps, two API
   keys, two URLs). Put the Testnet `PI_API_KEY` in `.env`, `SANDBOX=true`.
2. **Hosting**: deploy behind HTTPS on a trademark-compliant domain (must NOT
   start with "pi"), set the Production/Staging URLs in the portal, serve
   `/validation-key.txt` with the issued key and verify the domain.
   Testnet and Mainnet apps need distinct URLs (e.g. `staging.` subdomain).
3. **Real LLM wiring**: implement `generateWithLLM()` in `lib/worker.js`
   (provider config already plumbed), add per-user rate limits + cost caps.
4. **App wallet / Incoming Multisig Wallet** application for Mainnet U2A
   payments (owner; Core Team review "can take time" — file early).
   The wallet private key is the owner's custody item and is unrecoverable.
5. **PiNet**: after Ecosystem listing, register the PiNet subdomain in the
   portal checklist. The landing page is already PiNet-safe (no SDK call on
   load; auth only on "Hire agent").
6. **Submission package**: English name/description, trademark-safe logo,
   preview screenshots, privacy policy (draft is in the page footer — review
   before launch), demo video ≤ 3 min showing Pi sign-in + Pi payment working.
7. **Production proof**: one real end-to-end U2A payment on the Mainnet app
   before submitting (per the official Production checklist).

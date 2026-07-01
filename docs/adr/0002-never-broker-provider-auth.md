# ADR 0002 — Never broker provider auth

- **Status:** Accepted (2026-07-01)
- **Context:** The product hosts AI coding-agent CLIs. There are two ways to give users
  AI: (a) the app brokers/pools provider access (accounts, subscriptions, or keys pass
  through *our* servers), or (b) the app only launches the official CLIs, which each
  authenticate the user's own account locally.

## Decision

**We only ever do (b).** The app hosts the official first-party CLIs as subprocesses;
each CLI performs its own authentication (subscription or API key) on the user's machine.
We never store, proxy, pool, resell, or meter provider credentials or usage.

## Rationale

- **Legal / ToS.** Anthropic, OpenAI, and Google have all enforced against third-party
  apps that reuse *subscription* auth: Anthropic blocked subscription use in third-party
  tools (e.g. OpenClaw, enforced 2026-04-04); Google banned Gemini token-proxying; past
  reverse-engineered ChatGPT clients (revChatGPT) had user accounts terminated. Hosting
  the **official CLI** — which the vendor ships and authenticates — is exactly how a
  terminal is meant to run those tools, and sidesteps all of it.
- **Trust & simplicity.** No account, no backend, no credit ledger, nothing to leak. The
  user's keys never leave their machine.
- **It is also our positioning:** "Your keys, your CLIs — no subscription to us."

## Consequences

- "Multi-profile / account switching" (a later feature) must mean **orchestrating which
  CLI profile/env is active**, never holding provider secrets. Keep this boundary crisp
  in both code and marketing copy.
- First-party hook integrations (e.g. Claude Code `SessionStart` hooks) must carry
  **no** credentials — only local notify signals.
- We forgo any revenue model based on marking up AI usage. Monetization, if any, must
  come from the app/experience, not from being an AI middleman.

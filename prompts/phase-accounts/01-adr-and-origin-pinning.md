The paid tier starts at the STANCE and the one open bypass, not the login
button. Codify ADR 0016, then slam the door the audit flagged: an env var
must never be able to repoint where a shipped build talks to our servers.
Zero UI, zero account code yet — this is the doctrine + the prerequisite.

## Steps
1. **ADR 0016 — accounts & entitlements** (`docs/adr/`): our account is OUR
   credential, NOT a brokered provider login — ADR 0002 stands verbatim
   (Claude/Codex/Gemini still self-authenticate; no provider token ever
   enters this process). The freemium boundary: the free local core needs
   no account and works fully offline — gating applies to PAID features
   only. Custody: tokens rest only as `safeStorage` ciphertext or in
   memory, decrypt at the single point of use, NO IPC channel returns a
   token (extends 8/08 write-only). The offline-grace law: a cached
   entitlement is honored 7–30 days past fetch, then degrades to Free —
   never bricks. Enforcement honesty: local checks are UX; real teeth are
   hardware binding + server-side value. Explicitly forbid: any account
   requirement on the free path; any provider-credential handling; a token
   getter on any channel.
2. **Close `MOGGING_REGISTRY_BASE`** (`backend/features/integrations/
   catalog.ts:145`): remove the env override entirely. The catalog origin
   — and the future entitlement/IdP/update origins — become IN-CODE
   constants, not env-readable (`src/backend/core/origins.ts`, a single
   frozen table). A shipped build must talk to exactly one place, decided
   at build time.
3. **Extend the prod-artifact banlist** (`scripts/check-prod-artifact.mjs`):
   add `MOGGING_REGISTRY_BASE` and the reserved `MOGGING_ENTITLE_BASE` /
   `MOGGING_IDP_BASE` / `MOGGING_UPDATE_BASE` names to the forbidden-trigger
   set, so a reintroduction fails the build the way the harness triggers
   already do (electron.vite.config.ts:41-56).
4. **Extend the credential-wording gate** (`scripts/check-credential-
   wording.mjs`): retire the now-conditional absolutes ("no account", "no
   server", "no subscription to us") from copy that a paid tier makes
   untrue, the way ADR 0014 grew the gate (docs/adr/0014:166-173). The
   phrase "your keys, your CLIs" stays true and is allowed.
5. **ORIGINPIN static gate** (`scripts/`, wired into qa-smokes.sh docs):
   assert (a) no `process.env.MOGGING_*_BASE` read exists in shipped
   backend/main; (b) `origins.ts` is the only origin source and is frozen;
   (c) the banlist + wording gate both bite (sabotage-and-revert proof).
   Verdict `out/originpin-result.json`.

## Files
- `docs/adr/0016-accounts-and-entitlements.md` · `src/backend/core/origins.ts`
  · `backend/features/integrations/catalog.ts` · `scripts/check-prod-artifact.mjs`
  · `scripts/check-credential-wording.mjs` · `scripts/check-originpin.mjs` ·
  `scripts/qa-smokes.sh` (new row)

## Definition of Done
- ORIGINPIN green; the sweep count grows by one in the books.
- ADR 0016 states every stance above; the freemium boundary is explicit.
- `MOGGING_REGISTRY_BASE` is gone from the codebase; no env can repoint a
  shipped build's origins.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (AUDIT · SPACING ·
  PTYSEAM · PROTOVER — protocol v9); full local sweep including the new gate.

## Guardrails
- Zero account code, zero UI this step — doctrine + the bypass fix only.
- ADR 0002 untouched and restated; no provider credential surface added.
- Zero new deps; zero network; the daemon untouched (protocol stays v9).

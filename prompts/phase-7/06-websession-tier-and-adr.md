The sharpest class: `web-session` — providers with NO CLI and NO API key,
only a browser login (Cursor, Devin, Perplexity, Kimi, Mistral spend, …
~20 CodexBar rows). Reading a browser's cookie store crosses a line ADR
0002 drew, so this class ships behind its OWN ADR + consent — paste-first,
store-read strictly opt-in. Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **ADR 0007.b — usage may read a browser session, on purpose**
   (`docs/adr/`): a companion to ADR 0007 and the usage-only cousin of the
   PARKED agent-web Branch B (phase-10). Defines precisely: (a) DEFAULT is
   manual cookie-header/token PASTE — stored via 0007.a's keychain path
   (ciphertext only, WRITE-ONLY: replace/delete, never viewed again); (b) automatic cookie-store
   READ (Chrome/Edge/Brave Safe-Storage key via the OS keychain; Safari
   needs Full Disk Access on mac) is PER-PROVIDER opt-in, default OFF, and
   READ-ONLY against a usage endpoint; (c) these sessions are NEVER exposed
   to agents (that stays parked Branch B); (d) forbidden: writing any
   browser store, reading a store for any purpose but the one usage call,
   sensitive-origin cookies. Nothing on this class ships until the ADR lands.
2. **The `web-session` class adapter**: two sources behind one interface —
   PASTE (decrypted backend-side → header on the one request) and, when the
   provider is opted in, STORE-READ (decrypt the provider's cookie for its
   domain via the platform keychain key; that ONE cookie, that ONE request,
   dropped after). Per-OS cookie-store locations in a path table; a clear
   `unconfigured` when neither source is present.
3. **Consent surface** (minimal here; 12 makes it first-class): per-provider
   "read my browser session" toggle, default OFF, honest copy naming the
   keychain touch. Paste always works without it.
4. **Ship rows** (paste-first; store-read where a keychain path exists):
   Cursor, Devin, Manus, T3 Chat, Kimi (JWT cookie), Perplexity, Xiaomi
   MiMo, Sakana, Abacus, Mistral spend, Amp, Command Code, OpenCode
   workspace, Alibaba (cookie mode), Grok (browser fallback). Each row
   declares its cookie name + usage endpoint as data.
5. **WEBUSAGE smoke** (`MOGGING_WEBUSAGE`, env-gated, in qa-smokes.sh):
   FAKE-only — a fixture "browser store" file + fixture endpoints. Assert:
   paste path normalizes; store-read path fires ONLY when opted in (off →
   the fixture keychain is never touched, provider reads `unconfigured`);
   a pasted value is ciphertext at rest, has no read-back channel, and can
   be replaced/deleted; the snapshot carries no cookie value (grep). Zero network; verdict via
   `out/webusage-result.json`.

## Files
- `docs/adr/0007b-usage-web-sessions.md` ·
  `src/backend/features/usage/classes/web-session.ts` + cookie/path tables ·
  `src/ui/features/usage/` (per-provider consent stub) ·
  `src/main/webusage-smoke.ts` · `scripts/qa-smokes.sh` (gate row) ·
  `src/main/gallery.ts` (consent states)

## Definition of Done
- One paste-based provider (Cursor via a pasted cookie header) shows usage
  in dev; one opt-in store-read provider works ONLY after the toggle,
  `unconfigured` before it — books.
- ADR 0007.b committed with all four clauses; the consent copy names the
  keychain touch plainly.
- WEBUSAGE gate green; the snapshot never carries a cookie value (grep).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new WEBUSAGE gate.

## Guardrails
- Store-read is opt-in, default OFF, per provider, READ-ONLY, one cookie one
  call — never a crawl, never a write, never agent-facing (that's Branch B,
  still parked).
- Paste-first is the headline: most users never touch the keychain path.
- Sensitive-origin cookies (bank/mail/gov) are refused even if a row named
  one (the phase-8/01 blocklist).
- Cookie values, tokens, and origins never enter telemetry (ADR 0005) —
  counts/booleans only.

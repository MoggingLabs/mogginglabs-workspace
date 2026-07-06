# ADR 0007.b — Usage may read a browser session, on purpose

- **Status:** accepted (Phase 7/06, 2026-07-06)
- **Companion to:** ADR 0007 (usage rides existing sessions) · ADR 0007.a
  (keys at rest) · the usage-only cousin of the PARKED agent-web Branch B
  (`prompts/phase-10/FINDINGS.md`)

## Context

Some providers (Cursor, Devin, Perplexity, Kimi, Mistral spend, …) have no
CLI to ride and no API key — usage lives ONLY behind a browser login. Reading
a browser's cookie store crosses the exact line ADR 0002 drew ("never touch
the user's other credential stores"), so it needs a deliberate, bounded
amendment rather than drifting in as a feature. This is the *usage-only*
sibling of the parked agent-web Branch B — same trust boundary, far smaller
blast radius (a read of one cookie for one usage call, never handed to an
agent).

## Decision

Four binding clauses:

1. **The default is manual PASTE.** The user copies a cookie header or session
   token from their browser and pastes it once. It is stored via ADR 0007.a's
   keychain path — ciphertext only, WRITE-ONLY (replace/delete, never viewed
   again, no read-back channel). Most users only ever use this path.
2. **Automatic cookie-store READ is per-provider opt-in, default OFF, and
   read-only.** When a user explicitly enables it for a provider, the adapter
   decrypts THAT provider's cookie for ITS domain via the platform keychain
   key (Chrome/Edge/Brave Safe-Storage key; Safari needs Full Disk Access on
   macOS) — that one cookie, for that one usage request, dropped after. Never
   a crawl of the store, never all cookies, never a background sweep.
3. **These sessions are NEVER exposed to agents.** Reading a usage number is
   not the same as letting an agent act as you on a logged-in site — that is
   agent-web Branch B, which stays PARKED behind its own future ADR. A cookie
   read here reaches exactly one usage endpoint and nothing else.
4. **Forbidden, absolutely:** writing to any browser store; reading a store
   for any purpose but the single usage call; reading a cookie for a
   sensitive origin (banking/mail/gov — the phase-8/01 blocklist applies here
   too, and refuses even a row that named one).

## Consequences

- Paste-first means the keychain-touching path is opt-in and rare; a user who
  never enables store-read never has the app touch their browser's vault.
- The store-read path is genuinely sensitive (it decrypts a real login
  cookie), so the consent copy names the keychain touch plainly, and the read
  is scoped to one domain's one cookie per request.
- Cookie values, tokens, and origins never enter telemetry (ADR 0005) — the
  meter shows a number; the machine keeps everything else.
- If store-read ever needed to feed an agent, that is a NEW decision (Branch
  B's ADR), not an extension of this one.

CodexBar covers ~57 providers on a handful of MECHANISMS. Match that reach
the house way: a provider is a DATA ROW, a mechanism is an adapter CLASS.
This step lays the catalog contract and ships the biggest class — read the
CLI/editor's OWN stored session (the ADR 0007 tier). Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **Provider catalog as data** (`@contracts/usage`): `UsageProviderDef {
   id, label, klass: 'cli-store'|'api-key'|'cloud-cli'|'web-session'|
   'local', homePointerEnv?, endpoint?, windows: WindowSpec[], credits?,
   verifiedAt? }`; `USAGE_PROVIDERS: readonly UsageProviderDef[]`. `windows`
   declares which lanes a provider HAS (session/weekly/monthly/daily/hourly/
   rolling) — don't invent lanes a provider lacks. One dispatch keyed by
   `klass`; adding a provider on an existing class = one row.
2. **The `cli-store` class adapter** — generalizes 7/01's Claude adapter to
   read a CLI's own store by `klass`, driven by per-provider config. Ships
   these rows first (all real, all CLI-owned sessions, ADR 0007 verbatim):
   Codex (`~/.codex`), Gemini (CLI creds + quota API), Copilot (CLI-stored
   token + usage API — NOT the app-held device flow), Zed (editor keychain
   session), Kiro, Kilo (token + CLI fallback), Augment (CLI), JetBrains AI
   (IDE XML quota), Codebuff (`~/.config/manicode/credentials.json`),
   OpenCode (local SQLite), Windsurf (local cache/SQLite). Each: known path
   only, in-memory single-request use, degrade to `unconfigured`/`error`
   with a human reason.
3. **Per-OS path tables** beside the class, one row per provider; respect
   profile pointer homes (a profile relocates a CLI's home — read the
   pointed-at one; canonical-path compare on win32, the 6/03 lesson).
   `verifiedAt` on each row is the date its endpoint/shape was dev-checked
   (the 7/01 discipline — books record the shape).
4. **Fixture parity**: the FAKE adapter grows a fixture for every state
   these rows can emit — credit balances, daily-quota windows, multi-lane
   plans, SQLite-backed, XML-backed — so the USAGE gate exercises each
   normalization path with zero network.
5. **USAGE smoke growth**: assert catalog integrity (every row has a valid
   klass + at least one window or credits; no duplicate ids), and that each
   `cli-store` fixture normalizes to a valid `PlanUsage`.

## Files
- `src/contracts/usage/` (catalog + WindowSpec) ·
  `src/backend/features/usage/classes/cli-store.ts` + per-provider config ·
  `src/backend/features/usage/fake-adapter.ts` · `src/main/usage-smoke.ts` ·
  books (verified shapes + dates)

## Definition of Done
- Codex, Gemini, and at least one editor-store provider (Zed or JetBrains)
  return normalized `PlanUsage` from a real logged-in tool in dev; all
  degrade to labeled states, never throw.
- The catalog typechecks as data; the smoke proves integrity + every
  cli-store fixture normalizes.
- USAGE gate green; sweep count unchanged (no new gate — this grows USAGE).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (adapters
  backend-only; UI sees contracts + IPC).
- Full local sweep including the grown USAGE gate.

## Guardrails
- ADR 0002/0007: KNOWN locations only, no crawling; token in memory for one
  request; never persisted, logged, copied, or shown.
- StepFun-style username+password login is OUT (that brokers auth — ADR
  0002); app-held device flows are OUT (deferred, ADR 0008.d). A provider
  reachable ONLY those ways does not ship on this class.
- The FAKE adapter stays first-class — every new row needs a fixture before
  it counts.
- No new daemon wire surface (protocol stays v3).

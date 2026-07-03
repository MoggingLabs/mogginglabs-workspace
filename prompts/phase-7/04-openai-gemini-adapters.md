One seam, more providers: OpenAI/Codex and Gemini adapters on the exact
interface the Claude adapter proved — plus the authoring guide that makes the
NEXT adapter a contribution, not a project. Zero UI changes; the popover just
grows tiles.

## Steps
1. **Codex/OpenAI adapter**: read the Codex CLI's config home (auth/session
   file; per-OS path table like Claude's), fetch the plan's rate-limit /
   usage state (session + weekly lanes where the plan exposes them; credits
   for credit-based plans), normalize to `PlanUsage`. Same degradation ladder:
   no CLI → `unconfigured`, logged-out/expired → `error` with human reason.
2. **Gemini adapter**: same shape against the Gemini CLI's credential store
   and its quota surface; map whatever windows the plan actually has (daily
   request quotas normalize as a window with its own reset) — the contract's
   `windows[]` is the flex point, DON'T invent lanes a provider lacks.
3. **Per-OS path resolution**, one table per adapter beside its code:
   Windows (`%USERPROFILE%`/`%APPDATA%` forms), macOS (`~/`), Linux
   (`~`/XDG). Respect profile pointer homes (a profile can relocate a CLI's
   home — the adapter reads the pointed-at home, mirroring "switchable
   accounts without copying credentials"). Canonical-path discipline from the
   6/03 lesson: compare realpathed forms on win32.
4. **Fixture parity**: extend the FAKE adapter's fixture set so every state
   the two new adapters can emit exists as a fixture (credit balances,
   daily-quota windows, multi-lane plans). The USAGE smoke's assertions grow
   with them.
5. **Adapter authoring guide** (`docs/12-usage.md` § "Writing an adapter"):
   the interface, the degradation ladder, the fixture requirement (an adapter
   PR without fixtures is incomplete), the ADR 0007 rules, and the per-OS
   path table template. CodexBar ships 50+ providers on this exact pattern —
   the guide is what makes that ceiling reachable here.

## Files
- `src/backend/features/usage/adapters/` (codex.ts, gemini.ts + path tables) ·
  fake-adapter fixture set · `src/main/usage-smoke.ts` (grown assertions) ·
  `docs/12-usage.md` (§ authoring guide seed)

## Definition of Done
- All three real adapters (Claude, Codex/OpenAI, Gemini) return normalized
  `PlanUsage` from a logged-in CLI in dev, and degrade to labeled states —
  never throws — when absent/logged-out/expired.
- Every adapter state has a FAKE fixture and a smoke assertion.
- The authoring guide is complete enough that a fourth adapter needs no
  spelunking (interface, ladder, fixtures, paths, ADR rules).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep (USAGE + USAGEUI gates on the grown fixture set).

## Guardrails
- ADR 0007 verbatim: in-memory single-request token use; known locations
  only; nothing written into any CLI's home, ever.
- Normalize, don't editorialize: if a provider has no weekly lane, the
  contract carries what exists — the pace engine and UI already handle
  missing windows.
- Rate-limit courtesy per provider: independent cadences, jittered, backoff;
  a 429 from a usage endpoint is a `stale` state, not a retry storm.
- Smokes stay network-free — real adapters are dev-verified manually and
  exercised structurally through fixtures.

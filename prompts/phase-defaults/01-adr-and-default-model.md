A provider has many accounts (profiles), each with its OWN config home; a setting saved
to one never reaches another. Introduce a **provider-level default tier** in the
desired-state model so a value can be authored ONCE and apply to every account — while
leaving room for per-account exceptions. This step is model + persistence only; the
engine that resolves and writes lands in step 02.

## Steps
1. **ADR 0022** (`docs/adr/0022-shared-account-defaults.md`; take the next free number,
   deconflict on land): shared account defaults extend the config control plane (ADR
   0011) and follow profile identity like sessions do (ADR 0013). State the resolution
   law verbatim — `pin(P,S) ?? accountDefault(S) ?? file` — and the three doctrines:
   shared-by-default, primary-home-is-a-full-member, ADR-0002-non-secret. Cross-link 0011/0013.
2. **Model** (`src/contracts/domain/agent-settings.ts`): add `tier: 'default' | 'pin'` to
   `AgentConfigOverrideRecord` (optional; absent ⇒ legacy scoped override, unchanged). A
   `'default'` row is keyed by `(provider, settingId)` with a sentinel `targetId` (`'__all__'`)
   — NO scope-home of its own; a `'pin'` row keeps `targetId = profileId`. Do NOT widen the
   `AgentConfigScope` union — the tier is orthogonal to the real provider layers it compiles into.
3. **Persistence** (`getSettingsStore()` in `src/main/app-settings.ts`): add
   `listAccountDefaults(provider)`, `saveAccountDefault(record)`, `removeAccountDefault(provider,
   settingId)` on the same better-sqlite3 store that holds profiles + overrides (one table or a
   `tier` column — your call; migrate additively). Sanitize on save with the SAME deny-list the
   pointer-env path uses: a default `desiredValue` that LOOKS like a secret (key/token/JWT shape)
   is REFUSED at the boundary, not just discouraged. Values never enter telemetry.
4. **Smoke** (`MOGGING_DEFAULTSTORE`, `src/main/smokes/defaultstore-smoke.ts`): isolated boot →
   `saveAccountDefault` for a FAKE provider, setting S = "X" → `listAccountDefaults` round-trips
   it → `saveAccountDefault` with a secret-shaped value (`sk-live-…`) is REFUSED → `removeAccountDefault`
   clears it → the row is JSON-safe (no path/secret in the serialized record). Result JSON + a
   `scripts/qa-smokes.sh` entry; bump `scripts/check-gate-count.mjs` (+1).

## Files
- `docs/adr/0022-shared-account-defaults.md`
- `src/contracts/domain/agent-settings.ts` (the `tier` field)
- `src/main/app-settings.ts` (`getSettingsStore()` default-tier methods + migration)
- `src/main/smokes/defaultstore-smoke.ts` · `scripts/qa-smokes.sh` · `scripts/check-gate-count.mjs`

## Definition of Done
- A provider-level default record round-trips through the store; a secret-shaped default value
  cannot be saved; legacy scoped overrides deserialize unchanged (additive migration).

## Checks that must be green
- `npm run typecheck` → 0; build ok; `MOGGING_DEFAULTSTORE` green isolated; existing
  `MOGGING_AGENTSETTINGS` still green (migration didn't disturb scoped overrides).
- Gate-count check passes with the new total.

## Guardrails
- ADR 0002 is the hard line: defaults hold NAMES and NON-secret values; the deny-list makes a
  secret default impossible at the persistence boundary.
- Additive migration only — no existing `AgentConfigOverrideRecord` row changes meaning; `tier`
  absent still means "scoped override" exactly as today.
- The `'default'` tier is data only here: it resolves and writes NOTHING until step 02.

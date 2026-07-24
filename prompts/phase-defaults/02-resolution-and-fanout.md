The default tier exists in the store (step 01) but changes nothing yet. Make it real:
**resolve** each account's effective value and **fan the resolved value out into every
account's config home** for the provider — the default profile's real `~/.claude`
included. This is the heart of the phase.

## Steps
1. **Resolution** (`src/main/agent-settings.ts`): a pure function
   `resolveDefault(provider, profileId, settingId) = pin(profileId, settingId) ??
   accountDefault(settingId) ?? undefined` (undefined ⇒ fall through to the account's own
   file value). It reads the two tiers from `getSettingsStore()`; it never touches a file. Unit-test
   the precedence table directly.
2. **Enumerate homes**: `providerHomes(provider)` = every `store.listProfiles()` entry for that
   provider, INCLUDING the default profile whose home is the plain `user` scope (`~/.claude`) — it
   is a full member, not an exception. Each home already has a resolved `AgentConfigTarget` via the
   existing `resolveContext` (scope `profile` for pointer homes, `user`/`default` for the primary).
3. **Fan-out apply** (`applyAccountDefaults(provider)`): for each home, compute
   `resolveDefault(...)` per setting that has a default OR a pin, and drive the EXISTING
   enforce path (the same write+drift machinery scoped writes use) so each home's file carries its
   resolved value. Reuse enforcement wholesale — the new code decides WHAT each home should hold, not
   HOW it's written. Run async/post-paint/debounced; never on the boot critical path.
4. **Precedence wiring**: in the snapshot/effective computation, the account-default sits just
   above the file value and below a pin, and the whole tier sits below `session/project/local` —
   a per-project setting still wins. The scope picker's "effective" column must reflect a
   default-sourced value with an honest source label (e.g. "Account default").
5. **Smoke** (`MOGGING_PROFILEDEFAULTS`, `src/main/smokes/profiledefaults-smoke.ts`): isolated boot →
   two FAKE-provider profiles (homes tmpA/tmpB) + the primary/user home → `saveAccountDefault(S=X)`
   → `applyAccountDefaults` → assert tmpA's file, tmpB's file, AND the primary home's file all carry
   X → save a PIN S=Y on profile A → re-apply → assert home A = Y, home B = X, primary = X → the
   snapshot's `effective` for B labels the source "Account default". Result JSON + qa-smokes entry;
   `check-gate-count.mjs` +1.

## Files
- `src/main/agent-settings.ts` (`resolveDefault`, `providerHomes`, `applyAccountDefaults`, precedence)
- `src/main/smokes/profiledefaults-smoke.ts` · `scripts/qa-smokes.sh` · `scripts/check-gate-count.mjs`

## Definition of Done
- One `saveAccountDefault` reaches every account home for the provider, primary included; a pin
  overrides in exactly one home and leaves the others on the default; the effective source is honest.

## Checks that must be green
- `npm run typecheck` → 0; build ok; `MOGGING_PROFILEDEFAULTS` green isolated; `MOGGING_DEFAULTSTORE`
  + `MOGGING_AGENTSETTINGS` + `MOGGING_PROFILES` still green.

## Guardrails
- The primary `~/.claude` is a full member — no code path exempts it from the fan-out.
- Reuse the enforce machinery; do NOT fork a second writer (drift/ownership stay one implementation).
- Async/post-paint/debounced apply — the fan-out never enters the boot path or the render loop.
- Setting values never enter telemetry; only counts of managed defaults may (ADR 0005).

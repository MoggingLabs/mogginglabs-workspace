The engine is live; now give it a face. In the existing agent-settings screen, each
setting gains a shared-by-default control, a way to pin one account, a nudge to promote
values that already agree, and — the honesty beat — a one-time announcement the first
time a change reaches across accounts. Reuse the screen; add no second settings home.

## Steps
1. **Scope-of-effect control** (`src/ui/features/settings/agent-config.ts`, `settingRow`): beside the
   existing "On drift" select, add an "Applies to" control — **All accounts** (default selection,
   the shared-by-default posture) vs **This account only**. Choosing "All accounts" writes/updates the
   `tier:'default'` record on Save; choosing "This account only" writes a `tier:'pin'` for the profile
   currently in the scope picker. The control is present only for a provider that has ≥1 profile and a
   catalog key that supports the profile/user scopes.
2. **Reset to default**: on a key that carries a pin, show a quiet **Reset to default** action
   (mirrors the existing "release" affordance) that clears the pin so the key inherits the shared
   value live. When a default exists, the row shows its inherited value with an "Account default"
   source label (from step 02's snapshot).
3. **Smart-promote chip**: when a key has NO default and the app observes ≥2 of the provider's homes
   already holding the same value, render an inline chip — "All N accounts use X — make this the
   default?" — that on click saves the `tier:'default'` = X. Cheap heuristic off the snapshot; never
   auto-applies.
4. **First-write consent (the honesty beat)**: the first time a Save would enforce a key across
   accounts (i.e. into a shared/primary home), show a one-time `confirmDialog` with `rememberKey`:
   "This now manages <setting> across all N of your <provider> accounts, including your primary
   ~/.claude. Drift will be restored; pin an account to differ." Proceed only on confirm; remember the
   choice per provider.
5. **Smoke** (`MOGGING_DEFAULTSUX`, `src/main/smokes/defaultsux-smoke.ts`): renderer boot with a
   two-profile FAKE provider → the "Applies to" control renders and DEFAULTS to All accounts →
   choosing "This account only" then Save shows the pin + a Reset action → forcing two homes to share
   a value surfaces the promote chip, and clicking it creates the default → the first cross-account
   Save shows the consent dialog once, not twice. Result JSON + qa-smokes entry; `check-gate-count.mjs` +1.

## Files
- `src/ui/features/settings/agent-config.ts` (`settingRow`: Applies-to, Reset, promote chip, consent)
- `src/main/smokes/defaultsux-smoke.ts` · `scripts/qa-smokes.sh` · `scripts/check-gate-count.mjs`

## Definition of Done
- Every setting can be shared (default) or pinned (this account only) from the existing screen;
  a pin can be reset; agreeing values can be promoted in one click; the first cross-account write is
  announced once.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static AUDIT + SPACING `--max 0` green; `MOGGING_DEFAULTSUX` green.
- **MILESTONE + PERCEPTION re-measured, numbers UNCHANGED** (this step touches the renderer).

## Guardrails
- One settings home — extend `settingRow`, do not add a parallel "defaults" screen.
- Shared-by-default: the "Applies to" control defaults to All accounts; pinning is the deliberate act.
- The consent is once-per-provider (`rememberKey`), honest about the primary home, never a nag.
- The promote chip only SUGGESTS; it never writes a default without a click.

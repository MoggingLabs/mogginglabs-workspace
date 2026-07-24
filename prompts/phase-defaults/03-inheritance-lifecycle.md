Step 02 makes a default land in every home once. Now make the tier LIVE: a default that
changes re-reaches every unpinned home, a new account adopts the current defaults, a
hand-edit that drifts is restored, and a pin can be cleared back to inheriting. This is
the "intelligent" behavior — the reason the feature exists.

## Steps
1. **Live propagation**: `saveAccountDefault`/`removeAccountDefault` (and pin save/clear) trigger a
   debounced `applyAccountDefaults(provider)`. Changing a default from X→Z re-enforces Z into every
   home whose key is NOT pinned; a pinned home holds its pin. Removing a default lets each home fall
   back to its own file value (release the managed key, keep the last value — do not blank it).
2. **New-account auto-adopt** (`src/main/profiles.ts`): profile create/edit and the login-reconcile
   path already `announceProfilesChanged()`; hook `applyAccountDefaults(provider)` off the same
   signal so a NEW or newly-detected account inherits all current defaults immediately — no per-account
   opt-in. A brand-new home with no defaults yet is a no-op.
3. **Keep-in-sync drift**: the existing enforce/drift detector, now driven per-home by
   `resolveDefault`, restores a hand-edited default key to its resolved value on the next reconcile
   tick; a hand-edited PINNED key restores to the pin. A key with neither default nor pin is left
   entirely alone (the CLI's own value is untouched).
4. **Pin & reset-to-default**: saving a pin is `tier:'pin'` on that profile; "reset to default" is
   `removeAccountDefault`'s pin sibling — remove the pin row so `resolveDefault` falls through to the
   account-default LIVE (the home re-enforces to the shared value on the next apply). Expose both as
   store verbs the UI (step 04) calls; no UI here.
5. **Smoke** — EXTEND `MOGGING_PROFILEDEFAULTS` (`profiledefaults-smoke.ts`) with four bites, same
   isolated two-profiles+primary fixture: (a) change default X→Z → every unpinned home = Z, pinned
   home A = Y; (b) add a THIRD profile → it inherits Z on the announce; (c) hand-edit home B's file to
   W → next reconcile restores Z; (d) clear A's pin → home A re-inherits Z. No new gate id — the
   pack's functional gate grows its assertion set (note it in the smoke header; count unchanged).

## Files
- `src/main/agent-settings.ts` (debounced re-apply, release-keeps-value, reset verb)
- `src/main/profiles.ts` (auto-adopt off `announceProfilesChanged`)
- `src/main/smokes/profiledefaults-smoke.ts` (four lifecycle bites)

## Definition of Done
- Editing a default propagates to every unpinned home; a new account adopts current defaults on
  appearance; a drifted default key is restored; clearing a pin re-inherits the default live.

## Checks that must be green
- `npm run typecheck` → 0; build ok; `MOGGING_PROFILEDEFAULTS` green isolated with all lifecycle
  bites; `MOGGING_PROFILES` (its own switch/failover assertions) still green.
- Gate-count unchanged (this step extends an existing gate, adds none).

## Guardrails
- Live inheritance is per-KEY: a pin never freezes a whole account — every unpinned key keeps tracking.
- Removing a default or a pin RELEASES the key (keep its last value); it never blanks a real CLI file.
- Auto-adopt rides the profiles-changed signal — one debounced apply per change, never a loop.
- The primary home follows every lifecycle rule the others do (no exemption).

Two subscriptions in parallel is a first-class workflow: workspace A on the `Work`
profile, workspace B on `Personal`. The wizard picker makes that TRUE at launch — but
`profileIds` are launch-time-only today, so an app restart silently relaunches every
restored workspace on the DEFAULT profile (order 0). Make the per-slot profile choice
a PERSISTED part of the workspace manifest, like `paneCwds`/`roles`/`remotes` already
are — and keep it truthful through failover.

## Steps
1. **Persist the manifest slot** (the exact `paneCwds` pattern):
   `WorkspaceStateMeta += profileIds?: (string | null)[]` (contracts);
   `pane_profile_ids TEXT` column (try/catch ALTER + SELECT/INSERT round-trip in
   `settings-store.ts`); `persist()` includes `m.profileIds`; restore passes them to
   `controller.create` — `launchLineup(resume: true)` already reads
   `meta.profileIds?.[i]`, so restored lineups relaunch under the CHOSEN profile.
   Update the `model.ts` comment (no longer "launch-time only").
2. **Failover updates the manifest**: when usage-limit failover relaunches a pane on
   the next profile (agents feature `doFailover`), the WORKSPACE's manifest must
   follow — otherwise the next restart resurrects the capped profile. Add a small
   ui-core port callback (`onProfileFailover(paneId, profileId)` or reuse the
   launch-port shape) that the workspace feature services: locate the pane's
   workspace + slot (`ordinal*100+slot`), set `meta.profileIds[slot-1]`, persist.
   No cross-feature imports — port only.
3. **Surface the truth**: the pane ⋯ menu gains a read-only note when the launch
   carried a profile — "Profile: Work" (profile NAME on the pane-meta port, set at
   launch). A menu note, not header chrome — the header is full.
4. **Stale-profile hygiene**: a persisted `profileId` whose profile was deleted in
   Settings must degrade to the provider default silently (the main-side command
   handler already returns default env for unknown ids — ASSERT that, don't assume).
5. **Smoke** (`MOGGING_PROFPERSIST`, two-phase like TEMPLATE A/B — reused state dir):
   - **Phase A**: save two profiles (markers `PROFILE_A_4242`/`PROFILE_B_4242` in a
     `FAKE_MARK` pointer var, provider `gemini`); open a workspace whose spec picks
     profile B for slot 1; assert the pane env echoes B's marker; exit cleanly.
   - **Phase B** (fresh app, SAME state): restore relaunches → poll the pane buffer
     for B's marker (NOT A's — the default would be A/order 0); then delete profile
     B via the channel + one more restart-equivalent relaunch (dev handle) → the
     launch degrades to default WITHOUT error (step 4). qa-smokes entry (A then B,
     reuse pattern from TEMPLATE).

## Files
- `src/contracts/ipc/workspace.ipc.ts` · `src/backend/features/workspace/
  settings-store.ts` · `src/ui/features/workspace/index.ts` + `model.ts`
- `src/ui/core/agents/` (failover port) · `src/ui/features/agents/index.ts` ·
  terminal-pane menu note + pane-meta port
- `src/main/profpersist-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Workspace A on `Work` and workspace B on `Personal` come back on THOSE profiles
  after a full app restart — including a profile switched by failover.
- Deleting a profile never breaks a restore; it degrades to the default, silently.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_PROFPERSIST` A/B green isolated; `MOGGING_PROFILES` + TEMPLATE A/B still
  green (same store + restore machinery).

## Guardrails
- Persist PROFILE IDS only — never env values (they stay main-side; ADR 0002
  unchanged). The pane menu shows the profile NAME, nothing from `env`.
- Failover manifest updates are one-hop, like failover itself: no persistence churn
  loops (persist once per failover event, debounced with the existing persist()).
- One new column only; the migration is a no-op on dbs that already have it.

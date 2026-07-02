Power users run multiple provider accounts (work/personal, several API orgs) and hit
usage limits mid-flight. Add **named profiles** — pointer sets, never secrets — and
**usage-limit failover**: when an agent reports the limit, relaunch it on the next
profile with one click (or automatically, opt-in per workspace).

## Steps
1. **Model** (`src/contracts/ipc/profiles.ipc.ts`): `AgentProfile { id, name,
   provider, env: Record<string,string>, order }` where `env` values are DIR/FILE
   POINTERS or non-secret flags (e.g. `CLAUDE_CONFIG_DIR=~/.claude-work`) — a
   validation deny-list refuses values that LOOK like secrets (key/token/JWT shapes
   from 3/04's redaction module, reused). `ProfileChannels = { list, save, remove }`.
2. **Persistence + main**: `app_profiles` table in the settings store (same
   better-sqlite3 mechanism as the board); `src/main/profiles.ts` binds the channels;
   sanitize on save (shape + deny-list + env-name allowlist `^[A-Z][A-Z0-9_]{2,40}$`).
3. **Launch integration** (`src/backend/features/agents/launch.ts`): launch command
   optionally prefixed with per-profile env (platform-aware: `set X=… &&` / `X=… `).
   `AgentLaunchRequest += profileId?`. Wizard Agents step + pane-menu launch entries
   gain a profile picker when >1 profile exists for the provider (default = order 0).
4. **Failover**: `notifyEventToState` already maps events; add `usage-limit` →
   attention + a typed side-channel `terminal:limit` to the renderer. The agents
   feature offers a toast: "Limit on <profile>. Relaunch on <next>?" → kill + relaunch
   the SAME pane's CLI under the next profile (same cwd/worktree, `--resume` where
   supported). Per-workspace opt-in `autoFailover` makes it automatic. Hook docs:
   agents' hooks fire `mogging notify --event usage-limit`.
5. **Smoke** (`MOGGING_PROFILES`): isolated boot → save two fake profiles for a fake
   provider (env pointer `FAKE_HOME=<tmpA|tmpB>`) → launch a SHELL-provider pane
   under profile A → assert the pane env saw `FAKE_HOME=tmpA` (echo it) → fire
   `mogging notify --event usage-limit` in-pane → toast action → relaunch → pane env
   shows `FAKE_HOME=tmpB` → attempting to save a profile with `FAKE_KEY=sk-…` is
   REFUSED. Result JSON + qa-smokes entry.

## Files
- `src/contracts/ipc/profiles.ipc.ts` + channels · settings-store table ·
  `src/main/profiles.ts` + `src/main/index.ts`
- `src/backend/features/agents/launch.ts` · wizard/pane-menu picker · notify mapping
- `src/main/profiles-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Two profiles switch a real launch's environment; a usage-limit event relaunches on
  the next profile (manual toast + opt-in auto), same pane, same worktree; secret-
  looking env values cannot even be SAVED.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_PROFILES` green isolated; `MOGGING_AGENTLAUNCH` + `MOGGING_NOTIFY` still green.

## Guardrails
- ADR 0002 is the hard line: profiles hold NAMES and POINTERS. The app never reads,
  stores, copies, or echoes a credential; the deny-list makes the mistake impossible
  at the persistence boundary, not just discouraged.
- Failover kills/relaunches ONLY the affected pane's CLI, never the shell/PTY itself
  (scrollback survives); it never retries in a loop (one hop per event).
- Profile names/env keys may appear in telemetry as COUNTS only; values never.

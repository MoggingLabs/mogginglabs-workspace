The fleet shouldn't end at this machine. Make an **SSH pane** a first-class pane: the
daemon spawns `ssh <host>` as the pane process, the UI shows WHERE the pane lives, and
everything that can't work remotely degrades gracefully instead of lying.

## Steps
1. **Model** (`src/contracts/ipc/remotes.ipc.ts`): `RemoteHost { id, name, host,
   user?, port?, identityHint? }` — connection POINTERS only (the user's ssh config/
   agent does auth; we never touch keys or passwords). `RemoteChannels = { list,
   save, remove }`; `app_remotes` table (settings store); `src/main/remotes.ts`.
2. **Spawn path**: `PaneSpawnSpec += remote?: { hostId }` (contracts + daemon
   protocol — reuse v3). The daemon resolves the host row passed IN THE SPEC (the
   daemon stays db-free) and spawns `ssh -tt [-p port] [user@]host` as the pane's
   process instead of the local shell. Exit of ssh = pane exit (existing semantics).
   `PaneInfo += remoteName?` for `mogging list`.
3. **Graceful degradation, honestly surfaced**: for remote panes — git chip hidden
   (local probe would lie about a remote cwd), cwd tracking uses OSC 7 only (remote
   shells that emit it work; others show the host), worktree isolation + review are
   DISABLED in the UI with a plain reason ("remote pane — local repo tools are off").
   A `.pane-remote` chip (host name, distinct tint) sits next to the state dot.
   OSC state/notify/mail all work UNCHANGED when `mogging` is installed remotely and
   `MOGGING_DAEMON_ENDPOINT` is forwarded — document the one-liner in `docs/09`.
4. **Wizard/board**: the Start step's folder input accepts a remote target instead
   (host picker + remote cwd string, mutually exclusive with the local folder);
   workspaces can MIX local and remote panes (per-slot `remote` in the template
   spec, same pattern as `paneCwds`).
5. **Smoke** (`MOGGING_REMOTE`): no real network — spawn against a FAKE `ssh` shim
   (a script on PATH via the smoke's env that execs the local shell and prints
   `SSH_SHIM host=<argv>`): isolated boot → workspace with 1 local + 1 remote pane →
   assert: shim argv carried host/port/user; `.pane-remote` chip renders the host
   name; git chip absent on the remote pane, present on the local one; `mogging list`
   shows `remoteName`; pane exit on shim exit. Result JSON + qa-smokes entry.

## Files
- `src/contracts/ipc/remotes.ipc.ts` + channels · settings-store table ·
  `src/main/remotes.ts` + `src/main/index.ts`
- `src/contracts/daemon/protocol.ts` (spawn spec) · `src/pty-daemon/session.ts`
- terminal-pane chip + wizard Start step + template spec · `docs/09-swarm.md` (remote §)
- `src/main/remote-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- A workspace mixes local and remote panes; the remote pane is visibly remote, works
  as a terminal end to end, and every local-only affordance is disabled WITH a reason
  — no silent wrongness (a hidden chip beats a wrong branch).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_REMOTE` green isolated; `MOGGING_SMOKE` + `MOGGING_GIT` still green.

## Guardrails
- BYO-auth extends to SSH (ADR 0002): keys, passphrases, and known_hosts belong to
  the user's ssh stack. We pass flags; we never prompt for, store, or forward secrets.
- Host names are user data: local db + pane chip only — never telemetry (counts fine).
- Never parse remote shell output to infer state — OSC or nothing (ADR guardrail).

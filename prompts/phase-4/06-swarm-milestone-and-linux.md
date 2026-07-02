Prove Phase 4 as ONE asserted flow — *"a swarm shares a repo through the mailbox and
the ledger, and nothing lands without the reviewer"* — freeze the sweep, and open the
third platform: Linux.

## Steps
1. **Smoke** (`MOGGING_SWARMMILESTONE`, two-phase like 2/05 and 3/06):
   - **Phase A — the swarm.** Isolated boot + temp repo → swarm template: 2 workers +
     1 reviewer (shell provider — deterministic) in worktrees, roles set → worker 1
     claims `src/a/**`, worker 2's overlapping claim is DENIED → workers exchange a
     mailbox handshake (`PING`/`ACK` markers asserted via `mail read`) → each worker
     commits a change in ITS claimed area (scripted `mogging send`) → worker 1's
     branch: merge attempt → `ungated`; reviewer pane runs `mogging approve` → merge
     lands → worker 2's branch: human `override` path lands → repo contains both
     changes; HEAD clean; approvals cleared with worktree removal.
   - **Phase B — perf with the swarm up.** Board visited, 12+ live panes (the swarm
     + a torrent workspace), 3 s ANSI torrent + 4 switches: the UNCHANGED machine
     budget (≤150 ms worst / ≥30 fps / ≤300 MB) AND `MOGGING_PERCEPTION` run again
     afterwards in the sweep — no regressions from mailbox/ledger/gate chatter.
2. **Linux target**: `electron-builder.yml` += AppImage + deb (x64), `linux` section
   (category, icon set); native modules build documented for Debian/Ubuntu + Fedora
   toolchains in the README (mirror the Windows/macOS note). A `MOGGING_SMOKE` run
   under Linux CI (GitHub Actions matrix stub `ci.yml`: win + linux, typecheck +
   build + SMOKE headless via xvfb) — the FULL sweep on Linux is a follow-up, the
   stub must at least build + boot.
3. **Docs**: `docs/09-swarm.md` completed — roles, mailbox verbs, claim etiquette,
   the reviewer gate, profiles/failover, remote panes, and the scripted swarm demo
   (only `mogging …` + the app). `docs/02-mvp-and-roadmap.md` Phase-4 checkboxes.
4. **README + pack**: Quickstart status → Phase 4; `prompts/phase-4/README.md`
   sequence table marked DONE per step with measured numbers + the sweep record
   (mirror phase-3's close).

## Files
- `src/main/swarmmilestone-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`
- `electron-builder.yml` · `.github/workflows/ci.yml` · README toolchain note
- `docs/09-swarm.md` · `docs/02-mvp-and-roadmap.md` · `prompts/phase-4/README.md`

## Definition of Done
- One command (`bash scripts/qa-smokes.sh`) proves Phase 0 → 4 green on fresh
  isolated state — swarm loop included — with both budgets unchanged.
- The swarm demo is scriptable from the README; a Linux build exists and boots
  (CI-asserted), even if the full Linux sweep lands later.

## Checks that must be green
- `npm run typecheck` → 0; build ok (win NSIS + linux AppImage/deb); boundaries clean.
- Full sweep green including SWARM, LEDGER, GATE, PROFILES, REMOTE, SWARMMILESTONE;
  budget numbers recorded in the pack README.
- No mail bodies, claim paths, profile values, or hostnames in telemetry/logs
  (grep + smoke-asserted).

## Guardrails
- Do NOT relax any budget to pass Phase B — coordination surfaces must stay off the
  hot path (mailbox is pull-based; ledger events are deltas; gate checks are lazy).
- Deterministic shell provider in every asserted step; vendor TUIs stay unasserted
  (OSC over hooks, hooks over parsing).
- Linux work must not fork platform logic into features — platform differences live
  in `@backend/platform` and the builder config only.

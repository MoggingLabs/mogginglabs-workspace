# INVENTORY — the denominator

Every user-facing feature and every load-bearing subsystem, one row each. This
file is what makes "we checked everything" a checkable claim instead of a
feeling: **a surface that is not a row here cannot be audited**, and Part I's
coverage is measured against this list and nothing else.

Grouped by the `docs/02-mvp-and-roadmap.md` phase that shipped it.

## How a row is held honest

`scripts/check-launch-audit.mjs` (the `LAUNCHAUDIT` gate) reads this file every
sweep and refuses to go green unless:

1. **The denominator is closed.** Every gate in `scripts/qa-smokes.sh` is claimed
   by at least one row below. This is the "no subsystem without a row" proof,
   deliberately **inverted** — you cannot satisfy it by writing more rows, only
   by covering the sweep. Land a gate for a new subsystem and forget its row, and
   the sweep reds.
2. **The rows are real.** Every entry point resolves: the file exists, the line
   is in range, and the named symbol still greps. Every cited doc exists. A row
   pointing at a deleted file is an audit of nothing.
3. **Every lens is accounted for.** No blank cells.
4. **Every lens derives A.** A ≡ zero unresolved findings in `FINDINGS.md` for
   that (row, lens). Derived, never typed.

## The columns

| column | meaning |
| --- | --- |
| **#** | row id, stable — `FINDINGS.md` references it as `#<id>` |
| **Feature** | one concern. If two things can break independently, they are two rows. |
| **Entry point** | `path:line symbol` — where you start reading. The **line is a signpost** and drifts with edits above it; the **symbol is the anchor**, and the gate fails if it stops appearing in the file. |
| **Spec** | the doc that specifies the behavior. Multiple allowed, `·`-separated. |
| **Gates** | the gate(s) that would go red if this broke. |
| **corr · smell · spag · dup · eff · debt** | the six `RUBRIC.md` lenses. |

### The lens cells record PROVENANCE, not self-assessment

A lens cell names **the step that swept it** — never how it went:

- **`~03`** — pending; step 03 owns this sweep and has not done it yet.
- **`03`** — swept by step 03.

That is the whole vocabulary. A cell can never say "A", because the grade is
computed from `FINDINGS.md`, and a surface grading itself is precisely the
failure phase-8.5 was built to catch — an audit found "Settings — Usage" sitting
at D− with nobody's name on it, in plain sight, for a whole phase.

**Seed state (step 01): every lens is `~NN`.** The gate accepts pending cells in
its sweep mode and prints the outstanding census loudly. It does **not** accept
them under `--freeze`:

```
node scripts/check-launch-audit.mjs            # the sweep: pendings allowed, counted, printed
node scripts/check-launch-audit.mjs --freeze    # step 16: a single pending lens reds it
```

So a pending is always **visible and owned**, and the pack cannot be declared
done while one survives. That is the "no silent drops" guardrail with teeth.

### Which step owns which lens

| lens | owner | scope |
| --- | --- | --- |
| `corr` | **02** runtime & UI core · **03** orchestration & swarm · **04** money paths & reach | by subsystem — each row's `corr` cell names the step whose scope it falls in |
| `smell` `spag` `dup` `debt` | **05** quality — dedup, dead code, refactor | repo-wide |
| `eff` | **06** efficiency & perf | repo-wide |

Step **07** (environment & failure) re-sweeps `corr` on the rows whose behavior
is OS-, network-, or migration-dependent; those rows carry `~07`.

---

## The rows

<!-- ROWS:BEGIN — generated; edit rows.txt and regenerate, never by hand -->

### terminal — Phase 1 · MVP core

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Terminal pane rendering and echo | `src/ui/features/terminal/terminal-pane.ts:89 TerminalPane` | docs/07-perception-budget.md | SMOKE,MULTIPANE,PERCEPTION | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 2 | Pane menu and agent-launch entries | `src/ui/features/terminal/terminal-pane.ts:1598 buildMenu` | docs/11-design-system.md | PLAINMENU | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 3 | Per-pane WebGL context leasing | `src/ui/features/terminal/pane-webgl.ts:58 PaneWebglManager` | docs/05-perf-budget.md | FLICKER,MILESTONE | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 4 | ConPTY-only PTY spawn seam | `src/backend/platform/pty-host.ts:70 spawnPty` | docs/01-architecture.md | CONPTY,PTYSEAM | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 5 | Pane PTY lifecycle service | `src/backend/features/terminal/pty.service.ts:52 PtyService` | docs/adr/0003-persistent-pty-host-process.md | SMOKE,RELOAD | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 6 | Command blocks from OSC 133 | `src/ui/features/blocks/block-tracker.ts:35 BlockTracker` | docs/01-architecture.md | BLOCKS | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 7 | Agent state from the OSC stream | `src/backend/features/agent-state/osc-parser.ts:84 OscParser` | docs/01-architecture.md | STATE,RELOAD | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 8 | Clipboard copy, paste and drops | `src/main/clipboard.ts:279 registerClipboard` | docs/16-files.md | CLIPBOARD | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 9 | Pane working-directory truth | `src/backend/features/agent-state/cwd-state.ts:78 PaneCwdState` | docs/06-control-api.md | CWD,CWD_INPROC | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 10 | Typed-agent process detection | `src/backend/features/agent-state/agent-proc.ts:451 AgentProcessDetector` | docs/06-control-api.md | TYPED,TYPEDCOST | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 186 | Pane grid fit contract | `src/ui/features/terminal/pane-fit.ts:33 gridFor` | docs/01-architecture.md | PANEFIT | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 187 | Vendored terminal fonts and metric parity | `src/ui/core/terminal/font-port.ts:34 terminalFontSize` | docs/11-design-system.md | FONTCOVER | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 188 | Dead-pane restart door | `src/ui/features/terminal/terminal-pane.ts:568 restart` | docs/11-design-system.md | PANERESTART | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### panes/layout — Phase 1 · MVP core

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11 | Split grid and seam resize | `src/ui/features/layout/grid-layout.ts:112 GridLayout` | docs/02-mvp-and-roadmap.md | MULTIPANE,PANEOPS,KBAPG | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 12 | Split geometry and pane floors | `src/ui/features/layout/layout-tree.ts:477 computeLayout` | docs/02-mvp-and-roadmap.md | LAYOUT | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 13 | Equalize and balance lines | `src/ui/features/layout/layout-tree.ts:321 equalizeLineAt` | docs/02-mvp-and-roadmap.md | EQUALIZE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 14 | Cross-workspace pane move | `src/ui/features/workspace/move-pane-modal.ts:43 openMovePaneModal` | docs/11-design-system.md | MOVEPANE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 15 | Workspace close with undo grace | `src/ui/features/workspace/controller.ts:174 WorkspaceController` | docs/11-design-system.md | WSCLOSE,MULTIPANE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 16 | Layout painter pane budget | `src/ui/features/layout/pane-capacity.ts:132 effectivePaneCapacity` | docs/05-perf-budget.md | WIZLAYOUT | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### scroll — Phase 11.5 · Scroll

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 17 | Pane scroll anchor | `src/ui/features/terminal/pane-anchor.ts:82 createPaneAnchor` | docs/02-mvp-and-roadmap.md | PANESCROLL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 18 | Pane scrollbar rail | `src/ui/features/terminal/pane-scrollbar.ts:49 createPaneScrollbar` | docs/02-mvp-and-roadmap.md | PANESCROLL,KBAPG | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 19 | App-wide overlay scrollbars | `src/ui/core/scroll/overlay-scroll.ts:58 installOverlayScrollbars` | docs/02-mvp-and-roadmap.md | APPSCROLL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### ipc — Phase 1 · MVP core

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | Preload channel allowlist | `src/contracts/ipc/channels.ts:469 AllChannels` | docs/01-architecture.md | CHANNELS | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### state/persistence — Phase 1 · MVP core

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | Workspace and session SQLite store | `src/backend/features/workspace/session-store.ts:36 SessionStore` | docs/01-architecture.md | MIGRATE,SURVIVE_B | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 22 | Settings load, save and export | `src/main/app-settings.ts:24 registerAppSettings` | docs/01-architecture.md | PERSISTHEALTH | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 23 | Async request generation guard | `src/ui/core/async/async-state.ts:59 createAsyncGuard` | docs/11-design-system.md | ASYNCSTATE | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 24 | Config file mutation serialization | `src/backend/core/config-files/mutation-coordinator.ts:75 ConfigMutationCoordinator` | docs/adr/0011-agent-cli-configuration-control-plane.md | MUTATIONRACE | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 25 | Restore last working session | `src/main/session-restore.ts:208 registerSessionRestore` | docs/11-design-system.md | RESUME | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### daemon — Phase 1 · MVP core (ADR 0006)

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 26 | Daemon discovery and custody | `src/main/daemon-client.ts:249 ensureDaemon` | docs/adr/0012-daemon-custody-version-vs-build-stamp.md | DAEMONCUSTODY,STAMPWAR | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 27 | Detached pane sessions survive | `src/pty-daemon/session.ts:922 SessionManager` | docs/adr/0006-detached-pty-daemon.md | SURVIVE_A,SURVIVE_B,PANEOPS | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 28 | Daemon socket client heartbeat | `src/main/daemon-client.ts:389 DaemonClient` | docs/adr/0006-detached-pty-daemon.md | HEARTBEAT | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 29 | Daemon relay reconnect and heal | `src/main/daemon-relay.ts:92 startDaemonBackend` | docs/adr/0006-detached-pty-daemon.md | DAEMONHEAL | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 30 | Standalone Node runtime helper | `src/main/node-helper.ts:107 helperRuntime` | docs/adr/0017-split-node-runtime.md | RUNTIMESPLIT | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 31 | Daemon wire protocol version | `src/contracts/daemon/protocol.ts:28 DAEMON_PROTOCOL_VERSION` | docs/adr/0012-daemon-custody-version-vs-build-stamp.md | PROTOVER | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 32 | Windowless daemon child spawns | `src/backend/platform/windowless-children.ts:64 enforceWindowlessChildren` | docs/adr/0006-detached-pty-daemon.md | KILLFLASH | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 189 | Attach-size reconciliation | `src/pty-daemon/attach-dims.ts:14 attachDims` | docs/adr/0006-detached-pty-daemon.md | REATTACHFIT | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### agents — Phase 2 · Agent awareness

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 33 | Shared agent CLI registry | `src/ui/core/agents/registry.ts:46 refreshAgentRegistry` | docs/adr/0011-agent-cli-configuration-control-plane.md | AGENTREGISTRY | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 34 | Agent launch command and delivery | `src/backend/features/agents/launch.ts:102 buildLaunchCommand` | docs/adr/0011-agent-cli-configuration-control-plane.md | AGENTLAUNCH,LAUNCHNOW | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 35 | Agent context-window monitor | `src/backend/features/context/monitor.ts:96 ContextMonitor` | docs/adr/0013-sessions-follow-profiles.md | CTXACCURACY | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 36 | Per-workspace MCP tool plan | `src/main/tool-plan.ts:70 materializeToolPlanAtLaunch` | docs/14-integrations.md | TOOLPLAN | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### attention — Phase 2 · Agent awareness

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 37 | Pane attention state port | `src/ui/core/attention/attention-port.ts:78 setPaneState` | docs/01-architecture.md | ATTENTION | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 38 | mogging notify CLI verb | `bin/mogging.mjs:1299 runNotify` | docs/06-control-api.md | NOTIFY,NOTIFYPARITY | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 39 | Generated notify hook script | `src/backend/features/agents/notify-hook.ts:16 NOTIFY_HOOK_SOURCE` | docs/01-architecture.md | NOTIFYHOOK,NOTIFYPARITY | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 40 | Global agent hook wiring | `src/main/agent-global-hooks.ts:216 registerAgentGlobalHooks` | docs/01-architecture.md | GLOBALHOOKS | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### agent-settings — Phase 2 · Agent awareness (ADR 0011)

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | Agent CLI config control plane | `src/backend/features/agent-settings/service.ts:137 AgentSettingsService` | docs/17-agent-cli-settings.md | AGENTCFG | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 42 | Canonical agent CLI registry | `src/backend/core/agent-clis/registry.ts:62 AGENT_CLI_REGISTRY` | docs/adr/0011-agent-cli-configuration-control-plane.md | AGENTCAT | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 43 | Settings agent-config page | `src/ui/features/settings/agent-config.ts:270 createAgentConfigWorkspace` | docs/17-agent-cli-settings.md | SETAGENTCFG | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 44 | Settings shell navigation | `src/ui/features/settings/index.ts:91 settingsFeature` | docs/11-design-system.md | SETSHELL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### board — Phase 3 · Orchestration

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 45 | Card writer with CAS and claim | `src/main/board.ts:231 applyCardPatch` | docs/18-board.md | BOARDV2,BOARDMCP | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 46 | Per-project board resolution | `src/main/board.ts:122 boardForWorkspaceId` | docs/18-board.md | BOARDV2 | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 47 | GitHub two-way card sync | `src/main/github-board.ts:225 registerGithubBoard` | docs/adr/0015-board-github-write-back.md | BOARDGH | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 48 | Board lane view render | `src/ui/features/board/view.ts:65 createBoardView` | docs/18-board.md | BOARDRENDER,BOARDUX | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 49 | Card chips and context menu | `src/ui/features/board/card.ts:204 cardEl` | docs/11-design-system.md | BOARDUX,BOARDRENDER,VERDICTLIVE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 50 | Start agent on a board card | `src/ui/features/board/launch.ts:50 startOnCard` | docs/08-orchestration.md | BOARD,BOARDFAIL,ORCHESTRATION | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 51 | Board pull queue engine | `src/ui/features/board/queue.ts:33 createQueueEngine` | docs/18-board.md | BOARDQUEUE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### worktrees — Phase 3 · Orchestration

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 52 | Per-agent worktree isolation | `src/backend/features/worktrees/index.ts:62 createWorktree` | docs/08-orchestration.md | WORKTREE,REVIEW | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 53 | Dirty-safe worktree removal | `src/backend/features/worktrees/index.ts:140 removeWorktree` | docs/08-orchestration.md | WORKTREE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### review — Phase 3 · Orchestration

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 54 | Redacted worktree diff | `src/backend/features/review/index.ts:113 diffWorktree` | docs/08-orchestration.md | REVIEW,REVIEWSNAP | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 55 | Secret redaction before transport | `src/backend/features/review/redact.ts:59 redactSecrets` | docs/08-orchestration.md | REVIEW | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 56 | Guarded merge verb | `src/backend/features/review/index.ts:177 mergeBranch` | docs/08-orchestration.md | REVIEW,REVIEWSNAP | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 57 | Fork-base review snapshot | `src/backend/features/review/index.ts:62 snapshotForWorktree` | docs/08-orchestration.md | REVIEWSNAP | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 58 | Reviewer approval identity gate | `src/main/review.ts:15 approvalMatchesSnapshot` | docs/09-swarm.md | REVIEWSNAP | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 59 | Review diff modal | `src/ui/features/review/index.ts:281 reviewFeature` | docs/08-orchestration.md | REVIEW | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 60 | Reviewer merge gate | `src/main/review.ts:36 mergeReviewedWorktree` | docs/09-swarm.md | GATE,SWARMMILESTONE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### swarm — Phase 4 · Differentiators

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 61 | Swarm pane mailbox | `src/pty-daemon/mailbox.ts:14 Mailbox` | docs/09-swarm.md | SWARM,SWARMMILESTONE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 62 | File-ownership claim ledger | `src/pty-daemon/ledger.ts:24 Ledger` | docs/09-swarm.md | LEDGER,SWARMMILESTONE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 63 | App-assigned pane roles | `src/main/daemon-relay.ts:72 appAssignedRole` | docs/09-swarm.md | ROLERACE,SWARM | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 64 | Saved remote SSH hosts | `src/main/remotes.ts:74 registerRemotes` | docs/09-swarm.md | REMOTE | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 65 | Remote pane bootstrap command | `src/pty-daemon/session.ts:225 remoteBootstrapCommand` | docs/09-swarm.md | REMOTEBOOT | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### profiles — Phase 4 · Differentiators

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 66 | Agent account profiles | `src/main/profiles.ts:166 registerProfiles` | docs/09-swarm.md | PROFILES,PROFPERSIST_A,PROFPERSIST_B | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 67 | Profile login truth | `src/backend/features/agents/logins.ts:116 discoverLogins` | docs/09-swarm.md | LOGINTRUTH | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 68 | Sessions follow profiles | `src/backend/features/agents/session-pool.ts:241 poolProviderSessions` | docs/adr/0013-sessions-follow-profiles.md | SESSIONPOOL,PROFILES,PROFPERSIST_B | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### templates — Phase 4 · Differentiators

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 69 | Provider-mix preset store | `src/main/templates.ts:11 registerTemplates` | docs/11-design-system.md | TEMPLATE_A,TEMPLATE_B | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 70 | Provider mix to grid layout | `src/backend/features/templates/resolve.ts:23 resolveLayout` | docs/11-design-system.md | TEMPLATE_A,WIZLAYOUT | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### chrome/shell — Phase 5 · UI/UX excellence

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 71 | App shell and rail fold | `src/ui/shell/app-shell.ts:19 createAppShell` | docs/11-design-system.md | RAILFOLD,CHROMEUX | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 72 | Titlebar compression ladder | `src/ui/shell/titlebar.ts:17 createTitlebar` | docs/11-design-system.md | CHROMEUX,SPACING | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 73 | Native chrome press dismissal | `src/main/shell-chrome.ts:42 wireChromePress` | docs/11-design-system.md | CHROMEPRESS | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 74 | Dock and rail layout budget | `src/ui/core/layout/dock-budget.ts:27 dockLayoutBudget` | docs/13-browser.md | DOCKUX,RESPONSIVE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### themes — Phase 8.5 · The UI/UX revamp

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 75 | Theme catalog and application | `src/ui/core/theme/themes.ts:226 applyTheme` | docs/11-design-system.md | SETSHELL,CHROMEUX,UXMILESTONE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 76 | Theme selection persistence | `src/ui/core/theme/theme-state.ts:16 setTheme` | docs/11-design-system.md | SETSHELL,UXMILESTONE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### keyboard/a11y — Phase 5 · UI/UX excellence

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 77 | Calm motion for reduced motion | `src/ui/core/a11y/motion-port.ts:34 applyCalmMotion` | docs/11-design-system.md | MOTION | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 78 | Shortcut catalog and help sheet | `src/ui/core/commands/shortcuts.ts:29 SHORTCUTS` | docs/11-design-system.md | KBSHORTCUTS | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 79 | Global chord routing guard | `src/ui/core/commands/context.ts:83 shortcutsBlocked` | docs/11-design-system.md | KBGLOBAL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 80 | Modal focus trap and inerting | `src/ui/core/a11y/overlay-trap.ts:53 trapOverlay` | docs/11-design-system.md | A11YMODAL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### wizard — Phase 5 · UI/UX excellence

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 81 | New-workspace wizard page | `src/ui/features/wizard/index.ts:109 wizardFeature` | docs/11-design-system.md | WIZARDUX | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 82 | Wizard cd line and completion | `src/ui/features/wizard/cd-line.ts:60 createCdLine` | docs/11-design-system.md | WIZCD | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 83 | Worktree isolation per agent pane | `src/ui/features/wizard/wizard.client.ts:21 wizardClient` | docs/08-orchestration.md | WIZARDISO,WIZARDFAIL | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 84 | Home launcher and first run | `src/ui/features/home/index.ts:75 homeFeature` | docs/11-design-system.md | HOMEUX | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 85 | Wizard folder browser | `src/ui/components/folder-browser.ts:65 createFolderBrowser` | docs/11-design-system.md | FOLDERPICK | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### product — Phase 6 · Product-ready

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 86 | First-run setup checklist | `src/ui/features/home/firstrun.ts:46 createFirstRun` | docs/02-mvp-and-roadmap.md | FIRSTRUN,PRODUCT,UXMILESTONE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 87 | Toast feedback family | `src/ui/components/toast.ts:70 showToast` | docs/11-design-system.md | FEEDBACKUX | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 88 | Unsilenceable destructive confirm | `src/ui/components/confirm.ts:29 confirmDialog` | docs/11-design-system.md | FEEDBACKUX,UXMILESTONE | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### updater — Phase 6 · Product-ready

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 89 | Auto-update lifecycle and failure states | `src/main/updater.ts:157 initAutoUpdate` | docs/10-distribution.md | UPDATEFAIL,UPDATEOFFLINE,FIRSTRUN | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 90 | Rail update row and restart toast | `src/ui/features/updates/index.ts:30 updatesFeature` | docs/10-distribution.md | FIRSTRUN,UPDATEFAIL,UPDATEOFFLINE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 91 | Settings update card manual check | `src/ui/features/settings/updates.ts:64 createUpdatesSection` | docs/10-distribution.md | UPDATEFAIL,UPDATEOFFLINE | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### observability — Phase 6 · Product-ready

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 92 | Vendor-agnostic telemetry port | `src/backend/core/telemetry/index.ts:13 getTelemetry` | docs/adr/0005-observability-sentry-posthog.md | WATERMARK | 02 | ~05 | ~05 | ~05 | ~06 | ~05 |

### usage — Phase 7 · Usage & metering

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 93 | Provider usage poller service | `src/backend/features/usage/index.ts:159 createUsageService` | docs/adr/0007-usage-rides-existing-sessions.md | USAGE,USAGEUI,USAGESET | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 94 | Pace engine and verdict strings | `src/backend/features/usage/pace.ts:43 computePace` | docs/12-usage.md | USAGE,USAGEGLANCE,USAGECLI | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 95 | Local cost log scanner | `src/backend/features/usage/cost.ts:495 scanCost` | docs/12-usage.md | USAGE,USAGECLI | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 96 | Web-session usage readers | `src/backend/features/usage/classes/web-session.ts:141 fetchWebSessionUsage` | docs/adr/0007b-usage-web-sessions.md | WEBUSAGE,USAGESET | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 97 | Usage API key vault slots | `src/main/usage-keys.ts:33 keySetPlaintext` | docs/adr/0007a-usage-keys-at-rest.md | USAGESET,USAGECLI,SECRETFORMS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 98 | Titlebar gauge and popover | `src/ui/features/usage/index.ts:83 usageFeature` | docs/12-usage.md | USAGEUI,USAGEGLANCE,SETUSAGE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 99 | Settings Usage tab | `src/ui/features/settings/usage.ts:58 createUsageSection` | docs/12-usage.md | USAGESET,SETUSAGE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### connections — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | OAuth discovery and registration | `src/backend/features/integrations/oauth.ts:107 discoverAuthServer` | docs/adr/0014-app-held-service-connections.md | CONNPURE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 101 | Pre-registered OAuth clients | `src/backend/features/integrations/client-registry.ts:79 resolveClient` | docs/adr/0014-app-held-service-connections.md | PREREGCLIENT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 102 | Connect an app-held service | `src/main/connections.ts:310 connect` | docs/adr/0014-app-held-service-connections.md | CONNPURE,CONNLIVE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 103 | Terminal authorization runner | `src/ui/features/settings/auth-runner.ts:38 runIntegrationAuthorization` | docs/14-integrations.md | AUTHRUNNER | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### integrations — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 104 | Workspace tool plan | `src/main/integrations.ts:93 setToolPlan` | docs/14-integrations.md | INTEGUX,LIBRARYUX,INTEGMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 105 | Per-workspace write grants | `src/main/integrations.ts:144 mutateIntegrationsGrant` | docs/adr/0008-integrations-protocols-not-plugins.md | MCPWRITE,INTEGMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 106 | Agent activity trail ring | `src/backend/features/integrations/trail.ts:40 TrailStore` | docs/14-integrations.md | WEBTRAIL,SETINTEG | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 107 | Outbound webhook event bridge | `src/main/event-bridge.ts:164 emitBridgeEvent` | docs/14-integrations.md | SETINTEG,INTEGMILESTONE,EVBRIDGE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 108 | Board card service links | `src/backend/features/integrations/services/engine.ts:39 ServiceEngine` | docs/14-integrations.md | INTEG | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 109 | Integrations inventory page | `src/ui/features/settings/integrations.ts:1140 createIntegrationsSection` | docs/14-integrations.md | INTEGUX,SETINTEG | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 110 | Library store modal | `src/ui/features/settings/library.ts:512 openLibrary` | docs/14-integrations.md | LIBRARYUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### mcp — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 111 | House MCP server tool dispatch | `bin/mogging-mcp.mjs:733 handleToolCall` | docs/14-integrations.md | MCP,MCPWRITE,INTEGMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 112 | Per-CLI MCP config writer | `src/main/mcp-manager.ts:241 mgrApply` | docs/14-integrations.md | MCPMGR,MCPCAT,INTEGMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 113 | Catalog preset connect | `src/main/mcp-manager.ts:393 catConnect` | docs/14-integrations.md | MCPCAT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 114 | MCP connection status poller | `src/main/mcp-status.ts:115 registerMcpStatus` | docs/14-integrations.md | MCPSTATUS,MCPLOOP,INTEGUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### control-api — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 115 | Authed app control endpoint | `src/main/mcp-endpoint.ts:331 startMcpEndpoint` | docs/06-control-api.md | CONTROL,MCP,USAGECLI | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 116 | Control command sanitizer | `src/main/deep-link.ts:43 sanitizeControl` | docs/06-control-api.md | CONTROL2 | ~03 | ~05 | ~05 | ~05 | ~06 | ~05 |

### cli — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 117 | mogging usage CLI verbs | `bin/mogging.mjs:94 runUsage` | docs/12-usage.md | USAGECLI | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 118 | Pane list send capture verbs | `bin/mogging.mjs:1073 runList` | docs/06-control-api.md | CONTROL | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### vault — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 119 | OS keychain secret vault | `src/main/vault.ts:57 vaultStore` | docs/14-integrations.md | VAULTKEYS,SECRETFORMS,CUSTODY | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 120 | Fleet service key store | `src/main/service-keys.ts:45 serviceKeySet` | docs/14-integrations.md | VAULTKEYS,SECRETFORMS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 121 | Service keys into pane env | `src/main/service-keys.ts:108 resolveServiceKeyEnv` | docs/14-integrations.md | VAULTKEYS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### browser — Phase 8 · Integrations

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 122 | Browser dock main service | `src/main/browser-dock.ts:949 registerBrowserDock` | docs/13-browser.md | BROWSER,PERWS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 123 | Dock chrome and webview guests | `src/ui/features/browser/index.ts:57 browserFeature` | docs/13-browser.md | BROWSER,BROWSERUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 124 | Webview tab strip | `src/ui/features/browser/index.ts:566 renderTabStrip` | docs/13-browser.md | BROWSERTABS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 125 | Agent browser control verbs | `src/main/browser-dock.ts:696 agentAct` | docs/13-browser.md | BROWSERCTL,BROWSERTABS,AGENTWEB,PERWSAGENT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 126 | Page-world driver scripts | `src/main/browser-page-scripts.ts:44 SNAPSHOT_JS` | docs/13-browser.md | BROWSERCTL | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 127 | Per-workspace agent consent | `src/main/browser-dock.ts:602 setAgentConsent` | docs/13-browser.md | BROWSERCTL,BROWSERZERO | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 128 | Guest session permission hardening | `src/main/browser-guest-policy.ts:44 applyGuestSessionPolicy` | docs/13-browser.md | BROWSER,BROWSERUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 129 | Omnibox address resolution | `src/contracts/domain/address-input.ts:56 resolveAddressInput` | docs/13-browser.md | BROWSERUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 130 | Zero-workspace dock lockdown | `src/ui/features/browser/index.ts:1227 applyWorkspaceGating` | docs/13-browser.md | BROWSERZERO | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 131 | Cross-workspace late-reply scoping | `src/ui/features/browser/index.ts:339 workspaceStillCurrent` | docs/13-browser.md | BROWSERRACE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### files — Phase 11 · Files

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 132 | Explorer directory listing service | `src/backend/features/explorer/list.ts:30 listExplorer` | docs/16-files.md | FSLIST | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 133 | Folder-picker directory read service | `src/backend/features/fs-browse/index.ts:56 listDir` | docs/11-design-system.md | FSLIST,FOLDERPICK | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 134 | Virtualized file tree component | `src/ui/components/file-tree.ts:135 createFileTree` | docs/16-files.md | FILETREE,FILESMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 135 | Explorer dock and Changes lens | `src/ui/features/explorer/index.ts:141 explorerFeature` | docs/16-files.md | EXPLORER,EXPLORERRACE,TREEGIT,FILESMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 136 | Live directory watcher pool | `src/backend/features/explorer/watch.ts:60 createExplorerWatcher` | docs/16-files.md | TREELIVE,FILESMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 137 | File actions and containment guard | `src/main/explorer.ts:90 registerExplorer` | docs/adr/0010-explorer-window-not-manager.md | FILEACT,EXPLORER,EXPLORERRACE,TREELIVE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 138 | Send-to-pane path quoting | `src/contracts/domain/shell-quote.ts:44 quotePathForShell` | docs/16-files.md | FILEACT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### git — Phase 11 · Files

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 139 | Per-pane git status probe | `src/backend/features/git/probe.ts:426 probeGitFull` | docs/05-perf-budget.md | GIT,GITPURE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 140 | Shared git poll monitor | `src/backend/features/git/monitor.ts:52 GitMonitor` | docs/05-perf-budget.md | GIT,GITPURE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 141 | Per-file status decorations | `src/backend/features/git/probe.ts:375 parseStatusFiles` | docs/16-files.md | TREEGIT,FILESMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 142 | Git IPC and check-ignore batch | `src/main/git.ts:70 registerGit` | docs/16-files.md | GIT,TREEGIT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### account — The Accounts pack

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 143 | PKCE browser login flow | `src/main/account.ts:401 login` | docs/19-accounts.md | ACCOUNT,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 144 | Serialized refresh token rotation | `src/main/account.ts:564 accessTokenForEntitlement` | docs/19-accounts.md | ACCOUNT,ENTITLE,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 145 | Sign-out returns to anon Free | `src/main/account.ts:689 logout` | docs/19-accounts.md | ACCOUNT,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 146 | Settings account and plan panel | `src/ui/features/settings/account.ts:46 createAccountSection` | docs/19-accounts.md | PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### entitlements — The Accounts pack

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 147 | Local claim signature verification | `src/main/entitlements.ts:142 verifyEntitlementJwt` | docs/19-accounts.md | ENTITLE,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 148 | Offline entitlement grace window | `src/main/entitlements.ts:272 entitlementsSnapshot` | docs/19-accounts.md | ENTITLE,PRODMILESTONE,WATERMARK | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 149 | Device-attested entitlement fetch | `src/main/entitlements.ts:320 refreshEntitlements` | docs/19-accounts.md | ENTITLE,DEVICEKEY,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 150 | Free tier baseline limits | `src/contracts/entitlements/index.ts:79 FREE_ENTITLEMENTS` | docs/adr/0016-accounts-and-entitlements.md | ENTITLE,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 151 | Capped feature upgrade refusal | `src/main/remotes.ts:65 remoteQuotaRefusal` | docs/19-accounts.md | ENTITLE,PRODMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### hardening — The Accounts pack

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 152 | Non-exportable hardware device key | `src/backend/platform/device-key/index.ts:86 openDeviceKey` | docs/19-accounts.md | DEVICEKEY,PRODMILESTONE | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 153 | Forensic activation watermark | `src/backend/features/account/watermark.ts:102 deriveWatermark` | docs/19-accounts.md | WATERMARK,PRODMILESTONE | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 154 | Runtime tamper self-check | `src/main/native-preflight.ts:184 runTamperSelfCheck` | docs/19-accounts.md | WATERMARK,PRODMILESTONE | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 155 | Frozen outbound origin pin | `src/backend/core/origins.ts:18 ORIGINS` | docs/adr/0016-accounts-and-entitlements.md | ORIGINPIN | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 156 | Electron fuse wall | `electron-builder.yml:70 electronFuses` | docs/19-accounts.md | FUSES | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 157 | Main-process V8 bytecode | `electron.vite.config.ts:113 protectedStrings` | docs/19-accounts.md | BYTECODE | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 158 | Renderer CSP response header | `src/main/window.ts:39 installCspHeader` | docs/19-accounts.md | LOCKDOWN | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 159 | Main-window navigation deny guard | `src/main/window.ts:61 installNavigationGuard` | docs/19-accounts.md | LOCKDOWN | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 160 | Webview attach partition guard | `src/main/window.ts:79 createMainWindow` | docs/13-browser.md | LOCKDOWN,BROWSERUX | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |

### brain — Phase 12 · The Workspace Brain

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 161 | Brain service lifecycle | `src/backend/features/brain/index.ts:219 BrainService` | docs/adr/0018-workspace-brain.md | BRAINCORE,BRAINMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 162 | Project identity resolution | `src/backend/features/brain/project.ts:49 resolveBrainProject` | docs/20-brain.md | BRAINCORE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 163 | Off-thread WASM parsing | `src/backend/features/brain/parser-pool.ts:75 ParserPool` | docs/20-brain.md | BRAINPARSE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 164 | Hash-pinned grammar catalog | `src/backend/features/brain/parser-pool.ts:24 GrammarRow` | docs/20-brain.md | GRAMMARCAT,BRAINPARSE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 165 | Symbol graph resolution | `src/backend/features/brain/extract.ts:235 resolveProjectGraph` | docs/20-brain.md | BRAINGRAPH,BRAINMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 166 | Incremental freshness drains | `src/backend/features/brain/freshness.ts:163 BrainFreshness` | docs/20-brain.md | BRAINFRESH | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 167 | Brain read tool dispatch | `src/backend/features/brain/serve.ts:1024 serveBrainRead` | docs/20-brain.md | BRAINMCP,BRAINMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 168 | Ranked repo map render | `src/backend/features/brain/render.ts:24 renderRepoMap` | docs/20-brain.md | BRAINMAP | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 169 | Symbol write tools | `src/backend/features/brain/writes.ts:204 serveBrainWrite` | docs/20-brain.md | BRAINWRITE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 170 | Lockfile library lens | `src/backend/features/brain/libraries.ts:345 resolveLibraries` | docs/20-brain.md | BRAINDOCS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 171 | Memory wikilink graph scan | `src/backend/features/brain/memory.ts:263 scanMemoryDir` | docs/20-brain.md | MEMGRAPH | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 172 | Memory write and draft doors | `src/backend/features/brain/memory-writes.ts:76 serveMemoryWrite` | docs/20-brain.md | MEMGRAPH,BRAINCAP | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 173 | Semantic memory search lens | `src/backend/features/brain/serve.ts:899 serveMemorySearchSemantic` | docs/20-brain.md | BRAINSEM | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 174 | Draft capture from signals | `src/backend/features/brain/capture.ts:71 buildSessionDraft` | docs/20-brain.md | BRAINCAP | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 175 | Task-ranked memory recall | `src/backend/features/brain/recall.ts:146 serveBrainRecall` | docs/20-brain.md | BRAINRECALL | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 176 | Brain view and focus lens | `src/ui/features/brain/view.ts:79 createBrainView` | docs/20-brain.md | BRAINUX | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 177 | Memory reader rendering | `src/ui/features/brain/reader.ts:152 renderReader` | docs/20-brain.md | BRAINUX,BRAINPROPS | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### tools — v0.16.0 · The toolbelt bump (ADR 0020)

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 190 | Provider catalog as data | `src/backend/features/integrations/provider-catalog-data.ts:76 providerCatalog` | docs/adr/0020-tool-first-integrations.md | CATSCHEMA | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 191 | Credential core: exchange, refresh, quirks | `src/backend/features/integrations/credential-core.ts:42 normalizeTokenResponse` | docs/adr/0020-tool-first-integrations.md | TOOLCRED | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 192 | Tool verification status engine | `src/backend/features/integrations/status-engine.ts:38 classifyProbeOutcome` | docs/14-integrations.md | TOOLPULSE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 193 | Catalog-driven account identity | `src/backend/features/integrations/identity.ts:48 readProfilePaths` | docs/adr/0020-tool-first-integrations.md | TOOLWHO | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 194 | Tool cards grid and outcome wording | `src/ui/features/settings/connections.ts:1101 familyCard` | docs/14-integrations.md | TOOLCARDS,TOOLWORDS,TOOLSMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 195 | Silent config-drift reconciler | `src/main/mcp-manager.ts:239 scanCliDrift` | docs/14-integrations.md | TOOLFIX,TOOLSMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### restbridge — v0.16.0 · The toolbelt bump (ADR 0021)

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 196 | REST bridge executor: restTools as MCP tools | `src/backend/features/integrations/rest-bridge.ts:78 restToolsListResult` | docs/adr/0021-local-rest-bridge.md | RESTEXEC,RESTMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 197 | OpenAPI curator: specs in, drafts out | `scripts/curate-rest-tools.mjs:98 draftTool` | docs/adr/0021-local-rest-bridge.md | RESTIMPORT | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 198 | Guided API-key panel and family cards | `src/ui/features/settings/connections.ts:1052 familyKeyPanel` | docs/14-integrations.md | RESTCARDS,RESTMILESTONE | ~04 | ~05 | ~05 | ~05 | ~06 | ~05 |

### build — Cross-cutting · the shipped artifact

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 178 | Harness-free production bundle | `electron.vite.config.ts:137` | docs/02-mvp-and-roadmap.md | PRODARTIFACT | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 179 | Sweep-size prose consistency | `scripts/check-gate-count.mjs:51 CLAIMS` | docs/10-distribution.md | GATECOUNT | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 180 | Docs cross-link integrity | `scripts/check-docs-refs.mjs:30` | docs/02-mvp-and-roadmap.md | DOCSREFS | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 181 | npm config key hygiene | `scripts/check-npm-config.mjs:65 ALLOWED` | docs/10-distribution.md | NPMCONFIG | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 182 | Repo lint ruleset | `eslint.config.mjs:13` | docs/adr/0004-layered-feature-sliced-architecture.md | LINT | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 183 | Headless unit test tier | `vitest.config.ts:11` | docs/04-adding-a-feature.md | UNIT | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |
| 184 | Audit ledger coverage assertion | `scripts/check-audit.mjs:22` | docs/02-mvp-and-roadmap.md | AUDIT | ~07 | ~05 | ~05 | ~05 | ~06 | ~05 |

### audit-method — Phase Launch · Part I

| # | Feature | Entry point | Spec | Gates | corr | smell | spag | dup | eff | debt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 185 | Launch audit coverage gate | `scripts/check-launch-audit.mjs:50 LENSES` | prompts/phase-launch/RUBRIC.md | LAUNCHAUDIT | ~02 | ~05 | ~05 | ~05 | ~06 | ~05 |

<!-- ROWS:END -->

---

## Notes for 02–07 — leads, not findings

Step 01 files no findings: it builds the frame. But the sweeps that produced these
rows turned up things worth routing, and a lead that is only in someone's head is
a silent drop. Each is **verified**, and named here with its owner.

### Surfaces whose Spec cell is the closest doc, not a true spec

These rows are real and gated, but no doc under `docs/` normatively specifies
them. The Spec cell cites the nearest genuine doc so the column stays honest —
it is **not** a claim that the behavior is written down. Step **02** should
decide, per row, whether the gap is a doc to write or a feature to narrow:

| row | surface | what the cited doc actually covers |
| --- | --- | --- |
| 9 | Clipboard copy, paste and drops | `docs/16-files.md` specs the drop-path quoting half; OSC 52 and the clipboard history ring are unspecified |
| 11 | Typed-agent process detection | `docs/06-control-api.md` specs the negative ("unknown executables get no branding"), not the subtree walk |
| 16 · 17 | Cross-workspace pane move · workspace close with undo grace | `docs/11-design-system.md`'s feedback family, not the move/undo semantics |
| 28 | Async request generation guard | `docs/11-design-system.md` does not state the loading/error contract it enforces |

### Verified drift: ADR numbers in `qa-smokes.sh` comments are off by one

`scripts/qa-smokes.sh` attributes the accounts and hardening gates to **ADR
0015** (ORIGINPIN · FUSES · BYTECODE · LOCKDOWN · ACCOUNT) and RUNTIMESPLIT to
**ADR 0016**. On disk: `0015` is **board-github-write-back**, `0016` is
**accounts-and-entitlements**, `0017` is **split-node-runtime** — so each names
the ADR one below the one it means. `DOCSREFS` does not catch it because it
validates **path** citations, not `ADR NNNN` prose.

Owner: **05** (a `dup`/`debt`-shaped consistency defect in comments, not a
runtime bug); the durable fix is a `DOCSREFS` extension resolving `ADR NNNN` to
`docs/adr/NNNN-*.md`.

### Verified drift: `package-lock.json` states a version the product does not ship

`package.json:3` is **0.15.1**; `package-lock.json:3` and `:9` say **0.14.0**.
`GATECOUNT` pins `docs/10`'s release commands to `package.json`'s version, but
nothing pins the lockfile's. Functionally inert (npm rewrites it on the next
install), which is exactly why it drifted unnoticed — two committed lists that
must agree, with nothing making them agree.

Owner: **05**.

---

## Amendment log

`RUBRIC.md` requires that a rule which proves wrong is amended **visibly and for
every row**, never waived for one instance. Amendments to this file's own rules
are recorded here.

### A1 (step 02) — three areas re-homed from `~07` to `~02`

Step 01 assigned `corr` on **state/persistence** (rows 26–30), **daemon**
(31–38) and **updater** (89–91) to step **07**, reasoning that their failure
modes are environmental. Step 02's scope names all three explicitly — "the PTY
seam + daemon lifecycle (spawn/reconnect/quit/relaunch, the KILLFLASH windowless
path)", "workspace tabs + persistence/restore", "the updater lifecycle UX". The
step-01 assignment was wrong, so it is corrected here rather than argued around.

The rule as amended: **a row's `corr` cell names the step that owns its PRIMARY
correctness sweep** — the one that would catch the defect on a developer's own
machine. Step **07** keeps the *environmental* re-sweep (cross-OS custody, the
offline update feed, migration from a seeded old userData); it does not own the
first pass on lifecycle logic. Applied to all 185 rows, not just the three areas
that surfaced it.

### A2 (step 02) — themes/tokens had no row

Step 01's coverage check is **gate → row**: every gate must be claimed. A surface
with **no gate of its own** is therefore invisible to it, and themes/tokens was
exactly that — covered incidentally by SETSHELL/CHROMEUX/UXMILESTONE, owned by no
row. Rows **75–76** now exist.

### A3 (2026-07-24, post-merge) — the v0.16.0 toolbelt wave joins the denominator

The merge of `main` (053193d) landed mid-step-02 carrying phase-tools (ADR
0020), phase-restbridge (ADR 0021), the rendering contract, the dead-pane
restart door, and the live connect driver — **17 sweep gates no row claimed**,
and the sweep red exactly as check 1 promises. Rows **186–198** now claim 16 of
them; **CONNLIVE** rides row 102 (the `connect()` row it drives). Provenance:
the rendering/restart/attach rows are runtime & UI core (`~02` — step 02's
remaining edge coverage grows by four rows); the tools and restbridge rows are
money paths & reach (`~04`). Quality and efficiency lenses land with every
other row in 05–07. Steps 02 and 04's scope lines carry the same addendum.

The limitation is real and worth stating plainly: `LAUNCHAUDIT` proves *no gate
is unclaimed*, which is **not** the same as *no surface is unrowed*. The
gate-side denominator is closed; the surface-side one is closed only by a human
reading `src/` against this file. Steps 03–07 should each add the rows their
scope needs, as this one did.

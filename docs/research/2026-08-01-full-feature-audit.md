# Full feature audit — MoggingLabs Workspace v0.16.0

Date: 2026-08-01 · Method: 56 per-feature audit agents (docs = expected vs code = actual), adversarial verification of critical/high bug claims (47 confirmed / 3 refuted), completeness critic + second wave. 375 findings.

Severity: critical = data loss / security hole / core promise broken · high = user-visible breakage or product-law violation · medium = real but bounded · low = polish.
Verdict marks: [✓] adversarially verified · [✗] refuted (appendix) · unmarked = single-auditor finding.

## terminal-rendering  (implemented: partial)

> Expected: Per-pane xterm.js with WebGL rendering (DOM fallback, managed ~16-context budget, self-healing on context loss), fit/refit + font remeasure, 12-16px live font control, 10k scrollback, search and serialize addons, safe paste/IME handling, and a hard asserted 16-pane perf budget.

- **[HIGH · bug] [✓] Bare Shift keydown yanks a scrolled-up pane to the bottom via anchor.stick()**  
  Where: `src/ui/features/terminal/pane-anchor.ts:217`  
  Evidence: onKey (pane-anchor.ts:215-218): scroll keys require a modifier+SCROLL_KEYS key; every other key with no ctrl/meta/alt hits `stick()`. A keydown of bare 'Shift' (shiftKey=true, key='Shift') fails the first branch and passes the second, so stick() runs scrollToBottom (pane-anchor.ts:171-179).  
  Recommendation: In onKey, return early when e.key is a pure modifier ('Shift','Control','Alt','Meta','CapsLock','NumLock','ScrollLock') before the typing branch; add a bare-Shift keydown dispatch to the PANESCROLL K-section so the gate covers real key sequences.  
  Why: Shift prefixes every scrollback chord and is the force-selection modifier: from a scrolled-up viewport each new Shift press snaps to bottom, so keyboard paging never gets past one page and shift-click selection in history breaks.
  Verifier: Traced pane-anchor.ts:225-228: bare Shift fails SCROLL_KEYS, passes !ctrl/!meta/!alt → stick() → scrollToBottom (171-189). No guard: capture listener on body runs before xterm/handleKey; nothing stops propagation. Severity high stands; only continuous-hold Shift paging survives.

- **[MEDIUM · gap] Terminal search promised in docs and shipped as a dependency but never wired**  
  Where: `docs/01-architecture.md:13`  
  Evidence: docs/01-architecture.md:12-13 lists addon-search in the current tier (only unicode11/serialize/web-links are 'later'); package.json:43 ships @xterm/addon-search ^0.16.0. Repo-wide grep finds zero imports of SearchAddon and no find-in-scrollback UI anywhere in src/ui.  
  Recommendation: Load SearchAddon per pane and add a find bar bound to a chord in TerminalPane.handleKey (with decorations for matches), or remove the dependency and move addon-search to the 'later' list in docs/01.  
  Why: Panes hold 10k lines of scrollback with no way to find text in them — a core terminal affordance for reviewing long agent transcripts; the dependency is dead weight and the docs overpromise.

- **[MEDIUM · behavior-mismatch] Multi-line paste executes immediately in non-bracketed shells (Windows default shells)**  
  Where: `src/ui/core/clipboard/clipboard-port.ts:236`  
  Evidence: sanitizePaste (clipboard-port.ts:236-239) converts every \n to CR and only wraps in ESC[200~/201~ when the foreground program enabled bracketed paste; TerminalPane.handleNativePaste (terminal-pane.ts:860) writes the result straight to the PTY. cmd.exe and Windows PowerShell 5.1 never enable bracketed paste.  
  Recommendation: In handleNativePaste, when term.modes.bracketedPasteMode is false and the payload contains a newline, show a one-shot confirm (Windows Terminal's model) or at minimum strip the trailing newline before writing; keep the bracketed path unchanged.  
  Why: The code's own comment names the hazard ('NEWLINES EXECUTE') but the fix only covers opt-in shells: a 3-line paste runs instantly in a cmd/PS5 pane on Windows while macOS zsh holds it inert — a Win/mac divergence against the parity promise. (confidence: medium)

- **[MEDIUM · test-gap] Scroll-anchor logic has no unit tests; smoke only fires composed synthetic chords**  
  Where: `src/main/smokes/panescroll-smoke.ts:373`  
  Evidence: tests/unit has pane-fit and dpr-port tests but nothing for pane-anchor's gesture/intent machine; panescroll-smoke.ts:373 dispatches single KeyboardEvents with shiftKey pre-set — a real keyboard emits a separate bare 'Shift' keydown first, which no test ever sends.  
  Recommendation: Extract createPaneAnchor's decide/onKey logic behind a unit-testable seam (fake Terminal with viewportY/baseY), and add a smoke step dispatching keydown 'Shift' then 'PageUp' from a scrolled-up viewport, asserting no jump to bottom.  
  Why: This blind spot is why the bare-Shift stick() bug passes the PANESCROLL gate: the core invariant 'only a real gesture may move the viewport' is tested only with synthetic event shapes that skip modifier-prefix keydowns.

- **[LOW · gap] SerializeAddon loaded in every pane but TerminalPane.serialize() has no caller**  
  Where: `src/ui/features/terminal/terminal-pane.ts:2222`  
  Evidence: serializer is constructed (terminal-pane.ts:99) and loaded (line 186), and serialize() defined at 2222-2224, but a repo-wide grep for callers finds none — only grid-layout's unrelated serialize(). The daemon's raw scrollback is the actual persistence source.  
  Recommendation: Either surface it (a 'Save transcript…' entry in buildMenu writing serializer output to a file) or drop the SerializeAddon load and the serialize() method until the snapshot feature lands.  
  Why: Dead API loaded per pane invites drift; the docs' 'scrollback snapshots' use case (export/save transcript) is unreachable by users despite the machinery being in place.

- **[LOW · docs-drift] docs/05 points at src/main/milestone-smoke.ts; the budget lives in src/main/smokes/**  
  Where: `docs/05-perf-budget.md:10`  
  Evidence: docs/05-perf-budget.md:10 says 'Source of truth: BUDGET in src/main/milestone-smoke.ts'; the file does not exist — the BUDGET constant (which does match the documented table: 16/150/30/300/12) is at src/main/smokes/milestone-smoke.ts:32-43.  
  Recommendation: Update docs/05-perf-budget.md line 10 to src/main/smokes/milestone-smoke.ts.  
  Why: A stale source-of-truth pointer in the perf-budget law sends contributors to a missing file; values are in sync today but the pointer will not catch future drift.

- **[LOW · improvement] WebGL retry budget never re-arms while a pane stays visible**  
  Where: `src/ui/features/terminal/pane-webgl.ts:165`  
  Evidence: onContextLoss retries only while glLosses <= 3 (pane-webgl.ts:165); glLosses resets solely in onShow (line 87). A pane that stays visible through 4 context losses (driver reset, cap pressure) never retries until its workspace is hidden and re-shown.  
  Recommendation: Decay glLosses on a timer (e.g. reset after 60s without a loss) or re-arm one retry on window focus, keeping the gl.context_lost telemetry as is.  
  Why: docs/05 promises 'a pane can degrade, never die' with bounded re-acquire; a long-lived focused pane silently stays on the slower DOM renderer for the rest of the session even after the GPU recovers, eroding the minWebglVisible wedge metric. (confidence: medium)

## pty-daemon  (implemented: yes)

> Expected: A detached PTY host owning every pane's node-pty, surviving main crashes and app restarts, serving thin clients over a token-authed socket/pipe with a versioned protocol, cold-start restore, orphan sweep, idle shutdown and cross-version migration (docs/01 §2, ADR 0006).

- **[HIGH · bug] [✓] Daemon pane close does a bare pty kill, not a process-tree kill**  
  Where: `src/pty-daemon/session.ts:923`  
  Evidence: PaneSession.kill() calls this.proc.kill() (session.ts:923; killAll at :1216). The in-proc backend instead calls killPtyTree (pty.service.ts:353, :368), whose module says a bare kill 'leaves the agent running headless' on Windows and needs a group signal on POSIX (process-tree.ts:8-16).  
  Recommendation: Use killPtyTree from @backend/platform/process-tree (type-only node-pty import, passes check-pty-seam) in session.ts:923 and :1216. Add a gate asserting a grandchild spawned in a pane is gone after close on the daemon path.  
  Why: docs/01:30-32 promises a whole-tree kill on pane close, and the daemon is THE default backend. daemon-migrate.ts:13-15 also retires the old daemon assuming its agents end there; orphans mean duplicate live agents after an update.
  Verifier: Traced kill path: daemon-relay.ts:470 -> transport.ts:224 -> session.ts:1320 -> bare proc.kill() (session.ts:1026; killAll :1330). No killPtyTree in pty-daemon; vendored node-pty skips console-list kill under useConptyDll (default). Cited lines stale (1026 not 923). Severity high stands.

- **[HIGH · bug] [✓] No backpressure: a stalled client grows the daemon heap without bound**  
  Where: `src/pty-daemon/session.ts:682`  
  Evidence: Each pty chunk is fanned synchronously to subscribers (session.ts:682) and written straight to the socket ignoring the return value (transport.ts:85). Nothing in src/pty-daemon or daemon-client.ts calls proc.pause()/resume() or reads writableLength — a repo-wide drain/pause search finds no hit.  
  Recommendation: In transport.ts:113-134 check sock.write()'s return: on false pause the pty (new PaneSession.pauseOutput wrapping proc.pause()), resume on 'drain', ref-counted across subscribers; past ~8 MB queued, unsubscribe and destroy that socket.  
  Why: The daemon owns every pane, so its OOM kills them all. A build log or `yes` in one pane while main is blocked (sync git op, suspend, the wedged pipe the heartbeat exists for) queues unbounded buffers. docs/05 budgets only the renderer heap.
  Verifier: Traced session.ts:709 fan-out -> transport.ts:85 write, return ignored; no pause/drain/cap anywhere. But wedged-pipe trigger is bounded: client heartbeat (daemon-client.ts:485-488) destroys sock at ~25s and transport.ts:462-469 frees the queue; suspend halts daemon too. Corrected severity: medium.

- **[HIGH · behavior-mismatch] [✓] Pid-recycling defenses are Windows-only; macOS can wedge the daemon permanently**  
  Where: `src/pty-daemon/lifecycle.ts:40`  
  Evidence: ownerHoldsLock returns true for any live pid off Windows (lifecycle.ts:40); pipeAlive is a no-op off Windows (pid.ts:32), so endpointLive trusts isAlive alone (daemon-client.ts:65). lifecycle.ts:33-37 names the exact hazard and solves it only for Windows.  
  Recommendation: Add socketAlive(address) in lifecycle.ts that net.connect()s the unix socket and treats ENOENT/ECONNREFUSED as dead; use it in ownerHoldsLock (same 30s grace) and in daemon-client.ts endpointLive beside pipeAlive.  
  Why: Win/macOS parity is a core promise. After a SIGKILL a recycled pid makes daemon.lock un-takeover-able on macOS (index.ts:60 exits, ensureDaemon times out, boot degrades to in-proc), or ensureDaemon:252 keeps returning a dead endpoint. (confidence: medium)
  Verifier: Traced lifecycle.ts:40, pid.ts:32, daemon-client.ts:65/252/304, relay reconnect, boot fallback: no guard clears stale lock/endpoint on macOS pid recycle; connect failure never invalidates them. Corrected severity: medium — needs SIGKILL + rare pid reuse, self-heals, in-proc fallback works.

- **[HIGH · bug] `notify`/`kill`/`shutdown` take any pane id from any authed client, unbound**  
  Where: `src/pty-daemon/transport.ts:222`  
  Evidence: case 'notify' calls target.applyNotify(m.event) with no credential (transport.ts:219-226); 'kill' is sessions.remove(m.id) (:216); 'shutdown' needs only auth (:412). boundToPane (:143) is used only by mail-send/claim/release; cwd-report/approve check inline (:233, :370). bin/mogging.mjs:1191 exposes --pane.  
  Recommendation: Route notify and kill through boundToPane (transport.ts:143) with the target's MOGGING_PANE_TOKEN and drop --pane from bin/mogging.mjs notify. Give main's house-notify (mcp-endpoint.ts:234, services.ts:57) and shutdown a separate app-only secret.  
  Why: protocol.ts:14-21 states the broken rule: pane ids are public and every pane reads the endpoint file. `mogging notify --pane <sibling> --event done` forges a sibling's verdict; usage-limit drives failover; a raw kill ends another agent.

- **[MEDIUM · bug] createLineFramer has no max frame length and runs pre-authentication**  
  Where: `src/contracts/daemon/protocol.ts:493`  
  Evidence: createLineFramer appends every chunk to an unbounded string (protocol.ts:493), splitting only on '\n'. The daemon feeds raw socket data into it before auth (transport.ts:450 -> :419); the sole bound is the 3s auth timer at :90-92.  
  Recommendation: Add a max-frame guard (e.g. 1 MB) inside createLineFramer that drops the buffer and signals the caller; have transport.ts destroy the connection when it trips, and cap concurrent unauthenticated connections in the server callback (transport.ts:73).  
  Why: Any local process that can open the pipe/socket — including every pane, which holds MOGGING_DAEMON_ENDPOINT — can push a newline-free stream for the whole auth window and OOM the daemon, taking every pane with it.

- **[MEDIUM · bug] connect()'s welcome timeout leaks an authenticated socket into the daemon**  
  Where: `src/main/daemon-client.ts:429`  
  Evidence: The 8s welcome timeout rejects via settle() without destroying the socket (daemon-client.ts:429; settle at :422-427 only clears the timer). `hello` was already sent on 'connect' (:441-450), so the daemon counted the client (transport.ts:429-431) and keeps it.  
  Recommendation: Call sock.destroy() and clear this.sock before rejecting in the timeout branch at daemon-client.ts:429 (and in the 'error' reject arm), or route every non-resolve settle through this.dispose().  
  Why: Each timed-out attempt (a daemon cold-restoring 16 panes can exceed 8s) leaves a phantom authed client: index.ts:111 never idle-reaps, and inflated otherClients permanently disarms the build-stamp retire (daemon-client.ts:273).

- **[MEDIUM · bug] The run-root sweep can delete a still-starting older daemon's runtime dir**  
  Where: `src/main/daemon-sweep.ts:63`  
  Evidence: sweepRunRoot judges liveness only by endpoint.json's pid and rmSync's the dir when it is missing (daemon-sweep.ts:63-77). But the daemon takes daemon.lock first (index.ts:59), then restore() spawns a PTY per persisted pane (index.ts:79), and only writes the endpoint inside listen (index.ts:147).  
  Recommendation: In daemon-sweep.ts:63 also read daemon.lock and keep the dir when that pid is alive or its mtime is inside the same 30s startup grace ownerHoldsLock uses; only 'no endpoint AND no live lock' may count as dead.  
  Why: In that window a concurrently booting newer app deletes the older daemon's lock, sessions.db and socket. On macOS the unlink succeeds silently: its store is gone, clients never find it, and the freed lock permits a duplicate singleton. (confidence: medium)

- **[LOW · gap] POSIX socket files are never unlinked (ADR 0006 stale-socket cleanup missing)**  
  Where: `src/pty-daemon/index.ts:101`  
  Evidence: shutdown() clears endpoint and lock but only calls server.close() (index.ts:101) immediately before process.exit (:105), so libuv's close-time unlink never runs; nothing else removes the per-pid path from lifecycle.ts:30. A crash leaves it too. Windows pipes die with the process.  
  Recommendation: Unlink the socket path next to clearEndpoint() in index.ts:91-94 when platform !== 'win32', and add a startup pass in lifecycle.ts removing daemon-*.sock files whose pid is not alive.  
  Why: ADR 0006:49-50 lists stale-socket cleanup as anti-zombie hardening. Every daemon start leaves a permanent daemon-<pid>.sock in the current version dir, which daemon-sweep never touches; on macOS that plus a recycled pid triggers finding 3.

## panes-layout  (implemented: yes)

> Expected: Split-tree pane layout per workspace: grid templates (1/2/4/6/8/9/12/16), per-seam drag-resize with pane floors, expand trio (full/col/row), workspace tabs/rail, a screen-and-machine pane-capacity budget enforced at every door, DPR-change re-derivation, and focus routing via ports.

- **[HIGH · bug] [✓] Template apply seeds cwds for dense slots 1..N; real slots can be sparse after a pane move**  
  Where: `src/ui/features/workspace/controller.ts:1156`  
  Evidence: applyResolvedLayout calls this.publishPaneCwds(a.meta) with no slots arg (controller.ts:1156), which seeds dense 1..paneCount (controller.ts:481-489 via paneIdForSlot). But apply(n) lands on templateLocals (grid-layout.ts:359-367), which skips any local whose formula id is live in another workspace (a moved-out pane).  
  Recommendation: Pass the real slot set in applyResolvedLayout: this.publishPaneCwds(a.meta, a.layout.peekTemplate(count).map(s => s.local)) — mirroring what create() already does for restored trees with gaps.  
  Why: Move a pane from A to B, then grow A via a template: setPaneCwd overwrites the moved pane's cwd in B with A's root (wrong git chip / launch cwd), and the actual new slot gets no seed, so its shell spawns at the daemon fallback cwd.
  Verifier: Traced applyResolvedLayout: dense publishPaneCwds (481-488) vs sparse templateLocals (grid-layout.ts:359-367); formula id resolves to moved pane, setPaneCwd guard (pane-cwd.ts:55) only blocks agent/process; new slot unseeded, spawns cwd '' (terminal-pane.ts:504). Corrected severity: medium.

- **[MEDIUM · behavior-mismatch] Entitlement maxPanes cap not enforced on template applies (palette, control API)**  
  Where: `src/ui/features/workspace/controller.ts:1163`  
  Evidence: applyTemplate/requestApplyTemplate (controller.ts:1163-1187) go straight to layout.apply(n), which clamps only to the grid budget limit() (grid-layout.ts:360). effectiveMaxPanes (controller.ts:1194-1196) gates split, move, batch-isolate and the reorganize modal — but not this path.  
  Recommendation: In requestApplyTemplate (and requestReorganize's count check), clamp n to this.effectiveMaxPanes(view) and call refusePaneCap when the request exceeds it, before peekTemplate/confirm.  
  Why: Breaks the stated 'ONE cap refusal, quoted identically at every door' (controller.ts:1198): a plan with maxPanes below the grid budget is bypassed by the palette's 'Layout: 16 panes' or `mogging layout --panes 16` (index.ts:749-753).

- **[MEDIUM · bug] Failed applyRegions leaves meta.paneCount inflated, poisoning the persisted layout**  
  Where: `src/ui/features/workspace/controller.ts:1155`  
  Evidence: applyResolvedLayout sets a.meta.paneCount = count BEFORE apply() (controller.ts:1155-1157) and always calls onChange() (persist). applyRegions returns false without touching the tree when templateLocals(count) comes up short (grid-layout.ts:396-397) — capacity can shrink while the reorganize modal sits open.  
  Recommendation: Have the apply callback report success and only set meta.paneCount/seed cwds on success (or re-sync meta.paneCount = a.layout.paneCount after apply()); toast when applyRegions refuses.  
  Why: Persisted state then holds paneCount=count with the OLD tree; on restore parseTree rejects the mismatch (layout-tree.ts:607) and falls back to a template grid of `count` panes — the arrangement is lost and extra shells spawn. (confidence: medium)

- **[MEDIUM · test-gap] Structural tree mutators have zero test coverage (gate and unit tests cover geometry only)**  
  Where: `src/ui/features/layout/layout-tree.ts:228`  
  Evidence: scripts/check-layout-invariants.mjs destructures only allocateSpans/computeLayout/resizeSplitWeights/equalize*/parseTree/serializeTree — grep finds no splitLine, removeLeaf, moveLeaf, insertBeside, moveLeafToRootEdge, swapLeaves, normalize or treeForGrid calls; tests/unit has no layout-tree test either.  
  Recommendation: Add tests/unit/layout-tree.test.ts covering splitLine re-equalize (join vs new line), removeLeaf absorb + last-leaf null, moveLeaf/moveLeafToRootEdge shapes, swapLeaves, and normalize's same-dir merge / 1-child collapse.  
  Why: The README's core contracts — '+ re-equalizes the line', close-absorbs-space, drag-rearrange drops, and normalize's same-dir merge invariant — can silently regress; they underpin every PTY-preserving rearrange.

- **[LOW · docs-drift] Layout README still claims a 16-pane MAX_PANES enforcement that no longer exists**  
  Where: `src/ui/features/layout/README.md:62`  
  Evidence: README.md:60-63: '16 panes is the budget edge; MAX_PANES enforces it'. No MAX_PANES constant exists — only ABS_MAX_PANES=32 (src/contracts/domain/pane.ts:30) and MAX_LEAVES=32 (layout-tree.ts:563); pane-capacity.ts explicitly retired 'a hard 16'. layout-tree.ts:541 also references 'MAX_PANES'.  
  Recommendation: Update README.md's perf section (and the layout-tree.ts:541 comment) to name ABS_MAX_PANES/MAX_LEAVES (32) as the cap, with ~16 as the WebGL-context edge where PaneWebglManager falls back to the DOM renderer.  
  Why: The README is the feature's de-facto behavior spec (docs/01 is thin on layout); a stale hard-cap claim misleads contributors auditing the capacity/WebGL budget and contradicts pane-capacity.ts's model.

## persistence-restore  (implemented: yes)

> Expected: SQLite (better-sqlite3, WAL) persists workspaces, layout tree, per-pane cwd + command, and scrollback; on restart the app restores layout + cwd, repaints scrollback, and relaunches agents via their own resume flags, surviving crashes of UI, main, and daemon.

- **[HIGH · gap] Corrupt app-settings.db permanently bricks workspace persistence (no set-aside recovery)**  
  Where: `src/main/app-settings.ts:30`  
  Evidence: registerAppSettings catches a SettingsStore open failure and sets store=null (app-settings.ts:32-36); every load/save then fails and every later boot re-throws identically. The daemon's openSessionStore (src/pty-daemon/index.ts:37-51) handles this exact case: rename corrupt file aside, reopen fresh.  
  Recommendation: Mirror openSessionStore in registerAppSettings: on constructor throw, rename app-settings.db (plus -wal/-shm) to .corrupt-<ts>, retry a fresh open, and surface a one-time 'settings were reset' notice.  
  Why: One corruption event kills workspace/layout/board/profile persistence forever ('the file does not heal' is the daemon's own rationale). The renderer only shows a paused banner; the sole recovery is hand-deleting the db.

- **[MEDIUM · bug] Pane row skipped during restore is permanently deleted by the first full persist**  
  Where: `src/pty-daemon/session.ts:1170`  
  Evidence: restore() catches a spawn throw and skips the row (session.ts:1170-1175, comment admits it is 'dropped on the next persist'); the first persist has storeSynced=false so it runs savePanes(snapshotAll()) from LIVE panes only (session.ts:1001-1004), which DELETEs all rows and reinserts (session-store.ts:100-107).  
  Recommendation: Seed skipped rows into the first full savePanes (keep them inert, as requestedCwd keeps a missing cwd), or drop a row only after it fails restore on a later boot too; add a smoke that a spawn-throwing row survives one restart.  
  Why: Trigger: spawn ENOENT at boot (ssh/shell transiently off PATH, AV blocking children). Within ~2s the row, remote identity, and up to 100k chars of scrollback are erased — the same transient case requestedCwd deliberately protects.

- **[MEDIUM · bug] Corrupt-store set-aside leaves sessions.db-wal/-shm behind for the fresh database to adopt**  
  Where: `src/pty-daemon/index.ts:44`  
  Evidence: openSessionStore renames only dbPath (fs.renameSync(dbPath, aside), index.ts:44) before 'return new SessionStore(dbPath)' (index.ts:49). In WAL mode the -wal/-shm sidecars keep their original names, so opening the fresh db at that path finds the corrupt store's hot WAL and attempts recovery from its frames.  
  Recommendation: In openSessionStore, rename (or delete) dbPath + '-wal' and dbPath + '-shm' alongside the main file before reopening.  
  Why: Recovery can replay the quarantined bytes into the new store, or fail the second open — uncaught, so the daemon dies at boot, the exact outcome this helper exists to prevent. The set-aside evidence file is also incomplete without its WAL. (confidence: medium)

- **[MEDIUM · bug] Persisted scrollback tail cut without trimTornStart — torn escape/surrogate on repaint**  
  Where: `src/backend/features/workspace/session-rows.ts:55`  
  Evidence: paneToRow does p.scrollback.slice(-PERSISTED_SCROLLBACK_CHARS) with no tear trim (session-rows.ts:55); pane-shared.ts:18-28 guards the live ring against exactly this ('a blind .slice can land mid escape sequence or between surrogate halves'). Restore seeds the raw persisted string into the buffer (session.ts:453).  
  Recommendation: Wrap the persist cut: scrollback: trimTornStart(p.scrollback.slice(-PERSISTED_SCROLLBACK_CHARS)) in paneToRow, and relax the exact-length assertion at tests/unit/session-rows.test.ts:54.  
  Why: Any pane past the 100k persisted cap (live cap 200k, so the cut is routine) restores after a crash with an escape tail rendered as literal text or a lone surrogate at the top of the repaint — the garbling trimTornStart exists to avoid.

- **[MEDIUM · test-gap] No unit test bites on the SQL layer: column lists and migrations are smoke-only**  
  Where: `src/backend/features/workspace/session-store.ts:21`  
  Evidence: tests/unit/session-rows.test.ts and workspace-rows.test.ts cover only the pure row mappings. The hand-written PANE_COLUMNS/PANE_UPSERT lists (session-store.ts:21-34), addColumnIfMissing migrations (db-migrate.ts:14-21), and savePanes vs applyPaneChanges (session-store.ts:100-121) have no unit-tier test.  
  Recommendation: Add a vitest suite opening SessionStore on a temp file: create the pre-migration panes schema, reopen, assert a fully-populated PersistedPane round-trips; assert savePanes then applyPaneChanges parity row-for-row.  
  Why: The paneIds lesson (workspace-rows.ts:4-10) can recur a layer down: a new field keeps mapping tests green while the SELECT list or upsert drops its column. Legacy-schema migration and full-vs-delta parity are core invariants.

- **[LOW · improvement] Cold-start restore hard-codes platform:'posix' onto the restored remote spec**  
  Where: `src/pty-daemon/session.ts:1143`  
  Evidence: restore() builds spec.remote as { ...p.remote, platform: 'posix', ... } (session.ts:1143), stomping the persisted dialect the remote_platform/remote_shell columns exist to preserve ('a restored pane comes back speaking the same language' — session-store.ts:85-87, session-rows.ts:88).  
  Recommendation: Delete the platform: 'posix' override in restore() and let the persisted p.remote.platform ride the spread — ensure()/rowToPane normalizers already enforce what is currently spawnable.  
  Why: Harmless today only because normalizeRemoteConnection refuses non-posix (contracts/domain/remote.ts:72). Once windows passes the seam (remotes.ipc.ts:24-28), restore would silently send a POSIX bootstrap to a PowerShell host.

- **[LOW · docs-drift] Docs promise persisted command-block history; no store implements it**  
  Where: `docs/01-architecture.md:42`  
  Evidence: docs/01-architecture.md:42-43 lists 'command-block history' in the Phase-1 SQLite persistence set, but sessions.db has only panes+workspaces tables (session-store.ts:42-66) and app-settings.db has no block table (settings-store.ts:41-131); blocks exist only in the renderer from live OSC 133.  
  Recommendation: Scope the doc line to 'planned' / drop 'command-block history', or persist block boundaries alongside the pane row if still intended.  
  Why: After a restart, blocks survive only as far as the repainted scrollback tail; per-command history (boundaries, exit codes) is lost, so the doc oversells restore fidelity.

## agent-launcher  (implemented: yes)

> Expected: Detect the five first-party agent CLIs on PATH, install missing ones via the provider's own command (guided one-click setup), build shell-correct launch commands for cmd/PowerShell/POSIX identically on Windows and macOS, and surface sign-in state from known homes — never brokering provider auth.

- **[MEDIUM · bug] InstallService verdict re-detects on a stale process PATH, unlike SetupService**  
  Where: `src/backend/features/agents/install.ts:98`  
  Evidence: install.ts:98 onExit computes `const installed = isOnPath(adapter.bin)` on the boot-era process PATH; setup.ts:216 deliberately runs `await applyLivePathToProcess()` before the same check. The install ran in a login shell whose PATH the app process may not share.  
  Recommendation: In InstallService's onExit handler, await applyLivePathToProcess() (a fresh refresh, not the cache) before the isOnPath verdict — exactly what SetupService.verify already does — keeping the tailNote as residual fallback.  
  Why: A successful install into a bin dir created after boot (first ~/.npm-global/bin, rc-only PATH entry) reports 'failed' despite exit 0; refreshAgentSettingsForCli (agents.ts:42, success-only) is skipped.

- **[MEDIUM · bug] Setup cancel only observed between steps; killed cmd wrapper orphans npm on Windows**  
  Where: `src/backend/features/agents/setup.ts:113`  
  Evidence: cancel() (setup.ts:113-118) sets a flag and kills only the registered child; run() checks the flag solely at :193 after an exec completes. capture() children (:524) are never registered, exec() spawns without checking it, verify() (:214) never checks it, and child.kill() hits spawnTool's cmd.exe wrapper, not npm.  
  Recommendation: Check this.cancelled at the top of exec() and at step boundaries in run()/verify(); register capture() children; on Windows kill the process tree (taskkill /T /F or the existing killPtyTree pattern) instead of ChildProcess.kill on the wrapper.  
  Why: A cancel during applyLivePathToProcess or the npm-prefix capture lets the next 15-minute npm install start and finish before 'Cancelled.' appears; on Windows, killing the cmd.exe wrapper orphans the real installer, which keeps writing.

- **[MEDIUM · improvement] Session pooling runs synchronous recursive copies on the main process during launch**  
  Where: `src/main/agents.ts:135`  
  Evidence: agents.ts:135 calls poolProviderSessions inside the agents:command IPC handler; session-pool.ts does statSync/copyFileSync per transcript (:76-95) and recursive cpSync for claude sidecar dirs (:100-106) across every known profile home, up to 30 days of files (:37).  
  Recommendation: Move poolProviderSessions to async fs (fs.promises, bounded concurrency) or a worker thread, and/or cap copied bytes per pool; it is already documented best-effort, so completing it off-thread before returning the command keeps semantics.  
  Why: Main relays daemon pty traffic and all IPC; a first failover in a busy workspace blocks the main event loop for the whole copy, stalling pane output against the docs/05 frame-gap budget at launch time. (confidence: medium)

- **[MEDIUM · behavior-mismatch] Launcher's cmd quoting bypasses the hardened in-repo cmd codec (%VAR% expands)**  
  Where: `src/backend/features/agents/launch.ts:49`  
  Evidence: cdPrefix emits `cd /d "${cwd}" && ` raw and envPrefix emits `set "K=V" && ` (launch.ts:49,68) — a defined %NAME% pair inside quotes expands at a cmd prompt (acknowledged at :6-12). Yet quotePathForShell's %-splicing is proven against real cmd.exe (shell-quote.test.ts:36-38).  
  Recommendation: Reuse quotePathForShell (cmd flavor, contracts/domain/shell-quote.ts) for the cmd cdPrefix cwd, and route cmd env values through the same %-splice/control-strip codec, replacing the 'accepted residual' comment with coverage.  
  Why: A workspace path like C:\proj\100%TEMP%x launches the agent in a different, expanded directory on Windows while working verbatim on macOS — a parity-promise divergence the repo already has a measured fix for, one import away.

- **[MEDIUM · test-gap] buildLaunchCommand's three-dialect quoting has zero unit tests**  
  Where: `src/backend/features/agents/launch.ts:102`  
  Evidence: No test imports buildLaunchCommand/envPrefix/cdPrefix/shellArg (only two smokes reference it). cd-path.test.ts covers the wizard's cd box and shell-quote.test.ts covers drop-a-file quoting — neither exercises the launcher's psq/shq dance, `Set-Location -ErrorAction Stop`, `set "K=V" &&`, or RESUME_SESSION_ID gating.  
  Recommendation: Add tests/unit/agent-launch.test.ts asserting full command strings per LaunchTarget (posix/powershell/cmd) with quote-bearing cwds, env values holding $/backtick/quotes, exact vs bare resume, and a non-UUID resumeSessionId falling back to the bare flag.  
  Why: This is the Windows-quoting-fidelity invariant the feature promises; a regression in envPrefix or shellArg would type a broken or wrong-directory launch into every pane and no unit gate would catch it.

- **[MEDIUM · behavior-mismatch] Claude probe's signed-in marker (.credentials.json) never exists on macOS**  
  Where: `src/backend/features/agents/logins.ts:54`  
  Evidence: logins.ts:54: `signedIn = existsSync(join(home, '.credentials.json')) || email !== undefined`. Claude Code stores OAuth credentials in the macOS Keychain, not a file, so on macOS the probe depends entirely on oauthAccount.emailAddress appearing in .claude.json.  
  Recommendation: On darwin, when no email is found treat the missing credentials file as unknowable (return null so probeLogin yields undefined) or add a Keychain presence check; document the platform split in the probe comment.  
  Why: A signed-in macOS user whose .claude.json lacks oauthAccount reads as a CHECKED signedIn:false, so agents.ts:189 offers needsSignIn to a user who is already signed in, while Windows/Linux read the same state correctly. (confidence: medium)

- **[LOW · gap] OpenCode has a sign-in verb but no login probe**  
  Where: `src/backend/features/agents/logins.ts:91`  
  Evidence: PROBES (logins.ts:91-95) covers claude/codex/gemini only, while the registry gives opencode `signIn: { shell: 'opencode auth login' }` (registry.ts:216) and homes.ts already knows its default data home (~/.local/share/opencode, where the CLI keeps auth.json).  
  Recommendation: Add an opencode probe checking auth.json existence in its known data home (email optional), following the codex pattern of letting the blob die in function scope; keep aider probe-less as documented.  
  Why: probeLogin returns undefined (unknowable) for opencode, so agents.ts:189 can never set needsSignIn and discoverLogins cannot surface an opencode account — first-run sign-in guidance the other npm CLIs get is silently absent.

## agent-state-attention  (implemented: yes)

> Expected: Derive one per-pane AgentState (unknown/busy/attention/done/idle) from OSC 9/99/777/133/7/633 escapes plus hook verdicts under the "verdict law", and route it to pane dots, rail rings/badges, toasts, OS badge/flash and webhooks, event-driven within the perception budget.

- **[MEDIUM · behavior-mismatch] In-proc fallback backend silently loses the whole layer-B verdict channel**  
  Where: `src/backend/features/terminal/pty.service.ts:159`  
  Evidence: In-proc spawn env sets only MOGGING_PANE_ID/MOGGING_PANE_TOKEN (pty.service.ts:159-161); MOGGING_DAEMON_ENDPOINT is injected only by the daemon (pty-daemon/index.ts:77). Hooks no-op without it (notify-hook.ts:439). boot.ts:300 says panes 'work normally, but cannot survive an app restart'.  
  Recommendation: Give the in-proc backend a notify ingress (main-hosted endpoint file feeding PtyService trackers), or at minimum change the boot.ts:300 degraded message and docs/21 §2 to say completion/attention hooks are inactive in-proc.  
  Why: In in-proc mode (MOGGING_INPROC or daemon start failure) no done/turn-start/needs-input verdict can ever land: dots never green, hook reds never fire — contradicting docs/21 §2 ('every launch wires layer B') and the health message.

- **[MEDIUM · bug] Subagent tool activity cancels the deferred done, stranding the pane busy**  
  Where: `src/backend/features/agent-state/activity.ts:255`  
  Evidence: notify('busy') unconditionally sets deferredDone=false (activity.ts:254-257). During fan-out the main has already Stopped, so any busy re-assert (Claude PostToolBatch, OpenCode tool.execute.after — both fire for subagent tool work) is a subagent's, yet it discards the main's deferred verdict.  
  Recommendation: In activity.ts notify('busy'), keep deferredDone intact while pendingSubagents > 0 (a subagent's tool work is not evidence the main resumed), and add an ATTENTION-smoke assert: busy during fan-out, then last subagentStop still redeems done.  
  Why: turn-start, subagent-start, done(deferred), busy(subagent tool), subagent-stop leaves the pane busy with nothing to redeem; if no second Stop arrives, the green promised by the subagent-gate design (docs/21 §1) is lost until the next turn. (confidence: medium)

- **[LOW · bug] OSC introducer aborting a torn OSC is swallowed; next OSC can ring a false bell**  
  Where: `src/backend/features/agent-state/osc-parser.ts:101`  
  Evidence: In the pendingEsc branch while inOsc/discarding (osc-parser.ts:101-114), only ST_TAIL and ESC are recognized; OSC_INTRO (']') merely discards the old OSC. A following 'ESC ] 9;text BEL' after an unterminated OSC scans as ground and its BEL fires the bell event (line 139).  
  Recommendation: In the pendingEsc-inside-OSC branch of osc-parser.ts push(), handle code === OSC_INTRO by starting a fresh OSC (inOsc=true, discarding=false, buf='') instead of dropping to ground; add a torn-OSC case to oscOverflowAsserts in attention-smoke.  
  Why: A process killed mid-OSC write (pane kill/^C) followed by any BEL-terminated OSC yields a raw bell, so tracker.bell() latches a false red 2 s later if no done contradicts it — a manufactured attention, the class this hardening targets.

- **[LOW · bug] Webhook bridge never forgets a dead pane; reused id can suppress first needs-you**  
  Where: `src/main/event-bridge.ts:209`  
  Evidence: lastState (event-bridge.ts:209) is only ever set (lines 214-215), never deleted. daemon-relay onExit cleans lastStates/presence (daemon-relay.ts:145-148) but not this map, so a pane that exited while 'attention' leaves prev='attention' behind for its reused id.  
  Recommendation: Export an onPaneGoneForBridge(paneId) from event-bridge.ts that deletes the lastState entry, call it from daemon-relay.ts onExit beside notePaneGone (line 148), and assert it in attention-smoke's bridgeAsserts.  
  Why: Pane ids are reused; if a successor's first gate-passing state is attention (e.g. a held-bell latch), the edge test prev !== 'attention' fails and its needs-you automation event is silently dropped — wire disagrees with pane (ALERTAGREE).

- **[LOW · docs-drift] Docs claim oversized-OSC discard at >4 KB; the real cap is ~295 K characters**  
  Where: `src/backend/features/agent-state/osc-parser.ts:82`  
  Evidence: MAX_OSC = PANE_CWD_MAX * 9 + 64 (osc-parser.ts:82) with PANE_CWD_MAX = 32_768 (contracts/domain/cwd.ts:10) ≈ 295,000 chars. docs/21 §3 states oversized bodies '(vim/tmux OSC 52 clipboard > 4 KB) are discarded including their BEL terminator'.  
  Recommendation: Correct docs/21 §3 to the real MAX_OSC formula, or cap non-633 OSC bodies at a small bound (e.g. 4 KB) while keeping the large allowance only for the Mogging 633 cwd dialects that need PANE_CWD_MAX.  
  Why: A 5-200 KB OSC 52 write is fully buffered byte-by-byte on the PTY hot path, not discarded as documented (bells stay safe only because code 52 is ignored at flush). Doc and enforced bound differ ~72x; readers size against the wrong number.

- **[LOW · bug] Renderer reload double-records a standing done in the completion history**  
  Where: `src/ui/core/attention/completions.ts:30`  
  Evidence: recordCompletion fires on every transition INTO done (attention-port.ts:91). A reload rebuilds the port empty, and the welcome/stateSync replay of a still-standing 'done' transitions unknown→done, recording a second completion stamped Date.now() (completions.ts:30-35).  
  Recommendation: Mark replayed states (welcome/stateSync pull in terminal-pane.ts applyState) as sync rather than transition — e.g. a setPaneState 'replay' flag that skips recordCompletion — or document the session-scoped inaccuracy.  
  Why: The dedup comment ('cannot record it twice') only holds within one renderer session — after a reload the pane's history menu shows the same finish twice, the second timestamped at reload time, misstating what the agent did and when. (confidence: medium)

## command-blocks  (implemented: partial)

> Expected: Docs Phase 2 promises Warp-style command blocks driven by OSC 133 boundaries: collapsible per-command sections with exit-code color, timestamps, and search, degrading gracefully on shells without integration.

- **[HIGH · bug] [✓] Alt+Up/Down block jump is snapped back to bottom by the scroll anchor**  
  Where: `src/ui/features/terminal/pane-anchor.ts:216`  
  Evidence: Anchor's onKey treats a key as a scroll gesture only with shift/ctrl/meta (pane-anchor.ts:216) and excludes altKey from the typing branch (:217). blocks.jump() (block-tracker.ts:165-173) calls scrollToLine; onScroll outside a gesture window runs pin()->repin scrollToBottom (pane-anchor.ts:121-123,186).  
  Recommendation: In terminal-pane.ts:836-838 release the anchor before jumping (expose anchor.noteGesture(true) or a leave() API), or add alt-modified ArrowUp/Down to the gesture branch at pane-anchor.ts:216; assert it in blocks-smoke.  
  Why: A pane's default state is following. Press Alt+Up (terminal-pane.ts:835-838): the viewport jumps to the previous block, then the anchor re-pins to bottom on the next frame, so keyboard block nav is visibly broken.
  Verifier: Traced: anchor onKey (pane-anchor.ts:226-227) ignores Alt chords, so no gesture window; blocks.jump scrollToLine fires onScroll/onRender -> pin -> repin scrollToBottom (pane-anchor.ts:121-123). No guard exists on this path. Severity high is fair.

- **[HIGH · gap] Promised block search has no user-facing entry point**  
  Where: `src/ui/features/blocks/block-tracker.ts:149`  
  Evidence: find() (block-tracker.ts:149-155) is only called from the dev handle findBlocks (terminal-pane.ts:2207-2208) consumed by blocks-smoke; jumpTo() (:158-162) has zero callers. No palette command, find bar, or menu item references blocks.  
  Recommendation: Wire a real surface: a palette command or per-pane find bar that calls BlockTracker.find() and jumpTo() (which is why jumpTo exists), and cover it in the smoke.  
  Why: docs/02-mvp-and-roadmap.md:34 promises search as one of the four block sub-features; it exists only as an internal API reachable via the smoke's __mogging handle, so users cannot search blocks at all.

- **[MEDIUM · behavior-mismatch] Timestamps and durations are modeled but never displayed**  
  Where: `src/ui/features/blocks/block-tracker.ts:128`  
  Evidence: startedAt/durationMs are captured (block-tracker.ts:66,104-105) but the gutter tooltip renders only command + exit (:128) and the collapsed strip only command/exit/line-count (:201). No UI reads startedAt/durationMs outside the dev handle (terminal-pane.ts:2203).  
  Recommendation: Render start time and duration in the gutter title (block-tracker.ts:128) and the collapsed strip text (:201), e.g. 'echo hi - exit 0 - 1.2s - 14:03:22'.  
  Why: docs/02:34 lists timestamps as a promised block attribute; today they are dev-handle-only data, so the user-visible feature is missing one of its four promised properties.

- **[MEDIUM · bug] No replay guard: reattach falsifies timestamps and re-captures blocks to brain drafts**  
  Where: `src/ui/features/terminal/terminal-pane.ts:929`  
  Evidence: Daemon reattach replays scrollback including OSC 133 marks; the adjacent agent-exit handler guards this with a grace window (terminal-pane.ts:436-441) but BlockTracker does not: replayed blocks get startedAt=Date.now() at replay (block-tracker.ts:66,104). capturedThrough is a fresh instance field (:929-934).  
  Recommendation: Mark blocks created during the reattach replay window (the pane knows when it is replaying) as replayed with no timestamps, exclude them from emitSessionCapture, or persist the capture high-water mark per pane id across UI lives.  
  Why: After a reattach, historical blocks carry replay-time stamps and ~0 durations, and emitSessionCapture re-sends the whole replayed ladder to the brain, duplicating drafts the comment at :922 says cannot happen. (confidence: medium)

- **[MEDIUM · bug] Huge outputs trim markers to line -1, leaving ghost blocks with wrong covers and jumps**  
  Where: `src/ui/features/blocks/block-tracker.ts:190`  
  Evidence: scrollback is 10000 (terminal-pane.ts:172); xterm sets a trimmed marker's line to -1 (xterm.d.ts:490-493). BlockTracker never checks isDisposed/onDispose: reposition (block-tracker.ts:190-204) computes first=0 for such a block, jump/jumpTo (:158-173) target line -1, list/find keep returning it.  
  Recommendation: Subscribe to startMarker.onDispose when a block is created and prune (or tombstone) the block; additionally filter isDisposed markers in reposition(), jump(), and find().  
  Why: One command emitting >10k lines (a build or test torrent, the stated huge-output focus) trims its own start marker; collapsing it then paints a mislabeled cover over the top viewport rows, and Alt+Up nav dead-ends at line 0.

- **[MEDIUM · behavior-mismatch] Alt+Arrow is swallowed even in panes with zero blocks**  
  Where: `src/ui/features/terminal/terminal-pane.ts:836`  
  Evidence: The Alt+Up/Down branch returns false unconditionally (terminal-pane.ts:836-838), so the shell never receives ESC[1;3A/B even when BlockTracker has no blocks and jump() finds no target (block-tracker.ts:165-173).  
  Recommendation: Have jump() return whether it moved (or check this.blocks?.list().length) and return true (pass the key to the shell) when there is nothing to jump to.  
  Why: Non-conforming shells get the graceful no-blocks fallback for rendering but lose Alt+Up/Down as input; zsh dirhistory, fish and several TUIs bind those chords, eaten for a feature that cannot fire in that pane.

- **[MEDIUM · test-gap] No unit tests for BlockTracker; smoke never exercises jump, cover DOM, or timestamps**  
  Where: `src/main/smokes/blocks-smoke.ts:20`  
  Evidence: blocks-smoke asserts only model facts: count/exits/commands, the collapsed flag, and find() (blocks-smoke.ts:20-39). tests/unit contains no blocks test (grep for 'block' matches unrelated files). Alt+Arrow jump, the .block-collapsed cover, and startedAt/durationMs are asserted nowhere.  
  Recommendation: Add tests/unit/block-tracker.test.ts (exitColor, find, ring-buffer cap, readCommand cursor-row slice) and extend blocks-smoke to dispatch Alt+ArrowUp at the pane body and assert the viewport moved and the collapse cover element renders.  
  Why: The confirmed high bug (anchor snap-back on jump) lives precisely in the untested seam between blocks and the anchor; the gate stays green while the promised nav is broken.

- **[LOW · docs-drift] Stale src/ui/features/command-blocks dir describes an architecture that does not exist**  
  Where: `src/ui/features/command-blocks/README.md:4`  
  Evidence: The dir contains only a README claiming blocks are 'detected in backend/features/agent-state and delivered over a command-block contract slice'; the shipped implementation parses OSC 133 in the renderer (blocks/block-tracker.ts:49) with no contract slice, per blocks/README.md.  
  Recommendation: Delete src/ui/features/command-blocks or reduce its README to a one-line pointer to src/ui/features/blocks.  
  Why: Two feature dirs for one feature, one describing a backend-driven design that was never built, misleads contributors (and this audit's own source listing).

## notify-hooks  (implemented: yes)

> Expected: Agent CLIs raise their pane's attention via `mogging notify`/a generated hook script over the daemon's authed socket; the app wires session-scoped hooks per launch plus global first-party hooks (backup/undo/opt-out) for Claude/Codex/Gemini/OpenCode, with dedupe, no focus steal, and Win/mac parity.

- **[HIGH · behavior-mismatch] [✓] Codex session hooks never wire on macOS: whitespace guard always trips**  
  Where: `src/backend/features/agents/notify-hook.ts:297`  
  Evidence: codexBellArgs skips the `-c hooks.UserPromptSubmit/PostToolUse` overrides when the notify script path has whitespace (`if (!/\s/.test(p))`, notify-hook.ts:297). macOS userData is always under `~/Library/Application Support/...` — a space is guaranteed.  
  Recommendation: When the userData path contains whitespace, copy notify.mjs to a space-free dir (os.tmpdir() has none on macOS) and point the hook command there; the global twin (codexHookCommand, global-hooks.ts:257) already quotes paths without this restriction.  
  Why: Win/mac parity is a product law. On Windows the hooks wire; on macOS every Codex launch silently loses turn-start/busy — the file's own comment says without turn-start a second-turn Codex pane only leaves `done` by a keystroke.
  Verifier: Guard at notify-hook.ts:297 is real; macOS userData always has a space, so session -c hooks always skip. Severity inflated: correct is low. Skip is documented-deliberate (:290-294), done/OSC still wire, and global-hooks.ts:246-269 writes the same hooks to ~/.codex/config.toml, no whitespace limit.

- **[MEDIUM · bug] Gemini/OpenCode per-session generated configs share one fixed file; launches clobber**  
  Where: `src/main/notify-hook.ts:119`  
  Evidence: bellLaunchExtras writes session-scoped content (profile session.runtime/session.tui) into fixed names: writeGenerated('gemini-system-settings.json', ...) at notify-hook.ts:119-121 and writeGenerated('opencode-tui.json', ...) at :131; each pane's env points at the shared path.  
  Recommendation: Make the generated filename per-launch (suffix pane id or a nonce) and garbage-collect stale files on app start; the env var already carries the exact path.  
  Why: Panes launched with different profiles race: the later write can land before the earlier pane's CLI reads its settings, and restarted panes re-read whatever the newest launch wrote — per-session config in one shared mutable file.

- **[MEDIUM · bug] OpenCode tui.json read ignores XDG_CONFIG_HOME, diverging from global wiring**  
  Where: `src/main/notify-hook.ts:130`  
  Evidence: bellLaunchExtras reads user tui from `join(homedir(), '.config', 'opencode', 'tui.json')` (notify-hook.ts:130), while agent-global-hooks.ts:103-104 resolves $XDG_CONFIG_HOME/opencode first — and comments there claim bellLaunchExtras mirrors that resolution.  
  Recommendation: Extract opencodeDir()'s XDG_CONFIG_HOME-aware resolution into a shared helper and use it for the userTui read at src/main/notify-hook.ts:130.  
  Why: With XDG_CONFIG_HOME set (which OpenCode honors), launches merge the wrong file: the user's real tui prefs drop out of the generated OPENCODE_TUI_CONFIG, and Settings status reads a different file than the launch overlay.

- **[MEDIUM · gap] Manual Codex snippet notify=["mogging","notify"] cannot execute on Windows**  
  Where: `hooks/codex/config.toml:23`  
  Evidence: config.toml:23 sets `notify = ["mogging", "notify"]`. On Windows npm installs `mogging` as a .cmd shim (package.json bin), and Codex spawns its notify program without a shell, which cannot run .cmd. The OpenCode manual plugin works around this with shell:true (mogging-notify.js:39).  
  Recommendation: Change hooks/codex/config.toml (and the README Codex row) to recommend `notify = ["node", "<abs>/bin/mogging.mjs", "notify"]` on Windows, or add an explicit Windows caveat about the .cmd shim.  
  Why: Hand-wired Codex on Windows loses the `done` verdict while OSC 9 still chimes, so completions latch red — the exact bug the two-channel pair exists to fix — and the same snippet works on macOS: platform divergence. (confidence: medium)

- **[LOW · improvement] Toast cooldown conflates tones: green 'finished' suppresses red 'needs input' for 20s**  
  Where: `src/ui/features/notify/index.ts:68`  
  Evidence: One lastToast timestamp per pane gates both tones: `if (now - (lastToast.get(paneId) ?? 0) < COOLDOWN_MS) return` (index.ts:68, COOLDOWN_MS=20000) before the attention/done branch.  
  Recommendation: Key the cooldown by (paneId, tone), or let an 'attention' transition bypass a cooldown set by a 'done' toast.  
  Why: A background agent that finishes then blocks on a permission within 20s (e.g. the Board queue pulling the next card) shows no red toast; docs/08 step 4's 'needs you' moment loses its most urgent surface to a less urgent one.

- **[LOW · behavior-mismatch] mogging notify reads stdin before the pane-env guard; generated twin guards first**  
  Where: `bin/mogging.mjs:1322`  
  Evidence: runNotify awaits readStdinType() for needs-input (mogging.mjs:1322-1329) before the `!paneId || !endpointFile` bail at :1331; the generated script exits on missing pane env before its stdin read (notify-hook.ts template, env guard ahead of readStdinType).  
  Recommendation: Move the paneId/endpointFile no-op guard above the stdin read in runNotify (bin/mogging.mjs), matching the generated script's order.  
  Why: Outside a pane, a globally hand-installed Claude Notification hook pays up to 400ms per event in every foreign terminal, and the 'twins by contract' differ in an ordering NOTIFYPARITY's same-output corpus cannot catch.

## worktrees  (implemented: yes)

> Expected: Each agent pane in a git repo gets its own worktree on a random mogging/<slug> branch under <repo>/.mogging/worktrees, created before launch (preflight-gated, partial failure rolls back), never touching HEAD/index; removal is dirty-guarded so agent work is never silently destroyed.

- **[HIGH · bug] [✓] "Remove anyway" after a post-close dirty refusal is a dead code path**  
  Where: `src/ui/features/terminal/terminal-pane.ts:1946`  
  Evidence: remove(true) re-dispatches 'mogging:remove-worktree' on eventHost (terminal-pane.ts:1946-1951), but the listener is on the workspace container (controller.ts:326); after the pane closed the host is detached so the event never arrives. requestClosePane also returns false for a missing pane (controller.ts:814).  
  Recommendation: In remove(), when the pane is no longer mounted, call getBridge().invoke(WorktreeChannels.remove, {repo, path: cwd, force: true}) directly instead of dispatching on the detached pane host.  
  Why: Trigger: pre-check says clean, pane closes, the dying agent's last writes make the backend refuse 'dirty'; the toast's 'Remove anyway' then silently does nothing and the worktree has no in-app removal path left.
  Verifier: Traced: controller closes pane first (controller.ts:401); rebuild detaches host (grid-layout.ts:557); remove(true) dispatches on detached host so sole listener (controller.ts:326) never fires; controller.ts:814 also returns false. Corrected severity: medium — fails safe, git CLI workaround.

- **[HIGH · gap] No Windows long-path handling: worktree add can fail where the repo itself is fine**  
  Where: `src/backend/features/worktrees/index.ts:94`  
  Evidence: Worktrees live at <repo>/.mogging/worktrees/<8-hex> (index.ts:94,134-135), adding ~28 chars to every checked-out path. preflightWorktrees (index.ts:61-92) checks git, HEAD and writability but never path headroom or core.longpaths; no longpaths/MAX_PATH handling exists anywhere in src (grep verified).  
  Recommendation: In preflight on win32, compare longest `git ls-files` path plus the worktree-root prefix against 260 and refuse with an actionable reason (suggest `git config core.longpaths true`), and/or run adds with `-c core.longpaths=true`.  
  Why: On Windows (core.longpaths off by default) tracked paths within ~28 chars of 260 check out at the root but every `worktree add` dies with 'Filename too long' after preflight said ok. macOS is unaffected: platform-divergence law. (confidence: medium)

- **[MEDIUM · bug] Dirty detection fails open when git status errors (1MB maxBuffer, timeout)**  
  Where: `src/backend/features/worktrees/index.ts:214`  
  Evidence: removeWorktree treats a FAILED status as clean: `if (st.ok && st.stdout.trim().length > 0) return {reason:'dirty'}` (index.ts:214-215); listWorktrees same (index.ts:197-198). git() sets no maxBuffer (index.ts:36-39), so Node's 1MB default or the 15s timeout flips st.ok false on a heavily-dirty worktree.  
  Recommendation: Pass a large maxBuffer (e.g. 64MB) in git(); in removeWorktree treat st.ok===false as dirty (fail-safe); have listWorktrees mark dirty=true when the status call fails.  
  Why: Trigger: >1MB of porcelain entries. Pre-check shows clean, pane closes, non-force `git worktree remove` is refused by git; user gets 'error' after 20 retries, never the dirty/'Remove anyway' flow.

- **[MEDIUM · bug] Timed-out or killed `worktree add` leaks a partial worktree, branch and registration**  
  Where: `src/backend/features/worktrees/index.ts:140`  
  Evidence: createWorktree returns {ok:false} on a failed/killed add (index.ts:140-141) with no cleanup; the CHECKOUT_MS kill (index.ts:28) leaves a half-checked-out dir, a mogging/<slug> branch and a registered worktree. Wizard rollback only removes successful creates (wizard/index.ts:574,545-556); no `git worktree prune` in src.  
  Recommendation: On !res.ok in createWorktree, best-effort `git worktree remove --force <path>`, `git branch -D mogging/<slug>` and `git worktree prune` before returning the original error.  
  Why: Trigger: a checkout exceeding 10 min or git dying mid-add during launch. Siblings roll back but the interrupted worktree stays as litter, contradicting the WIZARDFAIL leak-zero intent for this failure class.

- **[MEDIUM · gap] Orphaned worktrees have no in-app inventory or cleanup once their pane is gone**  
  Where: `src/ui/features/terminal/terminal-pane.ts:1919`  
  Evidence: The only removal surface is the pane menu, gated on the pane's cwd matching .mogging/worktrees (terminal-pane.ts:1919-1981). Closing a pane, quitting, or crashing leaves the worktree on disk; WorktreeChannels.list is only consumed by the pre-check (terminal-pane.ts:1929). Branches are kept by design (index.ts:203-205).  
  Recommendation: Add a per-project worktrees panel (rail chip or layout menu) backed by listWorktrees with the same guarded remove flow, and offer cleanup of clean pane-less worktrees when a workspace closes.  
  Why: Normal use (close pane after merge, app restart) accumulates stale worktrees — full checkouts, so gigabytes — plus unbounded mogging/* branches, invisible in-app; users must shell out to `git worktree remove` by hand.

- **[MEDIUM · behavior-mismatch] Detached-HEAD launch records literal 'HEAD' as fork base; review base silently degrades**  
  Where: `src/backend/features/worktrees/index.ts:137`  
  Evidence: createWorktree records `rev-parse --abbrev-ref HEAD` as mogging-base (index.ts:137,147) — on a detached repo that is the string 'HEAD'. readManagedBase does not exclude it (repo.ts:247-258); resolveBaseRef looks for refs/heads/HEAD, fails, and probeBaseDivergence falls back to the default branch (probe.ts:155,223-228).  
  Recommendation: When abbrev-ref returns 'HEAD', write the commit SHA from `git rev-parse HEAD` to mogging-base instead; the SHA passes readManagedBase validation and resolves exactly to the fork point.  
  Why: Trigger: enabling isolation while the repo is at a tag/commit. Docs promise the diff is versus the recorded fork base (docs/08-orchestration.md:33-35), but the base becomes the repo default branch, including commits predating the fork. (confidence: medium)

## review-merge-gate  (implemented: yes)

> Expected: Pre-ship review renders the worktree diff (secrets redacted backend-side, text-nodes only), and the one mutating verb is a clean-repo-gated `merge --no-ff` behind a reviewer sign-off checked at the app, with a typed "merge"/"override" confirmation; conflicts pause for a human.

- **[HIGH · bug] [✓] Redactor misses npm/_authToken, gho_/ghu_/ghs_/ghr_, glpat-, and any _-prefixed key**  
  Where: `src/backend/features/review/redact.ts:41`  
  Evidence: Verified with the module's exact regexes: '_authToken=npm_...', '_password = ...', bare gho_/ghr_ tokens, and glpat- all pass with 0 redactions. PATTERNS (redact.ts:10-23) cover only ghp_/github_pat_; the KV key (line 41) requires an [A-Za-z] start after \b, so _authToken/_password never match.  
  Recommendation: Add patterns \bgh[ousr]_[A-Za-z0-9]{20,}\b, \bnpm_[A-Za-z0-9]{20,}\b, \bglpat-[A-Za-z0-9_-]{16,}\b; change the KV key start to (?<![A-Za-z0-9])([A-Za-z_][A-Za-z0-9_.-]{0,127}); add unit cases in tests/unit/redact.test.ts.  
  Why: Docs 08 promises the scrub covers 'GitHub' tokens and key=value; .npmrc _authToken is one of the most common secrets agents touch, so real credentials reach the renderer and the copy-hunks clipboard.
  Verifier: Ran the exact regexes: all five inputs get 0 redactions. KV (redact.ts:41) needs [A-Za-z] after \b so _-prefixed keys never match; PATTERNS cover only ghp_/github_pat_. Sole scrub on diff path (review/index.ts:138) feeding renderer and copy-hunks clipboard. Severity high stands.

- **[MEDIUM · behavior-mismatch] A pure file rename can never merge through the gate, with a misleading blocker**  
  Where: `src/backend/features/review/index.ts:156`  
  Evidence: Git's default rename detection emits a rename header with no @@ hunks; parsePatch yields hunks:[] so index.ts:156 sets nonRendered, unreviewable=true, and src/main/review.ts:50 hard-refuses (override cannot pass). numstat rename keys (index.ts:128) never match parsePatch paths, so rename+edit shows +0/-0.  
  Recommendation: Pass --no-renames to the numstat and patch git calls in diffWorktree (index.ts:118-119) so renames render as reviewable delete+add hunks with aligned stats keys; add a rename case to reviewsnap-smoke.  
  Why: Rename-only refactors are routine agent output; the gate blocks them permanently as 'binary, mode-only, or other non-rendered changes', pushing users to raw `git merge` in a terminal, around the gate the docs say everything lands through.

- **[MEDIUM · bug] TOCTOU: destination HEAD can move between staleness check and git merge**  
  Where: `src/backend/features/review/index.ts:205`  
  Evidence: mergeBranch verifies branch/baseHead/source at index.ts:186-199, then runs `git merge --no-ff` at :205 with no lock. Two review modals merged near-simultaneously both pass against the same HEAD; the second lands onto a base no review covered. Comment at :175 closes only the source-side race.  
  Recommendation: Serialize merges per repoId with an in-process async mutex in mergeReviewedWorktree (src/main/review.ts:36) and re-run the HEAD/baseHead check inside the critical section; the external-terminal window shrinks to git's own atomicity.  
  Why: The gate's promise is that exactly the reviewed graph lands; concurrent in-app merges (or a terminal commit in the window) silently merge onto an unreviewed destination and still report state 'merged'.

- **[MEDIUM · gap] Merge IPC rejection leaves the confirm footer stuck with no feedback**  
  Where: `src/ui/features/review/index.ts:201`  
  Evidence: The merge invoke at ui/features/review/index.ts:201-252 is `void (...).then(onFulfilled)` with no rejection handler: a rejected bridge invoke (handler not yet registered, structured-clone failure, main-process throw) is an unhandled rejection with no toast, footer left in typed-confirm state.  
  Recommendation: Add a .catch that shows a danger toast ('Merge failed to run') and calls rebuildFooter(), mirroring the diffGuard rationale; optionally reuse createAsyncGuard with a timeout.  
  Why: The diff read got createAsyncGuard for exactly this failure mode (comment at :99-101); the destructive merge click has the same bug unfixed, so the user cannot tell whether the merge ran.

- **[LOW · docs-drift] Override word accepted case-insensitively; contract and docs say VERBATIM**  
  Where: `src/ui/features/review/index.ts:197`  
  Evidence: UI compares input.value.trim().toLowerCase() (line 197) and sends the lowercased value (line 204), so 'OVERRIDE'/'Override' open the gate. docs/09-swarm.md:65 and src/contracts/ipc/review.ipc.ts:63 both say the word must be 'override' verbatim.  
  Recommendation: Drop the .toLowerCase() in both the comparison (line 197) and the payload (line 204) so the renderer enforces the same verbatim word the backend and docs specify.  
  Why: The typed override is the deliberate-human ceremony; the backend check (backend review index.ts:182) is exact and only the UI normalization papers over it, drifting from the stated contract.

- **[LOW · bug] Non-ASCII file paths render as '(unknown)' with zeroed stats**  
  Where: `src/backend/features/review/index.ts:85`  
  Evidence: With git's default core.quotepath=true, a non-ASCII path emits `+++ "b/caf\303\251.ts"`; pathMatch `^\+\+\+ b\/(.+)$` (index.ts:85) and headerMatch both fail on the quoted form, so the file shows as '(unknown)' and the escaped numstat key mismatches to +0/-0.  
  Recommendation: Invoke the diff/numstat/status/ls-files calls in diffWorktree with `-c core.quotepath=false` (prepend in the arg arrays at index.ts:118-121) and unescape quoted `diff --git` headers in parsePatch as a fallback.  
  Why: Agents create non-ASCII filenames routinely in i18n repos; the reviewer sees hunks under a wrong '(unknown)' header, weakening the review the gate depends on (wrong identically on both platforms). (confidence: medium)

## board-kanban  (implemented: yes)

> Expected: Per-project kanban whose cards launch agent CLIs with the card text as the first prompt (fail-closed handoff), live attention/claim chips, main-process one-writer persistence with CAS, and an opt-in queue with hard budgets, self-pause, and an instant kill switch.

- **[HIGH · bug] [✓] Task handoff writes raw multi-line/unsanitized text to the PTY, bypassing paste hygiene**  
  Where: `src/ui/features/board/launch.ts:155`  
  Evidence: launch.ts:114 strips only \r; :155 sends `prompt + '\r'` raw. The app's own hygiene (clipboard-port.ts:223-238: "NEWLINES EXECUTE", \n->CR, bracket-wrap, strip ESC[201~) never runs. Notes allow 10k chars incl. newlines/ESC (board.ts:151-153 only slices length).  
  Recommendation: In startOnCard, pass the composed prompt through sanitizePaste (bracketed per the pane's mode) or strip C0/ESC and normalize \n to CR before the final '\r'; add a BOARDFAIL case for hostile-notes bytes.  
  Why: Multi-line notes and the default-on repomap block submit fragment-by-fragment; agents can create cards, so hostile notes with ESC sequences become keystroke injection into another agent's pane when the queue launches that card.
  Verifier: launch.ts:114 strips only CR; :155 writes raw via daemon-relay.ts:445 to pty.service.ts:315. sanitizePaste runs only in terminal-pane.ts:904/920. Notes unfiltered (board.ts:153). App counts each newline as a submit (agent-proc.ts:100). Guards launch.ts:170, mcp-endpoint.ts:297; severity medium.

- **[MEDIUM · bug] Refused write is silently dropped when a newer write supersedes it (shared saveGuard)**  
  Where: `src/ui/features/board/model.ts:131`  
  Evidence: One saveGuard serves all cards (model.ts:131); patchCard applies optimistically (:139) then reconciles in guard.run. createAsyncGuard skips onSuccess/onError when superseded (async-state.ts:72-80). Refused writes never broadcast board:changed (board.ts:301).  
  Recommendation: Use per-card guards (Map<cardId, AsyncGuard>) or always run the write's reconcile branch regardless of generation; apply the same fix to removeGuard.  
  Why: Drag card X then quickly card Y: if X's patch is refused (conflict/claimed), no toast and no reload run — X keeps its optimistic lane and a wrongly bumped local revision, so the screen silently disagrees with the DB.

- **[MEDIUM · bug] Queue spend-record can clobber a concurrent kill-switch flip (board config is LWW)**  
  Where: `src/ui/features/board/queue.ts:90`  
  Evidence: pullOne re-reads then writes the whole queue object back (queue.ts:74,90-93). patchBoardMeta has no revision check and replaces config wholesale (board.ts:415-431). A disable landing in that window is overwritten with enabled:true; the settings Done save (board-settings.ts:287-299) races the same way.  
  Recommendation: Record spend in main as an atomic verb (append timestamp inside boardTransaction), make renderer config patches field-scoped, or add CAS to patchBoardMeta.  
  Why: Docs/18: the toggle is a hard kill switch and budgets are never under-counted. A lost disable relaunches unattended agents spending real quota; a clobbered launches array under-counts the hourly budget.

- **[MEDIUM · behavior-mismatch] Stale pane bindings persist for non-loaded boards; reused pane ids revive dead claims**  
  Where: `src/ui/features/board/index.ts:242`  
  Evidence: Unbinding on pane death covers only the loaded board (index.ts:242-253). The claim check resolves the holder via workspaceIdForPane (board.ts:249-251), which maps a reused formula pane id (reissued next session) to whichever workspace holds it now; liveBusy and chips key on it (queue.ts:46, card.ts:239).  
  Recommendation: Reconcile in main at board load: clear paneId/workspaceId on any card whose workspaceId no longer exists among persisted workspaces (keep branch, as the pane-death path does).  
  Why: Docs/18: "A dead pane's claim never blocks anyone." A card bound to pane 101 of a since-closed workspace blocks agent writes naming an unrelated pane next session, wears its chips, and occupies a queue maxConcurrent slot if left in Doing. (confidence: medium)

- **[LOW · gap] Queue self-pause counter is renderer-memory only; poke listener never unsubscribes**  
  Where: `src/ui/features/board/queue.ts:37`  
  Evidence: consecutiveFails is a closure Map (queue.ts:37); registerFailure pauses at 2 (queue.ts:140-147) but the count resets on reload/restart — only pausedReason persists. stop() clears the interval but leaves bridge.on(BoardChannels.changed, poke) subscribed (queue.ts:180-189).  
  Recommendation: Persist the consecutive-fail count in the board's queue config next to launches (sanitizeBoardConfig already round-trips that object), and have stop() remove the changed-channel subscription.  
  Why: A provider failing once per session (crash-on-launch, app relaunched each time) never trips the promised self-pause while still spending the hourly budget every session.

- **[LOW · bug] Queue launches compose the first prompt against the ACTIVE workspace's settings**  
  Where: `src/ui/features/board/launch.ts:118`  
  Evidence: startOnCard anchors composeFirstPrompt with the active workspace id (launch.ts:59-61,115-119) while the queue passes only cwd: board.projectKey (queue.ts:122) and ticks every enabled board regardless of which project is in front of the user.  
  Recommendation: For queue launches, derive anchorWorkspaceId from the board's own project (a workspace whose cwd resolves to board.projectKey), or pass null to skip orientation rather than borrow the active workspace's.  
  Why: Project B's card, queue-launched while the user works in project A, obeys A's orient/recall opt-ins and sends B's task text to a recall anchored at A's workspace — the wrong project's settings govern the prompt. (confidence: medium)

- **[LOW · bug] Failed legacy migration is latched as done for the whole session**  
  Where: `src/main/board.ts:76`  
  Evidence: migrateLegacyCards sets migrated = true before the boardTransaction runs (board.ts:74-81); if the transaction throws, all later calls skip migration for the session while pre-v2 cards (boardId NULL) stay invisible to every board listing.  
  Recommendation: Latch migrated = true only after the transaction commits; on throw leave it false so the next board access retries.  
  Why: Docs/18 promises pre-v2 cards migrate on first touch with nothing deleted; a one-off sqlite failure makes them vanish until the next restart, which reads as data loss.

## control-api  (implemented: yes)

> Expected: docs/06 promises tmux-grade scripting: list/send/send-key/capture over the daemon's token-authed local socket ("one control plane, nothing new listens"), a closed key allowlist, documented exit codes (0/1/2/3/4), 0600 endpoint+socket auth, and capture output to caller stdout only.

- **[MEDIUM · bug] Deep-link cwd reaches the renderer unvalidated (unbounded, control chars, UNC)**  
  Where: `src/main/deep-link.ts:31`  
  Evidence: cwdFromUrl (deep-link.ts:27-36) returns the cwd param verbatim — no length cap, no control-char check, no absolute/local requirement — and deliver() sends it to controller.openForCwd (line 109), which creates a workspace and spawns a shell there. sanitizeControl (line 51) caps 1024 chars but allows control chars/UNC.  
  Recommendation: Validate cwd in cwdFromUrl AND sanitizeControl with one shared helper: cap at PANE_CWD_MAX, reject /[\x00-\x1f\x7f]/, require an absolute local non-UNC path — mirroring normalizeRequestedRemoteCwd (src/main/daemon-relay.ts:23-36).  
  Why: A browser-clickable mogging://open?cwd=\\evil\share makes Windows probe/spawn at an attacker UNC path (SMB connect can leak NTLM credentials); oversized or control-char cwd lands in workspace state unfiltered.

- **[MEDIUM · bug] Any mistyped verb silently launches the GUI app instead of erroring**  
  Where: `bin/mogging.mjs:62`  
  Evidence: Verb dispatch falls through to runOpen(argv) (bin/mogging.mjs:62), which resolves the first arg as a directory and fires the open deep link with no existence check (lines 803-815), printing "opening workspace for …" and exiting 0.  
  Recommendation: In runOpen, require statSync(dir).isDirectory() (the check runCwd already does at bin/mogging.mjs:949-954) and exit 2 with usage when the argument is not an existing directory.  
  Why: `mogging captre 3` in a script cold-starts the Electron app with a workspace at nonexistent <cwd>/captre and reports success — against the documented exit-code discipline (shared code 2 = usage).

- **[MEDIUM · test-gap] Deep-link validation (sanitizeControl/controlFromUrl/cwdFromUrl) has zero unit tests**  
  Where: `src/main/deep-link.ts:43`  
  Evidence: grep for sanitizeControl|controlFromUrl|cwdFromUrl across tests/ returns no files. control-smoke.ts drives only daemon verbs; control2-smoke.ts:26 injects pre-validated commands via wc.send(ControlChannels.command, cmd), bypassing URL parsing/validation entirely.  
  Recommendation: Add tests/unit coverage for controlFromUrl/sanitizeControl/cwdFromUrl: wrong scheme/host, unknown verb, out-of-range panes/paneId, oversized cwd, unknown-field dropping, missing per-verb required fields, malformed JSON.  
  Why: This is the app's only injection boundary for OS-wide untrusted input; regressions in the closed-union/bounds logic would ship unnoticed since no gate exercises a malformed URL.

- **[LOW · bug] captureTail returns one line fewer than requested when scrollback ends with a newline**  
  Where: `src/pty-daemon/session.ts:812`  
  Evidence: captureTail (session.ts:812-816) does buffer.split('\n').slice(-cap): a buffer "a\nb\nc\n" splits to ['a','b','c',''] so --lines 2 returns one real line plus the empty trailing fragment.  
  Recommendation: Strip the trailing empty element before slicing: split, pop if last === '', slice(-cap), then re-append the final newline.  
  Why: Scripts requesting exactly N lines (docs example: capture --lines 200 | grep error) get N-1 content lines whenever output ended with a newline — the common case — silently dropping the oldest requested line.

- **[LOW · docs-drift] `mogging list` output has a REMOTE column the docs do not promise**  
  Where: `bin/mogging.mjs:1096`  
  Evidence: runList prints header `ID SIZE STATE REMOTE TITLE` (bin/mogging.mjs:1089-1097); docs/06-control-api.md:11 documents `ID SIZE STATE TITLE`.  
  Recommendation: Update the docs/06 table to the five-column shape (noting REMOTE is empty for local panes), or add a --json mode to list like owners/approvals already have.  
  Why: Scripts written to the documented four-column shape (e.g. awk '{print $4}' for title) mis-read the remote host name as the title whenever a remote pane exists.

- **[LOW · gap] send's pipelined-ping confirmation reports success even when the pty dropped the input**  
  Where: `src/pty-daemon/transport.ts:211`  
  Evidence: 'input' has no ack (sessions.get(m.id)?.write, transport.ts:210-212) and writePty swallows write failures during pty teardown (session.ts:713-721); the CLI's pong (bin/mogging.mjs:1126-1131) only proves frame processing, and its unknown-pane check races the welcome snapshot.  
  Recommendation: Have the daemon ack 'input' (reuse the 'sent' shape: ok=false for unknown pane or failed writePty) and key runSend's exit code off that ack instead of the ping.  
  Why: docs/06:12 says completion is confirmed via the pipelined ping: a pane exiting between welcome and input, or a tearing-down pty, yields exit 0 with nothing typed — a silent scripting failure. (confidence: medium)

## swarm  (implemented: yes)

> Expected: Docs/09 promise a daemon-mediated pull-only mailbox, an exclusive per-workspace ownership ledger with conservative deny-by-default overlap and auto-release on session exit, and a reviewer gate where only an app-named reviewer's sign-off (or a verbatim typed 'override') lets the merge verb land.

- **[MEDIUM · behavior-mismatch] claimsOverlap treats ? and [...] glob segments as literals, granting overlapping claims**  
  Where: `src/contracts/daemon/protocol.ts:179`  
  Evidence: claimsOverlap only special-cases '*'/'**'; line 179 declares divergence when `!x.includes('*') && !y.includes('*') && x !== y`. A segment like 'router?.ts' or 'file[0-9].ts' contains no '*', so it is compared as a pure literal.  
  Recommendation: In claimsOverlap, treat any segment containing '?' or '[' as non-literal (continue the walk like '*'), or reject '?'/'[' in normalizeClaimPattern so unsupported metacharacters exit 2 instead of silently mis-refereeing.  
  Why: Docs promise wildcards deny by default. Pane A claiming "src/api/router?.ts" while pane B owns "src/api/router1.ts" is GRANTED: two agents own the same file — the exact failure the ledger exists to referee.

- **[MEDIUM · bug] approve from the branch's own checkout records a sign-off that never gates a merge**  
  Where: `bin/mogging.mjs:476`  
  Evidence: runApprove defaults base to `git rev-parse --abbrev-ref HEAD` of cwd (line 476). Inside the branch's worktree, base === branch, so baseHead === head and mergeBase === head — valid OIDs, daemon accepts, CLI prints 'approved', exit 0.  
  Recommendation: In runApprove, detect base === branch (or head === baseHead) and refuse with a clear message: pass --base <destination> or run from the destination checkout.  
  Why: approvalMatchesSnapshot (src/main/review.ts:15-27) compares base/baseHead/mergeBase against the app snapshot, so the approval never matches and the merge stays 'ungated' silently. Docs invite reviewing from 'its own checkout'.

- **[MEDIUM · gap] set-role and unapprove lack the v10 pane binding; any agent can demote the reviewer**  
  Where: `src/pty-daemon/transport.ts:311`  
  Evidence: case 'set-role' (311-315) and 'unapprove' (400-407) accept any authed client with no from/token, while mail-send/claim/release/approve demand boundToPane. approve checks mailbox.roleOf (375-378), which set-role rewrites.  
  Recommendation: Extend v10 binding: CLI attaches from/token to set-role when MOGGING_PANE_ID is set; daemon refuses pane senders targeting another pane's role. Restrict unapprove to non-pane-bound (app) clients or an app-only channel like setRole.  
  Why: A rogue agent can `mogging role <reviewer-pane> worker`: the real reviewer's approve exits 6 until a reconnect replays roles; any pane can unapprove legit sign-offs. Fail-closed for the merge, but one agent can break the flow at will.

- **[MEDIUM · gap] Daemon retire/restore silently frees all claimed territory while sessions live on**  
  Where: `src/pty-daemon/ledger.ts:26`  
  Evidence: Claims live only in the in-memory array (ledger.ts:26). The build-stamp retire (protocol.ts:189-197) cold-start restores every pane, and daemon-migrate.ts carries panes/workspaces but no ledger, mailbox, or approvals (grep confirms none).  
  Recommendation: Carry the ledger (and roles) through the migrate/retire hand-off like pane sessions, or after restore push a broadcast mail + owners push announcing the ledger reset so agents re-claim.  
  Why: Docs say claims release 'when its session exits' — but an app-update retire restores sessions that keep running while every claim vanishes. Mid-swarm, all territory silently frees: fail-open for the ledger's one job. (confidence: medium)

- **[MEDIUM · test-gap] swarm-smoke reads endpoint via LOCALAPPDATA only; MOGGING_SWARM gate fails on macOS**  
  Where: `src/main/smokes/swarm-smoke.ts:41`  
  Evidence: endpointPath() is `join(process.env.LOCALAPPDATA ?? '', 'MoggingLabs', 'run', ...)` (40-41). On macOS the runtime base is XDG_RUNTIME_DIR || ~/Library/Application Support (bin/lib/runtime-paths.mjs:13-17); gate-smoke.ts:129 uses runtimeDir() correctly.  
  Recommendation: Replace the hand-rolled endpointPath() with runtimeDir()/endpoint.json from src/main/daemon-client, as gate-smoke.ts already does.  
  Why: Steps 4-5 (auth refusal, version refusal, 500-message ring cap) throw on macOS, failing the whole smoke — the swarm substrate's regression gate effectively runs only on Windows, against the identical-platforms promise.

- **[LOW · behavior-mismatch] Moved panes contest claims in their birth workspace; UI groups by the real one**  
  Where: `src/pty-daemon/ledger.ts:19`  
  Evidence: groupOf uses formulaOrdinalOf(paneId) — birth ordinal ('a moved pane's claims stay grouped where it was born'). The UI's claims-store.ts:28-35 deliberately groups by workspaceIdForPane, the post-move workspace.  
  Recommendation: Include the pane's current workspace ordinal on the claim wire (daemon already holds sessions.workspaces()), or re-home a pane's claims when the app moves it, so contest and display grouping agree.  
  Why: Docs: 'Claims contest ownership per workspace'. A moved pane's claims are refereed against panes it no longer shares a repo with (false denials), not its new wall-mates (false grants), and 'Show claims' shows the opposite grouping. (confidence: medium)

- **[LOW · test-gap] No unit tests for claimsOverlap / normalizeClaimPattern / Mailbox invariants**  
  Where: `src/contracts/daemon/protocol.ts:167`  
  Evidence: Grep of tests/ for claimsOverlap|normalizeClaimPattern|Mailbox|Ledger finds nothing; only coverage is one '**' overlap case in ledger-smoke.ts:62-66 and the ring cap in swarm-smoke.ts:116-152.  
  Recommendation: Add a unit table test in tests/unit for claimsOverlap (literal divergence, prefix containment, '**', partial wildcards, '?'/'[') and normalizeClaimPattern (traversal, drive roots, trailing slashes).  
  Why: claimsOverlap is a pure function whose conservative-deny promise is load-bearing; its tricky edges (partial '*', prefix containment, '?'/'[' — finding 1) are exactly what unit tests catch and the smokes never exercise.

- **[LOW · bug] Directed mail to a closed pane is delivered to the slot's next occupant**  
  Where: `src/pty-daemon/mailbox.ts:41`  
  Evidence: read() filters only on `m.to === forPane` (line 41); messages carry no generation. clearRole (56-59) exists because 'pane ids may be reused by new panes', but pending directed messages for the dead id are not cleared.  
  Recommendation: When SessionManager removes a pane (session.ts:1203-1213 and the onExit path), drop ring messages whose `to` is that pane id, mirroring clearRole; or stamp messages with the recipient's gen and filter stale ones in read().  
  Why: Send to worker 102, close pane 102, open a new pane in slot 102: the new agent's `mogging mail read` returns the predecessor's directed instructions — the same id-reuse hazard the codebase eliminates for gens, roles, and claims.

## profiles-failover  (implemented: partial)

> Expected: Pointer-only provider profiles (env pointers derived main-side, secret-shaped values refused at save), usage-limit failover relaunching the same pane/cwd with resume under the next profile, failover suggestions judged by a sibling's worst window, and per-slot profile persistence across restore.

- **[HIGH · bug] [✓] Failover relaunch in a daemon-reattached pane types nothing and mislabels the pane**  
  Where: `src/ui/features/agents/index.ts:468`  
  Evidence: launchInPane's adopt branch (`if (resume && wasPaneReattached(paneId))`, index.ts:468) returns without typing; doFailover (index.ts:679-688) calls launchInPane(resume=true) 900ms after ^C. liveness-port.ts:79-85: the reattached flag is only cleared by forgetPane (pane disposal), never when the agent exits.  
  Recommendation: In doFailover, bypass the adopt branch (add an option to launchInPane, or clear the pane's reattached mark when the daemon's agent-gone verdict arrives / when the app types a fresh launch into the pane).  
  Why: After any app restart (daemon keeps agents alive, so reattach is common), failover kills the CLI, adopts a phantom session, labels the pane with profile B — and never launches anything. Failover silently fails.
  Verifier: Traced limit event -> doFailover -> launchInPane(resume=true) -> adopt branch (index.ts:468) returns without typing; flag set at terminal-pane.ts:547, cleared only by forgetPane on dispose; index.ts:490-493 deliberately enables failover in adopted panes. Severity high is correct.

- **[HIGH · bug] [✓] Single ^C + fixed 900ms cannot exit double-Ctrl-C CLIs; resume lands in capped agent**  
  Where: `src/ui/features/agents/index.ts:682`  
  Evidence: doFailover sends one '\x03' then types the resume command after a fixed 900ms (index.ts:682-685). The repo's own smoke-shell.ts:152-156 says: 'One ^C cancels the CLI's current input; the second exits it... exactly why this is a loop and not a sequence' — yet production failover sends exactly one.  
  Recommendation: Replace the one-shot ^C + 900ms with the settleToShell pattern: loop ^C and verify a shell prompt returned (or the daemon's agent-gone event fired) before typing the relaunch command.  
  Why: Claude Code and Gemini need a second Ctrl-C to exit, so the typed resume command is submitted into the capped agent as a chat message, burning capped-account quota. The smoke passes only because gemini is absent on CI. (confidence: medium)
  Verifier: Traced doFailover (index.ts:682-685) -> lone '\x03', fixed 900ms, then launchInto types cmd+'\r' (agents.client.ts:28); resume path has no agent-exit guard (wasPaneReattached=false, spawn settled). Double-^C CLIs survive; command submits into capped agent; manifest already switched. High stands.

- **[MEDIUM · gap] Secret deny-list at profile save scans the value alone, so KEY-named credentials save**  
  Where: `src/main/profiles.ts:117`  
  Evidence: sanitizeProfile checks `redactSecrets(v).redactions > 0` on the bare value only (profiles.ts:117). redact.ts's KV rule (redact.ts:41-56) needs `key=value` text and keyLooksSecret is never consulted, so env `{ MY_API_KEY: '<40-char hex>' }` passes and is later typed into the launch command.  
  Recommendation: Scan the assignment, not the value: call redactSecrets(`${k}=${v}`) in sanitizeProfile, or additionally refuse when keyLooksSecret(k) unless the value matches the HOME_POINTER path grammar.  
  Why: The custody law refuses secret-shaped values at save. A credential without a recognizable prefix, paired with a key name that says 'secret', persists in plaintext SQLite and rides launch commands.

- **[MEDIUM · behavior-mismatch] No production producer of the usage-limit event — automatic failover never triggers**  
  Where: `src/backend/features/agents/notify-hook.ts:76`  
  Evidence: The generated hook whitelists Claude notification types (notify-hook.ts:76-106) and maps Codex types (40-50); neither ever yields 'usage-limit' — unknown types degrade to 'notice'. Repo-wide the only emitters are the smokes' hand-run `mogging notify --event usage-limit` (profiles-smoke.ts:97,111).  
  Recommendation: Dev-verify and map the CLIs' limit-indicating notification types to 'usage-limit' in notifTypeToEvent/codexTypeToEvent, or drive onLimit from the usage engine (fresh window at 100% on the pane's active profile).  
  Why: docs/12 and the agents header promise a usage-limit notify that offers/performs failover, but when a provider actually caps, its notification lands as 'notice' — the pane-level offer is unreachable except manually. (confidence: medium)

- **[MEDIUM · bug] suggestFailover judges siblings by lapsed windows, unlike the alert engine it feeds**  
  Where: `src/backend/features/usage/thresholds.ts:106`  
  Evidence: worstPct takes Math.max over ALL windows (thresholds.ts:106,114) with no resetsAt check, while evaluateThresholds explicitly skips lanes whose reset has passed ('old data however fresh', thresholds.ts:153-157).  
  Recommendation: Thread `now` into suggestFailover and exclude windows with `w.resetsAt && Date.parse(w.resetsAt) <= now` from worstPct so siblings are judged on live lanes only.  
  Why: A sibling idle since yesterday honestly serves a lapsed Session(5h) window reading >=50% used; that window has actually reset, but worstPct suppresses the suggestion exactly when the sibling is the best candidate.

- **[MEDIUM · test-gap] No unit tests for the profiles sanitizer, defaults derivation, or failover engine**  
  Where: `src/main/profiles.ts:93`  
  Evidence: tests/unit has redact.test.ts, logins.test.ts, workspace-rows.test.ts etc., but nothing targets sanitizeProfile/deriveProfileDefaults (profiles.ts:62-121) or suggestFailover/evaluateThresholds (thresholds.ts); coverage is only the env-gated app smokes (MOGGING_PROFILES/USAGE).  
  Recommendation: Add tests/unit/profiles.test.ts (secret refusal incl. key-named values, tilde/absolute home normalization, derived-order append, edit keeps env) and tests/unit/thresholds.test.ts (suggestFailover lapsed-window case, rollover/re-arm goldens).  
  Why: The custody refusal, home collision suffixing, order derivation, worst-window rule and boundary re-arm are pure functions whose edges (this audit found three) are cheap to pin in the unit tier but only exercised end-to-end.

- **[LOW · improvement] Auto-failover opt-in is in-memory only and silently resets to OFF every app run**  
  Where: `src/ui/features/agents/index.ts:69`  
  Evidence: `const autoFailover = new Map<string, boolean>()` lives in the feature's mount closure (index.ts:69), toggled only by the palette command (index.ts:343-357); nothing persists it to workspace meta or settings.  
  Recommendation: Persist the flag per workspace (workspace meta alongside profileIds, or an app_settings key) and surface its current state in the palette entry title or Settings § Profiles.  
  Why: A workspace opted into auto-failover loses the mode on every restart with no indication and no visible state — and the overnight-run use case the mode exists for is exactly the one that spans restarts.

## remotes-ssh  (implemented: partial)

> Expected: Phase 4 promises SSH/remote panes: the daemon spawns `ssh -tt` as the pane process (arg array, user's own ssh stack does all auth per ADR 0002), honest degradation of agent-awareness on remote, reconnect/restore via the detached daemon, and an auth-prompt-safe gate before agent commands are typed.

- **[HIGH · bug] [✓] Remote-ready latch never resets; restart types into the SSH auth prompt**  
  Where: `src/ui/core/terminal/liveness-port.ts:131`  
  Evidence: markPaneRemoteReady latches per pane id; only dispose clears it (terminal-pane.ts:2241 forgetPane). The ssh-exit path (terminal-pane.ts:327-339) calls markDead without dropping the mark, and restart() (terminal-pane.ts:561-577) respawns ssh without resetting it or remoteReadyMarked.  
  Recommendation: Add a per-pane reset (drop remoteReady mark + waiters) in liveness-port; call it from the onExit handler and restart(), and reset remoteReadyMarked/remoteReadyProbe there. Flushing waiters on exit also fixes launches queued forever on a dead-but-open pane.  
  Why: session.ts:327-329 says typing before readiness 'eats your credentials'. After one good session, whenPaneRemoteReady resolves instantly for every later ssh life in the pane, so a relaunch lands in the password/host-key prompt.
  Verifier: Traced: only dispose->forgetPane (terminal-pane.ts:2285) drops the latch; markDead (948) and restart (591) reset neither it nor remoteReadyMarked; spawnPty re-rides ssh; whenPaneRemoteReady short-circuits true (liveness-port.ts:46), so agents/index.ts:448 types into the auth prompt. High is correct.

- **[HIGH · bug] [✓] Stale ready-OSC in restored scrollback defeats the auth gate on daemon cold start**  
  Where: `src/pty-daemon/session.ts:453`  
  Evidence: PaneSession seeds restore.scrollback verbatim; the buffer captured the bootstrap's OSC 777 marker and persists up to 100k chars (session-rows.ts:19). The attach replay rides onData (transport.ts:187,206) and the renderer probe (terminal-pane.ts:308-318) marks remote-ready from any data.  
  Recommendation: Strip REMOTE_READY_OSC from remote panes' scrollback in snapshot() or when seeding restore, so readiness only comes from the live bootstrap. Add a stale-marker case to remote-smoke's daemon-restart section (it currently injects the marker renderer-side only).  
  Why: After reboot, restore spawns a FRESH ssh needing auth; res.restored suppresses the reattach mark (terminal-pane.ts:519) so the resume lineup TYPES — released by the replayed stale marker while ssh sits at the password prompt.
  Verifier: Traced end-to-end: marker persisted unscrubbed (session.ts:901, session-rows.ts:64), reseeded (session.ts:480), replayed via onData (daemon-client.ts:536), probe latches (terminal-pane.ts:327-337), lineup types (agents/index.ts:448,468). Guard session.ts:916 covers cwd only. Severity high stands.

- **[HIGH · behavior-mismatch] [✓] Windows-platform SSH hosts are confirmable in Settings but unspawnable everywhere**  
  Where: `src/main/daemon-relay.ts:373`  
  Evidence: Spawn refuses platform !== 'posix' ('unavailable or unsupported'); the daemon throws too (session.ts:1070-1073 via posix-only normalizeRemoteConnection, contracts/domain/remote.ts:72). Yet Settings offers 'Windows' + powershell/cmd (profiles-hosts.ts:406,414) and agents.ts:64-71 builds PowerShell commands for it.  
  Recommendation: Either wire the Windows dialect end-to-end (accept 'windows' in normalizeRemoteConnection and daemon-relay, route remoteBootstrap's PowerShell branch) or drop the 'Windows' option from Settings and state pane targets are POSIX-only; fix the wizard comment.  
  Why: A Windows-confirmed host never appears in the wizard's 'Runs on' list (wizard/index.ts:1332 filters non-posix) and errors if referenced; the windows branch of remoteBootstrap (session.ts:60-66) is unreachable dead code.
  Verifier: Traced both spawn paths (daemon-relay.ts:386 posix-only; pty.service.ts:113 rejects remotes), wizard filter (wizard/index.ts:1530), daemon guard (remote.ts:72 via session.ts:1172); all PaneSession sites force posix so session.ts:60-66 is dead. Corrected severity: medium.

- **[MEDIUM · gap] ConPTY may swallow the readiness OSC on some Windows builds; smoke hides it**  
  Where: `src/main/smokes/remote-smoke.ts:77`  
  Evidence: The smoke's own comment: it injects the readiness event explicitly 'because ConPTY does not preserve private OSCs consistently across Windows builds'. Real readiness depends on OSC 777/633 surviving ConPTY (ssh.exe runs under it), and whenPaneRemoteReady waits UNBOUNDED (agents/index.ts:448).  
  Recommendation: Add a smoke routing the marker through the real daemon PTY on the minimum supported Windows build, and bound the remote-ready wait with a fallback UX (after N seconds, an explicit 'shell is ready — launch now' confirm) instead of an unbounded silent queue.  
  Why: On affected Windows builds a remote agent launch queues forever with no feedback while macOS works — divergence in a README-law area — and CI proves nothing because the gate bypasses the daemon PTY when delivering the marker. (confidence: medium)

- **[MEDIUM · improvement] Editing a referenced host's identity silently kills its live SSH session**  
  Where: `src/pty-daemon/session.ts:1097`  
  Evidence: ensure() removes and respawns a live pane when matchesRemote fails (host/user/port/platform, session.ts:735-744). remotes:remove blocks deleting a referenced host with referencedBy (remotes.ts:95-99), but remotes:save accepts identity edits (port/user/host) unguarded (remotes.ts:79-85).  
  Recommendation: In the Settings host form save path, when host/user/port/platform of a workspace-referenced host changes, show the same referencedBy warning as delete and require explicit confirmation that live panes on this host will reconnect.  
  Why: Change a saved host's port in Settings and the next renderer reload/app restart kills the daemon-held ssh session (agent mid-conversation) without warning — the outcome the delete guard exists to prevent. Only renames are proven safe.

- **[LOW · test-gap] Bootstrap size budget asserted pre-quoting; Windows limit applies post-quoting**  
  Where: `scripts/remote-bootstrap-pure-smoke.ts:82`  
  Evidence: The gate asserts bootstrap.length < 30_000 raw chars (also remote-smoke.ts:122). On Windows node-pty builds a CreateProcess command line where every '"' in the bootstrap (hundreds) becomes '\"', plus ssh.exe and target args, against the 32,767-char ceiling the code cites (session.ts:483).  
  Recommendation: Assert the Windows-quoted length: mirror node-pty's argvToCommandLine over ['-tt','-p','22','user@host', bootstrap] in the pure smoke and require the total under ~30,000, or drop the raw budget to ~15,000.  
  Why: Today's ~10 KB bootstrap is safe, but the guard would pass a grown bootstrap that fails only on Windows while macOS stays green — a latent parity break the budget exists to prevent.

## browser-dock  (implemented: yes)

> Expected: docs/13 promises a toggleable per-workspace browser dock of sandboxed webview guests (deny-all permissions, own partitions, popup funneling), MCP-drivable agent verbs gated by consent/origin grants, and always-visible possession (banner, glow, tab dots) plus honest error/crash overlays.

- **[HIGH · bug] [✓] Crash overlay is dead: webview 'crashed' event does not exist in Electron 39**  
  Where: `src/ui/features/browser/index.ts:421`  
  Evidence: index.ts:421 registers wv.addEventListener('crashed', () => showCrash()). Electron 39's WebviewTag typings (node_modules/electron/electron.d.ts:18929) only expose 'render-process-gone'; 'crashed' was removed from the webview tag years ago, so the listener never fires.  
  Recommendation: Replace the 'crashed' listener with 'render-process-gone' (filter reason !== 'clean-exit') and add a smoke arm that crashes the guest (wc.forcefullyCrashRenderer()) and asserts errorVisible().  
  Why: docs/13:105-106 promises 'a crashed renderer explains itself (with Retry), never a white rectangle'. A guest OOM/crash today leaves exactly that white rectangle with no Retry.
  Verifier: Electron 39.8.10 WebviewTag typings list only 'render-process-gone'; the 'crashed' listener at index.ts:421 never fires and showCrash() has no other caller. No main-process forwarding of guest crashes (browser-dock.ts:960 only hardens sessions). Corrected severity: medium — manual Reload recovers.

- **[HIGH · behavior-mismatch] [✓] No possession grace beat: driving clears the instant each verb finishes**  
  Where: `src/main/browser-dock.ts:551`  
  Evidence: beginDriving's finish() (browser-dock.ts:547-555) sets driving=false and clears lastVerb as soon as activeOperations empties — no timer. The smoke helper's comment (line 560) references a '1.5 s auto-reset' that does not exist anywhere in the module (grep for 1500/grace: only that comment).  
  Recommendation: In finish(), when activeOperations empties, schedule a ~1.5s timer (cancelled by a new op) before clearing driving/lastVerb and pushing; keep agentStop immediate. Assert the hold in dockux-smoke via a real agentAct, not setDrivingForSmoke.  
  Why: docs/13:194-195 promises the banner holds 'and a grace beat after'. Fast verbs (click/type ~tens of ms) flash the banner imperceptibly and a verb sequence strobes it — visible possession, the core safety surface, is near-invisible.
  Verifier: Traced agentAct finally->finish() (browser-dock.ts:835,547-555): driving clears sync, no timer; renderer hides banner instantly (browser/index.ts:1466). Only mitigation: 5-min AGENT_ATTACH_MS tab pin (line 58), a different surface. High stands — the Stop button lives in the strobing banner.

- **[MEDIUM · bug] did-attach-webview front-run hardening never installs: winGetter() is null at registration**  
  Where: `src/main/browser-dock.ts:959`  
  Evidence: registerBrowserDock runs `const host = winGetter()` then `host?.webContents.on('did-attach-webview', ...)` (browser-dock.ts:959-961), but boot.ts calls registerBrowserDock at line 330 and openWindow() at line 368 — host is always null, so the listener never attaches.  
  Recommendation: Harden via app.on('web-contents-created', wc => { if (wc.getType() === 'webview') hardenSession(wc.session) }) in registerBrowserDock — window-agnostic and survives window recreation; delete the null-prone winGetter() branch.  
  Why: docs/13:130-134 promises guest sessions harden 'the instant it attaches — before dom-ready'. That layer is dead code; hardening waits for the renderer's guest IPC, and Electron grants permission requests by default when no handler is set.

- **[MEDIUM · behavior-mismatch] Agent-attached possession dot and LRU pin never expire without a new possession push**  
  Where: `src/main/browser-dock.ts:512`  
  Evidence: attached is computed against AGENT_ATTACH_MS (browser-dock.ts:157) but pushPossession (512-524) only runs on verb begin/finish/stop — nothing fires when the 5-minute window lapses. Renderer pinnedWs mirrors the last push (index.ts:987-989). s.pane is never cleared in finish(), so drivers[] carries stale panes.  
  Recommendation: In beginDriving, (re)schedule a setTimeout at lastAgentAct + AGENT_ATTACH_MS that calls pushPossession() so the dot/pin decay on time; clear s.pane once driving ends and the attach window lapses.  
  Why: After an agent's last act, the workspace tab keeps its 'X is using the browser' dot/tooltip and stays exempt from LRU eviction indefinitely (until any act anywhere or Stop) — possession UI claims an agent is present when none is.

- **[MEDIUM · bug] Unbounded page-driven tab/popup creation can spawn unlimited guest processes**  
  Where: `src/ui/features/browser/index.ts:533`  
  Evidence: Every non-popup window.open forwards to tabOpen (browser-dock.ts:296-303) and renderer newTab creates a <webview> per call with no cap (index.ts:533-542, 606-610); main caps only the tabsCache slice, not creation. The popup branch (browser-dock.ts:251-263) allows uncapped child BrowserWindows.  
  Recommendation: Cap tabs per (workspace, profile) in newTab (e.g. 12; ignore tabOpen beyond it with a toast) and rate-limit/cap popup child windows per guest in guestWindowOpenHandler (e.g. deny while N children are open).  
  Why: Electron applies no popup blocker, so a hostile/buggy page in any live guest (even a background workspace) looping window.open creates unlimited out-of-process renderers — a memory/fps blowout violating the docs/05 perf-budget law.

- **[LOW · docs-drift] Promised tab-strip/header favicons can never load: renderer CSP blocks remote images**  
  Where: `src/ui/features/browser/index.ts:577`  
  Evidence: Tab strip and url-lead set img.src to the page-reported favicon URL (index.ts:576-581, 813-817), but the renderer CSP is img-src 'self' data: (window.ts:16), so every remote favicon is blocked and onerror swaps in the globe/lock fallback.  
  Recommendation: Fetch favicons in main on the guest's own partition session and forward data: URLs to the renderer (CSP-compatible), or amend docs/13 to drop the favicon promise.  
  Why: docs/13:78-79 and 103 promise 'favicon + title' on the strip and a favicon in the header; users only see generic glyphs. Smoke checks (faviconSrc/faviconCaptured) read URL strings, not rendered images, so gates miss it.

## agent-web-consent  (implemented: yes)

> Expected: Agents read freely; act verbs on the signed-in profile need a per-workspace per-origin grant plus a first-act human confirm. Sensitive origins refuse at save and dispatch, every act lands in a local per-workspace trail, and cookies rest only in vault-backed partitions.

- **[HIGH · bug] [✓] Deleted workspace's browser-drive consent resurrects for a reused workspace id**  
  Where: `src/main/app-settings.ts:68`  
  Evidence: The delete sweep clears only integrations.grant.<wsId> and agent-config targets (app-settings.ts:66-73). Runtime consent is read directly from the legacy key: consentFor() = getSetting('browser.agentControl.<wsId>') === '1' (browser-dock.ts:154), which the sweep never clears.  
  Recommendation: In the `gone` loop of the saveState handler, also clear `browser.agentControl.<wsId>` (and consider `browser.profile.<wsId>`, `browser.lastUrl.<wsId>`, and the trail file) alongside clearGrant.  
  Why: grant-store.ts:120-122 states workspace ids get reused. A new workspace inheriting a deleted one's id starts with agent browser-driving ON, breaking 'per-workspace, default OFF — humans own the gate' (docs/13).
  Verifier: Traced: sweep (app-settings.ts:66-73) never clears browser.agentControl.<wsId>; agentAct gates only on consentFor (browser-dock.ts:699/154); id reuse via restore/create({id}) is the repo's own defended threat model. Severity high stands; browser.profile.<wsId> also survives, exposing old partition.

- **[MEDIUM · behavior-mismatch] Acts on the preview profile never land in the persistent trail**  
  Where: `src/main/browser-dock.ts:674`  
  Evidence: gateAct returns null immediately when prof !== 'agent-web' (browser-dock.ts:674) and it holds the only recordTrail calls for web acts; agentAct has no other trail write, so click/type/eval/navigate under web:'public' consent leave zero JSONL entries.  
  Recommendation: After the gate, record preview-profile ACT verbs too (recordTrail with verb + origin, outcome 'ok'), or amend docs/14 to say the persistent trail covers only the signed-in profile.  
  Why: docs/14 says 'Every agent act (web + MCP-write receipts + bridge drops) lands in a local, per-workspace ring.' Preview acts only reach the volatile 50-entry in-memory list (lost on restart), so the audit ledger under-reports.

- **[MEDIUM · gap] Web trail entries omit the acting pane, so web acts are not attributable**  
  Where: `src/main/browser-dock.ts:678`  
  Evidence: gateAct(v, wc, wsId, prof) never receives ctx.pane (available in agentAct, browser-dock.ts:696/714) and its recordTrail calls (lines 678, 692) set no pane. MCP writes DO record pane (mcp-endpoint.ts:235-243) and TrailEntry.pane exists for exactly this (contracts/integrations/trail.ts:23).  
  Recommendation: Thread ctx?.pane into gateAct and include `pane` on the ok/refused recordTrail calls (and on the origin-change entry when a possession is live).  
  Why: ADR 0008 promises every agent-initiated action is attributable; with several agents in one workspace the trail cannot say WHICH pane acted on a signed-in site, weakening the audit ledger's core purpose.

- **[MEDIUM · bug] Trail records 'ok' before the act executes; 'confirmed' outcome never applied to acts**  
  Where: `src/main/browser-dock.ts:692`  
  Evidence: gateAct records outcome 'ok' (line 692) then returns null; the verb runs afterward and can fail (badtarget at lines 750-763, exception at 830, cancellation) with the 'ok' entry already queued. contracts/integrations/trail.ts:15 defines 'confirmed' = performed after confirm, but no act entry ever uses it.  
  Recommendation: Record the act entry after the verb resolves with the real outcome (ok/refused + reason), and use outcome 'confirmed' for the first successful act after confirmPendingActOrigin.  
  Why: The ledger overstates what agents did: a failed or crashed act reads as a successful act in Settings § Activity, and the documented confirmed-act outcome is unreachable, so outcome badges mislead the reviewer.

- **[MEDIUM · gap] Sensitive-origin blocklist misses most major banks/brokerages**  
  Where: `src/contracts/integrations/grant.ts:71`  
  Evidence: SENSITIVE_ORIGIN_PATTERNS (grant.ts:71-78) covers 'bank', chase, wellsfargo, paypal, venmo, coinbase, stripe, mail, .gov, icloud. Substring match lets citi.com, fidelity.com, schwab.com, vanguard.com, americanexpress.com, capitalone.com, discover.com, robinhood.com, hsbc.com pass isSensitiveOrigin().  
  Recommendation: Extend the pattern list with the major US/UK financial hosts above (host fragments like existing entries), and add a unit test enumerating expected-blocked origins.  
  Why: docs/14 promises blocklisted banking origins refuse at save and dispatch; a user can grant acts on a Fidelity or Capital One session — exactly the stakes the both-ends rule exists to refuse. (confidence: medium)

- **[MEDIUM · bug] TOCTOU between origin gate and executeJavaScript lets an act run on an ungranted origin**  
  Where: `src/main/browser-dock.ts:675`  
  Evidence: For click/type/select/eval, gateAct reads originOf(wc.getURL()) at dispatch (line 675); the script runs later via wc.executeJavaScript (line 703). A page-initiated navigation can commit between check and execution, so the script executes in the new origin's document.  
  Recommendation: Re-check the grant/blocklist against wc.getURL() immediately before run(), or wrap injected scripts with an origin assertion that bails on mismatch.  
  Why: Path: agent clicks a link on granted origin A that navigates to ungranted B, then issues eval; the gate sees A but the body runs with B's signed-in cookies — the boundary the per-origin grant exists to hold. (confidence: medium)

- **[MEDIUM · test-gap] Zero unit tests for grant sanitization, blocklist, and trail ring invariants**  
  Where: `src/backend/features/integrations/grant-store.ts:63`  
  Evidence: tests/unit contains no test for grant-store.ts (sanitizeGrant, isBlockedActOrigin, normalizeActOrigin, clearGrant fallback), trail.ts (ring caps, torn-line skip), or ui/core/browser-origin.ts. All coverage lives in env-gated Electron smokes (MOGGING_WEBTRAIL/MOGGING_AGENTWEB).  
  Recommendation: Add tests/unit/grant-store.test.ts and trail-store.test.ts covering sanitizeGrant coercions, blocked-origin refusal, the 200-origin cap, ring/byte caps, torn-line reads, and pin normalizeBrowserOrigin to normalizeActOrigin.  
  Why: These are pure Electron-free boundary guards; a regression only surfaces if the opt-in smoke gate runs, and normalizeBrowserOrigin duplicates normalizeActOrigin with no drift test.

## usage-metering  (implemented: yes)

> Expected: Titlebar gauge + popover + Settings tab metering ~50 providers via five credential-free adapter classes (ADR 0007): pure pace engine with verbatim verdicts, per-window threshold alerts with outbox delivery, local JSONL cost scan with live pricing, history rings, and a `mogging usage` CLI.

- **[HIGH · behavior-mismatch] [✓] macOS Keychain is read speculatively at boot, violating ADR 0007 and platform parity**  
  Where: `src/backend/features/usage/claude-adapter.ts:249`  
  Evidence: claudeAdapter.detect() calls readKeychain() (`security find-generic-password`, claude-adapter.ts:31-40,249-251) on every poll; the seam schedules the first poll <=1500ms after boot (src/backend/features/usage/index.ts:298) and cli-store rows are enabled by default (index.ts:179-184).  
  Recommendation: On darwin, gate readKeychain() behind first explicit refresh or popover open (a one-time latch); until granted, have detect() use only the .credentials.json existence check and skip the claude adapter's automatic boot poll.  
  Why: ADR 0007 promises the Keychain is read 'on explicit refresh only, never speculatively at boot.' macOS shows a contextless OS prompt at launch (deny = dead meter); Windows reads a file silently — divergence the parity law forbids.
  Verifier: Traced boot.ts:366 -> usage.ts:335 -> index.ts:296-298 (first poll <=1500ms, visible=true, claude enabled by default) -> poll -> detect -> readKeychain (claude-adapter.ts:249, keychain tried before file). No guard exists; ADR 0007:52-54 violated. Severity high only if the ACL prompts; else medium.

- **[MEDIUM · bug] Gauge auto/merged pick judges a plan by windows[0] only, missing hotter weekly lanes**  
  Where: `src/ui/features/usage/index.ts:128`  
  Evidence: auto mode sorts plans by `(b.windows[0]?.usedPct ?? 0)` (index.ts:126-130); bestBySeverity's tie-break does the same (index.ts:111). The >=90% badge checks every window (index.ts:219).  
  Recommendation: Rank plans by their WORST window (Math.max over windows usedPct) in both the auto sort and the bestBySeverity tie-break, mirroring suggestFailover's worstPct rule in src/backend/features/usage/thresholds.ts:106.  
  Why: Docs 12 defines auto as 'highest usage'. Claude session 10%/weekly 95% loses to Codex session 50%/weekly 20%: the gauge mirrors the wrong provider while its own dot badge fires for a plan it is not showing.

- **[MEDIUM · behavior-mismatch] `mogging usage providers` reports disabled-by-default rows as enabled**  
  Where: `src/main/usage.ts:549`  
  Evidence: cliProviders computes `enabled: kv?.getSetting(`usage.enabled.${a.id}`) !== '0'`, while the poller and configGet use the class-aware default (api-key/cloud-cli/web-session OFF until configured — usage.ts:192-198, 420; index.ts:179-184).  
  Recommendation: Reuse statusEnabled(id) (the seam's rule, already in scope at usage.ts:192) for the `enabled` field in cliProviders instead of the `!== '0'` check.  
  Why: Docs 12 promises the verb shows 'enabled state'. With no setting stored, ~35 never-polled api-key/web-session rows print 'enabled', so scripts and users believe providers are watched that are not — the phase-11 audit's truthfulness failure.

- **[MEDIUM · bug] Live price fetch retries on every cost scan once stale, breaking the at-most-daily bound**  
  Where: `src/main/usage-prices.ts:66`  
  Evidence: refresh() only skips when `this.cached` is within TTL (usage-prices.ts:69); a failed fetch (`catch(() => undefined)`, :78) or empty parse (:74) leaves cached null/stale, so every current() call — one per provider per popover cost paint — starts a new fetch.  
  Recommendation: Record lastAttemptAt on every fetch start and gate refresh() on it (e.g. 1h negative-result TTL), persisting it beside the cache so restarts do not reset the bound.  
  Why: The stated contract is 'at most ONE bounded PUBLIC request per day'. Offline or blocked machines instead hit models.dev on every popover open/repaint (8s timeout each) — chatter the free-offline-core story says should not exist.

- **[LOW · behavior-mismatch] Outage relabel mutes the plan-level pace but per-window verdict lines still render**  
  Where: `src/main/usage.ts:260`  
  Evidence: enrich() strips only the plan's `pace` on an outage relabel (`{ ...view, pace: undefined }`, usage.ts:260) after toView attached a PaceView to every window (usage.ts:137-157); the popover renders each `w.pace` verdict row regardless (src/ui/features/usage/index.ts:631-640).  
  Recommendation: In enrich(), when the outage relabel applies, also strip `pace` from each window view (map windows to `{ ...w, pace: undefined }`) so no forecast renders on an outage-relabeled tile.  
  Why: Docs 12 promises an outage 'mutes the pace line' so the red names the right culprit; a stale tile during a provider outage still shows 'Ahead of pace — runs out ~…' forecasts built on data the outage made unrefreshable.

- **[LOW · gap] setKey/clearKey accept arbitrary provider ids, storing orphan ciphertext on a typo**  
  Where: `src/main/usage.ts:448`  
  Evidence: The keySet IPC handler (usage.ts:448-461) and CLI usage.setKey (usage.ts:87-96) validate only `typeof providerId === 'string'`; configSet by contrast requires configurable() (usage.ts:432-436). keySetPlaintext (src/main/usage-keys.ts:33) writes the vault entry for any id.  
  Recommendation: Apply the existing configurable(id) guard in both keySet paths (and keyClear/webReadSet), returning `{ ok: false, reason: 'unknown provider id' }` so the CLI exits 1 on a typo.  
  Why: `mogging usage set-key --provider openrouterr` exits 0, encrypts the key under an id no surface lists, and sets `usage.enabled.openrouterr=1` — the user believes the key saved while the real row stays keyless.

- **[LOW · bug] `mogging usage refresh` always waits the full 10s when Codex is the freshest source**  
  Where: `bin/mogging.mjs:381`  
  Evidence: runUsageRefresh waits for `plans.some((p) => p.fetchedAt >= started)` (bin/mogging.mjs:381-388), but readCodex deliberately stamps fetchedAt with the rollout file's mtime (src/backend/features/usage/classes/cli-store.ts:118), which precedes `started` by construction.  
  Recommendation: Expose a per-provider poll counter or lastAttempt stamp (service.debug() already tracks fetches) through usage.refresh/usage.list and wait on that, instead of inferring freshness from fetchedAt, which is an honest-age field.  
  Why: For a Codex-only setup (or any mix where only mtime-stamped providers answer) the poke completes quickly but the predicate never satisfies, so every `usage refresh` stalls the bounded 10s before printing — reads as a hang in scripts.

## vault-custody  (implemented: yes)

> Expected: Every credential the app holds rests as OS-keychain (safeStorage) ciphertext or is refused; configs carry ${NAME} pointers, values materialize only into pane env at spawn, secret-shaped literals are refused at save, and no IPC channel returns plaintext.

- **[MEDIUM · bug] keySetEnvRef reports ok when the settings store is absent (dropped write reads as save)**  
  Where: `src/main/usage-keys.ts:62`  
  Evidence: usage-keys.ts:61-64 uses `kv?.setSetting(...)` then returns {ok:true} unconditionally. The sibling plaintext paths were fixed for this exact class (usage-keys.ts:43-47, service-keys.ts:60-65, vault.ts:66-71); event-bridge.ts:53-55 saveList shares it for env-ref webhook saves (returns ok at line 133).  
  Recommendation: In keySetEnvRef, return {ok:false, reason:'the settings store is not available right now...'} when getSettingsStore() is null, mirroring keySetPlaintext:45-47; add the same guard to event-bridge saveList on the env-ref webhook path.  
  Why: An env-ref save in the shutdown-ordered IPC window vault.ts documents as real reports saved while nothing persisted; the stale cipher clear at line 63 is also skipped, so resolveKey keeps serving the old key.

- **[MEDIUM · bug] vaultEncrypt is not exception-safe: a keychain-denied throw escapes the refusal path**  
  Where: `src/main/vault.ts:41`  
  Evidence: vaultDecrypt (vault.ts:46-52) wraps decryptString in try/catch returning null, but vaultEncrypt (vault.ts:39-42) calls safeStorage.encryptString bare. On macOS encryptString can throw when the Keychain denies/locks access even after isEncryptionAvailable() returned true.  
  Recommendation: Wrap safeStorage.encryptString in try/catch inside vaultEncrypt and return null on throw (symmetric with vaultDecrypt); callers already turn null into the vault-unavailable refusal with the env-ref hint.  
  Why: A throw propagates through vaultStore to IPC as an opaque rejection instead of the designed {ok:false} refusal, defeating the keep-field-on-refusal UX; DPAPI never throws, so it is also a macOS/Windows error-path divergence. (confidence: medium)

- **[MEDIUM · gap] Credential-wording gate never scans src/main, where user-facing refusal strings live**  
  Where: `scripts/check-credential-wording.mjs:153`  
  Evidence: The scanned file list (check-credential-wording.mjs:153-157) walks only src/ui/**/*.ts, docs/**/*.md and README.md. User-read strings originate in main: refusal reasons (service-keys.ts:57, usage-keys.ts:40, event-bridge.ts:114), dialogs.ts, menu.ts, all rendered verbatim by the UI via IPC returns.  
  Recommendation: Add walk(join(ROOT,'src','main'),'.ts') (and bin/ .mjs CLI output) to the scanned file list; the line-pinned ALLOWED mechanism already handles any narrow true claims that surface.  
  Why: The gate exists because the false 'no keys stored' sentence gets independently re-typed anywhere copy is written; a main-side reason or dialog claiming 'never holds a credential' would ship ungated, exactly the drift the gate is for.

- **[LOW · behavior-mismatch] Webhook env-ref slot skips the secret-shaped deny-list every other env-ref slot applies**  
  Where: `src/main/event-bridge.ts:108`  
  Evidence: saveWebhook validates the env-ref with only /^[A-Z][A-Z0-9_]{2,64}$/ (event-bridge.ts:106-110) and persists it plaintext. usage-keys.ts:60, brain.ts:534 and registry.ts:83-85 additionally run redactSecrets and refuse; an AKIA-prefixed AWS key id passes the NAME regex here but is refused elsewhere.  
  Recommendation: After the NAME regex in saveWebhook, add redactSecrets(ref).redactions > 0 refusal with a 'that looks like a secret VALUE' reason, matching usage-keys.ts:60.  
  Why: ADR 0007a section 5 requires env-ref slots to refuse secret-shaped literals via the shared deny-list; this is the one custody-relevant env-ref field omitting it, so an uppercase-only token pasted here rests plaintext in the KV.

- **[LOW · gap] Pointer grammar diverges across consumers ({2,40} vs {2,64}); set/clear asymmetric**  
  Where: `src/main/service-keys.ts:18`  
  Evidence: ENV_NAME is {2,64} in service-keys.ts:18, its ref matcher (line 93) and event-bridge.ts:108, but {2,40} in usage-keys.ts:16 and contracts/ipc/profiles.ipc.ts:18. serviceKeySet strips a ${...} wrapper (lines 46-49) while serviceKeyClear (lines 70-74) only trims.  
  Recommendation: Extract one shared ENV_NAME regex and ${...}-stripping normalizer (in vault.ts or contracts); use it in service-keys, usage-keys, event-bridge and profiles, and apply the normalizer in serviceKeyClear so set/clear accept identical grammar.  
  Why: A 45-char env name is a valid service key and webhook ref but refused as a usage env-ref; a caller passing the accepted ${NAME} form to clear silently fails to delete a stored secret (clear returns void, nothing surfaces).

- **[LOW · test-gap] Vault primitives have zero unit tests; invariants live only in env-gated smokes**  
  Where: `src/main/vault.ts:57`  
  Evidence: tests/unit contains no test touching vault.ts, service-keys.ts or usage-keys.ts (grep for vault/key/secret matches nothing there). Coverage exists only in full-app smokes (vaultkeys-smoke.ts, secretforms-smoke.ts, usage-smoke.ts) behind MOGGING_* flags in qa-smokes.sh:407/456.  
  Recommendation: Add a unit suite stubbing getSettingsStore()/setVaultProbeForSmoke asserting: every set-path returns ok:false when the store is null, clear accepts the same name grammar as set, and vaultStore/vaultLoad round-trip and refusal branches behave.  
  Why: The store-absent env-ref bug and the set/clear grammar asymmetry sit in branches the smokes never drive (they always run with a live settings store); cheap unit tests with stubbed store and vault probe would have caught both.

## mcp-registration  (implemented: yes)

> Expected: Surgical, backed-up, marker-scoped MCP server registration across Claude/Codex/Gemini config dialects; read-only drift detection never auto-healed; per-workspace tool plans scoping which servers each CLI sees (git-excluded project files where no launch flag exists); curated secret-free catalog.

- **[HIGH · bug] [✓] Linked-worktree git exclude writes a path git never reads; plan file leaks**  
  Where: `src/main/tool-plan.ts:171`  
  Evidence: gitExcludeInWorktree resolves a `.git` FILE via its `gitdir:` line (tool-plan.ts:168-172) and appends to `<gitdir>/info/exclude` (173-181). For a linked worktree gitdir is `.git/worktrees/<name>`; git resolves info/exclude via $GIT_COMMON_DIR (the `commondir` file), so the per-worktree file is ignored.  
  Recommendation: After resolving gitDir from the `gitdir:` pointer, read `<gitDir>/commondir` if present and resolve info/exclude relative to that common dir before appending. Add a linked-worktree fixture to the toolplan smoke.  
  Why: The app runs workspaces in linked worktrees (.mogging/worktrees/* exists here). The function returns true, launch proceeds, and the managed .codex/config.toml or .gemini/settings.json shows in git status and can be committed by an agent.
  Verifier: Traced tool-plan.ts:160-182 via agents.ts:101; excludeRelPaths set only for codex/gemini project files (plan.ts:81); app launches agents in linked worktrees. Empirical git test: per-worktree info/exclude is ignored, file stays untracked. No commondir guard anywhere. Severity high stands.

- **[MEDIUM · bug] Tool-plan rollback restores files without CAS; can clobber a concurrent edit**  
  Where: `src/main/tool-plan.ts:108`  
  Evidence: rollback() calls configMutationCoordinator.mutate({ file, transform: () => prior.content }) with no expectedHash (tool-plan.ts:104-116); every forward write passes expectedHash (line 141). A refusal caused by 'changed-under-us' on a projectScoped worktree file then overwrites the newer bytes with the stale snapshot.  
  Recommendation: Pass expectedHash of the content this materialization wrote to each rollback mutate, and skip restore (log a warning) when the current content is not what we wrote.  
  Why: The exact scenario the refusal protects against — user/CLI/git touching .codex/config.toml during materialization — is where the unconditional restore silently destroys the external edit, with no backup taken on this path.

- **[MEDIUM · behavior-mismatch] resolveCliHomes ignores CLAUDE_CONFIG_DIR while honoring Codex/Gemini pointers**  
  Where: `src/main/mcp-manager.ts:77`  
  Evidence: resolveCliHomes honors CODEX_HOME and GEMINI_CLI_HOME/GEMINI_CONFIG_DIR but hardcodes Claude to homedir() (mcp-manager.ts:76-79; claude.ts:37 joins homes.home + '.claude.json'). Elsewhere the app treats CLAUDE_CONFIG_DIR as Claude's home pointer (usage/homes.ts:13, agent-settings/sources.ts:213, docs/17:105).  
  Recommendation: Resolve the Claude target as join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json'), keeping the sandbox branch; add an explicit claudeDir to CliHomes instead of reusing `home`.  
  Why: With CLAUDE_CONFIG_DIR set (the mechanism docs/17 and profiles rely on), apply reports ok into ~/.claude.json, which the CLI never loads, and drift detection watches the wrong file — despite the 'pointer envs the CLIs honor' comment. (confidence: medium)

- **[MEDIUM · improvement] mcp-manager writes Codex/Gemini configs outside the shared mutation coordinator**  
  Where: `src/main/mcp-manager.ts:159`  
  Evidence: mgrApply/mgrRemoveFrom use their own sync writeAtomic path (mcp-manager.ts:159-186); agent-settings writes the SAME files ($CODEX_HOME/config.toml, ~/.gemini/settings.json per docs/17:33-34) through configMutationCoordinator, whose contract says all provider writers must share it (mutation-coordinator.ts:72-74).  
  Recommendation: Route mgrApply/mgrRemoveFrom writes through configMutationCoordinator.mutate (expectedHash from the read; backup in the transform seam), or enqueue them on the coordinator's per-file tail so both writers serialize.  
  Why: Two uncoordinated read→check→rename paths in one process on the same file leave a lost-update window between writeAtomic's fileMatchesExpected (line 176) and renameSync (177); each path's CAS cannot see the other's in-flight write.

- **[LOW · bug] UTF-8 BOM in a CLI config fails registration with a raw JSON parse error**  
  Where: `src/backend/features/integrations/writers/json-dialect.ts:26`  
  Evidence: parseConfig JSON.parse()es raw text with no BOM strip (json-dialect.ts:26-38); mgrApply reads via readFileSync utf8 (mcp-manager.ts:190), so a BOM-prefixed .claude.json/settings.json surfaces as 'could not update … Unexpected token' (305). The coordinator path strips BOMs (mutation-coordinator.ts:54-61).  
  Recommendation: Strip a leading ﻿ in parseConfig before JSON.parse and re-prepend on stringify (mirroring the coordinator), or refuse with a sentence naming the BOM.  
  Why: Windows editors (Notepad, PowerShell redirects) prepend BOMs to these hand-edited files. The refusal is safe but opaque, and the same file edits fine via the agent-settings path — a Windows-leaning gap against the parity promise.

- **[LOW · docs-drift] Docs drift: backup keying and boot-time house-entry rewrite undocumented**  
  Where: `docs/14-integrations.md:477`  
  Evidence: docs/14:476-477 promises 'backs up once per file per session before its first write', but code keys backups by content hash (mcp-manager.ts:106-114, cap of 10). registerMcpManager also calls refreshManagedHouseRuntime() at boot (521), rewriting hash-verified managed house blocks with no user click (314-334).  
  Recommendation: Update docs/14's three-dialects section: backups are per-content (10 kept), and name the one boot migration that refreshes an unchanged hash-verified house entry when the app's runtime path moves.  
  Why: Both changes are defensible, but docs/14 also states 'never a write without your click' — the boot write, however scoped to byte-verified our-own blocks, is an unstated exception that auditors and users will trip on.

- **[LOW · test-gap] Writer splice edge cases have no unit tests, only env-gated smokes**  
  Where: `src/backend/features/integrations/writers/codex.ts:70`  
  Evidence: tests/unit has no tests for the writers, json-dialect, plan composition, or validateServerEntry. Invariants like keysOrphanedAfter (codex.ts:70-77), foreign-table refusal (97-98), JSONC refusal (json-dialect.ts:32-35), and applyState (writers/index.ts:61-71) run only under MOGGING_MCPMGR/TOOLPLAN smokes.  
  Recommendation: Add tests/unit/mcp-writers.test.ts covering upsert/remove/readCanonical/isManagedScoped for all three dialects (CRLF, blank line inside block, foreign twin, JSONC, array mcpServers) plus applyState and validateServerEntry refusals.  
  Why: These pure functions guard the app's most dangerous writes to user-owned config files; smokes are coarser than unit tests, so a regression in a splice edge (CRLF, blank-line orphaning, array mcpServers) can land between gate runs.

## mogging-mcp-server  (implemented: yes)

> Expected: A house MCP server serves a data-driven catalog: control-plane reads free to pane-identity sessions, write tools invisible and refused unless the per-workspace grant (default off) allows, approve never a tool, and both upstreams token-authed with independent degradation.

- **[HIGH · bug] [✓] Receipt frames honored without grant check: trail entries and pings forgeable**  
  Where: `src/main/mcp-endpoint.ts:450`  
  Evidence: mcp-endpoint.ts:450-452 forwards any {t:'receipt'} from a pane-bound socket to handleReceipt (224-244), which calls resolveGrantedWriteTools only to fetch workspaceId for the trail, never to gate; it then notifies an arbitrary client-supplied msg.pane and records a trail entry with outcome:'ok'.  
  Recommendation: In handleReceipt, refuse unless resolveGrantedWriteTools(boundPane).writeTools.includes(tool); better, record trail/attention inside the endpoint's own write handlers instead of trusting a client-sent receipt frame.  
  Why: An ungranted or revoked agent can fabricate audit-trail entries claiming writes happened and ping any pane in any workspace, breaking the 'every write is attributable' promise and the write boundary's audit surface.
  Verifier: Missing grant gate in handleReceipt (mcp-endpoint.ts:224-244) is real; severity low, not high. pane/workspaceId are server-derived (:427-435, integrations.ts:183-186) and trail.ts:54 drops unattributable entries, so self-noise only. Arbitrary-pane ping already ungated (transport.ts:227-232).

- **[MEDIUM · bug] Initialize-time grant resolve that loses the 2s race never emits tools/list_changed**  
  Where: `bin/mogging-mcp.mjs:773`  
  Evidence: mogging-mcp.mjs:772-780 races refreshGrant(false) against a 2000ms timer before replying to initialize. If the timer wins, initialize replies with grants empty; when refreshGrant later resolves, applyGrantSet(names, false) (lines 79-85) suppresses the list_changed notification.  
  Recommendation: Set a 'replied' flag once the initialize response is sent and have the still-running refreshGrant emit list_changed when it resolves after that point, instead of hardcoding emitChange=false.  
  Why: If the app answers grant.get slower than 2s, a workspace granted 'all' serves a tools/list with zero write tools and no notification ever corrects it until an unrelated grantChanged push or a blind direct call.

- **[MEDIUM · docs-drift] docs/14 Direction 2 stale: 'six writes' vs 'eleven write tools' vs 18 shipped**  
  Where: `docs/14-integrations.md:193`  
  Evidence: docs/14-integrations.md:193 says 'The eleven write tools'; line 343 says a grant of 'all' makes 'the six writes' appear; bin/mcp-catalog.json ships 18 access:'write' tools (fleet 5, board 6, brain 3, memory 4), and the table at 171-190 omits the brain/memory families and browser tab tools.  
  Recommendation: Rewrite the Direction 2 table and Scoping section to enumerate the current 18 write tools and state that the single per-workspace grant also covers brain symbol and memory file writes.  
  Why: The consent story users read is wrong: the one writeTools toggle now also covers on-disk file edits (replace_symbol_body etc.) and .memory/ writes, a materially larger blast radius than the six or eleven writes described.

- **[LOW · improvement] PANE_ID without PANE_TOKEN silently degrades to paneless with a misleading refusal**  
  Where: `bin/mogging-mcp.mjs:116`  
  Evidence: connectApp (mogging-mcp.mjs:113-117) sends a pane-bound hello only when BOTH env vars exist; with only MOGGING_PANE_ID, grant.get returns [] (paneless), while handleWriteCall (687) still treats the session as pane-identified and refuses citing the workspace grant default.  
  Recommendation: When paneIdentity() exists but paneToken() does not, word the write refusal (and refreshGrant's empty set) to name the missing pane credential instead of the workspace grant.  
  Why: Fail-closed is correct but the diagnostic lies: the human is told to flip a grant that may already be on, when the real fault is the missing pane token (e.g., a hand-launched MCP process).

- **[LOW · bug] Status poller visibility is one global flag flipped by any window's hide/minimize**  
  Where: `src/main/mcp-status.ts:119`  
  Evidence: registerMcpStatus (mcp-status.ts:119-124) hooks app 'browser-window-created' so every window's hide/minimize/show/restore writes the one module-level `visible` flag; a secondary window (e.g., undocked DevTools) closed while minimized leaves visible=false with no resetting event.  
  Recommendation: Scope visibility to the main window only (compare the event's window against winGetter()) or track a count of visible windows rather than a last-writer-wins boolean.  
  Why: The poller then pauses indefinitely while the main window is fully visible; statuses and auth-nags go stale until the main window itself cycles hide/show or a Settings-open refresh fires. (confidence: medium)

- **[LOW · test-gap] No unit tests for grant store or server-side catalog/arg validation**  
  Where: `src/backend/features/integrations/grant-store.ts:139`  
  Evidence: tests/unit contains no test touching grantedWriteToolNames, readGrant/clearGrant migration (grant-store.ts:100-143), argsProblem (mogging-mcp.mjs:229-241), or the receipt path; these invariants live only in env-gated smokes.  
  Recommendation: Add unit tests for grantedWriteToolNames filtering, readGrant migration and clearGrant reuse-safety, and argsProblem branches; add a smoke assertion that an ungranted receipt frame records nothing.  
  Why: The pure functions guarding the write boundary (grant sanitization, legacy migration, closed-catalog filtering) suit fast unit tests; the receipt path from the high finding has no coverage at all.

## event-bridge  (implemented: partial)

> Expected: Direction 4: house events (needs-you, notify, card-moved, review-changed) POST a versioned v1 JSON payload to user webhooks. URLs are vault-held secrets shown masked; delivery is a per-webhook queue with bounded retries, no redirects, and strict http/https target rules — a doorbell, not a bus.

- **[HIGH · behavior-mismatch] [✓] `mogging notify --message` never fires the `notify` bridge event in production**  
  Where: `src/pty-daemon/transport.ts:223`  
  Evidence: transport.ts:223 `target?.applyNotify(m.event)` drops m.message; session.ts:852 only feeds the state tracker. Main's sole feed is onPaneStateForBridge (event-bridge.ts:213), emitting `needs-you` alone (its comment admits the daemon dropped the note). Grep: no production emitBridgeEvent('notify') — only smokes + Test.  
  Recommendation: Fan the daemon's notify out to app subscribers (add a relay push carrying event+message, capped 280) and in daemon-relay call emitBridgeEvent('notify', { workspace, pane, note }) for user-facing notify events, gated by paneHasAgent like needs-you.  
  Why: docs/14:470-471 promises "mogging notify --message … rings the flow" and the UI sells "Any notification an agent sends" (webhooks.ts:48). A user wiring n8n to `notify` sees Test succeed, then never receives a real event.
  Verifier: Traced CLI (mogging.mjs:1377) -> transport.ts:231 (drops m.message) -> session.ts:928 (tracker only) -> daemon-relay.ts:161 -> event-bridge.ts:224 (emits 'needs-you' only, gated by paneHasAgent). No production emitBridgeEvent('notify'); phase-8 REPORT.md:207 admits it. Severity high stands.

- **[MEDIUM · bug] env-ref webhook URLs bypass the URL-safety policy entirely at delivery**  
  Where: `src/main/event-bridge.ts:80`  
  Evidence: resolveUrl (event-bridge.ts:80) returns process.env[envRef] raw; emitBridgeEvent:179 hands it straight to deliverWebhook. urlAllowed runs only on the pasted-URL save branch (event-bridge.ts:112); the env-ref branch (:106-110) validates the NAME only, never the resolved value.  
  Recommendation: In emitBridgeEvent, run urlAllowed(resolvedUrl, true) before enqueueing delivery for env-ref webhooks; on refusal set health 'failing' and record a label-only trail drop naming the refusal, mirroring the dropped-after-retries path.  
  Why: docs/14:455 bans plain http to public hosts, yet an env var holding http://public-host/hook delivers fine, sending workspace/pane ids and note text unencrypted. The policy is a save-time gate the env-ref route never crosses.

- **[MEDIUM · improvement] Vault-held webhook URL is decrypted on every list render and health repaint**  
  Where: `src/main/event-bridge.ts:61`  
  Evidence: urlMask (event-bridge.ts:59-67) calls resolveUrl → vaultLoad just to compute `host/…`; views() runs it per webhook on every webhookList IPC and every pushViews — which fires after every single delivery (event-bridge.ts:190).  
  Recommendation: At save time, extract new URL(url).host (non-secret) and persist it on StoredWebhook; build urlMask from the stored host so display never touches the vault. Keep vaultLoad exclusively inside the delivery queue.  
  Why: Contradicts the file's own doctrine "Resolve the URL for delivery ONLY" (:76) and the one-decryption-point custody spirit; a keychain/DPAPI round-trip per webhook per delivery is needless syscall load on the health push path.

- **[MEDIUM · test-gap] Pure delivery engine has zero unit tests — backoff, 4xx no-retry, URL classes untested**  
  Where: `src/backend/features/integrations/bridge.ts:80`  
  Evidence: deliverWebhook was built for injection (fetchFn, sleep, maxAttempts — bridge.ts:80-92) yet nothing under tests/ references deliverWebhook, classifyWebhookUrl, or urlAllowed (grep: zero hits). Only the env-gated evbridge smoke exercises delivery; it asserts none of the retry/classification edges.  
  Recommendation: Add tests/unit/bridge.test.ts: 5xx retries 4 attempts with 200/400/800 backoff (injected sleep); 404 stops after 1 attempt; classifyWebhookUrl table (loopback, RFC1918 bounds, .local, [::1], http-public invalid); note truncation at 280.  
  Why: Retry/backoff and SSRF classification are the feature's core invariants; a regression (retrying 4xx forever, 172.32.x classed as LAN) only surfaces if someone runs the optional smoke, which asserts none of these edges.

- **[LOW · bug] Bridge's lastState never cleared on pane exit — reused pane id can swallow needs-you**  
  Where: `src/main/event-bridge.ts:209`  
  Evidence: lastState (event-bridge.ts:209) only grows; daemon-relay onExit (daemon-relay.ts:142-149) clears its own specs/lastStates and calls notePaneGone but never resets the bridge map. Pane ids are reused ("a split takes the lowest free slot", daemon-relay.ts:108).  
  Recommendation: Export a paneGoneForBridge(paneId) from event-bridge that deletes lastState (mirror of agent-presence's notePaneGone) and call it from daemon-relay's onExit alongside notePaneGone.  
  Why: A pane exiting while latched 'attention' leaves prev='attention' for its id; a successor pane whose first relayed state is 'attention' fires no needs-you webhook. Narrow, but the map also accumulates stale state across daemon restarts. (confidence: medium)

- **[LOW · docs-drift] Test button sends first-checked event with a fabricated shape, not the documented notify**  
  Where: `src/main/event-bridge.ts:242`  
  Evidence: webhookTest emits `w.events[0] ?? 'notify'` with workspace 'test' and a note (event-bridge.ts:242). docs/14:468-469 promises "the receiver gets a `notify` with note: 'Test event…'".  
  Recommendation: Either always send event 'notify' for tests (matching docs), or build the test payload with exactly the fields that event emits in production (no note for card-moved) and use the webhook's real workspaceId or omit the fake 'test' id.  
  Why: A card-moved-only webhook gets a card-moved test carrying `note` — a shape production card-moved never sends (board.ts:305, ids only). Docs tell users to pin the test run and build on it, so the flow trains on a payload that never recurs.

## service-adapters-github  (implemented: yes)

> Expected: A board card links to a GitHub PR/issue; polling rides the user's own gh (cadence, jitter, backoff, hidden-pause, last-good-as-stale), and a review/merge/close transition lands a house notify on the owning pane, fires review-changed, and applies opt-in board rules. No credential enters the process.

- **[HIGH · behavior-mismatch] [✓] Merge/close/review changes while the app is closed never fire notify or board rules**  
  Where: `src/backend/features/integrations/services/engine.ts:163`  
  Evidence: transitionLabel returns null when prev is undefined (engine.ts:163 'first fetch is not a transition'), and statuses live only in engine memory — services.ts persists only links (KV 'integrations.links', services.ts:22), never the last status. After every restart prev is undefined on first fetch.  
  Recommendation: Persist each link's last state+reviewDecision beside the link in KV and seed engine runtimes on boot; or at minimum invoke transitionRules on a first fetch whose state is merged/closed (the lane move is idempotent).  
  Why: docs/18 promises 'PR merged → Done'; in the common overnight-merge case the chip shows merged but the card stays in Review forever and no pane notify or review-changed ever fires — the opt-in rule silently no-ops.
  Verifier: Traced restart → fresh engine (services.ts:122-135) → fetchOnce with prev=undefined → transitionLabel null guard (engine.ts:163) → onTransition/applyTransitionRules (services.ts:55, github-board.ts:213) never fire; no status persistence or startup reconcile exists. Severity high is accurate.

- **[MEDIUM · bug] No in-flight guard: concurrent ticks duplicate gh fetches and can double-fire transitions**  
  Where: `src/backend/features/integrations/services/engine.ts:114`  
  Evidence: fetchOnce (engine.ts:114) has no per-link in-flight flag; refresh() (engine.ts:86) ticks immediately without clearing the pending cadence timer. Overlapping fetchOnce calls each capture prev at entry (engine.ts:116), so both compute the same transition label.  
  Recommendation: Add an inFlight boolean to LinkRuntime; skip or coalesce ticks arriving while a fetch is in flight, and clear the pending timer at tick start.  
  Why: Chip Refresh (board/index.ts:66 → linkRefresh IPC) racing the cadence timer, or a double-click, sends the same 'PR #N: merged' notify twice, fires review-changed webhooks twice, and spawns duplicate gh subprocesses.

- **[MEDIUM · bug] A throw from the notify/rules sink corrupts a fresh status to stale and inflates backoff**  
  Where: `src/backend/features/integrations/services/engine.ts:142`  
  Evidence: deps.onTransition is called inside fetchOnce's try (engine.ts:142); the catch (engine.ts:143-149) overwrites the just-fetched fresh status with prev-as-stale and doubles backoff. services.ts:55-64 calls daemon notify, emitBridgeEvent, and transitionRules with no try/catch despite its own comment.  
  Recommendation: Invoke onTransition after fetchOnce's try/catch (or wrap it in its own); additionally wrap transitionRules?.() in services.ts onTransition.  
  Why: If applyTransitionRules/applyCardPatch throws (board.ts:99 throws on a missing store), the chip shows 'stale' carrying the rule's error as reason and polling backs off up to 30m — a sink bug masquerades as a GitHub outage.

- **[MEDIUM · improvement] Unbounded concurrent gh spawns at boot/import; detect spawns gh --version every fetch**  
  Where: `src/main/services.ts:135`  
  Evidence: engine.setLinks(loadLinks()) at boot (services.ts:135) ticks every link at once (engine.ts:71); ghImport links up to 50 cards, each calling engine.refresh (services.ts:88). Every fetch first runs detect() = a fresh `gh --version` subprocess (engine.ts:122, github.ts:58).  
  Recommendation: Cache detect() in the adapter for a TTL (~5 min) and stagger initial ticks with the existing jitter or a small concurrency pool (e.g. 3) instead of firing all links at once.  
  Why: N links means ~2N simultaneous subprocess spawns pre-paint (perf/perception budget path) and a GitHub API burst inviting the 429s the engine then backs off from; docs promise one bounded request per refresh — reality is 2-3 spawns.

- **[MEDIUM · gap] Links on archived/Done cards poll gh forever; no retirement path except manual unlink**  
  Where: `src/main/services.ts:113`  
  Evidence: removeLink is reachable only via the linkRemove IPC (services.ts:139); nothing wires card archive/auto-archive to it (cards are archive-only, docs/18). applyTransitionRules skips archived cards (github-board.ts:215) but the engine keeps their 5m-cadence polls.  
  Recommendation: On card archive (and auto-archive), remove or pause the card's link — export retireLinkForCard(cardId) from services.ts and call it from board.ts's archive path; re-add on restore.  
  Why: Every imported-then-finished issue card keeps spawning two gh subprocesses every ~5 minutes for the life of the profile — unbounded growth in CPU, battery, and GitHub rate budget for cards nobody can see.

- **[MEDIUM · behavior-mismatch] Fixture 'fake' adapter ships registered in the production engine, selectable over IPC**  
  Where: `src/main/services.ts:123`  
  Evidence: registerServices unconditionally registers createFakeAdapter() beside github (services.ts:123), and setLink honors a renderer-supplied service field (p?.service ?? 'github', services.ts:105). boardgh-audit-fixture.ts:4-8 states the shipped app 'can only ever run the user's real gh'.  
  Recommendation: Register the fake adapter only under the harness (via harness-install/fixture-port, like boardGhWorld), and have setLink reject service ids not in the registered-adapter set.  
  Why: A linkSet call with service:'fake' renders fabricated PR statuses ('approved', 'merged') as real chips in a shipped build — the same fabricated-data shape fixture-port.ts names as the usage.ts audit failure (finding 41).

- **[LOW · docs-drift] Rate-limited first fetch claims 'showing last good' when no last good exists**  
  Where: `src/backend/features/integrations/services/github.ts:113`  
  Evidence: ghReason unconditionally returns 'GitHub rate limit — showing last good' (github.ts:113); when the first-ever fetch is rate-limited the engine has no prev and emits health:'error' carrying that reason (engine.ts:149).  
  Recommendation: Return a plain 'GitHub rate limit — try again shortly' from ghReason and let the engine's stale branch, which alone knows prev exists, own the 'showing last good' phrasing.  
  Why: The failure-honesty rule (labeled failures; stale is a state) is broken in wording: the chip's error state asserts a stale re-serve that never happened.

- **[LOW · test-gap] The transition-to-notify wiring in main has no gate: smokes bypass services.onTransition**  
  Where: `src/main/services.ts:55`  
  Evidence: boardgh-smoke.ts:189 calls githubBoardDebug.applyTransitionRules directly; integ-smoke.ts drives a standalone ServiceEngine with a stub onTransition. Nothing tests services.ts:55-64 (card lookup, paneId notify via daemon, review-changed emission, statusFor handoff).  
  Recommendation: Extend BOARDGH (or INTEG) to mint a fake-service link on a pane-claimed card, flip the fixture state, and assert one daemon notify (stub) and one bridge event via setBridgeEventSinkForSmoke.  
  Why: A regression in the routing glue — wrong paneId string, notify verb, or statusFor lookup — passes every gate while breaking the headline promise that review lands back in the pane that wrote it.

## connections-oauth  (implemented: yes)

> Expected: ADR 0014: the app is the sole OAuth client per service (PKCE browser or RFC 8628 device flow); tokens rest only as OS-keychain ciphertext with one decryption point; CLIs reach services via a secret-free stdio bridge; serialized rotation-safe refresh; local-only disconnect; no daemon.

- **[HIGH · behavior-mismatch] [✓] Offline heartbeat demotes valid grants to 'expired', rings attention, never recovers**  
  Where: `src/main/connections.ts:1401`  
  Evidence: verifyOne:1401-1414: null accessTokenFor records 'unauthorized' + state 'expired'. doRefresh:1180-1186 writes 'expired' on ANY refresh failure incl. 'Could not reach host'. Network-down guard covers only the probe leg (1500-1504); sweeps (1556-1558) filter state==='connected', so demoted cards never rejoin.  
  Recommendation: Return a typed refresh outcome from accessTokenFor; in verifyOne's !token branch classify it with isNetworkDownMessage: on network-down write no state, record no attention, return 'network-down' so the sweep aborts. Let sweeps revisit such 'expired' cards.  
  Why: Violates the reachability law in connection-pulse.ts:13-15 and status-engine.ts:15. A laptop waking offline with stale tokens turns every OAuth card red with wrong 'reconnect it' advice until a manual Check or agent call.
  Verifier: Traced heartbeat→verifyOne→accessTokenFor→doRefresh: offline fetch fails (oauth.ts:369-371), doRefresh:1185 writes 'expired'; null-token branch (1402-14) rings attention, bypasses network-down guard; sweep filter 1557 excludes demoted cards. High stands; 'never recovers' slightly overstated.

- **[MEDIUM · bug] Concurrent connect() race: superseded flow leaks server; stale timer kills live flow**  
  Where: `src/main/connections.ts:500`  
  Evidence: abandonFlow() runs at line 405 but `pending` is assigned at 500 after 2-3 awaits. A second connect() in that window passes its own abandonFlow (pending null); the later assignment overwrites `pending` without closing the loser's server/timer; the timer callback (512-515) calls endFlow() with no identity check.  
  Recommendation: Re-run abandonFlow() immediately before `pending = {...}` at line 500, close the previous flow's server when overwriting, and guard the timeout callback with `if (pending !== flow) return` before endFlow().  
  Why: Connect card A then card B while A is mid-discovery: A's consent hits A's still-open server, fails the state check against flow B and errors B's card (668-673); or A's stale 5-min timer closes B's live server mid-consent.

- **[MEDIUM · test-gap] Main-side flow lifecycle (supersede, timer, cancel ordering) has no automated coverage**  
  Where: `src/main/connections.ts:254`  
  Evidence: CONNPURE, DEVICEFLOW and PREREGCLIENT smokes bite only Electron-free backend halves (oauth.ts, client-registry.ts, connect-orchestrator.ts, credential-core.ts). The PendingFlow state machine in src/main/connections.ts (254-530, 656-763) is exercised by no test; tests/unit has no connections coverage.  
  Recommendation: Extract the pending-flow lifecycle into an Electron-free module with injected timer/server effects, mirroring connect-orchestrator.ts, and add a CONNPURE lane asserting double-connect, cancel-during-exchange, and timer-after-supersede interleavings.  
  Why: The concurrent-connect race above lives exactly in this uncovered seam, and the file's comments record three prior hand-found bugs there ('connecting forever', late-cancel overwrite). commitLandedGrant proves the extraction pattern works.

- **[LOW · bug] clearClient mid-flight guard covers code flow but not a device poll at the same issuer**  
  Where: `src/main/connections.ts:1051`  
  Evidence: clearClient abandons only `if (pending && pending.metadata.issuer === issuer)` (1051-1053). A device flow lives in `pendingDevice` (292), which stores no issuer and is never checked; its poll (590-651) keeps the cleared client in memory and on success commits `userClient: client.source === 'user'` (649).  
  Recommendation: Store the issuer in `pendingDevice` alongside serviceId/cancelled, and have clearClient abandon a matching device flow the same way it abandons a matching `pending` code flow.  
  Why: A device poll completing after Forget-client-ID stamps a connected card claiming a pasted client the vault no longer holds; the guard's own comment says it exists to prevent this. Latent: only github-mcp.json declares a device endpoint.

- **[LOW · bug] Boot sweep demotes interrupted flows without clearing the stale `device` panel from meta**  
  Where: `src/main/connections.ts:1589`  
  Evidence: sweepInterruptedFlows writes `{ state: 'error', lastError: ... }` (1593) without `device: undefined`, unlike every other demotion (312, 606-608, 1080, 1090) which clears it; the stale userCode/verificationUri persists in the KV meta across restarts.  
  Recommendation: Add `device: undefined` to the setState patch in sweepInterruptedFlows (line 1593), matching every other state demotion.  
  Why: Harmless in current UI (devicePanel renders only in the 'connecting' case, ui connections.ts:949), but any future consumer of `device` outside 'connecting' resurrects the stale-code-panel bug the file warns about at 1088-1090.

- **[LOW · docs-drift] Live check's hardcoded GitHub scope list claims to match the app but can drift**  
  Where: `scripts/device-flow-live-check.ts:42`  
  Evidence: SCOPES = ['repo','read:org','read:user','user:email','gist','workflow'] with the comment 'the same list the app asks for' (41-42). The app derives scopes at runtime from RFC 9728 resource metadata via pickScopes (src/backend/features/integrations/oauth.ts:289-296); nothing pins the two together.  
  Recommendation: Have the script fetch GitHub's protected-resource metadata and derive scopes via pickScopes (falling back to the hardcoded list), or reword the comment to call the list a dated snapshot of what the resource declared.  
  Why: The check's step 4 answers 'could this grant clone private repos'; if GitHub's resource-declared scopes change, the manual check verifies a different consent than users see, quietly invalidating its evidence. (confidence: medium)

## explorer-files  (implemented: yes)

> Expected: A read-only, virtualized, git-decorated explorer dock that watches only visible (expanded) directories via a 64-handle LRU fs.watch pool with jittered poll fallback, updates within 1s, costs zero when closed/hidden, and only delegates (open/reveal/copy/send-to-pane) without ever executing.

- **[HIGH · bug] [✓] Landing listings clear the stale flag on unwatched dirs, resurrecting ghost listings**  
  Where: `src/ui/components/file-tree.ts:196`  
  Evidence: ensureLoaded (file-tree.ts:196) and applyChanged (:653) set st.stale=false unconditionally. markUnwatched (:446-450) sets stale on collapse, but setShowHidden (:697-702) calls applyChanged([...nodes.keys()]) — every cached COLLAPSED dir is re-listed and its stale flag cleared while unwatched.  
  Recommendation: At both landing sites set st.stale = !(dir === rootPath || expanded.has(dir)) instead of false, so a listing landing for a dir outside the watch set stays marked for re-list on next expansion. Add the collapse+setShowHidden sequence to TREELIVE.  
  Why: Deterministic: expand src/, collapse, toggle show-hidden, agent writes src/new.ts, re-expand — ensureLoaded skips the list, main seeds a fresh watch signature, so no batch ever corrects it. The tree shows a wrong listing indefinitely.
  Verifier: Traced: setShowHidden:701 feeds collapsed dirs to applyChanged, clearing stale at :653; ensureLoaded:174 skips re-list on expand; watch.ts setDirs/seed re-seeds sig silently, no corrective batch. Real, but heals on next change in dir or Refresh — corrected severity: medium.

- **[HIGH · bug] [✓] Dock closed before first git:filesChange leaks the repo registration; git polls forever**  
  Where: `src/ui/features/explorer/index.ts:576`  
  Evidence: dropGit only unwatches when gitRoot is known (index.ts:576), and gitRoot is set solely by onGitFiles (:402) whose first event needs a git status spawn. monitor.watchFiles keeps the root in fileRoots, keeping the 2.5s interval alive (monitor.ts:246), and lastFiles survives (:322).  
  Recommendation: Track the cwd passed to gitFilesWatch in a renderer variable and unwatch by it in dropGit regardless of gitRoot; or let unwatchFiles('') clear the dock's registration in GitMonitor. Assert 0 spawns after a fast close in the TREEGIT smoke.  
  Why: Close the dock or switch workspace inside the first-probe window: git polls every 2.5s while closed, breaking docs/16 §7's 'closed explorer = 0 git traffic' law; on reopen the change-only check suppresses the emit, so decorations stay dead.
  Verifier: dropGit (index.ts:576) is the sole unwatch; gitRoot set only by onGitFiles after the async first emit. Close in that window leaks fileRoots, poll persists (monitor.ts:246/338), lastFiles suppresses reopen emit. Corrected severity: medium (narrow race, self-heals).

- **[MEDIUM · bug] Virtualization drops keyboard focus to body when the focused row scrolls out**  
  Where: `src/ui/components/file-tree.ts:307`  
  Evidence: renderWindow clears body (:283) then re-focuses only when the active row is inside the rendered window (:311-313); when active < first || active >= first+count it merely sets tabIndex=0 on the first row (:307-310) — the removed focused row lets DOM focus fall to document.body.  
  Recommendation: In renderWindow, when hadFocus is true and the active row is not rendered, focus the scroller itself (give it tabIndex=-1) or the substitute tabindex-0 row, so key events keep reaching the scroller's keydown handler.  
  Why: Focus the tree, wheel-scroll a page: arrows, type-ahead, Shift+F10 and the dock's Ctrl+C all stop working (listeners sit on scroller/dock, which no longer contain focus) until the user clicks a row again. An APG tree must keep focus.

- **[MEDIUM · bug] refreshIgnored's ignoreBusy guard silently drops invalidations with no re-run**  
  Where: `src/ui/features/explorer/index.ts:373`  
  Evidence: refreshIgnored returns immediately when ignoreBusy (index.ts:373); the dirs list is snapshotted before the sequential await loop (:373-382), so a dir expanded or invalidated (ignoredByDir.delete at :335) while a pass is awaiting git is neither processed nor rescheduled.  
  Recommendation: Replace the boolean skip with a pending flag: if busy, set ignorePending=true and return; after the loop, when ignorePending, clear it and run another pass over dirs missing from ignoredByDir. Keeps one-spawn-per-dir without dropping work.  
  Why: Expand two dirs quickly, or a batch lands mid-pass: the second dir's ignore-dimming is missing or stale until the next unrelated event — indefinitely in an idle repo, contradicting docs/16 §4's cache-until-listing-changes promise.

- **[MEDIUM · test-gap] Zero unit tests for the Electron-free explorer core; all guarantees ride env-gated smokes**  
  Where: `src/backend/features/explorer/watch.ts:36`  
  Evidence: watch.ts:34-36, list.ts:24 and file-tree.ts each claim to be 'Electron-free/testable without booting an app', yet tests/unit contains no explorer, watcher, or file-tree test (only shell-quote/relative-to-dir touch this feature); coverage is exclusively the E2E smokes.  
  Recommendation: Add vitest units: createExplorerWatcher against a temp dir (cap eviction, sig-change-only batches, suspend/resume), a listExplorer refusal/cap/sort table, and createFileTree with a stub list asserting the stale/expanded invariant.  
  Why: The LRU/poll demotion ladder, coalesce ceiling, suspend/resume re-seed and the stale-flag invariant (finding 1) are unit-testable state machines; smokes are slow, env-gated and timing-loose, so this regression class lands unseen.

- **[LOW · bug] Rapid workspace switch mid-load clobbers the interrupted workspace's expansion memory**  
  Where: `src/ui/features/explorer/index.ts:616`  
  Evidence: root() calls saveMemory() first (index.ts:616) with wsId/rootPath still naming the PREVIOUS workspace; if that workspace's own root() was interrupted before its memory restore (:654-661), tree.expandedDirs() is the just-reset empty set, overwriting memory.get(prevId).  
  Recommendation: Skip the save while a root() is in transit: set a 'settled' flag after the memory-restore block completes and have saveMemory no-op when the current generation never settled, so an interrupted load cannot overwrite a good snapshot.  
  Why: Switch to workspace A (large folder, listing in flight), then quickly to B: A's remembered expansion/scroll/selection is replaced by an empty snapshot, breaking the documented per-workspace 'returning, not arriving' memory promise. (confidence: medium)

- **[LOW · docs-drift] Worktree-deleted files never show the promised D/strikethrough row, even in the lens**  
  Where: `src/ui/components/file-tree.ts:246`  
  Evidence: Rows exist only for entries in st.children from readdir (file-tree.ts:246; list.ts:47); a file deleted from the worktree is absent from the listing, so the D badge/strikethrough (docs/16-files.md:163) and the Changes-lens filter (lensSets over gitFiles) have no row to decorate.  
  Recommendation: Either amend docs/16 to state deletions surface only via folder tint and chip count, or render synthetic deleted-file rows inside the Changes lens (paths from gitFiles with state 'deleted'), marked meta so delegation verbs refuse the missing file.  
  Why: docs/16 promises deleted files render struck-through and the lens shows the changed paths; a deletion is invisible (only index-deleted-but-on-disk files ever show D), and the chip count exceeds the rows the lens can display.

## agent-settings-editor  (implemented: yes)

> Expected: Settings → Agent CLIs edits Claude/Codex/Gemini/Aider/OpenCode config via honest scopes, dialect-preserving one-layer edits, per-setting baseline capture/restore, drift detection, and a validated catalog refreshed at most daily — with no interval polling of provider files.

- **[HIGH · behavior-mismatch] [✓] Hourly interval reconciles/polls provider files, contradicting docs' no-interval promise**  
  Where: `src/main/agent-settings.ts:398`  
  Evidence: catalogTimer = setInterval(... refreshInstalledCatalogs(true), 60*60*1000) at src/main/agent-settings.ts:398-401; refreshInstalledCatalogs (383-392) force-spawns 5 version probes, unconditionally awaits settings.reconcileAll() (reads/rewrites enforced provider files) and emitChanged for all 5 providers hourly.  
  Recommendation: In the interval callback, run reconcileAll only when refreshDue actually refreshed a catalog or a probed version changed; add daily backoff for stale-catalog retries in isDue; emitChanged only for providers that changed.  
  Why: docs/17:102 says 'No interval polls provider files.' A stale catalog also makes isDue true (catalog-service.ts:124), so network refresh retries hourly, breaking 'at most daily'; hourly wakeups fight the perf-budget law.
  Verifier: setInterval is at agent-settings.ts:460-462 (not 398). reconcileAll touches provider files hourly only if enforce rows exist (service.ts:725 short-circuit); network fetch daily-gated by isDue except hourly stale-retry (catalog-service.ts:124). Docs 17:102 contradicted. Corrected severity: medium.

- **[MEDIUM · bug] Baseline capture not hash-linked to the write; restore can revert to a stale value**  
  Where: `src/backend/features/agent-settings/service.ts:253`  
  Evidence: set() captures baselinePresent/baselineValue via a standalone coordinator.read (service.ts:253-265); reconcileRows() later does a fresh read and uses THAT hash as the CAS token (service.ts:442, 457-459). No hash continuity connects the baseline read to the mutated snapshot.  
  Recommendation: Pass the baseline-read snapshot's hash as expectedHash to coordinator.mutate for the first apply, or re-derive the baseline from the `current` snapshot inside transform and persist it only after the write succeeds.  
  Why: If the CLI or user rewrites the key between set()'s baseline read and reconcile's read, the write lands (CAS passes vs the newer hash) but the recorded baseline is older; 'Restore previous' later reverts to the wrong pre-claim state.

- **[MEDIUM · gap] AgentConfigSource.candidates never populated; OpenCode writes fragment user config**  
  Where: `src/backend/features/agent-settings/sources.ts:245`  
  Evidence: candidates ('Alternative filenames are checked in order before file is created', sources.ts:43-44) is consumed at sources.ts:364/378 but no fileSource call sets it. OpenCode user runtime is three separate sources (245-247); selectAgentConfigSource reverse-find (376) always picks opencode.jsonc.  
  Recommendation: For OpenCode user scope, emit one writable source with candidates ['config.json','opencode.json','opencode.jsonc'] so an existing file is edited in place and opencode.jsonc is created only when none exist; keep the read chain as separate layers.  
  Why: A user whose only real config is ~/.config/opencode/config.json gets every Workspace edit written into a newly created opencode.jsonc, splitting configuration across files and shadowing later hand edits to config.json.

- **[MEDIUM · behavior-mismatch] Drift computed in snapshot() never persisted; overview can say synced while drifted**  
  Where: `src/backend/features/agent-settings/service.ts:154`  
  Evidence: providers() rolls up sync health from stored row.status (service.ts:154-155, 165), which changes only on reconcile. snapshot() computes live drift via computeSyncState (204-213, 605) but never writes it back; computeSyncState skips the drift branch when the selected source has a read error (122).  
  Recommendation: Persist the recomputed status when snapshot() finds it differs from desired.status for enforce rows, and in computeSyncState map a selected-source read error on an enforce row to 'error' instead of keeping desired.status.  
  Why: docs/17 promises drift is visible without opening the provider file. After an external hand edit the overview keeps the stale persisted status until a reconcile; a corrupted selected layer leaves an enforce row showing its old status. (confidence: medium)

- **[LOW · bug] mergeValues deep-merges objects for providers whose merge mode is 'replace'**  
  Where: `src/backend/features/agent-settings/service.ts:98`  
  Evidence: settingState's effective loop calls mergeValues(effectiveValue, read.value, merge === 'deep-concat-arrays') (service.ts:589). mergeValues (98-107) deep-merges any two objects regardless of merge mode; Aider sources declare merge: 'replace' (sources.ts:236-241).  
  Recommendation: Thread the source's merge mode into mergeValues and return `next` outright (no object recursion) when merge === 'replace', reserving deep merge for 'deep'/'deep-concat-arrays' providers.  
  Why: Aider replaces per key between home/git-root/cwd files. For an object-valued key present in two layers, the UI would display a merged object Aider never produces (bounded: most Aider options are scalars/lists). (confidence: medium)

- **[LOW · test-gap] No unit tests for ConfigMutationCoordinator CAS/atomicity or secret-name heuristics**  
  Where: `src/backend/core/config-files/mutation-coordinator.ts:83`  
  Evidence: tests/unit has only codecs.test.ts for this feature. Nothing unit-tests ConfigMutationCoordinator (changed-under-us CAS, per-file queue, BOM/EOL, symlink handling at 131-146), validation.ts secretShapedName, or sources.ts precedence; coverage lives only in app-booted smokes.  
  Recommendation: Add tests/unit/mutation-coordinator.test.ts (tmp-dir CAS conflict, concurrent enqueue ordering, BOM/CRLF preservation, ENOENT) and a validation.test.ts table of secretShapedName positives/negatives mirroring the catalog gate's fixture ids.  
  Why: ADR 0011 gate 2 requires concurrent-edit and atomic-replacement fixtures. Smokes cover live flows coarsely; a regression in the CAS re-read (mutation-coordinator.ts:111-114) or the secret heuristic would not be caught headless.

## accounts-entitlements  (implemented: yes)

> Expected: Free local core works account-less and offline forever; Pro is a signed, device-bound entitlement claim verified locally, honored through a 14-day offline grace window, degrading to Free (never bricking); an unreachable or struggling AS/issuer must never end a session.

- **[HIGH · bug] [✓] Transient vault decrypt failure destroys the session: refresh clears the grant on !rt**  
  Where: `src/main/account.ts:592`  
  Evidence: doRefresh: rt = vaultLoad(VAULT_REFRESH) (582), then `if (!rt || !key) { clearSession() }` (592-597). vaultDecrypt returns null on ANY decryptString throw (src/main/vault.ts:46-52). vaultHas was already true (account.ts:566), so !rt here means exactly 'ciphertext present but decrypt failed'.  
  Recommendation: In doRefresh, treat rt-decrypt failure as transient: return null and keep the ciphertext instead of clearSession(). The real copied-vault case still ends cleanly when the AS rejects the foreign-key refresh (invalid_grant).  
  Why: A one-time keychain/DPAPI failure (macOS keychain deny after a signing change, DPAPI after a password reset) deletes the refresh-token ciphertext and DPoP key, violating the unavailable-is-not-absent law docs apply to the AS and device key. (confidence: medium)
  Verifier: Traced doRefresh: vaultHas true (:566), vaultLoad null on any decrypt throw (vault.ts:46-52), :592 clearSession wipes both vault slots. Module applies unavailable-vs-absent for device key (:586-590) and AS (:605) but not rt; no guard exists. Severity high stands.

- **[MEDIUM · gap] Cached entitlement is not bound to the account — another user inherits Pro through grace**  
  Where: `src/main/entitlements.ts:272`  
  Evidence: entitlementsSnapshot checks revoked/deviceMismatch/grace only (279-282); claims.accountId (parsed at 182) is never compared to the session. clearOnLogout runs only on explicit logout (404-409); a definitive AS rejection calls clearSession which keeps the entitlement cache (account.ts:604-608).  
  Recommendation: When a claim carries accountId and a session subject is known, drop the cache in refreshOnLogin when the new session's subject differs from cached claims.accountId (or compare in entitlementsSnapshot); keep the anon device-mismatch story untouched.  
  Why: Path: user A's session ends via invalid_grant (cache kept by design), user B signs in on the same machine, B's entitle fetch fails/404s (doFetch returns false, line 366) — B's app honors A's device-matching Pro claim for up to 14 days. (confidence: medium)

- **[MEDIUM · improvement] Background-refresh staleness keys off exp only; long-exp claim coasts to grace cliff**  
  Where: `src/main/entitlements.ts:397`  
  Evidence: maybeBackgroundRefresh: staleish = not-fresh OR `exp*1000 - now() < 6h` (397); graceStateOf answers 'fresh' whenever t < exp regardless of fetchedAt age (213-226). Nothing refetches on fetchedAt aging while fresh.  
  Recommendation: Add a fetchedAt-age term to the staleish predicate, e.g. `|| now() - entry.fetchedAt > GRACE_MS / 2`, so the fetch anchor advances on online machines independently of the issuer's exp choice.  
  Why: Docs promise an online machine open for weeks keeps its plan; that holds only if the issuer honors the 24-72h TTL. One long-exp claim means zero refetches for 14 days, then a visible Free degrade at the cadence tick before recovery.

- **[MEDIUM · test-gap] Wound-back-clock grace branch and engine invariants have zero unit tests**  
  Where: `src/main/entitlements.ts:220`  
  Evidence: The future-anchor branch `if (entry.fetchedAt - t > 86_400_000) return 'expired'` (220) is exercised nowhere: entitle-smoke only advances the clock (entitle-smoke.ts:156,169), and tests/unit has no entitlement/account test (account-defaults.test.ts is ADR 0022 agent settings).  
  Recommendation: Add tests/unit/entitlements-grace.test.ts: fetchedAt > now+1d reads expired and heals when the clock repairs; fresh/grace/expired boundaries; verifyEntitlementJwt refusing wrong alg/typ/shape; transient-vs-definitive classification in dpopTokenRequest.  
  Why: The anti-rollback promise (docs/19 grace law: a wound-back clock must not extend grace) is a security-relevant invariant proven only by a comment; graceStateOf and verifyEntitlementJwt are pure with an injectable clock, trivially testable.

- **[LOW · bug] Login over an existing session can keep the previous user's identity claims**  
  Where: `src/main/account.ts:320`  
  Evidence: persistGrant updates KV_EMAIL/KV_PLAN only when claims are defined (330-331); handleCallback passes undefined claims when the id_token's JWKS is unreachable (521-527) — the 'stored claims stand' rule (319).  
  Recommendation: On the authorization-code (login) path, blank KV_EMAIL/KV_PLAN before persistGrant when verified claims are absent, so a fresh session never inherits the previous account's identity strings; keep the refresh path's claims-stand behavior.  
  Why: If user B signs in over A's live session (no logout, so KV never blanked) during a JWKS blip, accountStatus shows B's session wearing A's email/plan in Settings. Display-only, but misidentifies the signed-in account. (confidence: medium)

- **[LOW · docs-drift] docs/19-accounts.md heading numbers itself as chapter 18**  
  Where: `docs/19-accounts.md:1`  
  Evidence: File is docs/19-accounts.md but its H1 reads '# 18 — Accounts, entitlements & hardening' (line 1).  
  Recommendation: Change the H1 to '# 19 — Accounts, entitlements & hardening' (or renumber the file), and grep docs/ for '18 —' references to this chapter.  
  Why: Cross-references elsewhere cite docs/19-accounts.md; a mismatched chapter number invites broken doc anchors and confusion about which chapter is authoritative.

## brain  (implemented: yes)

> Expected: One deterministic per-project context service (tree-sitter code graph, repomap injected at spawn, granted symbol writes, lockfile-true library docs, .memory wikilink graph with auto-captured drafts, promotion, recall) served to every pane over the house MCP server, staleness stamped on every answer.

- **[HIGH · bug] [✓] Lockfile changes via head moves or cold-start reconcile never re-resolve library truth**  
  Where: `src/backend/features/brain/freshness.ts:399`  
  Evidence: onHeadMove (freshness.ts:397-413) routes only '.memory/' paths to memorySubs; lockSubs fires only from onRepoBatch porcelain paths (freshness.ts:346). attachRoot's cold-start reconcile schedules only a memory rescan (index.ts:958-960), never scheduleLibraryResolve.  
  Recommendation: In onHeadMove's delta loop collect isLockfile(rel) paths and fire lockSubs exactly as onRepoBatch does; in BrainService.attachRoot, when reconcile=true also call scheduleLibraryResolve(root) alongside scheduleMemoryRescan.  
  Why: After a branch switch or a lockfile change while the app was closed, list_libraries/get_library_docs serve old versions with no dirty flag, breaking docs/20 organ 2's promise of same-tick lockfile re-resolve and doc pruning.
  Verifier: runLibraries fires only from rebuild (index.ts:320) and lockSubs (index.ts:268), which only onRepoBatch triggers (freshness.ts:346). onHeadMove and cold-start attach never do; serve.ts:479 is cache-read-only. Severity high stands.

- **[MEDIUM · gap] Sessions still alive at app quit never land a session draft**  
  Where: `src/ui/features/terminal/terminal-pane.ts:970`  
  Evidence: emitSessionCapture fires only from markDead (line 955, process exit) and dispose (line 2272, pane close). No beforeunload/pagehide/window-close flush exists anywhere in src/ui (grep for beforeunload|pagehide returns nothing).  
  Recommendation: On window close, flush live panes' ladders before renderer teardown (main's before-quit asks the renderer to invoke captureSession for each pane and awaits it), or mirror the block ladder main-side so quit-time capture needs no renderer.  
  Why: Quitting the app is the most common end of a long agent session, yet it captures nothing: the day's command ladder is silently lost, against docs/02's promise of auto-captured drafts at session end. (confidence: medium)

- **[MEDIUM · test-gap] One unit test file covers a ~9k-line feature; pure invariants untested outside smokes**  
  Where: `tests/unit/brain-libraries.test.ts:1`  
  Evidence: tests/unit holds exactly one brain test (lockfile parsers). writes.ts byte-splice arithmetic (lineStarts/eolOfLine/applyIndent, CRLF and no-trailing-newline edges), memory.ts parse/serialize/replaceMemoryBody, the filter grammar, capture.ts arcs, render.ts budget, recall ranking have no vitest coverage.  
  Recommendation: Add unit tests for writes.ts splice (replaceBody/insertAfter/insertBefore across LF, CRLF, and terminator-less EOF files) and memory.ts (parseMemoryText/serializeMemory/replaceMemoryBody round-trips, parseMemoryFilter errors) at minimum.  
  Why: These pure Electron-free functions guard user file integrity during symbol writes; today they are proven only by env-gated app-boot smokes that plain vitest never runs, so regressions in CRLF/EOF edge handling surface late and expensively.

- **[LOW · docs-drift] Docs' closed refusal-reason enum does not match the code's actual reason set**  
  Where: `docs/20-brain.md:137`  
  Evidence: docs/20 claims a closed 9-value refusal enum, but serve also emits 'unknown-node' (serve.ts:206), 'too-deep' (serve.ts:338), 'no-map' (serve.ts:472), 'unknown-library' (serve.ts:534), 'unknown-memory', 'wrong-checkout' (writes.ts:233), 'no-brain' (recall.ts:163); BrainRefusalReason (brain.ipc.ts:65) holds only 4.  
  Recommendation: Extend docs/20 section 3's enum to the real set, or centralize one exported union of serve-layer refusal reasons in src/contracts/ipc/brain.ipc.ts and type the refuse() helpers in serve.ts/writes.ts/recall.ts against it.  
  Why: Agents and integrators coding against the documented enum will mishandle the seven undocumented reasons; the 'closed enum' claim is load-bearing (junk refuses typed) but no type enforces it.

- **[LOW · improvement] A fresh worker (V8 isolate + sqlite open + WASM parser init) is spawned per drain**  
  Where: `src/backend/features/brain/index.ts:1049`  
  Evidence: runBuild (index.ts:1010), runDelta (index.ts:1049), and runLibraries (index.ts:1088) each `new Worker(workerFile)` and terminate after one op; drains recur every ~1-3s under active writes (BRAIN_DRAIN_QUIET_MS 750ms debounce, freshness.ts:28).  
  Recommendation: Keep one persistent worker per BrainService (created lazily, terminated in dispose()), dispatching build/delta/libraries ops over the existing id-keyed message protocol; the runExclusive queue already guarantees one op in flight per project.  
  Why: Repeated worker startup is pure overhead against docs/05 budgets under sustained 16-pane edit load; the parse cache saves parses but not the per-spawn isolate/WASM/db-open cost, and warm grammar instances are discarded every time. (confidence: medium)

- **[LOW · docs-drift] Usage counters and eviction counts contradict the 'db is disposable' stance**  
  Where: `src/backend/features/brain/store.ts:653`  
  Evidence: memory_usage (store.ts:653-667) and memory_draft_stats (store.ts:628-645) exist only in the derived db; docs/20 section 1 says the db 'is deletable and rebuildable at any moment', and index.ts:1146 makes delete+rebuild the documented recovery for an unopenable db.  
  Recommendation: Amend docs/20 section 1 to name usage/eviction counters as the deliberate exception to full rebuildability, and show a one-line note in the Brain view's usage table after a db recreation (a generation reset is detectable).  
  Why: The recall-usage truth the human prunes by (docs/20 section 6) and the 'never silent' eviction count are silently zeroed by the very recovery path the code recommends; two documented laws conflict without disclosure. (confidence: medium)

## context-monitor  (implemented: yes)

> Expected: A per-pane gauge showing how full each agent CLI's context window is, read from files the CLIs already write, with each provider's percent computed using that CLI's own formula so header and pane never disagree; for Claude an injected statusline relay pushes the exact /context numbers and identity.

- **[MEDIUM · bug] Relay pin never set when sink names the already-locked file**  
  Where: `src/backend/features/context/monitor.ts:334`  
  Evidence: monitor.ts:334 pins only when `sink.transcriptPath !== t.file`. In the normal app-launched flow the pane locks its own fresh log heuristically first (lines 352-356), then the first sink fire names that same file — the branch is skipped and `t.pinned` stays false forever.  
  Recommendation: At monitor.ts:334, when the fresh sink's transcriptPath equals t.file and !t.pinned, set t.pinned = true (no re-lock). Add a unit test asserting a heuristically-locked pane becomes pinned once its own sink confirms the file.  
  Why: Pin is the defense (header lines 57-59) against mtime takeover/migration; sessionFor() (line 142, ADR-0013 resume via src/main/context.ts:105) can name a foreign session after takeover despite the relay stating exact identity.

- **[MEDIUM · bug] aiderLogPath lacks the channel/version segment — dev and installed builds collide**  
  Where: `src/backend/features/context/providers.ts:25`  
  Evidence: providers.ts:25 builds `mogging-aider-<user>/<paneId>.jsonl` with no runtimeSegment, while contextSinkPath (readers.ts:184-187) added the segment precisely because pane ids are per-app and a segment-less dir made instances read each other's numbers. Both daemons inject it (pty-daemon/session.ts:536).  
  Recommendation: Include runtimeSegment(channelFromEnv()) in the aider dir name mirroring contextSinkPath (both derivations are app/daemon-side), and unlink aiderLogPath(paneId) in ContextMonitor.remove() alongside the claude sink.  
  Why: With dev build and installed release running concurrently (the supported case the claude sink fix targets), pane N of each app shares one aider log; both gauges wear whichever wrote last. remove() (monitor.ts:151) never sweeps this file.

- **[MEDIUM · behavior-mismatch] OpenCode emits a dead previous session's numbers as a real reading**  
  Where: `src/backend/features/context/monitor.ts:430`  
  Evidence: monitor.ts:430-444 emits readOpencodeUsage() unconditionally; providers.ts:99/146 picks the newest session row matching the cwd with no time filter. Contrast aider one branch up: `if (!r || r.mtimeMs < this.floorFor(t)) return` (monitor.ts:414).  
  Recommendation: Select the session's last-message time_created (or stat opencode.db/-wal mtime) and compare against floorFor(t): stay pending, or emit approx:true, until the reading postdates the watch floor — matching the aider guard above.  
  Why: Relaunching opencode in a cwd with history shows the old session's percent immediately, not flagged approx — violating the feature's own contract (pending until first response, ui/features/context/index.ts:73-75) and header/pane agreement.

- **[MEDIUM · improvement] Aider/opencode bypass the stat gate: sync reads and SQLite opens on main every tick**  
  Where: `src/backend/features/context/monitor.ts:412`  
  Evidence: Steps 3b (monitor.ts:412-444) run before the stat gate at line 449. readAiderUsage reads a 256KB tail every tick even when mtime is unchanged (providers.ts:34-40); readOpencodeUsage opens a fresh better-sqlite3 Database and runs a 200-row query per pane per 2.5s tick (providers.ts:137-146).  
  Recommendation: Gate both on last-seen mtimes (aider log; opencode.db and -wal) via the existing t.lastMtimeMs fields before reading. Also skip candidates() for these providers at monitor.ts:352 — they fall into the codex day-dir scan pointlessly.  
  Why: Contradicts the module's stated discipline (monitor.ts:28-31, stat-gated / zero reads idle) and perf-budget law: this runs synchronously in Electron main, so idle aider/opencode panes add recurring main-thread stalls to IPC latency.

- **[LOW · behavior-mismatch] Learned claude windows are global per model id — one 1M session poisons 200K panes**  
  Where: `src/backend/features/context/window.ts:61`  
  Evidence: learnClaudeWindow (window.ts:61-66) writes a process-global LEARNED_WINDOWS keyed by bare model id, last-writer-wins, never expired. claudeWindowForModel (line 73) prefers it for every transcript-only pane running that model.  
  Recommendation: Key learned windows by (home, model) — the watch already carries the resolved home — or prefer the documented table when a learned value conflicts downward, and note the cross-profile caveat in window.ts.  
  Why: Two profiles on the same model with different windows (1M beta vs 200K — the ambiguity the file documents) make an unrelayed pane report about half its true fullness (10% shown vs 50% real), hiding imminent auto-compaction. (confidence: medium)

- **[LOW · gap] No docs entry for the context gauge — spec lives only in contract comments**  
  Where: `docs/07-perception-budget.md:1`  
  Evidence: The audit's named doc source, docs/07, concerns GL/perception budgets, not this feature; no file under docs/ (00-21, ADRs) describes the context gauge. The de-facto spec is the comment block in src/contracts/ipc/context.ipc.ts:1-41 and monitor.ts headers.  
  Recommendation: Add a short docs section (in docs/21-agent-state-signals.md or a new docs/22-context-gauge.md) stating the gauge contract: per-provider sources, formula-parity rule, pending/approx semantics, and the relay/sink rendezvous.  
  Why: The feature encodes subtle promised behavior (per-CLI formula parity, pending/approx semantics, relay pinning, adopted lookback) that reviewers cannot check against any doc, inviting silent drift.

## templates  (implemented: yes)

> Expected: Provider-mix templates (code-named 06b): built-in and user-saved provider mixes resolve to a concrete pane grid and open a workspace with each slot's CLI launched; templates persist as metadata only (providers + counts, never credentials) in the app settings store.

- **[HIGH · gap] Template save persists custom: commands with no secret-shape refusal (custody rule)**  
  Where: `src/backend/features/workspace/settings-store.ts:777`  
  Evidence: saveTemplate (settings-store.ts:777-783) stores mix JSON verbatim; a mix provider may be `custom:<command>` (src/contracts/ipc/templates.ipc.ts:11), built from free text at src/ui/features/wizard/index.ts:1609. The same file defines valueLooksSecret (line 48) for ADR-0022 saves but templates skip it.  
  Recommendation: In saveTemplate (or the templates:save handler in src/main/templates.ts:30), run redactSecrets/valueLooksSecret over each mix entry's provider string and the template name, and refuse the save with the same typed refusal agent-settings uses.  
  Why: Custody law says secret-shaped values are refused at save. A preset whose custom command inlines a token (custom:MY_KEY=sk-... aider) lands in plaintext SQLite, bypassing the house detectors guarding every other save in this store.

- **[MEDIUM · bug] Saved presets silently lose their pane count (shell slots dropped from the mix)**  
  Where: `src/ui/features/wizard/index.ts:1603`  
  Evidence: savePreset (wizard/index.ts:1599-1610) builds the mix from roster + custom counts only — shell slots are never recorded — while naming the card "N agents · M panes". applyMix (line 430-432) derives the grid from flat.length + shell entries, so a reapplied preset gets the CURRENT grid size, not M.  
  Recommendation: In savePreset, append { provider: 'shell', count: paneCount - agentTotal } to the mix; applyMix and resolveLayout already count shell entries, so apply then restores the saved grid size.  
  Why: A preset named "2 agents · 9 panes" reapplies as 2 agents on the default 4-grid: the card's own label promises a layout the apply path cannot reproduce. User-visible mismatch on the feature's core save-and-reapply loop.

- **[MEDIUM · bug] templates:save accepts unvalidated payloads; malformed mixes break the wizard**  
  Where: `src/main/templates.ts:30`  
  Evidence: The save handler passes t straight to saveTemplate with no shape check; loadTemplates (settings-store.ts:772-774) only drops rows whose mix cell fails JSON.parse — a non-array mix (object/number/string) survives the filter and reaches renderPresets, which calls p.mix.filter (wizard/index.ts:1629).  
  Recommendation: Validate in registerTemplates: id/name non-empty bounded strings, reject ids starting with 'preset-', mix must be an array of { provider: string, count: finite number }. Harden the loadTemplates filter to Array.isArray(t.mix).  
  Why: One bad row (buggy caller, corrupted DB, or an id reusing the 'preset-' prefix the wizard filter hides) throws inside the presets render, breaking the section with no UI path to repair or delete the row.

- **[MEDIUM · gap] Machine pane budget enforced only inside the wizard UI, not at the template open seam**  
  Where: `src/ui/core/workspace/open-service.ts:49`  
  Evidence: openWorkspaceFromTemplate → controller.openFromTemplate (controller.ts:1843) opens any paneCount with no capacity check; the budget model (pane-capacity.ts:100-159, which charges panesElsewhere) is consulted only by the wizard painter. Board card launches (board/launch.ts:86) open a new workspace + agent each time.  
  Recommendation: In controller.openFromTemplate (or the opener registered in workspace/index.ts:487), compare live pane total + spec.paneCount against machinePaneBudget(machineSpec()) and refuse or toast-warn on overflow, mirroring the wizard's honest-budget copy.  
  Why: Perf budgets are law (docs/05): repeated board/queue card launches can exceed the RAM/CPU budget the capacity model protects, silently, because enforcement lives in one caller's UI rather than the shared open seam. (confidence: medium)

- **[LOW · improvement] Curated grid list duplicated between backend resolve and UI layout, synced by comment**  
  Where: `src/backend/features/templates/resolve.ts:5`  
  Evidence: GRIDS = [1,2,4,6,8,9,12,16] at resolve.ts:5, commented '(Kept in sync with the layout feature's TEMPLATE_COUNTS)'; the authoritative list is src/ui/features/layout/templates.ts:19. No shared constant and no test crosschecks them.  
  Recommendation: Move the curated counts into src/contracts (next to ABS_MAX_PANES in domain/pane.ts) and import them in both resolve.ts and layout/templates.ts; add a unit assertion that TEMPLATES' keys equal the shared list.  
  Why: Adding or removing a curated grid on the UI side silently makes resolveLayout pad mixes to a pane count the toolbar no longer offers (or miss a new size), producing workspaces whose grid matches no template.

- **[LOW · docs-drift] Built-in PRESETS served to no consumer; comments claim a Home launcher that does not exist**  
  Where: `src/main/templates.ts:13`  
  Evidence: templates:list's only caller is wizardClient.listPresets (wizard.client.ts:26), and the wizard filters out every 'preset-' id (wizard/index.ts:359). Comments at templates.ts:13 and wizard/index.ts:356-358 claim Home + asyncstate consume the list; Home only calls openWizard (home/index.ts:94).  
  Recommendation: Either surface the built-ins in a real UI or delete PRESETS and the list-side merge; fix the two comments; add a provider-mix-templates section to docs covering the two resolve dialects and persistence.  
  Why: presets.ts is shipped dead weight and the stale comments will mislead the next change. No doc describes the templates feature at all: docs/01 and docs/18 never mention it, and the '06b' spec cited across the code exists only in comments.

- **[LOW · test-gap] No tests for template persistence or IPC handlers; only resolveLayout is covered**  
  Where: `tests/unit/resolve-layout.test.ts:1`  
  Evidence: tests/unit contains resolve-layout.test.ts only; nothing exercises SettingsStore.loadTemplates/saveTemplate/removeTemplate (settings-store.ts:766-787) — upsert semantics, corrupted mix cells, rowid ordering — or the request-shape branching in the templates:resolve handler (templates.ts:26-28).  
  Recommendation: Add a SettingsStore template unit suite (temp-file DB: save/overwrite/remove/load order, non-array and unparseable mix cells) and a handler-level test for both resolve request dialects.  
  Why: The persistence round-trip and the array-vs-{mix,exact} request parsing are the seams a refactor most likely breaks, and neither would fail a test today; the malformed-row weakness in finding 3 stays unpinned for the same reason.

## updater-distribution  (implemented: partial)

> Expected: Signed auto-update via the GitHub Releases feed (electron-updater) with signature verification, publish-after-assets draft law, space-free artifact names, graceful daemon retire before install, NSIS installer hardening, and winget/homebrew manifests pinned to shipped release bytes.

- **[HIGH · behavior-mismatch] [✓] Windows updates are not signature-verified; docs claim tampered builds are rejected**  
  Where: `electron-builder.yml:156`  
  Evidence: docs/10-distribution.md:88-90, docs/RELEASING.md:38-39 and src/main/updater.ts:20-22 all state electron-updater "verifies the update's signature, so an unsigned/tampered build is rejected". No publisherName or verifyUpdateCodeSignature exists anywhere in the repo (grep), and builds are unsigned (cert pending).  
  Recommendation: Fix docs/10:88-90, RELEASING.md:38-39 and the updater.ts comment: Windows updates are sha512-integrity-checked only until signing lands. Pin win.publisherName in electron-builder.yml now and assert it in verify-signing-readiness.mjs.  
  Why: NsisUpdater only verifies Authenticode when publisherName is present. Today Windows accepts any unsigned update; only sha512-vs-feed over HTTPS protects it. macOS diverges (Squirrel refuses unsigned) — a platform-divergence law hit.
  Verifier: Traced NsisUpdater.js:84-99: verifySignature skips (returns null) when app-update.yml lacks publisherName; repo sets none, so docs claims (10-distribution.md:87-88, RELEASING.md:38-39, updater.ts:20-22) are false. Corrected severity: medium — exploitation needs feed compromise or TLS MITM.

- **[HIGH · bug] [✓] Re-running Release for an old tag force-marks it --latest, regressing the feed**  
  Where: `.github/workflows/release.yml:332`  
  Evidence: release.yml:332 runs `gh release edit "$TAG" --draft=false --latest` unconditionally; the workflow explicitly supports dispatch against any existing tag (release.yml:10-16, example `-f tag=v0.3.0`). updater.ts:80 sets allowDowngrade=true whenever allowPrerelease is on.  
  Recommendation: In the publish job, compare the tag against the highest published semver (gh release list) and pass --latest=false when it is not the newest. Note the guard in docs/10's publish-after-assets section.  
  Why: A re-run to fix an old release republishes it as GitHub's "latest": /releases/latest then serves the old version to every install. Pre-release users (allowDowngrade=true) actively downgrade; everyone else sees a stale feed.
  Verifier: Traced dispatch(old tag) -> publish job release.yml:332: unconditional `gh release edit --latest`; no version guard anywhere (ensure-release:41-54 and publish:325-331 only check drafts/feed files). Stable users get stale feed, prerelease can downgrade via demote/republish path. Severity high stands.

- **[MEDIUM · bug] Background check clobbers phase 'ready', defeating the graceful pre-install daemon retire**  
  Where: `src/main/updater.ts:387`  
  Evidence: checking-for-update pushes phase 'checking' unconditionally (updater.ts:387); an offline failure settles to 'idle' (updater.ts:206-212). before-quit retires the daemon only when last.phase==='ready' (updater.ts:330-334); the restart handler refuses when phase!=='ready' (updater.ts:301).  
  Recommendation: Track an updateDownloaded flag set on 'update-downloaded' and gate before-quit/restart on it instead of last.phase; skip the periodic startCheck while a download is pending, or restore 'ready' on failed checks when the flag is set.  
  Why: Update ready, user picks Later, machine wakes offline past the 6-hour tick: phase leaves 'ready', the rail row vanishes, and quit installs via autoInstallOnAppQuit WITHOUT the retire — falling to installer.nsh's hard daemon kill.

- **[MEDIUM · behavior-mismatch] Draft-demotion guard misses partially-fed premature publishes**  
  Where: `.github/workflows/release.yml:50`  
  Evidence: ensure-release demotes only when DRAFT=false AND feed-asset count is 0 (release.yml:49-53: `[ "$FEED" = "0" ]`), while the publish job requires all three of latest.yml/latest-mac.yml/latest-linux.yml (release.yml:325-331). docs/10:132-139 says a prematurely published release is demoted back to draft.  
  Recommendation: Change the demotion condition to check the same explicit three-file list as the publish job and demote when any is missing, not only when all are absent.  
  Why: A release hand-published with only latest.yml present (e.g. a failed prior run's win leg) counts FEED=1 and stays live, so every mac/linux install's update check errors for the whole build window — the exact v0.16.0 outage the law targets.

- **[MEDIUM · test-gap] No test covers the phase-gated restart/quit install paths**  
  Where: `src/main/updater.ts:293`  
  Evidence: tests/unit has no updater test (directory listing); the only update gates are FIRSTRUN (fake feed UX), UPDATEFAIL and UPDATEOFFLINE (check-outcome classification, qa-smokes.sh:411-412). Nothing exercises the restart handler's phase guard (updater.ts:301) or the before-quit retire (updater.ts:329-334).  
  Recommendation: Extract the quit/restart decision (phase gate + retiredForInstall + installOnQuit) into a pure function and unit-test it, or add a gate that drives the fixture feed to 'ready' and asserts the before-quit retire fires exactly once.  
  Why: These paths are the fixes for the v0.11.x installer stall and the stale-'ready' dead-panes bug, both found live. They are the least-observable code in the feature and regress silently; the 'ready'-clobber race would have been caught here.

- **[LOW · bug] Daemon-retire PowerShell breaks on $ in install path and over-matches sibling dirs**  
  Where: `build/installer.nsh:137`  
  Evidence: installer.nsh:137 embeds $INSTDIR inside a double-quoted PowerShell string: `StartsWith(\"$INSTDIR\", OrdinalIgnoreCase)`. PS expands `$name` sequences inside double quotes, and the prefix match has no trailing path separator.  
  Recommendation: Publish $INSTDIR to the PowerShell child via SetEnvironmentVariable and read $env:MOG_INSTDIR inside the script (no interpolation), and compare against the path with a trailing backslash appended.  
  Why: Install dir is user-chosen; a path containing `$` (legal on NTFS) makes the filter match nothing — daemon survives, exe lock forces the double-extract fallback. No separator: C:\...\App also matches C:\...\App-dev's helper. (confidence: medium)

- **[LOW · improvement] winget installer manifest lacks AppsAndFeaturesEntries for upgrade correlation**  
  Where: `scripts/update-manifests.mjs:71`  
  Evidence: The generated installer manifest (packaging/winget/MoggingLabs.Workspace.installer.yaml) declares only Architecture/InstallerUrl/InstallerSha256 for a nullsoft per-user install; no AppsAndFeaturesEntries (DisplayName/Publisher/DisplayVersion).  
  Recommendation: Emit AppsAndFeaturesEntries in update-manifests.mjs's installer template with DisplayName "MoggingLabs Workspace", Publisher "MoggingLabs" and DisplayVersion ${version}, matching the NSIS uninstall registry values electron-builder writes.  
  Why: winget correlates installed NSIS apps via ARP registry entries; without AppsAndFeaturesEntries, `winget upgrade` can fail to match the installed app, and winget-pkgs reviewers routinely require the block — friction on submission day. (confidence: medium)

## wizard-first-run  (implemented: yes)

> Expected: A one-full-page new-workspace wizard beside the rail with a click-to-pick folder browser (breadcrumb + repo badges), a live first-run "Get set up" checklist on Home, skip/cancel/Esc re-entry, and a transactional launch that rolls back cleanly if interrupted.

- **[MEDIUM · bug] Successful launch never disposes wizard resources (leave() skipped)**  
  Where: `src/ui/features/wizard/index.ts:662`  
  Evidence: launch() ends with `if (activeView() === 'wizard') leave()`, but workspace controller.create() already ran `setActiveView('grid')` (src/ui/features/workspace/controller.ts:763) inside the awaited openPlannedWorkspaceFromTemplate, so on every successful launch the guard is false and leave() is skipped.  
  Recommendation: After a successful launch, dispose unconditionally (selection, cdLine, setupPanels, launching=false, openGeneration++) and only call goBack() when activeView() is still 'wizard'; split disposal out of leave() so navigation and cleanup are independent.  
  Why: selection subscribers, cd-line timers, and missing-CLI setup panels (each 'owns an IPC subscription apiece', index.ts:1390) stay live and mutate detached DOM until the wizard next opens — breaking the code's own disposal contract.

- **[MEDIUM · behavior-mismatch] First-run checklist completion collapse/toast is unreachable in production**  
  Where: `src/ui/features/home/firstrun.ts:209`  
  Evidence: Auto-dismiss + 'Setup complete' toast fire only inside refresh() (firstrun.ts:209-217), which runs only when Home shows (home/index.ts:286-293). view-port.ts:42 makes Home unreachable while any workspace exists, so the 'Open your first workspace' row can never flip done during a real Home render.  
  Recommendation: Subscribe the checklist to workspace-count changes (workspace-info-port) and run refresh() on the transition 0→1 workspaces regardless of active view, so completion is detected and persisted the moment the first workspace opens; keep the toast on that event.  
  Why: The Phase-6 promise (row flips live, card collapses on completion) passes only because the FIRSTRUN smoke drives the DEV-only refresh handle (firstrun-smoke.ts:64) — production cannot take that path.

- **[MEDIUM · bug] Checked isolation is silently dropped on any folder change**  
  Where: `src/ui/features/wizard/index.ts:1748`  
  Evidence: Every selection change calls probeIsolation() which nulls isolatePreflight (index.ts:1704) and syncIsolate() then forces `isolate = false` while unusable (index.ts:1751); when the new folder's preflight lands 'ok' the box is re-enabled but left unchecked — the user's choice is gone.  
  Recommendation: Track user intent (e.g. `wantIsolate` set in onChange) and re-apply it in syncIsolate() when the new preflight is ok; if the new folder cannot isolate, say so in isolateHint instead of resetting silently.  
  Why: Trigger: check 'Isolate each agent', click a sibling/sub folder in the browser (still a valid repo), Launch — agents open unisolated, writing into the checkout the user believed protected. Only signal is the quietly cleared box.

- **[LOW · docs-drift] docs/02 says the 8.5 wizard has 'no cd bar' but a cd line shipped and takes focus**  
  Where: `docs/02-mvp-and-roadmap.md:140`  
  Evidence: docs/02:140-141: 'a folder is pickable by click through a real browser (breadcrumb + repo badges), no `cd` bar.' The wizard builds a cd line beneath the path bar (index.ts:858-865) and open() deliberately focuses it first (index.ts:314-320); a WIZCD gate pins its behavior (scripts/qa-smokes.sh:617).  
  Recommendation: Amend the Phase-8.5 bullet in docs/02 to note the 2026-07-16 revamp reinstated a cd-only line (Tab completion, cd/chdir only) alongside click-to-pick, and reference the WIZCD gate.  
  Why: The roadmap's description of the shipped surface contradicts the product; anyone auditing 8.5 against docs/02 reads a false claim about the wizard's primary input affordance.

- **[LOW · bug] Folder browser reports a failed listDir IPC as 'That folder isn't there'**  
  Where: `src/ui/components/folder-browser.ts:337`  
  Evidence: load()'s catch maps a rejected listDir to `{ ok: false, reason: 'missing' }` ('It may have been moved or renamed'), while the path-selection controller maps the same failure to 'unavailable' ('The filesystem service did not answer') at path-selection.ts:107.  
  Recommendation: Change the catch in folder-browser.ts load() to `reason: 'unavailable'` so the REFUSALS.unavailable copy ('Try again') matches the actual failure, mirroring path-selection.ts.  
  Why: A transient IPC failure while double-clicking into a folder tells the user their real folder doesn't exist — misleading, and inconsistent with the typed-path route through the same wizard for the identical fault.

- **[LOW · gap] Preset save/delete IPC failures are swallowed with no feedback**  
  Where: `src/ui/features/wizard/index.ts:1611`  
  Evidence: savePreset(): `void wizardClient.savePreset(preset).then(...)` with no .catch (index.ts:1611-1615); removePreset likewise (index.ts:1669-1672). Every other wizard IPC call in open()/launch() has an explicit catch.  
  Recommendation: Add .catch handlers that surface the failure (path.setStatus warn or showToast 'Could not save preset — try again') and leave the in-memory list untouched; same for removePreset.  
  Why: If TemplateChannels.save rejects (store locked, disk full), the click produces nothing — no card, no error, plus an unhandled promise rejection — and the user's painted mix is silently not saved.

## palette-commands  (implemented: yes)

> Expected: A Ctrl/Cmd+K command palette listing every registered action, keyboard-first (combobox + aria-activedescendant), dimming unavailable commands and printing the reason instead of firing into surfaces the user cannot see (finding 29/30 contracts in code; docs/11 covers only its scrim/z-index/icon).

- **[HIGH · behavior-mismatch] [✓] Palette runs commands beneath a blocking modal; CommandContext.modalOpen is dead code**  
  Where: `src/ui/features/palette/index.ts:219`  
  Evidence: Ctrl+K handler (palette/index.ts:212-227) never checks isBlockingModalOpen(); run() (:179-184) only checks cmd.enabled. context.ts:19/69 computes modalOpen but no command reads it; only requiresGrid exists (context.ts:88). Modals mount to <body>, so inerting #app does not stop the palette.  
  Recommendation: In toggle(true) (palette/index.ts:98) early-return when isBlockingModalOpen(); or make availability() (command-port.ts:28) refuse by default when ctx.modalOpen unless a command opts in. Wire or delete the unused modalOpen field.  
  Why: With a review/confirm modal up, Ctrl+K then Enter runs 'New workspace…' or 'Toggle Board' under the dialog — the finding-29 defect ('a keystroke that mutates something you cannot see') the command context exists to prevent.
  Verifier: Traced Ctrl+K (palette/index.ts:212-227, no modal check) and run() (:179, only cmd.enabled; workspace:new/board:open have none); no command reads modalOpen. But palette z-index 150 > modal 100, so it opens visibly ABOVE the modal — not an invisible keystroke. Corrected severity: medium.

- **[MEDIUM · bug] Shift+Tab moves real focus onto an option row, breaking the combobox contract**  
  Where: `src/ui/core/a11y/overlay-trap.ts:74`  
  Evidence: FOCUSABLE (overlay-trap.ts:18-25) matches 'button:not([disabled])' regardless of tabindex, so focusables(panel) = [input, ...options] despite items being tabIndex:-1 (palette/index.ts:160). At the input (first), Shift+Tab hits the wrap branch (:72-74) and calls last.focus() on the last option button.  
  Recommendation: In focusables() (overlay-trap.ts:37-41) filter out elements whose tabindex is '-1' (matching native tab order) so the input is first and last and Tab/Shift+Tab wrap onto it. Add a unit test with tabindex=-1 buttons.  
  Why: One Shift+Tab strands a keyboard user — typing, arrows and Enter stop working until Esc — contradicting 'Real focus never leaves this input' (palette/index.ts:70) and breaking the aria-activedescendant pattern.

- **[MEDIUM · bug] Ctrl+K matched via e.key, dead on non-Latin keyboard layouts and off house style**  
  Where: `src/ui/features/palette/index.ts:216`  
  Evidence: palette/index.ts:216 tests `e.key.toLowerCase() === 'k'`, while brain/index.ts:67 and board/index.ts:281 deliberately use `e.code === 'KeyM'/'KeyG'`. On Cyrillic/Greek/Hebrew layouts Ctrl+K yields e.key 'л' etc., so the advertised palette shortcut never fires.  
  Recommendation: Match on `e.code === 'KeyK'` (keeping modifier checks) at palette/index.ts:216, mirroring brain/board; sweep the e.key-based chords in explorer/index.ts:767 and app-shell.ts:127 in the same change.  
  Why: The titlebar trigger and shortcuts sheet promise Ctrl+K; a layout-dependent chord silently fails for non-QWERTY users — the primary keyboard entry to every command. Same pattern in explorer/index.ts:767 and app-shell.ts:127.

- **[MEDIUM · behavior-mismatch] Hint rank/icon maps and in-grid boost cover 6 of 16 registered hint categories**  
  Where: `src/ui/features/palette/index.ts:31`  
  Evidence: HINT_PRI/HINT_ICON (palette/index.ts:31-32) list only Workspace/Board/Integrations/App/Trust/Appearance. Registered hints also include Agent, Profiles, Pane, Layout, Explorer, Browser, Worktree, Updates, Notifications, Help. ctxRank (:123) boosts only hint==='Workspace'.  
  Recommendation: Extend HINT_PRI/HINT_ICON to the full hint set, include Pane/Layout/Agent in the in-grid ctxRank boost at palette/index.ts:123, and warn in DEV when a registered hint is missing from the maps.  
  Why: Ten categories get the generic chevron glyph and rank 2, and 'in a workspace: its verbs rank first' is false for the pane verbs — zoom/split/launch-agent sort below 'Open integrations' on the empty query.

- **[MEDIUM · test-gap] Zero unit tests for score(), the command registry, or availability**  
  Where: `src/ui/core/commands/command-port.ts:50`  
  Evidence: tests/unit has 31 test files; none reference palette, score, command-port, or availability (grep over tests/ returns nothing). score() (palette/index.ts:15-28) and runCommand()'s refusal-toast path (command-port.ts:50-64) are pure or DOM-light.  
  Recommendation: Add tests/unit/command-port.test.ts (runCommand hit/miss/refusal, setCommands republish) and export score() for golden ordering tests over prefix/word-start/substring/subsequence and the empty-query rank.  
  Why: Ranking and matcher regressions ship silently, and runCommand is Home's entry point ('workspace:quick', home/index.ts:94-101) — a renamed command id would only fail at runtime, invisibly.

- **[LOW · gap] Rail toggle has a shortcut and a titlebar button but no palette command**  
  Where: `src/ui/shell/app-shell.ts:125`  
  Evidence: app-shell.ts:124-135 binds Ctrl+Shift+B and shortcuts.ts:77 documents it, but no setCommands() call registers a rail command (grep across all 12 sources). Explorer and browser dock toggles both have palette entries (explorer/index.ts:777, browser/index.ts:1117).  
  Recommendation: Register a 'rail:toggle' command (hint 'App', kbd 'Ctrl+Shift+B') from app-shell.ts calling toggleRail(), matching the explorer.toggle pattern.  
  Why: The palette header claims 'every registered action' is reachable; typing 'rail' or 'sidebar' finds nothing while 'explorer' and 'browser' both work — the one chrome toggle missing from the registry.

- **[LOW · improvement] Matcher scores out-of-order multi-word queries as zero**  
  Where: `src/ui/features/palette/index.ts:21`  
  Evidence: score() (palette/index.ts:15-28) ranks prefix/word-start/substring then a strict in-order character subsequence over title only. 'workspace new' scores 0 against 'New workspace…' (no char after the 'workspace' run matches ' '/'n'); cmd.hint and cmd.id are never searched.  
  Recommendation: Split the query on whitespace and require every token to match title+hint (scored prefix/word-start/substring, summed); keep the single-token subsequence as the fallback tier.  
  Why: Word-order-insensitive queries are the standard palette habit (VS Code splits tokens); category-first typing ('workspace new', 'pane split') yields 'No matching commands' despite an exact conceptual hit.

- **[LOW · docs-drift] Named docs source contains no behavioral spec for the palette**  
  Where: `docs/11-design-system.md:100`  
  Evidence: docs/11-design-system.md mentions the palette only as a scrim consumer (:100), a z-index rung (:411), and an icon surface (:727). No section states coverage, matching, availability, or the keyboard contract; those live only in code comments (palette/index.ts:45-49, context.ts:4-15).  
  Recommendation: Add a short palette/commands section to docs/11 (or the owning UX doc) stating the registry model, availability/refusal contract, empty-query rank intent, and the one-tab-stop keyboard contract.  
  Why: The audit's expected-behavior source cannot answer what the palette should do, so invariants like 'every registered action' and the refusal contract are unenforceable comment prose — the drift pattern docs/11 itself warns about.

## shortcuts  (implemented: yes)

> Expected: One SHORTCUTS source (KB-01) renders identically in the ? overlay, Settings › Shortcuts, and the palette; global chords use the platform modifier, never steal keystrokes from text fields or modals, and shifted chords deliberately spare real terminal keys so hosted TUIs keep their keyboard.

- **[HIGH · bug] [✓] Palette, explorer, rail, and settings chords skip the shortcutsBlocked guard**  
  Where: `src/ui/features/palette/index.ts:216`  
  Evidence: palette/index.ts:212-227 (Ctrl+K), explorer/index.ts:764-774 (Ctrl+Shift+E), shell/app-shell.ts:124-134 (Ctrl+Shift+B), settings/index.ts:1056-1068 (Ctrl+,) are capture-phase listeners with no shortcutsBlocked check; context.ts:76-85 calls it 'the guard every raw global keydown listener owes'.  
  Recommendation: Add `if (shortcutsBlocked(e.target)) return` to the four listeners (palette keeps its Escape-when-open branch); keep terminal-proxy exemption as-is. Add negative KBGLOBAL rows pressing Ctrl+K/Shift+E/Shift+B from the rename field.  
  Why: Same defect class as audit finding 29, fixed in only 4 of 8 global listeners: input stopPropagation is bubble-phase so it cannot protect against these, and open modals do not block them.
  Verifier: Traced all 4 listeners: no shortcutsBlocked, no compensating guard (modal.ts traps only Escape; no enabled() checks modalOpen) — Ctrl+K over a modal runs commands the modal blocks directly. But these are reversible chrome toggles; palette/settings need the exemption. Corrected severity: low-medium.

- **[HIGH · behavior-mismatch] [✓] Plain Ctrl+T and Ctrl+K stolen from terminals; hosted CLI keys break on Windows only**  
  Where: `src/ui/features/workspace/index.ts:708`  
  Evidence: workspace/index.ts:708-711 consumes plain Ctrl+T (capture + stopPropagation, terminal proxy exempted by context.ts:51-55); palette/index.ts:216-218 consumes plain Ctrl+K. app-shell.ts:122-123 and explorer/index.ts:762-763 state the opposite rule: plain Ctrl+B/Ctrl+E 'must reach the PTY'.  
  Recommendation: Let plain Ctrl+T/Ctrl+K pass to the PTY when e.target is inside .xterm (keep Cmd+T/Cmd+K on macOS and Ctrl variants outside terminals), or rebind to shifted chords; update SHORTCUTS rows and Command.kbd labels to match.  
  Why: Claude Code (todos) and Codex (transcript) bind Ctrl+T; readline binds Ctrl+K/T. On macOS Cmd carries the app chord so Ctrl+T/K still reach the CLI; on Windows they never can — platform divergence in an app whose job is hosting these TUIs.
  Verifier: workspace:708/palette:216 steal plain Ctrl+T/K before xterm (capture; proxy exempt, context.ts:53). No platform divergence though: isModKey (shortcuts.ts:15) matches ctrlKey on macOS too, so stolen on ALL platforms; deliberate, smoke-tested (kbglobal-smoke.ts:242). Corrected severity: medium.

- **[MEDIUM · bug] Half the global chords match e.key, half e.code — layout-dependent dead shortcuts**  
  Where: `src/ui/features/workspace/index.ts:726`  
  Evidence: workspace/index.ts:690,708-730 (t/d/enter/=/1-9 via e.key.toLowerCase()), palette/index.ts:216 ('k'), explorer/index.ts:767 ('e'), app-shell.ts:127 ('b') are layout-dependent; board/index.ts:280, brain/index.ts:68, browser/index.ts:1086 use layout-independent e.code (KeyG/KeyM/KeyU).  
  Recommendation: Standardize the workspace, palette, explorer, and rail listeners on e.code (Digit1-9, KeyT, KeyD, KeyK, KeyE, KeyB, Equal, Enter) as board/brain/browser already do; keep the '='/'+' dual-spelling logic via code 'Equal'.  
  Why: On AZERTY the digit row emits '&é"…' unshifted, so Ctrl+1..9 workspace switching is dead; on Cyrillic/Greek layouts Ctrl+K/T and Ctrl+Shift+E/B/D are dead while Ctrl+Shift+G/M/U work — inconsistency the sheet cannot explain.

- **[MEDIUM · docs-drift] SHORTCUTS sheet omits real bindings: scrollback, block jump, Insert chords, rail keys**  
  Where: `src/ui/core/commands/shortcuts.ts:29`  
  Evidence: shortcuts.ts:3-6 claims 'the map can't drift from the real bindings', but Shift+PageUp/PageDown/Home/End (terminal-pane.ts:867-877), Alt+Up/Down (:880), Ctrl+Insert/Shift+Insert (:802,:829), F2/Delete on rail tabs (workspace/controller.ts:606-615), and dock Ctrl+F/L/=/-/0 (browser/index.ts:1100-1110) are absent.  
  Recommendation: Add a 'Scrollback & history' group (Shift+PageUp/PageDown/Home/End, Alt+Up/Down) and the Insert-chord clipboard alternates to SHORTCUTS; list F2/Delete rail-tab keys as contextual rows. KBSHORTCUTS row-count floor (>=10) rises automatically.  
  Why: Discoverability is the feature's whole point (KB-01), and pane-scrollbar.ts:52-55 justifies aria-hiding the scrollbar because these keys make scrollback 'reachable from the keyboard' — an argument that fails if they are undocumented.

- **[MEDIUM · test-gap] No unit tests for the guard predicates; KBGLOBAL never presses Ctrl+K / Shift+E / Shift+B**  
  Where: `src/main/smokes/kbglobal-smoke.ts:47`  
  Evidence: kbglobal-smoke.ts:47-56 chord table covers D/Enter/Alt-arrows/G/U/T/1/2 only; tests/unit has no file exercising isEditableTarget, shortcutsBlocked, isModKey, or runCommand availability. kbshortcuts-smoke.ts:9 admits it 'proves the list, not the keys'.  
  Recommendation: Add tests/unit/command-context.test.ts (jsdom) for the context.ts predicates incl. the xterm-proxy exemption, and extend the KBGLOBAL chord table with Ctrl+K, Ctrl+Shift+E, Ctrl+Shift+B positive rows plus rename-field negative rows.  
  Why: The unguarded handlers (finding 1) are precisely the chords no gate presses — the same blind spot that once let 'every global chord was dead' ship (kbshortcuts-smoke.ts:10-13).

- **[LOW · bug] isModKey treats the Windows key as the app modifier on Windows/Linux**  
  Where: `src/ui/core/commands/shortcuts.ts:14`  
  Evidence: shortcuts.ts:14-16 returns e.ctrlKey || e.metaKey unconditionally; terminal-pane.ts:793-795 states the house rule it violates: 'on Windows metaKey is the WINDOWS key, and any Win+... combo the OS lets through must not be eaten'.  
  Recommendation: Mirror terminal-pane's split inside isModKey: `e.ctrlKey || (IS_MAC && e.metaKey)`, sharing the IS_MAC constant, so all listeners inherit the fix; the palette/explorer/rail longhand `e.ctrlKey || e.metaKey` copies should call isModKey too.  
  Why: OS-unreserved combos like Win+Alt+Arrow reach the renderer and move pane focus via workspace/index.ts:689-706; on Linux the Super key triggers every chord. Bounded, but exactly the divergence terminal-pane already guards against. (confidence: medium)

## settings-ui  (implemented: partial)

> Expected: Phase 8.5 promises a Settings shell whose dense tabs (Integrations, Usage) open overview-first with per-section disclosure that persists, no attention chip ever hidden behind a collapsed header, a settings search, and a safe non-secret write path (custody rule at the store boundary).

- **[HIGH · behavior-mismatch] [✓] Attention re-opens a hand-collapsed card on every signal, defeating persistence**  
  Where: `src/ui/components/collapsible-card.ts:129`  
  Evidence: setAttention calls setOpen(true,{persist:false}) whenever closed and a chip exists — no transition latch, though l.128 says it 'only insists the first time'. usage.ts:735 re-calls it on every UsageChannels.changed push (usage.ts:748); integrations.ts:1171 on every connections refresh (entry sync l.1087-97, push l.474).  
  Recommendation: Latch attention in setAttention: auto-open only on the null->non-null transition, reset the latch when attention clears, chip always rendered. Extend setusage-smoke: collapse providers during a hot snapshot, assert a second changed push leaves it collapsed.  
  Why: With a hot plan or expired connection, collapsing the card is undone by the next poll tick or settings re-entry; the stored '0' only matters on reload. Promised disclosure persistence dies exactly when attention is active.
  Verifier: Traced collapsible-card.ts:129 (only guard is !open, no latch), usage.ts:735/748 fed by per-poll pushes (main/usage.ts:344,207), integrations.ts:1131/1162/1171 (no dedupe, attentionOpens:true). No guard prevents the reopen. Severity corrected: medium (UX-only).

- **[MEDIUM · test-gap] Settings search (S5) has zero automated coverage in smokes or unit tests**  
  Where: `src/ui/features/settings/index.ts:884`  
  Evidence: grep for 'settings-search'/'Search settings' across src/main/smokes and tests/unit returns nothing; setshell-smoke.ts never mentions search. The index has subtle rules: rebuilt only on a session's first keystroke (index.ts:950), Enter clicks the first hit (l.981-984), folded-card open-before-scroll (l.930-934).  
  Recommendation: Add asserts to setshell-smoke.ts: type a query matching a knob in a folded Usage card, assert a .settings-search-hit, press Enter, assert the right tab shows, the fold opens, and the target flashes. Add a unit test pinning the indexed class names.  
  Why: Search is a headline 8.5 behavior over ~80 knobs, and the DOM-walk index silently breaks if any block renames .toggle-row-label/.cc-title/.section-header-caption; nothing would catch it.

- **[MEDIUM · behavior-mismatch] Search jump persists the fold open; the twin focus path deliberately does not**  
  Where: `src/ui/features/settings/index.ts:933`  
  Evidence: jumpTo opens folded cards via fold.querySelector('.cc-toggle')?.click(); that onclick is setOpen(!open), which always persists (collapsible-card.ts:120). applyIntegrationsFocus instead uses setOpen(true,{persist:false}) — 'you asked to see it once, not to change your layout' (integrations.ts:1107,1115).  
  Recommendation: Expose a non-persisting external open — a registry from data-collapsible id to handle, or a 'cc:open' CustomEvent the card handles with persist:false — and use it in jumpTo instead of clicking .cc-toggle.  
  Why: One search jump into a collapsed advanced card (e.g. Service keys) permanently rewrites the stored disclosure pref — the intent-overwrite the handle API (collapsible-card.ts:51) exists to prevent; two machine-open paths now disagree.

- **[LOW · bug] Search hits go stale mid-session: index nodes detach when live blocks repaint**  
  Where: `src/ui/features/settings/index.ts:950`  
  Evidence: buildSearchIndex runs only when !lastQuery and stores direct element refs (index.ts:896-918). Usage repaints its grid on every UsageChannels.changed push (usage.ts:748-756). A hit clicked after a repaint targets a detached node: scrollIntoView and closest('.collapsible-card') no-op.  
  Recommendation: Re-resolve the target at click time (store tab id + stable selector, or re-run the walk for the clicked title), or rebuild the index on every input event — an ~80-node walk is inside the docs/07 budget.  
  Why: Trigger: open Settings, type a query matching a usage row, wait one usage push, click the hit — only the tab switches; no scroll, flash, or fold-open. The 'no-op shaped like a success' jumpTo's own comment warns about. (confidence: medium)

- **[LOW · gap] Usage attention signal is purely visual — no text or ARIA for the hot state**  
  Where: `src/ui/features/settings/usage.ts:693`  
  Evidence: computeAttention builds a bare colored track (.usage-fill.is-hot, width:100%) with no text or aria-label; only the error branch appends a text pill (usage.ts:701). Integrations chips carry text ('2 need you', integrations.ts:59,1134).  
  Recommendation: Give the hot track an accessible name — append a visually-hidden span or set aria-label='usage above 90%' on the .usage-attn box in computeAttention, mirroring the integrations attnChip text pattern.  
  Why: The 'attention never hidden' promise fails for screen-reader users on Usage: the always-visible header announces nothing when a plan is hot, and the fill is color-only for low-vision users.

- **[LOW · docs-drift] Shell docstrings drifted: 'NINE tabs' and '13 tabs' vs the actual 14 sections**  
  Where: `src/ui/features/settings/index.ts:78`  
  Evidence: The mount docstring says 'a left TAB rail of NINE tabs' (index.ts:78) and the search comment says '~80 across 13 tabs' (index.ts:885-886), but the sections array defines 14 tabs (index.ts:535-844) and NAV_GROUPS lists all 14 ids (index.ts:38-43).  
  Recommendation: Update both counts or make the comments count-free ('NAV_GROUPS is the source of truth') so they cannot drift again.  
  Why: These comments double as spec for a 'compatibility surface' that gates (SETSHELL, KBSHORTCUTS, USAGESET) key off; stale counts invite trusting the wrong number.

## theme-design-system  (implemented: partial)

> Expected: One token layer (colors in exactly two places, enforced by grep), measured AA contrast via a shared four-theme probe, a 12-color identity ramp with per-theme ink mixes, reduced-motion becalming with a script gate, and a spacing gate frozen at --max 0.

- **[HIGH · behavior-mismatch] [✓] Documented color-literal guardrail is unwired and stale; token discipline drifted**  
  Where: `src/ui/styles/global.css:7240`  
  Evidence: docs/11:845 claims a grep gate (awk '$1 > 152', 'must return empty'). It is wired nowhere (qa-smokes.sh, ci.yml lack it) and run as documented returns 47 hits (token blocks end ~283). Real strays: global.css:659 #fff, 7039/7042 lane hexes, 7240-47 board-dot hexes, 3225/8422 raw shadows.  
  Recommendation: Add scripts/check-color-literals.mjs whitelisting token blocks by section banner (not line number), wire it as run_static in qa-smokes.sh, then tokenize or sanction the strays (board hues to theme layer, shadows to --shadow-*, #fff to a token).  
  Why: The core rule 'colors are defined in exactly TWO places' is violated and unenforceable as documented; the board dot/lane palette is theme-blind and new literals land silently.
  Verifier: Gate at docs/11:845 is unwired (not in qa-smokes.sh, ci.yml, any check-*.mjs; no stylelint) and returns 47 hits — token blocks end ~global.css:283, past the 152 cutoff. Strays at 659, 7039/7042, 7240-47, 3225/8422 real; no TS theming of dots/lanes. Severity inflated: medium.

- **[MEDIUM · bug] Phantom --surface-*/--text-dim tokens: undefined token in CSS, cited in docs**  
  Where: `src/ui/styles/global.css:10909`  
  Evidence: .usage-prov-row:hover uses var(--surface-2, rgba(128,128,128,0.06)); --surface-2 is defined nowhere, so the literal fallback always renders. docs/11:758-767 spec the gauge as '--surface-3 base', '--surface-1 ring', '--text-dim border'; actual CSS (global.css:10382/10401/10413) uses --border, --bg-elevated, --muted.  
  Recommendation: Replace var(--surface-2, ...) at global.css:10909 with a real token (--bg-elevated or a color-mix hover stop) and correct the gauge token names in docs/11's usage table to --border/--bg-elevated/--muted.  
  Why: A token that never resolves is a silent literal in feature CSS, and the docs teach a token vocabulary that does not exist — future code written to the docs will not resolve either.

- **[MEDIUM · bug] Spacing gate holes: one-line rules escape; malformed --max disables the freeze**  
  Where: `scripts/check-spacing.mjs:19`  
  Evidence: Demonstrated: a file with '.x { padding: 20px; }' plus a multi-line 20px rule reports 1 violation, not 2 — SPACING anchors to line start. Also demonstrated: '--max=0' and bare '--max' both exit 0 with violations present (indexOf misses '=' form; violations.length > NaN is false).  
  Recommendation: Scan declarations appearing after '{' on selector lines (or strip the selector prefix first), accept --max=N, and exit non-zero when --max is present but its value is not a finite number.  
  Why: The --max 0 freeze is law (docs/11:297, qa-smokes.sh:186); either hole lets drift return invisibly — one collapsed one-liner rule or one typo in the invocation and the gate is decorative.

- **[MEDIUM · improvement] aa-probe leaves renderer frozen and theme unrestored if any step throws**  
  Where: `src/main/smokes/aa-probe.ts:111`  
  Evidence: probeContrastAcrossThemes injects #aa-freeze (line 111), then loops setTheme per theme with no try/finally; restore + thaw run only after a fully successful loop (lines 127-128). Any rejection (setTheme absent outside DEV, renderer reload, executeJavaScript error) skips both.  
  Recommendation: Wrap the theme loop in try/finally with restore + thaw in finally; also compare the unrounded ratio to AA_TEXT (measure() rounds first, so 4.4951 passes as 4.5) and round only for the report.  
  Why: Eleven smokes import this probe, several composed: a mid-probe failure disables all transitions and strands the wrong theme for every later stage in the run, corrupting subsequent assertions and screenshots.

- **[LOW · docs-drift] docs/11 rail spec contradicts shipped CSS; stale ramp comment in model.ts**  
  Where: `docs/11-design-system.md:214`  
  Evidence: docs/11:214-215 say label overflow 'fades via an alpha mask-image instead of …' — global.css ~1694 reversed this to text-overflow: ellipsis (dated 2026-07-10). docs/11:196 bar 'floating 1px off the outline', insets '= the corner radius' — global.css:1789-1794 has left:0 attached and calc(var(--r-md) - 2px).  
  Recommendation: Update docs/11's rail-selection rows (ellipsis not mask; bar attached at left:0, r-md minus 2px insets) and fix the stale '54% toward black' comment at src/ui/features/workspace/model.ts:44-46 to the per-theme --ws-ink-mix formula.  
  Why: The file is declared the single source of truth; a contributor restyling the rail from this spec reintroduces exactly the treatments that were deliberately reversed.

- **[LOW · bug] Solarized terminal foreground diverges from chrome --text-hi**  
  Where: `src/ui/core/theme/themes.ts:176`  
  Evidence: themes.ts:7-9 promises 'a matching xterm terminal theme derived from the same values, so panes always match chrome', but solarized hand-passes '--text-hi': '#e4ddc8' (line 176) while its chrome --text-hi is '#eee8d5' (line 164). Nord and the others pass matching values; no comment explains the gap.  
  Recommendation: Pass the chrome value '#eee8d5' to terminalFrom for solarized, or add a comment stating the deliberate dimming and note it in docs/11's theme section.  
  Why: Pane text renders a visibly different cream from chrome text in one of four themes; if deliberate it is undocumented, if accidental it defeats the derivation helper written to prevent exactly this. (confidence: medium)

## telemetry  (implemented: yes)

> Expected: Telemetry must be opt-in end-to-end (both consent flags default OFF), honor DO_NOT_TRACK, use an anonymous install id, never carry PII/paths/terminal content, and generate zero network traffic when disabled — preserving the free-local-core "fully offline forever" promise (docs/00, ADR 0005).

- **[HIGH · behavior-mismatch] [✓] Product analytics events sent to Sentry when user consented only to error reporting**  
  Where: `src/main/telemetry.ts:37`  
  Evidence: composite() fans captureEvent to every active adapter (src/main/telemetry.ts:37-39); sentry adapter forwards it as Sentry.captureMessage (src/main/sentry-telemetry.ts:43-45); renderer forwards product events regardless of productAnalytics (src/renderer/telemetry.ts:52-54).  
  Recommendation: Make the Sentry adapter's captureEvent a no-op (mirror posthog-telemetry.ts:31-33 which no-ops captureError), or tag adapters with a kind and route captureEvent only to analytics adapters in composite().  
  Why: With errorReporting=true and productAnalytics=false, every usage event (agent.launched with provider, wizard/browser use, app.launched) is uploaded to Sentry as an info message — the two-toggle consent shown in Settings is not enforced.
  Verifier: Traced full path: with errorReporting on and productAnalytics off, composite([sentry]) (main/telemetry.ts:71-99) fans captureEvent (37-39) to Sentry.captureMessage (sentry-telemetry.ts:43-45); renderer forwards events unguarded (52-54); IPC handler (143-146) has no analytics check. High stands.

- **[HIGH · bug] [✓] Crash reports carry absolute paths with the OS username; beforeSend scrub too narrow**  
  Where: `src/main/sentry-telemetry.ts:31`  
  Evidence: beforeSend deletes only server_name, user, request (sentry-telemetry.ts:31-37). captureError sends raw errors (boot.ts:305, updater.ts:286): Node fs/spawn error messages and every stack frame abs_path embed C:\Users\<name>\... on user machines.  
  Recommendation: In beforeSend, normalize exception.values[].value and stacktrace frame abs_path/filename by replacing os.homedir() (and app paths) with placeholders; add a unit test asserting a synthetic ENOENT error event contains no homedir substring.  
  Why: ADR 0005 rules 1 and 4 forbid file paths and PII in telemetry; a username in exception values and stacktrace frames is PII and reveals workspace locations — exactly the crash-report-contents risk.
  Verifier: Traced captureError (boot.ts:305, pty.service.ts:292, updater.ts:286) -> composite telemetry.ts:34 (no sanitize) -> Sentry.captureException; beforeSend strips 3 keys only, no beforeBreadcrumb. Spawn/fs messages embed C:\Users\<name>. High stands; opt-in and SDK app:/// frame rewrite only narrow it.

- **[HIGH · docs-drift] ADR-mandated beforeBreadcrumb scrubber missing; console/http breadcrumbs unscrubbed**  
  Where: `src/main/sentry-telemetry.ts:26`  
  Evidence: Sentry.init (sentry-telemetry.ts:26-38) and renderer Sentry.init (src/renderer/telemetry.ts:31) set no beforeBreadcrumb and prune no default integrations, while docs/adr/0005-observability-sentry-posthog.md:36-37 says the adapter MUST set beforeSend/beforeBreadcrumb and drop console breadcrumbs.  
  Recommendation: Add beforeBreadcrumb to both inits: drop category 'console' (and strip 'http'/'fetch' URL data), or disable those breadcrumb integrations via the integrations option, matching ADR 0005 rule 3.  
  Why: @sentry/electron default integrations record console and http breadcrumbs in both processes; main-process logs contain workspace/daemon paths and outbound URLs, all attached to every opted-in error event.

- **[MEDIUM · behavior-mismatch] Revoking analytics consent still sends one final PostHog network flush**  
  Where: `src/main/telemetry.ts:95`  
  Evidence: applyConsent calls posthog.shutdown() on revoke with comment 'flush + stop — nothing sent after revoke' (telemetry.ts:94-97); posthog-node shutdown flushes the queued batch (flushAt:10/15s buffer, posthog-telemetry.ts:21-25) over the network AFTER revoke.  
  Recommendation: On revoke call client.disable() (posthog-node exposes it) before shutdown, or drop the pending queue instead of flushing; if flushing consented-era events is intended, fix the comments and document the behavior.  
  Why: A user toggling analytics off to stop network activity still triggers an HTTP POST of up to 10 buffered events post-revoke, contradicting the kill-switch claim at telemetry.ts:20-21.

- **[MEDIUM · test-gap] Zero tests or gate smokes for the opt-in/off-by-default privacy invariant**  
  Where: `src/main/telemetry.ts:52`  
  Evidence: Grep for 'telemetry' across tests/ returns no files; src/main/smokes has no telemetry smoke. Defaults-off (settings-store.ts:872-873), DNT gating (telemetry.ts:54), sanitizeEvent (telemetry.ts:104-120) and revoke re-init are all untested.  
  Recommendation: Add unit tests: fresh settings store returns both consent flags false; DO_NOT_TRACK forces rendererConfig flags false; sanitizeEvent rejects bad names/non-primitive props; applyConsent with both flags off leaves getTelemetry() as NoopTelemetry.  
  Why: Off-by-default is the load-bearing half of the 'fully offline forever' promise; a tiny regression (dropping the dnt term, flipping a default) would silently make the app phone home and nothing in the gate would catch it.

- **[LOW · improvement] before-quit flush is fire-and-forget, so tail analytics events are routinely dropped**  
  Where: `src/main/boot.ts:431`  
  Evidence: app.on('before-quit') calls `void flushTelemetry()` without awaiting (boot.ts:431); PostHog buffers up to 10 events / 15s (posthog-telemetry.ts:23-24), and the process can exit before the flush's HTTP round-trip completes.  
  Recommendation: In before-quit, preventDefault once, await flushTelemetry() with its 1500ms cap, then app.quit(); keep the current fire-and-forget as fallback if the flush rejects.  
  Why: Bounded reliability issue for opted-in users: short launch-and-quit sessions lose most events, skewing the only analytics collected; no privacy impact.

## ipc-preload-contracts  (implemented: partial)

> Expected: docs/01 §1 promises contextIsolation/sandbox/no-nodeIntegration with all privileged ops crossing one preload surface over typed IPC. ADR 0016 §6 adds the origin pin: every remote origin is an in-code constant in one frozen table, never repointable by an env var.

- **[HIGH · bug] [✓] Brain libfetch env vars re-open the origin bypass ADR 0016 banned**  
  Where: `src/main/libfetch.ts:29`  
  Evidence: libfetch.ts:29-30 `process.env.MOGGING_BRAIN_REGISTRY_NPM || 'https://registry.npmjs.org'` (same at :30 for PyPI). ORIGINPIN only matches `/process\.env\.MOGGING_\w*_BASE\b/` (check-originpin.mjs:69) and neither name is in HARNESS_TRIGGERS (check-prod-artifact.mjs:62-84), so both ship in the signed bundle.  
  Recommendation: Move both origins into ORIGINS in src/backend/core/origins.ts and delete the env reads; make braindocs-smoke.ts:217 pass a baseUrl parameter. Widen check-originpin.mjs:69 to any process.env.MOGGING_* read defaulted to an http(s) literal.  
  Why: ADR 0016 §6 says 'No environment variable may repoint one'. A signed install launched with this env set fetches attacker JSON whose README is distilled into the brain, i.e. into agent context.
  Verifier: Traced libfetch.ts:29-41 (any-https override, no isPackaged gate), boot.ts:161 (no scrub), both gates blind as claimed (check-originpin.mjs:69, check-prod-artifact.mjs:62-83), ADR 0016 §6 violated. But needs local env control plus default-OFF consent: corrected severity medium.

- **[MEDIUM · gap] Zero sender validation on every ipcMain registration**  
  Where: `src/main/electron-context.ts:13`  
  Evidence: electron-context.ts:13-18 discards the event (`(_e, payload) => handler(payload)`) for both handle and on; every direct registration does the same (explorer.ts:159, daemon-relay.ts:445, account.ts:762). grep for senderFrame across src/main and src/backend returns nothing.  
  Recommendation: Add a fromTrustedFrame(e) helper in electron-context.ts asserting e.senderFrame === getWebContents()?.mainFrame, used in handle and on; then forbid bare ipcMain.handle/on outside that file via an eslint no-restricted-syntax rule.  
  Why: Electron security checklist #17. Today only CSP frame-src 'none' (window.ts:17) and the will-attach-webview preload strip (window.ts:152-162) keep other frames off the 286-channel surface; either is one line from regressing.

- **[MEDIUM · docs-drift] origins.ts is not the sole origin table; ORIGINPIN checks only one direction**  
  Where: `scripts/check-originpin.mjs:100`  
  Evidence: check-originpin.mjs:100-108 asserts only that URLs already in origins.ts appear nowhere else; nothing checks the reverse. posthog-telemetry.ts:22 defaults to 'https://us.i.posthog.com', usage-prices.ts:12 pins 'https://models.dev/api.json', libfetch.ts:29-30 pins npm/PyPI — all outside the frozen table.  
  Recommendation: Move house origins (posthog host, models.dev, npm, PyPI) into ORIGINS and import them, or add a commented ALLOWED-OUTSIDE list in check-originpin.mjs and fail on any https literal in src/main or src/backend/features absent from both.  
  Why: ADR 0016:79 claims every remote origin a shipped build talks to is a constant in origins.ts. That is false for at least four house origins, and the gate meant to hold it is blind in that direction.

- **[MEDIUM · test-gap] Nothing tests that the preload allowlist actually refuses an unlisted channel**  
  Where: `src/preload/index.ts:16`  
  Evidence: preload/index.ts:16-18 assertAllowed is the whole boundary. check-channels.mjs only proves AllChannels is complete and never loads the preload; lockdown-smoke.ts:7-22 lists CSP, nav/open denial, webview dock, openExternal — no bridge arm. grep 'ipc channel not allowed' across smokes and tests returns nothing.  
  Recommendation: Add a lockdown-smoke arm run in the renderer: invoke and send on 'mogging:not-a-channel' must both throw 'ipc channel not allowed'; Object.keys(window.bridge) equals invoke/send/on/getPathForFile; window.require/process are undefined.  
  Why: Deleting assertAllowed from send, or building the Set from the wrong export, leaves every gate in the sweep green while opening arbitrary ipcRenderer.send. The repo gates the LIST but never the ENFORCEMENT.

- **[MEDIUM · gap] No compile-time channel-to-payload binding; AllChannels erases its literal union**  
  Where: `src/contracts/ipc/channels.ts:494`  
  Evidence: channels.ts:494 annotates `AllChannels: readonly string[]`, discarding the literal union. bridge.ts:5-6 is `invoke(channel: string, payload?: unknown): Promise<unknown>`, so clients cast blind — terminal.client.ts:29 casts `as Promise<SpawnResult>` against a handler typed independently in daemon-relay.ts:432.  
  Recommendation: Drop the readonly string[] annotation (use as const) and add an IpcMap in src/contracts/ipc/index.ts mapping each channel literal to {payload,result}; make Bridge and BackendContext.handle generic over it; fail check-channels.mjs on a channel with no entry.  
  Why: docs/01:17-18 promises 'typed IPC'. Names are gated, shapes are not: a handler can change its return shape and every renderer cast still compiles — silent drift across 286 channels.

- **[MEDIUM · improvement] Terminal event fan-out is O(panes) across the context bridge, unmeasured by the perf gate**  
  Where: `src/preload/index.ts:10`  
  Evidence: preload/index.ts:10-14 acknowledges one listener per terminal channel per pane (capped at 32) and answers with setMaxListeners(0). terminal.client.ts:67-74 subscribes globally; terminal-pane.ts:325-326 filters with `if (e.id === this.id)`. Each terminal:data chunk therefore crosses the contextBridge once per pane.  
  Recommendation: Keep one ipcRenderer listener per terminal channel in the preload and route by pane id: expose onPane(channel, paneId, cb) backed by a Map inside the preload, then change terminal.client.ts onData/onExit/onState/onCwd to take the pane id.  
  Why: docs/05:76-78 says the milestone injects the torrent renderer-side via term.write, and the IPC path is proven only by the 8-PTY multipane smoke. The 32-pane cap is 4x anything measured, and invisible to the fps budget. (confidence: medium)

- **[LOW · docs-drift] docs/01 names the preload surface window.pty; the shipped surface is window.bridge**  
  Where: `docs/01-architecture.md:18`  
  Evidence: docs/01-architecture.md:18 says privileged ops go 'through the preload's single `window.pty` surface'. src/preload/index.ts:20 exposes contextBridge.exposeInMainWorld('bridge', …), and :43 adds getPathForFile, a non-channel member the 'single surface' phrasing does not cover.  
  Recommendation: Rewrite docs/01-architecture.md:18 to name window.bridge, describe it as a generic invoke/send/on bridge locked to the AllChannels allowlist rather than a typed per-feature surface, and record getPathForFile as its one sanctioned non-channel member.  
  Why: docs/01 is the named expected-behavior source for this feature; anyone auditing the security posture greps for a surface that does not exist, and the doc understates what is actually exposed.

## security-hardening  (implemented: partial)

> Expected: ADR 0016 §6/§7 + 0017 promise pinned in-code origins, an exact fuse wall proven off the packaged artifact with a tampered-asar refusal, a zero-blast-radius renderer (sandbox, CSP meta+header, flat-deny nav/open, one openExternal hop), hardened webview guests, bytecode main + readable preload.

- **[HIGH · behavior-mismatch] [✓] Brain library-docs fetch lets an env var repoint a shipped build's registry origin**  
  Where: `src/main/libfetch.ts:29`  
  Evidence: libfetch.ts:29-30 reads MOGGING_BRAIN_REGISTRY_NPM/_PY over 'https://registry.npmjs.org'/'https://pypi.org'; allowedBase (:33-42) then accepts ANY https host (:104,:122). Neither origin is in src/backend/core/origins.ts. brain.ts:790 calls it in the shipped main graph.  
  Recommendation: Add npmRegistry/pypi rows to src/backend/core/origins.ts, delete both env reads in libfetch.ts, pass a baseUrl param from brain.ts:790 (braindocs-smoke.ts:217 injects it). Widen check-originpin.mjs:69 to `MOGGING_\w*(BASE|REGISTRY|ORIGIN|ENDPOINT|URL)\b`.  
  Why: ADR 0016 §6 forbids env-readable origins. ORIGINPIN's regex is `process.env.MOGGING_\w*_BASE\b` (check-originpin.mjs:69) and PRODARTIFACT bans only the four *_BASE names, so both gates are blind. Fetched text lands in agent context.
  Verifier: Traced index.ts→boot.ts→brain.ts:790→libfetch.ts:29; allowedBase:40 passes any https host. ADR 0016 §6 forbids this; ORIGINPIN regex (_BASE-only) and PRODARTIFACT triggers both miss MOGGING_BRAIN_REGISTRY_*. Consent gate (brain.ts:764) gates fetch, not origin. Severity high stands.

- **[HIGH · bug] [✓] Remote-supplied OAuth endpoints reach shell.openExternal with no scheme validation**  
  Where: `src/main/connections.ts:585`  
  Evidence: connections.ts:585 openExternal(grant.verificationUriComplete ?? verificationUri) — strings taken verbatim from remote device-code JSON (oauth.ts:598-610, str() accepts anything). connections.ts:518 opens buildAuthorizeUrl over metadata.authorization_endpoint, accepted unchecked at oauth.ts:211.  
  Recommendation: Add an https-or-loopback endpoint validator in src/backend/features/integrations/oauth.ts: reject metadata at :211 unless authorization/token/registration endpoints pass, and reject the grant at :599 unless verification_uri(_complete) pass. Add unit goldens.  
  Why: validConnectionUrl (connections.ts:353) guards only the pasted URL; endpoints discovered downstream are unvalidated. A hostile self-hosted MCP server returns `ms-msdt:` or a UNC path and the Windows shell runs it.
  Verifier: 518 confirmed: hostile PRM→AS metadata; oauth.ts:211 checks presence only, buildAuthorizeUrl:307 keeps "ms-msdt:" scheme, hits shell.openExternal unguarded (cf browser-dock.ts:173). 585 refuted: device endpoint is catalog-pinned https (provider-catalog-data.ts:99, github only). Severity: medium.

- **[MEDIUM · bug] FUSES tamper proof has no negative control and accepts any death on macOS**  
  Where: `scripts/check-fuses.mjs:228`  
  Evidence: check-fuses.mjs:226-228: `died = (status!==0)||signal!==null`, then `tamper.bit = died && (named || platform === 'darwin')`. win32 demands 'Integrity check failed' on stderr; darwin accepts ANY nonzero exit. The untampered binary is never launched as a baseline.  
  Recommendation: Before flipping byte 40, spawn the untampered binary with the same env/timeout and require it NOT die; store it as tamper.baseline and fail with 'does not launch cleanly even untampered' when it does. Only then accept a darwin death as the refusal.  
  Why: A mac artifact that cannot launch for unrelated reasons (nested-code signing, dyld, headless runner) exits nonzero and reads as 'the fuse bites' — the release blocker passes proving nothing, and gate strength diverges by platform.

- **[MEDIUM · improvement] Navigation guard treats every file:// URL on the machine as the app origin**  
  Where: `src/main/window.ts:63`  
  Evidence: window.ts:63-64 `isAppUrl = url.startsWith('file:') || url === 'about:blank' || (!!devOrigin && url.startsWith(devOrigin))`, used by the will-navigate/will-redirect deny at :69-75. The bridge preload (:126) attaches to whatever document the window lands on.  
  Recommendation: Allow file: only when pathToFileURL(join(__dirname,'../renderer')).href prefixes the URL; make the dev branch `new URL(url).origin === devOrigin`; apply the same to isAppDoc (window.ts:44-46) and extract isAppUrl for unit goldens.  
  Why: The stated claim is 'any navigation off the app origin is refused', but file: is not an origin: any local HTML passes and inherits the preload. Agent CLIs write files constantly. The dev branch is prefix-matched (localhost:5173.evil.tld). (confidence: medium)

- **[MEDIUM · gap] mogging:// deep links execute destructive verbs with no validation or confirmation**  
  Where: `src/main/deep-link.ts:27`  
  Evidence: cwdFromUrl (:27-36) returns the `cwd` param with zero validation — no absolute/exists/isDirectory/length check (sanitizeControl :51 at least caps 1024). deliver (:96-116) hands it to the renderer, which runs openForCwd/closePaneById unprompted (ui/features/workspace/index.ts:739,761).  
  Recommendation: Require cwd absolute, <=1024 chars, existsSync+isDirectory in cwdFromUrl and sanitizeControl before delivery; stop accepting close-pane over the OS protocol association (keep it on the local control endpoint). Add tests/unit/deep-link.test.ts goldens.  
  Why: setAsDefaultProtocolClient (:146-148) makes this reachable from any web page. close-pane destroys a live agent pane and its in-flight work; a UNC cwd spawns shells against an SMB path on Windows only. No unit test covers deep-link.ts. (confidence: medium)

- **[MEDIUM · bug] macOS branch of the runtime-isolation guard never checks the real runtime base**  
  Where: `src/main/runtime-isolation.ts:50`  
  Evidence: runtime-isolation.ts:50-57 refuses only when XDG_RUNTIME_DIR is unset (darwin) or matches /^\/run\/user\// (linux); win32 (:36-47) compares against homedir()+'\AppData\Local'. runtime-paths.ts:20 shows the macOS real base is XDG_RUNTIME_DIR || ~/Library/Application Support.  
  Recommendation: In the non-win32 branch add a refusal when the canonicalized XDG_RUNTIME_DIR equals join(homedir,'Library','Application Support'), beside the /run/user check; add that darwin golden to tests/unit/runtime-isolation.test.ts (its darwin block :71-81 lacks it).  
  Why: Exporting XDG_RUNTIME_DIR="$HOME/Library/Application Support" satisfies the guard and lands the launch on the REAL run/v<N> tree — the retire war that kills every live pane. Windows is protected against the same mistake; macOS is not.

- **[MEDIUM · gap] grantFileProtocolExtraPrivileges is absent from the 'exact' fuse wall**  
  Where: `electron-builder.yml:122`  
  Evidence: electron-builder.yml:122-147 declares 6 fuses; check-fuses.mjs:59-66 EXPECTED carries the same 6 and the loop at :138 iterates EXPECTED only. FuseV1Options indices 6-8 (incl. GrantFileProtocolExtraPrivileges) are copied into the verdict `wall` but never asserted.  
  Recommendation: Add `grantFileProtocolExtraPrivileges: false` to electron-builder.yml electronFuses and to EXPECTED in check-fuses.mjs; re-run LOCKDOWN to confirm boot. Make the check-fuses loop iterate every index present in `wire`.  
  Why: The gate header claims the artifact carries 'EXACTLY the fuse wall'; unlisted indices are unasserted. Production loads its main document from file:// (window.ts:208) and the nav guard is permissive there, so this is the fuse that matters. (confidence: medium)

- **[LOW · docs-drift] Hardening comments cite the wrong ADR and the wrong docs file throughout**  
  Where: `scripts/qa-smokes.sh:308`  
  Evidence: qa-smokes.sh:308,323,433 say 'ADR 0015 §hardening' (0015 is board-github-write-back); :309-310 still says 'runAsNode ON until step 09' though ADR 0017 flipped it OFF. check-fuses.mjs:34, native-preflight.ts:89,92, entitlements.ts:38 cite docs/18 (=18-board.md) for §honest limits, which is docs/19-accounts.md.  
  Recommendation: Rewrite the three qa-smokes.sh comments to 'ADR 0016 §hardening' with runAsNode OFF; repoint the four docs/18 citations to docs/19-accounts.md; fix docs/adr/0016:174's link label; extend check-docs-refs.mjs to match number to filename.  
  Why: check-docs-refs.mjs passes because docs/18-board.md exists, so the drift is invisible to the sweep, and the stale 'runAsNode ON' line directly contradicts the gate it annotates.

## error-resilience  (implemented: yes)

> Expected: Docs/01 promise: native-module (node-pty/sqlite) failures surface as fatal boot errors, never silent broken windows; the detached PTY daemon survives crashes with automatic reconnect; a UI crash can't kill agents; Windows/macOS parity; async failures surface honestly (finding-39 policy).

- **[HIGH · bug] [✓] Daemon sets sessions.db aside on ANY open failure, not just corruption — session data loss**  
  Where: `src/pty-daemon/index.ts:42`  
  Evidence: openSessionStore (index.ts:37-51) catches every SessionStore constructor throw, renames sessions.db to .corrupt-* (line 44), and retries. The catch does not distinguish corruption from transient errors (EACCES/AV lock, SQLITE_FULL during migration DDL).  
  Recommendation: Only set the file aside when the error is corruption-shaped (SQLITE_CORRUPT, SQLITE_NOTADB, 'database disk image is malformed', 'file is not a database'); rethrow anything else so the boot fails without touching the store.  
  Why: A transient failure renames a good store aside; the retry fails identically, the daemon dies this boot, and the next healthy boot starts a fresh empty store — all restorable panes gone unless the user hand-restores the .corrupt-* file. (confidence: medium)
  Verifier: Traced index.ts:37-51 + SessionStore ctor: catch is indiscriminate, no corruption check, no auto-recovery. File-lock case self-guards (rename also fails, swallowed at :46-48); real trigger is disk-full/perm splits. Data set aside, not destroyed. Corrected severity: medium.

- **[MEDIUM · gap] Helper-ABI natives never preflighted; broken helper node-pty degrades every boot**  
  Where: `src/main/native-preflight.ts:64`  
  Evidence: assertNativeModules dlopens only Electron-ABI copies. Since ADR 0017 the daemon loads its own natives from the helper's node_deps (native-require.ts:31-40); helperRuntime() checks only the exe exists (node-helper.ts:110-115). session-store.ts:19 and pty-host.ts:9 require them at module load.  
  Recommendation: Preflight the helper side too: run helperRuntime().executable with a one-line require of node-pty/better-sqlite3 from nativesDir (or verify an ABI stamp written at build), and include the daemon.log tail in the degraded-health message when daemon start fails.  
  Why: A stale/partial helper build kills the daemon at import every boot; boot.ts:302-324 falls back to in-proc forever with a generic banner — the exact silent-fallback mode native-preflight.ts:14-17 exists to prevent.

- **[MEDIUM · bug] Daemon spawn handler has no try/catch — a pty spawn throw becomes a blind 5s timeout**  
  Where: `src/pty-daemon/transport.ts:175`  
  Evidence: The 'spawn' case calls sessions.ensure(m.id, spec) with no try/catch. ensure/PaneSession can throw (pty.spawn on a missing/broken shell binary from spec.shell; session.ts:1228 admits 'spawn can throw'). The throw unwinds to the daemon's log-and-keep-serving uncaughtException handler (index.ts:71).  
  Recommendation: Wrap the ensure/reply block in try/catch and send({ t: 'error', id: m.id, reason }) on throw; daemon-client.ts:591-598 already rejects the pending spawn with that reason, so the renderer would show the actual cause.  
  Why: The client never gets an error frame, so spawn times out with 'daemon did not answer spawn... within 5000ms' (daemon-client.ts:627) — transport noise, not the cause — and the relay's stored spec replays the failing spawn on every reconnect.

- **[MEDIUM · improvement] Window opens only after daemon migrate+start — up to ~25 s of app with no UI at all**  
  Where: `src/main/boot.ts:368`  
  Evidence: openWindow() (boot.ts:368) runs after `await startDaemonBackend` (boot.ts:303), which serializes migration, a possible stamp-retire (3s probe + 4s wait), and a 15s endpoint wait (daemon-client.ts:333). boot.ts:228-231's own comment measures this at ~25 s. No splash (window.ts:105,202).  
  Recommendation: Show the window before startDaemonBackend (RuntimeHealth IPC is registered earlier, boot.ts:284) and let the existing health banner cover the wait; queue or politely refuse terminal invokes until the backend registers.  
  Why: The 'Starting the terminal service…' health state (runtime-health.ts:8-13) exists precisely for this window but nothing can render it — the user stares at a dead desktop and may relaunch; the perception budget (docs/07) is law.

- **[MEDIUM · behavior-mismatch] fatal() frames every lifetime crash as a boot failure and offers no relaunch**  
  Where: `src/main/fatal.ts:51`  
  Evidence: installFatalHandlers (fatal.ts:62-63) routes all uncaughtException/unhandledRejection for the app's entire lifetime into fatal(), which always shows 'MoggingLabs Workspace failed to start' (line 51) and tags telemetry feature:'boot' (line 44), then app.exit(1).  
  Recommendation: Set a 'booted' flag once the window opens; post-boot fatals should use an accurate title ('crashed'), a distinct telemetry op, and call app.relaunch() before app.exit(1) (or offer a Relaunch button).  
  Why: A crash hours in (e.g. the dead-webContents send class noted at boot.ts:205-208) tells the user the app 'failed to start' and misfiles telemetry; daemon mode's promise is sessions survive exactly this crash, yet there is no Relaunch path.

- **[MEDIUM · bug] Pre-ready fatal errors are silent in packaged builds — showErrorBox guard too strict**  
  Where: `src/main/fatal.ts:49`  
  Evidence: fatal() shows the dialog only `if (!headless && app.isReady())`; Electron documents dialog.showErrorBox as safe before the ready event. installFatalHandlers is installed before whenReady specifically to catch early-wiring failures (fatal.ts:59, boot.ts:233).  
  Recommendation: Drop the app.isReady() condition (keep !headless); showErrorBox is explicitly pre-ready-safe on all platforms.  
  Why: A packaged, double-clicked app hitting an uncaughtException before ready exits 1 with the report only on stderr, which no desktop user sees — the exact silent failure this module exists to kill.

- **[LOW · bug] ensureDaemon leaks the daemon.log fd on every spawn attempt**  
  Where: `src/main/daemon-client.ts:313`  
  Evidence: `const logFd = fs.openSync(daemonSpawnLogPath(), 'a')` is passed to spawn stdio (line 327) but never closed in the parent; no closeSync exists in the file. The reconnect loop (daemon-relay.ts:267-330) re-runs ensureDaemon indefinitely with 15s max backoff.  
  Recommendation: fs.closeSync(logFd) immediately after spawn() (the child holds its own duplicate), in a try/finally so a spawn throw also closes it.  
  Why: While a daemon persistently fails to come up (broken helper, AV interference), main leaks ~one fd per 30 s for the app's lifetime — slow but unbounded, plus lingering open handles on the log file on Windows.

- **[LOW · test-gap] async-state.ts (finding-39 policy) has zero unit tests**  
  Where: `src/ui/core/async/async-state.ts:126`  
  Evidence: tests/unit contains no test for createAsyncGuard/describeAsyncError/withTimeout (grep: only the full-app ASYNCSTATE smoke exercises them). The module encodes load-bearing rules: IPC_NOISE fallback (lines 118-124), 140-char cap, generation supersession, timeout.  
  Recommendation: Add tests/unit/async-state.test.ts covering each IPC_NOISE pattern, wrapper stripping, the >140-char fallback, stale-generation calls never firing onSuccess/onSettle, and timeoutMs producing a terminal error.  
  Why: These pure functions guard ten UI features' error honesty; a regression (e.g. a new Electron IPC wrapper string) would only surface through the slow gate smoke, and the noise-pattern list is exactly what drifts.

## qa-gates-integrity  (implemented: partial)

> Expected: A 207-gate sweep (175 app-boot + 32 static) with honest verdicts: every swept gate is known to the app (check-gates.mjs), gate counts are derived not typed (check-gate-count.mjs), CI gates on printed results (check-sweep-log.sh), and fault/fixture seams stay out of shipped builds.

- **[HIGH · bug] [✓] BOOTFAIL verdicts pass CI green on linux/macos — the log gate cannot see them**  
  Where: `scripts/check-sweep-log.sh:10`  
  Evidence: check-sweep-log.sh:10 counts only ' (FAIL|MISSING)$'; qa-smokes.sh:143-144 rewrites a never-booted gate to BOOTFAIL, which the regex misses ('T' precedes FAIL). CI pipes the sweep to tee (ci.yml:304-305, 389) with no shell: bash on linux/macos, so no pipefail and tee masks the sweep's exit 1.  
  Recommendation: In check-sweep-log.sh change the grep to ' (FAIL|MISSING|BOOTFAIL)$' (or count result lines not ending ' PASS'), and add 'set -o pipefail' or shell: bash to the linux/macos sweep steps so the sweep's own exit code also gates.  
  Why: A gate that never ran certifies as ALL GATES PASS on linux/macos nightlies; Windows (shell: bash → pipefail, ci.yml:452+) propagates exit 1 — the same failure is red on Windows, green elsewhere: gate honesty and platform parity both broken.
  Verifier: Traced qa-smokes.sh:142-144 BOOTFAIL rewrite; ci.yml:305/389 lack shell: bash so no pipefail and tee masks the sweep's exit 1; check-sweep-log.sh:10 regex misses BOOTFAIL (empirically verified: exits 0, prints ALL GATES PASS). Windows (ci.yml:461) has pipefail, stays red. Severity high correct.

- **[MEDIUM · gap] Gate registry is one-directional: verdict-writing smokes exist that the sweep never runs**  
  Where: `scripts/check-gates.mjs:47`  
  Evidence: check-gates.mjs:35-48 only checks sweep rows against index.dev.ts. MOGGING_AGENT (index.dev.ts:510) and MOGGING_WORKSPACE (index.dev.ts:524) dispatch real verdict-writing smokes (workspace-smoke.ts:149 writes out/workspace-result.json) yet have no run_smoke row in qa-smokes.sh — they never run in any sweep.  
  Recommendation: Extend check-gates.mjs with the reverse check: every env dispatch in index.dev.ts must have a run_smoke row, with an explicit allowlist for manual-only tools (SHOT, GALLERY, and AGENT/WORKSPACE if intentionally manual) so exemptions are declared.  
  Why: The 'silent gate loss' protection fails in one direction: a gate authored but never registered is invisible to every check. Commit 50e5fba ('register the gate that was never run') proves this already happened once.

- **[MEDIUM · gap] CI sweep job timeouts (120/150 min) cannot host the sweep the repo says takes ~4h**  
  Where: `.github/workflows/ci.yml:238`  
  Evidence: ci.yml:7 says 'Full 207-gate sweeps are heavy (~4h each)' but linux/macos sweep jobs set timeout-minutes: 120 (ci.yml:238, 334) and windows 150 (ci.yml:418). Worst-case per-gate budgets in qa-smokes.sh sum to 39,120s (~10.9h); the Phase-11 gates deliberately run LAST (qa-smokes.sh:17).  
  Recommendation: Reconcile the numbers: raise timeout-minutes on the three sweep jobs above measured full-sweep duration (or fix ci.yml:7 if sweeps now fit), and make check-sweep-log.sh assert the results block contains the full expected gate count.  
  Why: If the sweep runs near its stated duration, every nightly is killed mid-run and the tail gates (the seven Files gates incl. FILESMILESTONE) never execute on CI — chronic coverage loss disguised as an infra timeout. (confidence: medium)

- **[MEDIUM · docs-drift] softEchoMs contradicts both honesty statements about what soft-CI mode relaxes**  
  Where: `src/main/smokes/smoke-shell.ts:221`  
  Evidence: smoke-shell.ts:189 docstring: 'Echo-latency/heap/correctness claims are never relaxed'; qa-smokes.sh:10: soft 'relaxes ONLY frame-gap budgets'. Yet softEchoMs (smoke-shell.ts:221-228) triples the echo budget 60→180ms under soft (used by perception-smoke.ts:19), and all three CI sweeps set soft.  
  Recommendation: Scope softEchoMs to process.platform==='win32' (its stated justification) and update the smoke-shell.ts:189 docstring and qa-smokes.sh:10 header to name echo as a relaxed budget where it truly is.  
  Why: The relaxation's stated justification is the virtualized Windows PTY (~85ms floor); applying it on linux/macos CI — where echo measures 1-2ms — lets a huge echo regression there pass the docs/07 perception gate.

- **[MEDIUM · behavior-mismatch] PRODMILESTONE budget phase discards its 16-pane wait and floors panes across workspaces**  
  Where: `src/main/smokes/prodmilestone-smoke.ts:399`  
  Evidence: prodmilestone-smoke.ts:399 awaits waitUntil(paneCount===16, 20000) but ignores its boolean; the only backstop is budgetsHold's livePanes >= 12 (line 429), where livePanes = (m.panes||[]).length (line 425) — total panes across ALL workspaces, wedge included.  
  Recommendation: Capture the waitUntil result into a named flag ANDed into pass (like the other arrows), and count only the torrent workspace's panes (id in (b, b+16]) for the floor — or require exactly 16 and fail honestly with the measured count in the result JSON.  
  Why: On a slow runner where apply(16) lands only ~10 torrent panes in 20s, wedge panes lift the total past 12 and the 'budgets ON the composed 16-pane surface' verdict passes on a lighter surface — a time-masked verdict on the authority gate. (confidence: medium)

- **[LOW · bug] harness-install's isSmoke is the denylist shape index.dev.ts explicitly abandoned**  
  Where: `src/main/harness-install.ts:68`  
  Evidence: harness-install.ts:68 treats ANY MOGGING_* var (except MOGGING_CHANNEL/MOGGING_CLI) as a gate-driven boot and swaps in the empty usage world (adapters: [], statusFetcher: null). index.dev.ts:205-213 documents why exactly this any-var heuristic failed open and was replaced by the SMOKE_ENV allowlist.  
  Recommendation: Have usageWorld() decide isSmoke from the same SMOKE_ENV allowlist index.dev.ts uses (export it or pass it into installHarnessPorts) instead of the any-MOGGING_* denylist, so knob vars keep the real adapters in dev.  
  Why: 'MOGGING_INPROC=1 npm run dev' — the documented daemon-failure workaround (index.dev.ts:207) — silently strips real usage adapters/status from a real dev session, breaking the 'dev is representative' claim at harness-install.ts:62.

## ci-workflows  (implemented: yes)

> Expected: A three-OS CI: per-push typecheck/build/static gates, nightly staggered 207-gate full sweeps on linux/macos/windows, a per-push Linux build+boot+package job, manual signing dry runs, and a tag-triggered release pipeline that packages, gates fuses/feed, and publishes only after all feed files exist.

- **[HIGH · bug] [✓] BOOTFAIL gates certify green on linux/macos nightly sweeps**  
  Where: `scripts/check-sweep-log.sh:10`  
  Evidence: check-sweep-log.sh:10 greps ' (FAIL|MISSING)$' — 'NAME BOOTFAIL' (verdict set at qa-smokes.sh:143) does not match. ci.yml:299-305 (linux) and :387-389 (macos) omit 'shell: bash', so the default 'bash -e' (no pipefail) lets '| tee sweep.log' mask qa-smokes' exit 1 (qa-smokes.sh:660).  
  Recommendation: Change check-sweep-log.sh:10 to grep -cvE ' PASS$' over the result rows (mirroring qa-smokes.sh:654), and add 'shell: bash' to the linux/macos Full-sweep steps so pipefail propagates qa-smokes' own exit code as a second wall.  
  Why: The intermittent boot race kill-devservers.mjs documents (ENOENT on out/main/index.js) yields BOOTFAIL — and the nightly certification prints ALL GATES PASS for a gate that never ran. Windows propagates via pipefail; linux/macos do not.
  Verifier: Traced qa-smokes.sh:142-144/660 (BOOTFAIL, exit 1), check-sweep-log.sh:10 regex misses 'NAME BOOTFAIL' ('T' precedes FAIL), ci.yml:299-305/387-389 lack shell:bash so bash -e (no pipefail) lets tee mask exit 1; windows (:461) has shell:bash+pipefail. No guard. Severity high stands.

- **[MEDIUM · gap] Release artifacts are never weighed — the WEIGHT gate's 'last stop' is manual-only**  
  Where: `.github/workflows/release.yml:229`  
  Evidence: release.yml:219-247 runs the fuse wall gate on the unpacked artifact then uploads; no check-package-weight step exists. ci.yml:536-537 calls the signing-dryrun weight gate 'the last stop before a release', but that job only runs on dispatch with inputs.signing_dryrun (ci.yml:484).  
  Recommendation: Add a 'Package weight gate' step to release.yml after the fuse gate (line 235), reusing its per-OS APP resolution with MOGGING_WEIGHT_APP, and soften the ci.yml:537 'last stop' comment to point at release.yml.  
  Why: The one artifact users install is the only one the debris gate never sees. WEIGHT exists because v0.16.0 shipped 137MB/916 files of debris that 'regrows silently' — a regression landing between nightly and tag ships unweighed.

- **[MEDIUM · bug] CI cache key omits prune-helper-deps.mjs, serving stale helper trees**  
  Where: `.github/workflows/ci.yml:183`  
  Evidence: The nm-cache keys (ci.yml:183, 273, 443) hash build-node-helper.mjs and build-device-key.mjs but not prune-helper-deps.mjs, the new module holding HELPER_RUNTIME_DEPS and all prune rules (imported at build-node-helper.mjs:46). On cache-hit the composite action — and any prune — is skipped entirely.  
  Recommendation: Add 'scripts/prune-helper-deps.mjs' to the hashFiles() list in all three cache blocks (ci.yml:183, 273, 443) and bump the -e36 suffix, so any ship-list or rule change rebuilds the helper.  
  Why: The key's comment promises 'a source edit can never serve a stale artifact'; now false. A tightened rule leaves debris in cached build/node-helper (WEIGHT red on environment); adding a dep to HELPER_RUNTIME_DEPS serves a tree missing it.

- **[MEDIUM · behavior-mismatch] kill-devservers on macOS/Linux SIGKILLs any process whose argv names the repo**  
  Where: `scripts/kill-devservers.mjs:76`  
  Evidence: POSIX branch (kill-devservers.mjs:68-79) keeps every ps row containing the repo path and classifies anything not electron-vite/esbuild as 'electron.exe' (line 76), which TIERS kills unless argv has 'daemon.js'. The Windows branch (lines 53-66) restricts to node.exe/electron.exe/esbuild.exe names.  
  Recommendation: In the POSIX snapshot, mirror the Windows constraint: require the executable path to live under <repo>/node_modules (electron/esbuild) or args to contain 'electron-vite', instead of classifying every unknown repo-path process as killable electron.  
  Why: An editor opened with the repo path in argv (VS Code is Electron), or any 'node <repo>/…' tool, gets SIGKILLed; qa-smokes calls this after every one of ~175 smokes. Windows and macOS diverge — the repo's own core parity promise. (confidence: medium)

- **[MEDIUM · gap] No per-push app-boot gate on Windows/macOS — only Linux boots per push**  
  Where: `.github/workflows/ci.yml:150`  
  Evidence: linux-boot (ci.yml:150-224) builds, boots SMOKE headless, packages, and runs fuse+weight gates on every push. Windows and macOS get only typecheck/build/static gates per push (verify matrix, ci.yml:36-145); their first boot/package coverage is the nightly sweep or a manual dispatch.  
  Recommendation: Add a windows-boot job mirroring linux-boot's cheap slice (cache + composite rebuild + MOGGING_SMOKE boot + electron-builder --dir + fuse/weight gates), or at minimum run it on pushes to main if PR cost is the concern.  
  Why: README promises identical Windows/macOS behavior, yet a Windows-only boot or packaging regression merges green and surfaces up to ~24h later in a nightly, after landing on main. WEIGHT's NSIS install-cost motivation is Windows-specific.

- **[LOW · docs-drift] The 'uncommitted ci.yml diff' is a superseded stash; popping it regresses prose**  
  Where: `.github/workflows/ci.yml:7`  
  Evidence: git diff of .github/workflows/ci.yml is empty; the WIP lives in stash@{0} and its content (WEIGHT gates, always-prune stamp path) already landed via commit a37ff5e. The stash's prose says '201-gate' while committed ci.yml:7 says 207 and check-gate-count derives 207 (13 claims agree).  
  Recommendation: Drop stash@{0} (git stash drop 'stash@{0}') after confirming nothing unique remains beyond what a37ff5e landed — its ci.yml/build-node-helper/qa-smokes hunks are all present in HEAD in updated form.  
  Why: The stash is a landmine: applying it reintroduces stale 201-gate comments (a confusing GATECOUNT red) and re-orders RESTOREDIMS. The landed change itself is sound — prune-before-probe proves deletions via the helper's real pty+sqlite probe.

- **[LOW · improvement] WEIGHT gate run as a subset without FUSES fails on environment, not product**  
  Where: `scripts/check-package-weight.mjs:40`  
  Evidence: qa-smokes.sh:322 runs WEIGHT reading 'the tree FUSES just packaged'; check-package-weight.mjs:40-44 exits 1 when dist/<platform>-unpacked is absent. ci.yml's dispatch 'gates' input (lines 14-17) allows subsets, so MOGGING_GATES=WEIGHT without FUSES reads red or weighs a stale local dist tree.  
  Recommendation: In qa-smokes.sh, make WEIGHT imply FUSES under MOGGING_GATES (like the documented TEMPLATE_A/B pairing at lines 108-111), or have check-package-weight.mjs distinguish 'nothing to weigh' with a pointer to run FUSES first.  
  Why: A dispatch iterating on the weight gate alone gets a false FAIL (fresh checkout) or a stale verdict (dev box with an old dist/) — the exact 'fail on environment, not product' class the sweep comments elsewhere guard against.

## cli-ux  (implemented: partial)

> Expected: A `mogging` CLI giving tmux-grade pane control (list/send/send-key/capture/cwd), swarm verbs (mail/role/claim/release/approve), usage/map/recall via the app endpoint, and deep-link open — with a documented exit-code table, authed socket discovery, and honest errors when the app is down.

- **[MEDIUM · bug] Any typo'd verb silently cold-starts the app as a workspace deep-link, exit 0**  
  Where: `bin/mogging.mjs:62`  
  Evidence: bin/mogging.mjs:62 `else runOpen(argv)` — every unrecognized first arg falls through to runOpen (803-815), which resolves it as a directory with no statSync existence check and fires the mogging:// deep link, printing 'opening workspace for <cwd>/<typo>' and exiting 0.  
  Recommendation: In runOpen, statSync the resolved dir; if it does not exist, print 'unknown command or missing directory <arg>' to stderr and exit 2. Keep bare `mogging` / `mogging .` working.  
  Why: `mogging clam "src/**"` (claim typo) or docs' own `mogging endpoint --path` launches the whole Electron app for a nonexistent dir instead of a usage error; scripts see success. runCwd validates existence (950-954) — open does not.

- **[MEDIUM · bug] Global --dev filter strips the token from send/mail/recall payloads and flips channel**  
  Where: `bin/mogging.mjs:36`  
  Evidence: bin/mogging.mjs:32 sets CHANNEL='dev' if '--dev' appears ANYWHERE in argv; line 36 filters every bare '--dev' out of all args. `mogging send 101 vite build --dev` retargets the dev-channel daemon (usually absent: exit 3 'no daemon endpoint found') and, if one exists, types 'vite build' without the flag.  
  Recommendation: Only treat `--dev` as the channel flag when it precedes the payload (scan the verb+flags region, not the whole argv), and support a `--` terminator in runSend/runMailSend/runRecall after which tokens are payload verbatim.  
  Why: Text-carrying verbs (send, mail send, recall) cannot transmit a literal `--dev` token, and its presence silently changes which daemon is addressed. There is no `--` terminator to escape it (recall even drops literal '--', line 251).

- **[MEDIUM · docs-drift] `mogging endpoint --path` is documented (SSH forwarding recipe) but not implemented**  
  Where: `docs/09-swarm.md:113`  
  Evidence: docs/09-swarm.md:113 shows `ssh -R /tmp/mogging.sock:$(mogging endpoint --path) host` for remote panes. bin/mogging.mjs's dispatch (39-62) has no 'endpoint' verb (grep of bin/ finds none), so the command hits the deep-link fallthrough and prints 'opening workspace for .../endpoint'.  
  Recommendation: Add a `mogging endpoint --path` verb printing endpointFilePath() (and the socket address from the file, for the ssh -R form) to stdout, exit 3 when absent; or correct docs/09 to the real mechanism.  
  Why: The documented remote-swarm recipe command-substitutes runOpen's stdout ('mogging: opening workspace for ...') into the ssh -R argument — a broken forward plus a surprise app launch, on the exact path docs tell remote users to follow.

- **[MEDIUM · behavior-mismatch] `mogging list` omits the ROLE column docs/09 promises; docs/06 column list also stale**  
  Where: `bin/mogging.mjs:1082`  
  Evidence: runList (bin/mogging.mjs:1082-1097) prints ID SIZE STATE REMOTE TITLE — no role, though PaneInfo.role rides the welcome payload (src/contracts/daemon/protocol.ts:248). docs/09-swarm.md:11 says roles 'enrich `mogging list`'; docs/06-control-api.md:11 documents 'ID SIZE STATE TITLE' (no REMOTE).  
  Recommendation: Add a ROLE column to runList's rows (r.role ?? ''), and update the docs/06 table to the real column set (ID SIZE STATE ROLE REMOTE TITLE).  
  Why: The swarm docs tell operators to verify role assignments via `mogging list`; the data is on the wire and simply dropped, so a scripted reviewer check has no supported source. Three-way drift between two docs and the implementation.

- **[LOW · behavior-mismatch] `mogging approve` exits 6 ('not the reviewer') when the pane token env is merely missing**  
  Where: `bin/mogging.mjs:453`  
  Evidence: bin/mogging.mjs:452-455 exits 6 when MOGGING_PANE_TOKEN is unset even though MOGGING_PANE_ID passed. docs/09-swarm.md:160 defines 6 as 'not the reviewer'; the identical stale-env condition in claim/release exits 2 via paneTokenOrUsage (546-553).  
  Recommendation: In runApprove, exit 2 for a missing MOGGING_PANE_TOKEN (reuse paneTokenOrUsage) and reserve 6 for the daemon's notreviewer refusal.  
  Why: Scripts distinguishing 'wrong role' (re-route to reviewer pane) from 'not in a pane' (environment problem) get the wrong signal, and the two pane-bound verb families disagree on the same condition.

- **[LOW · improvement] owners/approvals/mail-read/role drop daemon error frames, dying as timeout exit 3**  
  Where: `bin/mogging.mjs:610`  
  Evidence: runOwners (bin/mogging.mjs:610 `if (m.t !== 'owners') return`), runApprovals (514), runMailRead (681), runRole (702-713) ignore non-auth `{t:'error'}` frames; the comment at 1100-1104 records fixing exactly this class for `list` (died 5s later blaming a daemon that 'did not respond').  
  Recommendation: Give withDaemon a default: any `{t:'error'}` frame unhandled by the verb's onMessage prints 'rejected (<reason>)' and finishes 1, instead of each verb re-remembering it.  
  Why: Latent today (transport.ts has no error path for these reads), but any future daemon-side rejection reproduces the misdiagnosed 'did not respond in time' exit 3 that was already fixed once for list.

- **[LOW · improvement] `mogging --help` prints usage to stderr with exit 0**  
  Where: `bin/mogging.mjs:65`  
  Evidence: usage() (bin/mogging.mjs:64-83) always writes the help text to process.stderr, including the explicit `--help`/`-h`/`help` dispatch at line 61 which calls usage(0).  
  Recommendation: In usage(code), write to process.stdout when code === 0 and process.stderr otherwise. Also add a unit test over bin/mogging.mjs arg parsing (tests/unit has none; findings 1-2 would have been caught).  
  Why: `mogging --help | grep send` and `mogging help > cheatsheet.txt` produce empty output — a daily paper cut for a CLI whose docs lean on scriptability; stderr is right only for the exit-2 misuse path.

## window-chrome-clipboard  (implemented: partial)

> Expected: Phase 5 + 8.5 promise a true-center titlebar command box, event-driven F11 with zero dead gap, --window-corner harmony, full clipboard paths incl. OSC 52 and in-memory history, a destructive confirm that focuses the safe action and can never be silenced, and a deliberate menu policy.

- **[HIGH · bug] [✓] CRLF read-back breaks remove's clipboard-clear promise and duplicates entries on Windows**  
  Where: `src/main/clipboard.ts:371`  
  Evidence: The write handler normalizes CRLF because "Windows stores clipboard text as CRLF... \n rewritten to \r\n" (clipboard.ts:289-295), but remove raw-compares readClipboardText() === gone.text (:371), poll's watermark raw-compares text !== lastText (:235), and the dedupe key raw-compares (:173).  
  Recommendation: Hoist the sameText CRLF-normalizing helper (clipboard.ts:295) to module scope and use it in the remove comparison (:371), the poll watermark (:235), and the text dedupe (:172-173); add a multi-line Windows case to the CLIPBOARD smoke.  
  Why: On Windows, deleting a multi-line row that IS the current clipboard fails to clear the system clipboard (promised at settings/clipboard.ts:106), leaving it one Ctrl+V away; each multi-line in-app copy also duplicates as a 'system' entry.
  Verifier: Traced write (clipboard.ts:280-297, CRLF-tolerant only there), poll watermark :235, dedupe :172-173, remove raw-compare :371, promise settings/clipboard.ts:106. No guard normalizes CRLF on those paths; recordOurText priming defeated. Severity high stands (explicit privacy promise broken on Windows).

- **[MEDIUM · bug] restore and writeEntry skip the write verification the write path was hardened with**  
  Where: `src/main/clipboard.ts:346`  
  Evidence: ClipboardChannels.write reads back and throws because a locked Windows clipboard makes writeText a silent no-op (clipboard.ts:283-296). restore (:343-351) and writeEntry (:304-316) write with no read-back, then restore re-dates and floats the entry ('it IS the clipboard now').  
  Recommendation: Apply the same read-back-and-throw in restore and writeEntry (images: compare signatureOf vs imageSignature()); in settings/clipboard.ts catch restoreEntry rejection with the copy-failed toast instead of 'Copied', skipping the re-date.  
  Why: With the clipboard held open by another Windows process, 'Put this back on the clipboard' shows the 'Copied' success toast (settings/clipboard.ts:96-98) and reorders history while the clipboard is untouched — the bug class write fixed.

- **[MEDIUM · behavior-mismatch] Destructive confirms are session-silenceable via rememberKey, against the 8.5 promise**  
  Where: `src/ui/components/confirm.ts:30`  
  Evidence: docs/02:157 promises the destructive confirm 'can never be silenced', but confirmDialog resolves true without showing when rememberKey is in sessionSkip (confirm.ts:30) regardless of danger, and agent-config.ts:459-467 passes danger:true WITH rememberKey — incl. the 'permission-bypass' confirm.  
  Recommendation: In confirmDialog, ignore rememberKey when opts.danger is true (no checkbox, no sessionSkip fast-path) and drop rememberKey from the danger confirms at agent-config.ts:466; keep it for non-danger prompts.  
  Why: The invariant is enforced only by per-caller convention (controller.ts:1027 'Bug #8: NO rememberKey'); a danger confirm that reduces provider permission checks auto-approving all session is exactly what the doc rules out.

- **[MEDIUM · gap] F11 is dead while the browser dock guest holds focus**  
  Where: `src/main/browser-dock.ts:333`  
  Evidence: F11 is handled on the main window's webContents before-input-event (window.ts:180-186), which never fires for webview guest input; the dock guest's own before-input-event relay bails on any chord without ctrl/meta ('if (!mod) return', browser-dock.ts:334-336), so unmodified F11 is dropped.  
  Recommendation: In browser-dock.ts:332, before the mod check, intercept keyDown F11 on non-darwin: preventDefault and toggle the host window's fullscreen (mirror window.ts:182-185), or relay it as a guestChord to the same toggle.  
  Why: Concrete trigger: open the browser dock, click into the page, press F11 — nothing happens on Windows/Linux. The 'event-driven F11 with zero dead gap' promise has a literal dead gap whenever the guest is focused.

- **[MEDIUM · behavior-mismatch] Packaged macOS has no keyboard fullscreen toggle while Windows/Linux get F11**  
  Where: `src/main/menu.ts:32`  
  Evidence: window.ts:182 gates F11 to process.platform !== 'darwin'; on macOS the togglefullscreen accelerator (Ctrl+Cmd+F) lives in the viewMenu role, which menu.ts:32 includes only when !app.isPackaged; the windowMenu role carries minimize/zoom/front, not fullscreen.  
  Recommendation: Add { role: 'togglefullscreen' } to the packaged macOS template in menu.ts — e.g. inside the windowMenu submenu or a minimal View menu with only that role.  
  Why: README's identical-behavior promise: Windows/Linux toggle fullscreen from the keyboard, packaged macOS only via the green traffic light — a parity gap beyond the justified F11-keycap divergence. (confidence: medium)

- **[MEDIUM · test-gap] sanitizePaste's paste-jacking defense has zero test coverage**  
  Where: `src/ui/core/clipboard/clipboard-port.ts:236`  
  Evidence: sanitizePaste strips the forgeable ESC[201~ end sentinel and normalizes newlines to CR (clipboard-port.ts:236-239). No unit test exists (tests/unit has no clipboard/paste test) and clipboard-smoke.ts never exercises it (zero hits for 201/bracket/sanitize).  
  Recommendation: Add tests/unit/clipboard-paste.test.ts: embedded ESC[201~ stripped, CRLF and lone \n -> CR, bracketed wrap on/off, and parseOsc52 (read '?', empty declined, >1MB declined, bad base64, UTF-8 decode).  
  Why: A core 'we type, the user executes' invariant (pasted text must never self-submit or smuggle live keystrokes) is one refactor from silently regressing; parseOsc52's caps and read-refusal are only smoke-covered.

- **[LOW · improvement] History broadcast reships every image data URL to every window on each change**  
  Where: `src/main/clipboard.ts:108`  
  Evidence: broadcast() sends the whole ring on every record/remove/restore (clipboard.ts:107-112); toWire strips text but keeps imageDataUrl (:103-105) — up to 256KB per image (contracts/ipc/clipboard.ipc.ts:103) across up to 100 entries (:99), per window, per change.  
  Recommendation: Strip imageDataUrl from the historyChanged/history wire payloads and add a per-id thumbnail fetch (like restore-by-id), or at minimum broadcast deltas instead of the full ring.  
  Why: A ring holding a few dozen screenshots pushes tens of MB over IPC on every copy event — a standing tax against the docs/05 budgets for a list that only renders a few visible rows. (confidence: medium)

## home-updates-ui  (implemented: yes)

> Expected: Phase 6/06 promises a live dismissible first-run checklist, one-click session restore on Home, and honest update UX: quiet dot while downloading, one sticky ready toast (Restart now / Later), a rail row, offline-vs-broken honesty, plus (phase-launch/21) an in-app "What's new" changelog surface.

- **[HIGH · bug] [✓] Updater push() can hard-exit the app when a state push lands on a destroyed webContents**  
  Where: `src/main/updater.ts:55`  
  Evidence: push() does `getWin?.()?.webContents.send(...)` (updater.ts:55) with no isDestroyed() guard. boot.ts:204-208 documents the identical shipped bug for daemon events: webContents dies BEFORE 'closed' nulls `win`, send() throws, and fatal.ts:62/56 turns uncaughtException into dialog + app.exit(1).  
  Recommendation: In push(), guard like boot.ts liveWebContents(): `const w = getWin?.(); if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return` before send, or pass liveWebContents into initAutoUpdate.  
  Why: Download-progress pushes fire continuously; closing the window mid-download (macOS stays alive windowless) lands a push in the destroy gap and hard-exits the app — the crash class boot.ts already fixed via liveWebContents().
  Verifier: Traced updater.ts:55 push -> boot.ts:394 wires raw `() => win`, not liveWebContents (boot.ts:209); destroy-gap throw -> fatal.ts:62/56 app.exit(1); download-progress (updater.ts:394) supplies pushes. Severity inflated: medium — ms-scale race needing an in-flight download at window close.

- **[MEDIUM · bug] Rail row and ready toast never seed from stateGet; pending update invisible after reopen**  
  Where: `src/ui/features/updates/index.ts:90`  
  Evidence: The updates feature only subscribes to pushes (index.ts:90) and never invokes UpdateChannels.stateGet at mount; only settings/updates.ts:120 does. Main keeps `last` exactly for late subscribers (updater.ts:47-49). boot.ts:419-421 recreates the window on macOS 'activate'.  
  Recommendation: At mount in updates/index.ts, factor the bridge.on callback into onState() and also `void bridge.invoke(UpdateChannels.stateGet).then(s => onState(s))` to seed the row, dot, and toast.  
  Why: macOS: update reaches 'ready', user closes and reopens the window — the new renderer shows no rail row, dot, or toast until the 6h tick. Boot-time pushes dropped mid-load are lost the same way. Platform-divergent UX vs the parity promise.

- **[MEDIUM · gap] No changelog / "What's new" surfacing anywhere in the update UX**  
  Where: `src/ui/features/updates/index.ts:111`  
  Evidence: The ready toast (index.ts:111-130), rail row, and Settings § Updates card offer a version number only — no release-notes link or in-app changelog. Repo has no CHANGELOG.md and no scripts/gen-changelog.mjs; phase-launch/21's in-app "What's new" is unchecked (prompts/phase-launch/CHECKLIST.md:179-183).  
  Recommendation: When landing phase-launch/21, add a "What's new" affordance to the ready toast and Settings § Updates reading changelog.json; until then link the GitHub release for s.version from the toast/settings status row.  
  Why: Users are asked to restart with zero information about what the update contains; the planned one-source/three-faces changelog pipeline has not landed in the app.

- **[LOW · behavior-mismatch] Titlebar dot appears during every 'checking' phase claiming "Downloading an update…"**  
  Where: `src/ui/features/updates/index.ts:96`  
  Evidence: `downloading = s.phase === 'checking' || 'available' || 'downloading'` gates dot visibility (index.ts:96-97) while the dot's title is fixed at "Downloading an update…" (index.ts:37). The file's own comment (line 35) and phase-6/06 step 3 say the dot shows only mid-download.  
  Recommendation: Drop 'checking' from the dot condition (keep 'available'/'downloading'), or give 'checking' its own title ("Checking for updates…") so the tooltip never claims a download that isn't happening.  
  Why: Every packaged boot and 6-hour tick shows an indicator whose tooltip claims a download while the app is merely checking — a small repeated honesty miss in the surface whose stated law is honesty.

- **[LOW · docs-drift] firstrun.ts header claims copy-only, never-installs; card ships one-click installers**  
  Where: `src/ui/features/home/firstrun.ts:16`  
  Evidence: Doc-comment (firstrun.ts:13-18): "NEVER installs anything, runs no elevated command… offers copy buttons only". Lines 141-157 embed createAgentSetupPanel one-click Install buttons running npm/Node bootstrap installs; phase-6/06 guardrail (line 53) states the same never-installs rule.  
  Recommendation: Rewrite the firstrun.ts header (and annotate prompts/phase-6/06) to say the checklist offers the shared one-click non-elevated setup panel, and that ADR 0002's never-broker rule concerns auth, not installs.  
  Why: The change is deliberate (in-code 'explicit direction'; setup.ts refuses sudo) but the stale header and phase-6 guardrail now assert the opposite of what ships, inviting a wrong-direction 'fix' later.

- **[LOW · bug] "Setup complete" toast fires on boot for users whose checklist was never shown**  
  Where: `src/ui/features/home/firstrun.ts:209`  
  Evidence: refresh() toasts "Setup complete — happy shipping" whenever all required rows are done and the dismissed key is absent (firstrun.ts:209-217); nothing requires the card to have ever been visible or any row to have transitioned this session.  
  Recommendation: Track a wasIncomplete flag in createFirstRun and only toast when a prior refresh this session rendered the card incomplete; otherwise call setDismissed() silently.  
  Why: A veteran user whose renderer localStorage resets (LevelDB corruption, partial data clear) while main-side workspace stores survive gets a congratulatory setup toast on launch for steps completed long ago. (confidence: medium)

## a11y  (implemented: yes)

> Expected: docs/11 promises AA contrast (4.5:1 text) measured across all four themes via aa-probe gates, modal focus traps with inert backgrounds, APG-correct composite widgets, reduced-motion twins for every animation, and aria-label + title on every icon-only control.

- **[HIGH · behavior-mismatch] [✓] Collapsed rail leaves every workspace-switch button with an empty accessible name**  
  Where: `src/ui/features/workspace/controller.ts:545`  
  Evidence: The .ws-tab-activate button gets no aria-label (controller.ts:545-556); its only name source is .ws-label textContent. global.css:1979 sets `#app.rail-collapsed .ws-label { display: none }` (and :1961 for rail-auto-collapsed), and icons.ts:193 stamps aria-hidden on every SVG — so the button's accname computes to empty.  
  Recommendation: Set activate.setAttribute('aria-label', meta.name) at build (controller.ts:545) and refresh it where rename commits (controller.ts:674 sets label.textContent). Alternatively hide .ws-label with the .sr-only recipe instead of display:none when collapsed.  
  Why: Collapsed (manually or by auto-collapse), a screen reader hears N identical unnamed buttons, contradicting docs/11:748-749 'Every icon-only button carries title + aria-label'. The wrapper div's title does not name the inner button.
  Verifier: controller.ts:545-556: no aria-label/title on button; only name is .ws-label, display:none collapsed (global.css:1979/:1961). Triggers real (app-shell.ts:41, dock-budget.ts:34). icons.ts:193 aria-hidden. No guard found. High stands.

- **[HIGH · gap] Terminal content has no screen-reader path: xterm screenReaderMode never enabled**  
  Where: `src/ui/features/terminal/terminal-pane.ts:170`  
  Evidence: new Terminal({...}) at terminal-pane.ts:170-180 sets font/scrollback/GL options but never screenReaderMode; `grep -rn screenReaderMode src` returns nothing, and Settings § Terminal exposes only fontSize (docs/11 §Terminal type). Panes render via canvas/WebGL, which exposes no text to AT.  
  Recommendation: Add an opt-in 'Screen reader support' toggle (Settings § Terminal, beside fontSize) that passes screenReaderMode: true into the Terminal options and re-opens panes; keep it off by default to protect the docs/05 perf budgets.  
  Why: The app's core surface — every agent CLI pane — is completely silent to screen readers. All the modal/rail/tree ARIA work bounds a surface a blind user can navigate to but never read.

- **[MEDIUM · bug] Active-workspace state (aria-current) sits on the wrapper div, not the focusable button**  
  Where: `src/ui/features/workspace/controller.ts:744`  
  Evidence: switch() does `v.tab.setAttribute('aria-current','true')` on the plain .workspace-tab div (controller.ts:744-745). The element keyboard users actually focus is the .ws-tab-activate button inside it, which carries no state attribute.  
  Recommendation: Move (or duplicate) the attribute onto the button: set aria-current='true' on v.activate in switch() and remove it from the deselected tabs' activate buttons.  
  Why: Screen readers announce state from the focused element, not an ancestor div, so tabbing the rail never reveals which workspace is active — the selection treatment docs/11 §Rail selection spec specifies is visual-only for AT users.

- **[MEDIUM · gap] Assertive live-region channel is dead code; refusals and danger toasts are all polite**  
  Where: `src/ui/core/a11y/live-region.ts:25`  
  Evidence: live-region.ts:4 promises 'assertive for things the user must hear now (refusals)', but the only callers app-wide are two polite ones (workspace/controller.ts:991, usage/index.ts:245); no announce(msg, true) exists. toast.ts:103 hardcodes role='status' (polite) for every tone including 'danger'.  
  Recommendation: In toast.ts mount(), use role='alert' (or aria-live='assertive') when tone === 'danger', and route refusal paths through announce(message, true) so the documented assertive channel has real callers.  
  Why: Refusal surfaces the custody rule cares about (secret-shaped save refusals, launch declines) reach AT late or not at all — a danger toast auto-dismisses in 6s (TOAST_DEFAULT_MS) and a polite queue can outlive it.

- **[LOW · bug] Modal entry focus can land on a disabled control and silently focus nothing**  
  Where: `src/ui/components/modal.ts:127`  
  Evidence: doOpen()'s entry selector `panel.querySelector('input, select, textarea, button:not(.modal-close)')` (modal.ts:127) does not exclude [disabled], unlike overlay-trap's FOCUSABLE list (overlay-trap.ts:18-25). focus() on a disabled element is a no-op.  
  Recommendation: Append :not([disabled]) to each segment of the entry selector (or reuse the FOCUSABLE constant from overlay-trap.ts) so the fallback chain (.modal-close, then the tabindex=-1 panel) actually engages.  
  Why: A modal whose first form control opens disabled leaves focus on <body> after the opener is inerted and blurred — the exact stranded-focus state the comment at modal.ts:122-125 says this line exists to prevent. (confidence: medium)

- **[LOW · test-gap] A11YMODAL gate never exercises nested traps — the refcounted inert path is untested**  
  Where: `src/main/smokes/a11ymodal-smoke.ts:96`  
  Evidence: The smoke drives one modal (shortcuts sheet), the palette, and the tab close — all single-level traps. overlay-trap.ts:14-16 and :90-96 exist specifically for nested overlays (confirm over wizard): the inner release must not un-inert an app the outer modal still covers. No gate opens two traps at once.  
  Recommendation: Extend a11ymodal-smoke: open a wizard-variant modal, open confirmDialog over it, close the confirm, and assert document.getElementById('app').inert is still true until the outer modal closes.  
  Why: A regression in the `held` refcount (e.g. release() decrementing the wrong background) would un-inert the shell under a still-open wizard — the exact finding-30 defect — and every gate would stay green.

- **[LOW · docs-drift] docs/11 cites the AA probe and setshell smoke at paths that do not exist**  
  Where: `docs/11-design-system.md:12`  
  Evidence: docs/11:12 says the contrast math 'lives in src/main/setshell-smoke.ts' and :28 says 8.5/06 'lifts the probe into src/main/aa-probe.ts'; the real files are src/main/smokes/setshell-smoke.ts and src/main/smokes/aa-probe.ts (verified: the src/main/ paths do not exist).  
  Recommendation: Correct both references to src/main/smokes/… in docs/11-design-system.md (lines 12 and 28), and add the paths to whatever scripts/check-docs-refs.mjs validates so they cannot drift again.  
  Why: The design-system page is the stated single source of truth and this section teaches contributors where the enforced AA math lives; a wrong path sends the next auditor grepping a directory with nothing in it.

## deps-hygiene  (implemented: partial)

> Expected: Lean 14-package runtime dep list with gated hygiene: no root .npmrc (unsupported keys banned by check-npm-config.mjs), pruned/probed native chain (node-pty + better-sqlite3 for Electron and pinned Node 24.15.0 helper ABIs), shipped weight gated, and a repeated zero-new-runtime-deps discipline.

- **[HIGH · gap] Helper natives ship to users with unpinned, integrity-unchecked transitive deps**  
  Where: `scripts/build-node-helper.mjs:243`  
  Evidence: NPM_ARGS includes '--no-package-lock' (line 243); only node-pty/better-sqlite3 versions are pinned (line 225). Transitives bindings and file-uri-to-path (kept by prune-helper-deps.mjs:26) resolve fresh from the registry per semver on every build and ship inside the installer.  
  Recommendation: Commit a package-lock.json for the helper install (use `npm ci` in OUT), or pin bindings/file-uri-to-path exactly and verify tarball integrity against the root package-lock.json before staging.  
  Why: The main tree is lockfile-protected but this shipped tree is not: a malicious publish of bindings (better-sqlite3 depends via ^ range) lands in the packaged app with no integrity hash; builds are non-reproducible.

- **[MEDIUM · bug] npm install fails on Windows after any Electron ABI bump (stale build/ tree)**  
  Where: `scripts/rebuild-native.mjs:5`  
  Evidence: The script's header documents that postinstall (`electron-builder install-app-deps`, package.json:14) hits WinError 183 on a dirty tree: node-gyp's msvs generator os.rename() refuses the existing binding.sln — 'the FIRST thing an Electron-major bump does is fail'. postinstall never clears build/ dirs.  
  Recommendation: In postinstall before install-app-deps, reuse rebuild-native.mjs's clear loop: stamp the Electron ABI next to node_modules and rm -rf node_modules/{node-pty,better-sqlite3}/build when the stamp differs.  
  Why: Every Windows dev's plain `npm install` breaks with a misleading error on each Electron bump while macOS succeeds — platform-divergent workflow, healed only by knowing to run rebuild:native.

- **[MEDIUM · gap] No CVE surveillance for the 625-package tree: no npm audit gate, no update automation**  
  Where: `scripts/qa-smokes.sh:218`  
  Evidence: The sweep runs 34 static gates (NPMCONFIG at qa-smokes.sh:218, WEIGHT at :322) but none runs `npm audit`; grep across scripts/ and .github/ finds no audit invocation, no dependabot.yml, no renovate config. package-lock.json resolves 625 packages.  
  Recommendation: Add scripts/check-vulns.mjs running `npm audit --omit=dev --audit-level=high` (same spawnSync shell:true single-string pattern as check-npm-config.mjs) wired into qa-smokes.sh, or add .github/dependabot.yml.  
  Why: A shipped Electron app with native modules has no mechanism to learn a locked dependency acquired a CVE; the gates catch config and weight regressions but are blind to vulnerability disclosures.

- **[MEDIUM · improvement] Pinned Node helper download verified only against SHASUMS from the same origin**  
  Where: `scripts/build-node-helper.mjs:165`  
  Evidence: fetchPinnedNode() downloads both the archive and SHASUMS256.txt from nodejs.org/dist/v24.15.0 (lines 165-176) and compares them to each other — both fetched from the same host in the same session; the SHASUMS signature is not checked and no hash is committed to the repo.  
  Recommendation: Commit the expected sha256 per platform archive next to HELPER_NODE_VERSION (line 48) and compare against those constants, using the downloaded SHASUMS only as a secondary cross-check.  
  Why: Self-consistent verification adds nothing beyond TLS: a compromised CDN response serves a matching archive+sums pair and the tampered runtime becomes the shipped daemon host. The exact pin makes the hash knowable in advance.

- **[MEDIUM · improvement] Electron ^39.8.10 pin likely outside the upstream security-support window**  
  Where: `package.json:62`  
  Evidence: devDependencies pin electron ^39.8.10 (lockfile: 39.8.10); the deep .8.10 patch depth and the note that node-pty 1.1.0's conpty dates to Oct 2025 (build-node-helper.mjs:78) suggest line 39 is ~9+ months old as of 2026-08. Electron security-supports only the latest 3 majors on an ~8-week cadence.  
  Recommendation: Verify line 39's EOL on electronjs.org's release timeline; if lapsed, schedule a major bump (rebuild-native.mjs, the conpty gate, and the helper probe already de-risk ABI churn) and add the support-window check to the release checklist.  
  Why: An out-of-support Electron stops receiving Chromium/V8 security backports; the app renders untrusted terminal output in that runtime. xterm 6.0.0 and node-pty 1.1.0 look current by contrast. (confidence: low)

- **[LOW · docs-drift] Zero-new-deps discipline is folklore: no ADR owns it and no gate pins the dep list**  
  Where: `docs/adr/0004-layered-feature-sliced-architecture.md:1`  
  Evidence: ADR 0004 (named by this audit's brief as the no-new-deps source) covers only layer boundaries; the discipline lives in per-feature assertions (docs/16-files.md:50, docs/adr/0010:66). No gate asserts package.json's 14 runtime deps; .npmrc is absent by design (check-npm-config.mjs).  
  Recommendation: Add a runtime-dep allowlist gate (mirror check-npm-config.mjs's ALLOWED set: fail if Object.keys(dependencies) differs from the 14), write a short dep-policy ADR covering it and the parser-stack rationale, and fix the ADR 0004 cross-reference.  
  Why: An unowned invariant erodes silently: a 15th runtime dep merges untripped, and the deliberate parser duplication (jsonc/yaml/toml codecs for edits vs tree-sitter json/yaml/toml wasm, 5KB/189KB/24KB, for indexing) is undocumented.

- **[LOW · improvement] No engines field despite Node-version-sensitive toolchain**  
  Where: `package.json:57`  
  Evidence: package.json declares no engines field; check-npm-config.mjs:68 pre-sanctions 'engine-strict' for an .npmrc that doesn't exist. The toolchain is Node-sensitive: vite 7 needs Node 20.19+/22.12+, CI runs 22 (ci.yml:48), dev machines 24.15.0, build scripts cite Node-24 behaviors (DEP0190).  
  Recommendation: Add "engines": { "node": ">=22.12" } to package.json and a root .npmrc with engine-strict=true (already in check-npm-config.mjs's ALLOWED set).  
  Why: A contributor on an older Node gets an obscure downstream failure (vite crash, native build error) instead of an immediate named engine refusal — the invisible-when-wrong class the repo's gates exist to kill.

## docs-drift  (implemented: partial)

> Expected: Docs promise a gate-kept truth surface: every relative doc link resolves (check-docs-refs.mjs), gate counts/versions agree everywhere (check-gate-count.mjs), and README/docs claims (shipped phases, shortcuts, CLI verbs, measured budgets) match the code.

- **[MEDIUM · docs-drift] docs/02 still marks Phase 0 as '*current*' twelve shipped phases later**  
  Where: `docs/02-mvp-and-roadmap.md:17`  
  Evidence: docs/02-mvp-and-roadmap.md:17 reads 'Phase 0 — Parity spike (1–2 wks) · *current*' and :21 '(Implemented as the current single-pane app.)', while README.md:53 says all phases through 12 shipped and docs/02's own entries mark Phases 3-12 ✅. Phases 1-2 carry no status marker at all.  
  Recommendation: Change the Phase 0 heading to '✅ (shipped)' like Phases 3+, delete the '(Implemented as the current single-pane app.)' parenthetical, and add ✅ markers to Phases 1 and 2.  
  Why: The roadmap is the canonical status doc; a reader landing on Phase 0 'current' concludes the product is a single-pane spike, contradicting the README status block.

- **[MEDIUM · docs-drift] 'Codified as ADR 0009' cites an ADR that does not exist, and the number is reserved twice**  
  Where: `docs/02-mvp-and-roadmap.md:165`  
  Evidence: docs/02:165 says loops are 'Codified as ADR 0009' (present tense); docs/adr/ jumps 0008→0010. docs/research/2026-07-third-party-integrations.md:123,203 reserves ADR 0009 for a different decision (service keys as pointers). prompts/phase-11/README.md:50 also cites 'docs/15-loops.md + ADR 0009' — neither exists.  
  Recommendation: Reword docs/02:165 to future tense ('will be codified as ADR 0009' or 'ADR TBD'), and pick one owner for the 0009 slot — renumber the research doc's reservation so two future ADRs are not promised the same number.  
  Why: Phase 9 is 'authored, not built', but the prose asserts a decision record exists; DOCSREFS cannot catch prose citations. The double reservation guarantees a future collision like the existing 0022 one.

- **[MEDIUM · docs-drift] ADR labels in docs/02 accounts pack point at differently-numbered ADR files**  
  Where: `docs/02-mvp-and-roadmap.md:315`  
  Evidence: docs/02:315 reads 'ADR [0015](../adr/0016-accounts-and-entitlements.md)' and :330-331 'ADR [0016](../adr/0017-split-node-runtime.md)' — the visible label disagrees with the file number in both. README.md:178 cites the same ADRs correctly as 0016/0017; adr/0015 is actually board-github-write-back.  
  Recommendation: Fix the two labels to ADR 0016 and ADR 0017. Optionally extend check-docs-refs.mjs to assert that link text matching /ADR \[?(\d{4})/ agrees with the digits in its target filename — this drift class is invisible to the existence check.  
  Why: A reader chasing 'ADR 0015' from the accounts section lands on the GitHub write-back ADR; number/target mismatch is exactly the quiet drift the DOCSREFS gate exists to stop but cannot see.

- **[MEDIUM · docs-drift] Two different ADRs both carry the number 0022**  
  Where: `docs/adr/0022-shared-account-defaults.md:1`  
  Evidence: docs/adr/0022-connections-reach-the-terminal.md ('# ADR 0022 — Connections reach the terminal', proposed 2026-07-31) and docs/adr/0022-shared-account-defaults.md ('# ADR 0022 — Shared account defaults', accepted 2026-07-31) both claim the same number.  
  Recommendation: Renumber one file to 0023 (the still-proposed connections-reach-the-terminal is the safer rename), update its H1 and any prose citing it, and add a tiny static check that ADR filename number prefixes are unique.  
  Why: Every citation of 'ADR 0022' is now ambiguous between an accepted decision and a proposed one — a decision-record system's one job is unambiguous citation.

- **[MEDIUM · gap] DOCSREFS gate never scans README.md or prompts/**, and prompts already cite a missing doc**  
  Where: `scripts/check-docs-refs.mjs:30`  
  Evidence: check-docs-refs.mjs:30 walks only 'docs'. README.md carries ~15 relative links (all resolve today, hand-verified) with no gate keeping them honest. prompts/phase-11/README.md:50 and prompts/phase-9/07-loops-milestone.md:2 cite docs/15-loops.md, which does not exist.  
  Recommendation: Add README.md and a prompts/ walk to the scanned roots in check-docs-refs.mjs, and either stub docs/15-loops.md or reword the two citations as future work.  
  Why: README is the most-read doc and links receipts (prompts/phase-5/REPORT.md etc.); one rename would silently break it with no gate going red — the '404 that still reads as true' the script's own header warns about.

- **[MEDIUM · docs-drift] docs/06 'Control API' verb table documents 9 of the CLI's 21 verbs**  
  Where: `docs/06-control-api.md:11`  
  Evidence: The docs/06 verb table lists list/send/send-key/capture/cwd/map/recall/[dir]/notify only. bin/mogging.mjs:39-60 dispatches 21 verbs; open/layout/focus/expand/close-pane are advertised in README.md:83 ('mogging open ~/my-project --panes 4') and docs/02:54-55 as Control API, but appear nowhere in docs/06.  
  Recommendation: Add rows for open [--panes N], layout, focus, expand and close-pane to the docs/06 table (bounds 1-16 per bin/mogging.mjs:777,794), plus one-line pointers to docs/09 (mail/role/claim/release/owners/approve/approvals) and docs/12 (usage).  
  Why: docs/06 presents itself as the scripting reference ('tmux-grade scriptability'); a script author following it cannot discover the layout-control half of the surface the README quickstart itself demonstrates.

- **[LOW · docs-drift] docs/05 points the budget source-of-truth at a moved file path**  
  Where: `docs/05-perf-budget.md:10`  
  Evidence: docs/05:10 says 'Source of truth: BUDGET in src/main/milestone-smoke.ts'; the file lives at src/main/smokes/milestone-smoke.ts (BUDGET at line 32). The values themselves match the doc table exactly (16 panes / 150ms / 30fps / 300MB / 12 WebGL).  
  Recommendation: Update the path to src/main/smokes/milestone-smoke.ts. It is a backtick code span, not a markdown link, so DOCSREFS cannot catch it — worth a grep for other stale 'src/main/*-smoke.ts' spans while there.  
  Why: Perf budgets are law (product rules); the law's stated source-of-truth pointer dangles, sending an auditor to a nonexistent file before they find the real one.

- **[LOW · docs-drift] README project tree says 'adr/ decision records (0001–0004)' — 23 ADR files exist**  
  Where: `README.md:157`  
  Evidence: README.md:157 annotates the docs tree with 'adr/ decision records (0001–0004)', while docs/adr/ holds files through 0022 (including 0007a/b, 0014-0018, 0020-0022) — and README's own roadmap section cites ADR 0014-0018 by name.  
  Recommendation: Change the annotation to 'decision records (0001–0022)' or, better, the evergreen 'decision records' with no range so it can never drift again.  
  Why: Small but front-page: the range understates the decision history by a factor of five and contradicts the same file's roadmap section.

## Workspace tabs, switching, and per-workspace themes  (implemented: yes)

> Expected: Color-coded workspace tabs (one per project dir) with Ctrl+T/Ctrl+1..9, drag+keyboard reorder, a persisted 12-color identity allocation with restore-time repair, an app theme picker persisted with state, move-pane/reorganize modals, undo-grace close, and metadata-only restore-on-relaunch.

- **[MEDIUM · bug] Drag-reorder silently diverges rail order from logical order during a pending close**  
  Where: `src/ui/features/workspace/controller.ts:714`  
  Evidence: finish() collects every '.workspace-tab' and filters by this.views.has(id) (controller.ts:711-713). A soft-closed tab is hidden but still in the DOM and in views (softClose:1047), so next.length > order.length and line 714 skips the order update — after dragover:705 already moved the DOM node.  
  Recommendation: In finish() (controller.ts:710-714) exclude mid-close tabs: filter with views.has(id) && !pendingClose.has(id) and compare against that; or revert the DOM move when the count check fails so the rail never shows an order the model rejected.  
  Why: During the 5s undo grace, a drag-reorder visually succeeds but this.order (Ctrl+1..9 targets, persistence, palette) keeps the old order — a permanent visible/logical mismatch that survives the grace lapse.

- **[MEDIUM · bug] Ctrl+1..9 workspace switching dead on keyboard layouts with shifted digits**  
  Where: `src/ui/features/workspace/index.ts:726`  
  Evidence: The capture-phase handler matches digits via e.key: `!e.shiftKey && k >= '1' && k <= '9'` (index.ts:726). On layouts with a shifted digit row (French AZERTY, Czech), unshifted Ctrl+digit reports e.key '&', 'é', … so the branch never fires; using Shift to reach the digit is excluded by !e.shiftKey.  
  Recommendation: Match on e.code ('Digit1'..'Digit9', plus 'Numpad1'..'Numpad9') in the switch branch at index.ts:726-730, keeping the e.key comparison as fallback.  
  Why: Ctrl+1..9 is the core daily navigation promise (README; shortcuts.ts:45) and is unreachable for whole keyboard-layout populations on both Windows and macOS.

- **[MEDIUM · behavior-mismatch] openForCwd duplicates workspaces on Windows: strict path equality, no case folding**  
  Where: `src/ui/features/workspace/controller.ts:1823`  
  Evidence: openForCwd matches with `v.meta.cwd === cwd` (controller.ts:1823). The backend defines foldProjectKey — case-folded on Windows because two spellings of one folder are one project (project-identity.ts:14-15) — but the UI match never folds; bin/mogging.mjs:804 resolves whatever casing the shell reports.  
  Recommendation: Fold both sides before comparing in openForCwd (separator normalize + win32 case-fold, mirroring foldProjectKey) — via a renderer-safe helper in @contracts, or fold in main before forwarding WorkspaceChannels.openCwd.  
  Why: README promises `mogging .` focuses an existing workspace for that dir. On Windows, c:\proj vs C:\Proj creates a duplicate workspace for the same project — divergence from macOS, against the platform-parity law.

- **[MEDIUM · gap] Debounced persist has no quit-time flush; last 400ms of changes are lost**  
  Where: `src/ui/features/workspace/index.ts:391`  
  Evidence: persist is debounce(fn, 400) (index.ts:362-391) and every mutation (rename, reorder, split, active-tab switch, theme change at :736) routes through it. Grep over src/ui and src/main finds no beforeunload/pagehide flush and no main-side save-on-quit — only the ipcMain saveState handler (app-settings.ts:47).  
  Recommendation: Flush pending saves on teardown: invoke the debounced body immediately from a pagehide/beforeunload listener (skipping when restoring/persistencePaused), or have main capture a final buildState before window close.  
  Why: Quitting within 400ms of the last action silently drops that change; restore lands on the previous active tab or misses the last split/rename. Bounded metadata loss, but it erodes the restore-on-relaunch promise. (confidence: medium)

- **[MEDIUM · test-gap] Color-allocation model (nextColor/resolveColors) has zero test coverage**  
  Where: `src/ui/features/workspace/model.ts:87`  
  Evidence: model.ts documents load-bearing invariants: live-set allocation (nextColor:87-96), least-worn overflow past 12, retired-hex repair, and resolveColors' two-pass no-eviction order (:118-136). Grep for nextColor/resolveColors/isWorkspaceColor under tests/ returns nothing; workspace-smoke.ts asserts persistence only.  
  Recommendation: Add tests/unit/workspace-colors.test.ts covering: first-free allocation, least-worn reuse past 12, retired-hex re-allocation, duplicate repair keeping the first claimant, and resolveColors' no-eviction property.  
  Why: These pure functions exist to repair real corrupted stores (duplicate brand orange, retired #b5d21b). A regression would silently reintroduce the exact duplicate-color collision the code was built to end, and no test would fail.

- **[LOW · bug] publishRoles seeds swarm roles for slots the restored layout no longer has**  
  Where: `src/ui/features/workspace/controller.ts:465`  
  Evidence: publishRoles calls setPaneRole/TerminalChannels.setRole for every role-bearing index (controller.ts:464-473) with no liveness check, unlike launchLineup's live.has(paneId) guard (:1897-1901). closePane never scrubs the closed slot's manifest row, so roles persist for closed middle slots.  
  Recommendation: In publishRoles, compute the live slot set the way create() does (leafIds of the restored tree, else 1..paneCount) and skip roles whose paneIdForSlot is not live, mirroring launchLineup's guard.  
  Why: Restoring a workspace whose middle pane was closed publishes a role for a nonexistent pane id: the pane-meta port and daemon record a ghost role (`mogging list` from-roles), and the dead slot consumes one entitlement-capped role grant. (confidence: medium)

- **[LOW · docs-drift] Docs drift: 'docs/02 Phase-1/05' missing; README misplaces themes.ts**  
  Where: `src/ui/features/workspace/README.md:16`  
  Evidence: The expected-behavior source docs/02 Phase-1/05 is absent — docs/ holds only numbered top-level files (00-22, adr, research), no Phase-1 dir. README.md:16-17 lists 'themes.ts' as a file of this feature, but it lives at src/ui/core/theme/themes.ts, and the theme picker UI is in settings (settings/index.ts:99).  
  Recommendation: Update src/ui/features/workspace/README.md to point themes.ts at src/ui/core/theme/ and note the picker lives in settings; restore or re-point the Phase-1/05 spec reference to a doc that exists.  
  Why: The feature's canonical spec pointer is dead and its file inventory is stale, so contributors and future audits will look for the theme system in the wrong module.

## Connection stdio bridge into agent CLIs (ADR 0014)  (implemented: partial)

> Expected: A connected service is registered in CLI configs as a secretless stdio MCP entry running the app's bridge shim; the bridge forwards the agent's JSON-RPC over the 0600 token-authed local socket and the app attaches the keychain-held OAuth token at exactly one decryption point.

- **[CRITICAL · bug] Connection launcher redirects to the house MCP server inside every pane**  
  Where: `src/main/cli-runtime.ts:153`  
  Evidence: stableMcpLauncherSource hardcodes paneTarget = join(runRoot, segment, 'bin', 'mogging-mcp.mjs') (cli-runtime.ts:153), yet line 197 reuses it for connectionEntry. Every pane carries MOGGING_DAEMON_ENDPOINT (src/pty-daemon/index.ts:77), whose dirname is run/v11, so the regex matches and the redirect always fires.  
  Recommendation: Parameterize the pane-target filename in stableMcpLauncherSource (use basename(current) instead of the literal 'mogging-mcp.mjs') and add a smoke that runs connectionShim with MOGGING_DAEMON_ENDPOINT set, asserting the bridge (not the house server) answers.  
  Why: Agent CLIs spawn MCP servers with the pane env, so the 'sentry' entry launches mogging-mcp.mjs (ignores --connection) instead of the bridge. Connected-service tools never reach a pane agent — ADR 0014's core delivery path is broken.

- **[HIGH · bug] Protocol bump strands every connection entry on a swept, version-pinned shim path**  
  Where: `src/main/cli-runtime.ts:203`  
  Evidence: connectionShim lives in the versioned dir run/v<N>/bin (cli-runtime.ts:203 via runtimeDir); daemon-sweep.ts:76 rmSync-deletes older v<N> dirs at boot. registerConnectionServer runs only on connect paths (connections.ts:433,631,745,842,895,957); mgrRefresh (mcp-manager.ts:318) repairs only the 'mogging' entry.  
  Recommendation: At boot after installCliRuntime, re-run registerConnectionServer for every connected service (or extend mgrRefresh to bridge entries); or register the version-neutral connectionEntry path the way the house entry registers mcpEntry.  
  Why: After a protocol bump the entries name a deleted .cmd/.sh path. Drift detection compares configs to the stored stale canonical, so nothing flags it; every connected service silently fails to spawn until reconnected.

- **[HIGH · behavior-mismatch] Windows registers a .cmd as the MCP command while the house server avoids it**  
  Where: `src/main/connections.ts:1266`  
  Evidence: registerConnectionServer writes command: runtime.connectionShim — mogging-connection.cmd on win32 (cli-runtime.ts:203). houseServerEntry deliberately uses the helper exe + script args instead (mcp-manager.ts:93-94), so only connection entries take the batch-file path on Windows.  
  Recommendation: Register connections the same shape as the house server: command = runtime.executable, args = [runtime.connectionEntry, '--connection', id]. This removes the .cmd spawn hazard and the shim indirection entirely, on both platforms.  
  Why: Node-based CLIs spawning stdio servers without shell:true fail on .cmd with EINVAL (CVE-2024-27980 hardening); Claude Code guidance requires 'cmd /c' wrappers. macOS gets a working sh shim — divergence against the README parity promise. (confidence: medium)

- **[MEDIUM · gap] connection.rpc ignores the workspace tool plan the ADR calls the real boundary**  
  Where: `src/main/mcp-endpoint.ts:159`  
  Evidence: handleConnectionRpc (mcp-endpoint.ts:159-220) validates only the id regex; boundPane gates only REST writes (line 179). Any pane in any workspace — or any paneless endpoint-file reader — can call any connected service and get token-attached responses.  
  Recommendation: For pane-bound sessions, resolve pane → workspace (workspaceIdForPane) and refuse connection.rpc when the workspace plan omits the connection — the same fail-closed ladder ADR 0022 specifies for credential.get. Keep paneless behavior explicit and documented.  
  Why: ADR 0014 says a connection is reachable by agents whose workspace plan includes it, but the plan is enforced only at config fan-out; an agent can shell-spawn the shim with any --connection id and bypass the plan its workspace excluded.

- **[MEDIUM · test-gap] Gate never exercises the real spawn chain shim → launcher → bridge**  
  Where: `scripts/connections-pure-smoke.ts:369`  
  Evidence: connections-pure-smoke.ts:369 spawns bin/mogging-connection.mjs directly with process.execPath; toolplan-smoke.ts:67-87 tests the stable launcher only with mogging-mcp fixture targets; runtimesplit-smoke.ts:96 only reads shim bodies as text.  
  Recommendation: Add a smoke that executes runtime.connectionShim end-to-end against a fixture endpoint, once with and once without MOGGING_DAEMON_ENDPOINT in env, asserting the bridge's rpcError/echo behavior in both cases.  
  Why: The exact composition agents execute (connectionShim → connectionEntry launcher → versioned bridge, with pane env present) is untested — which is precisely why the critical launcher cross-wire passed the gate.

- **[LOW · docs-drift] The '0600 endpoint file' boundary is POSIX-only; Windows relies on inherited ACLs**  
  Where: `src/main/mcp-endpoint.ts:596`  
  Evidence: writeFileSync(endpointFile(), ..., { mode: 0o600 }) at mcp-endpoint.ts:596 — the mode option is a no-op on win32; protection is the default %LOCALAPPDATA% ACL. ADR 0014/0022 repeatedly name 'the 0600 endpoint file' as the trust boundary now carrying OAuth reach.  
  Recommendation: Either explicitly set a user-only DACL on the runtime dir at creation, or amend the ADR/docs to state that on Windows the boundary is the profile ACL, not a 0600 mode.  
  Why: Practically user-scoped on default Windows setups, but the documented guarantee is stronger than what the code enforces there — a parity-of-promise gap worth closing now that this file gates credential-bearing calls. (confidence: medium)

## Curated REST tool bridge (ADR 0020/0021)  (implemented: partial)

> Expected: ADR 0021: catalog-curated restTools served as MCP tools by a house bridge executing pinned provider REST endpoints with the vault-held key injected server-side — typed refusals, endpoint pinning, catalog-grammar retries, next-link pagination said honestly, write-grant gating at the MCP-write seam.

- **[HIGH · behavior-mismatch] Stripe's declared cursor pagination is unimplemented: silent one-page answers**  
  Where: `src/backend/features/integrations/rest-bridge.ts:275`  
  Evidence: Pagination only follows a top-level string `next` URL (rest-bridge.ts:275-297); `pagination.cursorParam`/`pageParam` (provider-catalog.ts:161) are never read. stripe.json:67,80,93,105 declare {"cursorParam":"starting_after"}; Stripe list responses carry `has_more`+cursors, never a `next` URL.  
  Recommendation: Implement cursorParam pagination in executeRestTool (re-request with cursor = last item's id, detect `has_more`) or, minimally, set morePages when the declared grammar can't be followed; add a Stripe-shaped fixture page to restexec-pure-smoke.ts.  
  Why: All four Stripe list tools return only page 1 (default 10 items) with morePages false, so the agent is told the answer is complete — breaking the "says so when more exist" promise on the provider whose grantCopy screams MONEY.

- **[MEDIUM · gap] connectionConfig never plumbed at the production seam; ${placeholder} rows ship broken**  
  Where: `src/main/mcp-endpoint.ts:176`  
  Evidence: handleRestBridgeRpc is called with only {entry, token, writeGranted} (mcp-endpoint.ts:176-180); restBridgeUpstream (connections.ts:1216-1228) returns no config, and no store/UI collects connectionConfig values on the key route. resolveEndpoint then sees {} (rest-bridge.ts:229) and refuses every ${KEY} endpoint.  
  Recommendation: Persist connectionConfig values with connection meta (collect in the key panel when declared), return them from restBridgeUpstream, pass them at mcp-endpoint.ts:176; add a placeholder-row case through the real seam to restmilestone-smoke.  
  Why: RESTSCHEMA validates ${connectionConfig} interpolation and the CATSCHEMA selftest ships a ${INSTANCE_URL} tool, so the advertised data-PR path yields a row that always refuses "needs its X configured" while Settings has nowhere to set it.

- **[MEDIUM · test-gap] RESTMILESTONE smoke rebuilds the bridge service instead of exercising handleConnectionRpc**  
  Where: `src/main/smokes/restmilestone-smoke.ts:249`  
  Evidence: The smoke constructs its own svc = {entry, token, writeGranted} (restmilestone-smoke.ts:249-258) and calls handleRestBridgeRpc directly, mirroring mcp-endpoint.ts:176-180 rather than routing frames through handleConnectionRpc.  
  Recommendation: Drive the milestone assertions through handleConnectionRpc (or an exported wrapper of the real service construction) so the seam under audit is the seam under test.  
  Why: Drift in the one production construction site is invisible to the gate — it already missed the dropped connectionConfig field; a future regression in restBridgeUpstream or write-grant wiring would also pass green.

- **[MEDIUM · bug] Key verification probe ignores restAuth carriage; query-auth providers can never connect**  
  Where: `src/backend/features/integrations/credential-core.ts:226`  
  Evidence: runVerificationProbe always sends `authorization: <scheme> <key>` (credential-core.ts:223-230); connectBridgeKey passes only entry.restAuth.scheme (connections.ts:871-872). Yet schema.json and executeRestTool (rest-bridge.ts:239-243) support restAuth in:'query' and arbitrary header names.  
  Recommendation: Thread the row's full RestAuthSpec into runVerificationProbe (header name and query-param carriage) and add a query-auth fixture case to the smokes; or have RESTSCHEMA refuse restAuth shapes the probe cannot prove.  
  Why: A row using query-param or non-Authorization-header auth (valid per RESTSCHEMA) gets a provider 401 on prove-before-save, so a correct key is refused at paste and the bridge route is unreachable. Latent: shipped rows all use Bearer.

- **[LOW · improvement] readOnly:true non-GET tools bypass the write grant on curator say-so, no second check**  
  Where: `src/backend/features/integrations/rest-bridge.ts:220`  
  Evidence: The gate fires only on `tool.readOnly === false` (rest-bridge.ts:220). cf-graphql.json:68-74 ships a POST marked readOnly:true (defensible — CF's GraphQL analytics schema has no mutations), and RESTSCHEMA (check-catalog.mjs:185-187) only requires readOnly be explicit, not truthful.  
  Recommendation: Add a RESTSCHEMA rule requiring a `readOnlyRationale`/provenance field for any readOnly:true non-GET tool (with a selftest mutation), so reviewers must justify each write-grant exemption.  
  Why: One mis-curated data PR (a POST marked readOnly:true) silently exempts a real mutation from the per-workspace write grant — the boundary docs call "exactly as gated as an MCP write tool", repealed by data alone. (confidence: medium)

- **[LOW · improvement] Retry and pagination abandon unconsumed response bodies**  
  Where: `src/backend/features/integrations/rest-bridge.ts:201`  
  Evidence: fetchWithRetry refetches after a retryable !ok response without cancelling/consuming the first res.body (rest-bridge.ts:200-205); pagination `break`s on !res.ok (line 289) likewise drop an unread body.  
  Recommendation: After deciding to retry or break, call `void res.body?.cancel()` (or `res.arrayBuffer().catch(() => {})`) on the abandoned response before issuing the next request.  
  Why: Under Node/undici an unconsumed body keeps the connection reserved until GC; bounded (one retry, ≤3 pages) but a real resource hold in a long-lived main process serving many agent panes.

## Per-pane git branch/dirty chip pipeline  (implemented: yes)

> Expected: Every local pane header streams a read-only git chip (branch, worktree, dirty/staged counts, divergence vs upstream and base) from one shared main-process GitMonitor: one status spawn per distinct worktree per 2.5s tick, metadata-dir watches for instant updates, remote panes never probed.

- **[MEDIUM · bug] Probe inherits GIT_DIR/GIT_WORK_TREE, letting env redirect every chip**  
  Where: `src/backend/features/git/probe.ts:20`  
  Evidence: run() calls execFile('git', args, { timeout, maxBuffer, windowsHide }) with no env option (probe.ts:18-25), so process.env passes through. GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE override `git -C root status` regardless of -C; findRepoRoot (pure fs, repo.ts:14) would still report the pane's root.  
  Recommendation: In run() (probe.ts) and checkIgnore (src/main/git.ts:40) pass an env with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_NAMESPACE deleted (and set GIT_TERMINAL_PROMPT=0), mirroring what the smoke already does for its own git calls.  
  Why: If the app is launched from a shell or hook where GIT_DIR is exported (git aliases/CI wrappers), every pane chip silently reports the env repo's branch/dirty state under the pane's root label — a lying chip on both platforms.

- **[MEDIUM · bug] Tick subscriber keyed by raw root gets files=null when root is inside a larger repo**  
  Where: `src/backend/features/git/monitor.ts:288`  
  Evidence: probeRepo sets wantFiles via this.tickSubs.has(this.foldRoot(root)) where root=findRepoRoot(cwd) (monitor.ts:288), but subscribeTick keys tickSubs by foldRoot of the subscriber's raw root (monitor.ts:148-150). tick() then delivers p.files=null with p.status non-null (monitor.ts:342-356).  
  Recommendation: In probeRepo, compute wantFiles by checking whether any tickSubs entry's findRepoRoot(entry.root) folds to this root (or store the resolved repo root on the tickSubs entry at subscribe time and key the wantFiles check on it).  
  Why: A brain root that is a subdirectory of an enclosing repo (monorepo project, dotfiles-tracked home) gets status!=null but files=null every tick; freshness.ts:295-301 matches neither branch, so brain freshness stalls for that root. (confidence: medium)

- **[MEDIUM · improvement] Synchronous fs walks repeat on the main process every tick; unbounded on slow drives**  
  Where: `src/backend/features/git/monitor.ts:280`  
  Evidence: Each tick, per pane: probeRepo calls findRepoRoot(cwd) (monitor.ts:280) — realpathSync.native plus up to 256 lstat/stat rounds (repo.ts:23-45) — then probeGitFull repeats findRepoRoot (probe.ts:431) and readGitLayout 3+ times (probe.ts:436, repo.ts:85-110, readManagedBase repo.ts:239).  
  Recommendation: Memoize cwd->(root, layout) across ticks in GitMonitor, invalidated on metadata-watch wake, probe error, or setCwd; or convert findRepoRoot/readGitLayout to async fs so slow filesystems never block the main thread.  
  Why: Fine at 16 panes on SSD, but one pane cwd on a UNC/network drive (Windows) turns each statSync into tens of ms of main-thread block every 2.5s — jank that stalls IPC and violates docs/05 frame-gap budgets. (confidence: medium)

- **[MEDIUM · test-gap] Gate smoke records the OSC-7 chip-retarget result but never asserts it**  
  Where: `src/main/smokes/git-smoke.ts:250`  
  Evidence: Comment at git-smoke.ts:219 says 'Cwd refinement is gated too', yet the pass expression (lines 250-313) omits oscRetargeted/oscLatencyMs — they are only reported (lines 339-341). The URI also uses authority 'host' (line 220), which the locality parser rejects as foreign (git-feature-pure-smoke.ts:169-173).  
  Recommendation: Add oscRetargeted (and a latency bound) to the pass expression in git-smoke.ts, and emit the OSC 7 URI with an empty or localhost authority so the leg exercises the accepted grammar.  
  Why: OSC-7-driven cwd refinement is the only chip-retarget path for plain shells; it can regress (or already be vacuously failing, given the foreign authority) while the GIT gate stays green.

- **[LOW · bug] unwatchFiles leaks registration, keeping the poll alive, when the repo root was deleted**  
  Where: `src/backend/features/git/monitor.ts:129`  
  Evidence: unwatchFiles resolves the key as findRepoRoot(cwd) ?? cwd (monitor.ts:129). If the worktree was deleted before unwatch (managed-worktree removal is a core app flow), findRepoRoot returns null and the raw cwd never matches the root stored by watchFiles (monitor.ts:119-121), so fileRoots retains the dead root.  
  Recommendation: Have watchFiles record cwd->root in a Map and have unwatchFiles delete via that map (falling back to findRepoRoot), so the registration is removed by the same key it was created under.  
  Why: stopIfIdle (monitor.ts:252) never sees size 0, so the 2.5s interval and a per-tick findRepoRoot of a dead path run for the rest of the session even with zero panes; lastFiles entries are retained too.

- **[LOW · test-gap] Porcelain-v2 parsers have no unit tests; all coverage rides live-git smokes**  
  Where: `src/backend/features/git/probe.ts:375`  
  Evidence: tests/unit contains no git test file (verified by listing); parseStatusV2 (probe.ts:250), parseStatusFiles (probe.ts:375), and unquotePath's octal byte reassembly (probe.ts:331-351) are exercised only through smokes that spawn real git on simple fixtures.  
  Recommendation: Add tests/unit/git-porcelain.test.ts feeding hand-written porcelain-v2 strings (including quoted UTF-8 octal paths and a >GIT_FILES_CAP list) through parseStatusV2/parseStatusFiles and asserting counts, states, and truncation.  
  Why: Crafted edges — rename '2' records with tab origPath, 'u' conflict lines, C-quoted non-ASCII/CR paths, detached/unborn headers, GIT_FILES_CAP truncation — are exactly where a parser regression would ship silently past the gate.

- **[LOW · docs-drift] The Phase-2/03 spec cited across the feature does not exist in docs/**  
  Where: `src/ui/features/git/index.ts:7`  
  Evidence: Eight files cite 'Phase-2/03' as the feature's spec (src/ui/features/git/index.ts:7, src/contracts/ipc/git.ipc.ts:1, src/backend/features/git/index.ts, src/main/boot.ts, ...), but docs/ has only numbered topic files 00-22 plus adr/ and research/ — no '02 Phase-2' directory or 03 document anywhere.  
  Recommendation: Either restore the Phase-2/03 document under docs/ (capturing watch lifecycle, remote-pane guard, tick cost, and degrade semantics) or repoint the code comments at an existing doc section.  
  Why: The designated expected-behavior source is missing, so the contract for chip behavior (remote guard, poll cadence, degrade states) lives only in code comments and cannot be reviewed against a promise.

## Shared account defaults tier (ADR 0022)  (implemented: yes)

> Expected: A provider-level defaults tier: a value authored once fans out into every account's config home via the existing enforce writer, per-account pins win (pin ?? default ?? file), secrets refused at the persistence boundary, per-provider rollout, honest UI labels and first-write consent.

- **[MEDIUM · behavior-mismatch] Per-provider rollout allowlist (DEFAULTS_PROVIDERS) is enforced only in the renderer**  
  Where: `src/main/agent-settings.ts:383`  
  Evidence: setDefault/clearDefault/promotable handlers (agent-settings.ts:378-413) accept any isAgentCliId provider; setAccountDefault (service.ts:474) has no allowlist. The only DEFAULTS_PROVIDERS check is src/ui/features/settings/agent-config.ts:40 ('claude' only).  
  Recommendation: Move DEFAULTS_PROVIDERS into src/contracts as a shared constant and reject non-allowlisted providers in the setDefault/clearDefault/promotable handlers in src/main/agent-settings.ts (or at the top of setAccountDefault/applyAccountDefaults).  
  Why: docs/22:91-93 promises the tier reaches a provider only after its gate certifies home enumeration/codec behavior. Any renderer-side IPC call can fan out into uncertified CODEX_HOME/GEMINI_CLI_HOME homes via never-gated TOML codec paths.

- **[MEDIUM · bug] Debounced fan-out racing a direct apply yields spurious 'changed-under-us' errors**  
  Where: `src/backend/features/agent-settings/service.ts:519`  
  Evidence: setAccountDefault awaits applyAccountDefaults (service.ts:519) without cancelling a pending applyTimers timer (service.ts:641). Both runs read the file hash outside the write queue (service.ts:777) then CAS-mutate (service.ts:792); the loser throws changed-under-us (mutation-coordinator.ts:88).  
  Recommendation: Serialize applyAccountDefaults per provider via an in-flight promise chain, and have setAccountDefault/clearAccountDefault clear any pending applyTimers entry for that provider before applying directly.  
  Why: Save a profile (400ms apply scheduled, profiles.ts:204) then save a default in that window: the losing run marks compiled rows 'error' and returns ok:false, so the UI toasts a false failure and shows error pills until the next reconcile.

- **[MEDIUM · bug] Failed debounced adoption is swallowed with no retry, despite a comment claiming one**  
  Where: `src/backend/features/agent-settings/service.ts:642`  
  Evidence: scheduleApplyAccountDefaults ignores ok:false and its catch is empty (service.ts:644-649), claiming 'the next tick (reconcileAll) retries'. But the baseline-read failure path (service.ts:587-601) saves no compiled row, and reconcileAll (service.ts:381) never re-runs fan-out.  
  Recommendation: Reschedule a failed timer-driven apply with bounded backoff, or add applyAccountDefaults for providers with authored tiers to the periodic refreshInstalledCatalogs pass in src/main/agent-settings.ts:445-463 (today it calls reconcileAll only).  
  Why: A new account whose home is transiently unreadable at the one debounced apply silently never adopts defaults until app restart or the next authored edit, breaking the docs/22:62-64 Adopt promise. Nothing is surfaced to the user.

- **[MEDIUM · behavior-mismatch] 'On drift: Apply once' selector renders but is silently ignored on tier-routed saves**  
  Where: `src/ui/features/settings/agent-config.ts:475`  
  Evidence: On defaults-eligible rows the ownership select renders (agent-config.ts:402-406, 563) but save() always routes through setDefault (agent-config.ts:475-495) which never sends ownership; setAccountDefault hardcodes ownership:'enforce' (service.ts:509).  
  Recommendation: In agent-config.ts, hide or disable the 'On drift' select whenever the Applies-to control routes the save to setDefault, or show 'Keep in sync' fixed with a hint that tier-managed keys are always enforced.  
  Why: Picking 'Apply once' plus 'This account only' saves an enforced pin whose drift is restored forever; the visible control promises semantics the tier cannot deliver, with no feedback (honest-labels doctrine, docs/22:78-80).

- **[LOW · gap] Consent announces 'all N accounts' even when fan-out skips unsupported homes**  
  Where: `src/ui/features/settings/agent-config.ts:427`  
  Evidence: consentCrossAccount counts profile scope options + 1 (agent-config.ts:411, 427), but applyAccountDefaults skips homes whose scope the setting lacks (service.ts:577-578 continue). Eligibility needs only user OR profile scope (agent-config.ts:414).  
  Recommendation: Count enforceable homes per setting in the consent message (filter scope options by setting.scopes), or restrict defaultsEligible to settings whose scopes include both 'user' and 'profile'.  
  Why: For a user-only-scope setting the first-write announcement claims management across all accounts while only the primary home is enforced; the honesty beat docs/22:83-85 promises is factually wrong for those keys. (confidence: medium)

- **[LOW · bug] A profile pointer aimed at the primary's home creates dueling compiled rows in one file**  
  Where: `src/backend/features/agent-settings/service.ts:444`  
  Evidence: providerHomes (service.ts:444-470) never dedupes a pointered profile whose CLAUDE_CONFIG_DIR resolves to ~/.claude against the primary home; deriveProfileDefaults's taken-set (profiles.ts:83) checks siblings only, and explicit env payloads are honored as-is.  
  Recommendation: Dedupe providerHomes by resolved source file (drop a pointered profile whose home equals the primary's), or refuse saving a profile whose pointer resolves to the provider's default home in src/main/profiles.ts.  
  Why: Pin that profile while a default exists: both compiled rows land in one file group (service.ts:766-772), last transform wins, the other row reports perpetually 'drifted', and every reconcile rewrites the file. (confidence: medium)

- **[LOW · test-gap] No test exercises pinning the PRIMARY home, an explicit doc doctrine**  
  Where: `src/main/smokes/profiledefaults-smoke.ts:131`  
  Evidence: docs/22:34-36 promises 'a pin on the primary resolves like any other'. profiledefaults-smoke.ts:131 and defaultsmilestone-smoke.ts:90 pin only pointer profiles; tests/unit/account-defaults.test.ts never covers the user-scope compiled-row path via providerHomes/tierProfileId.  
  Recommendation: Add a bite to profiledefaults-smoke.ts: pin the primary profile via setAccountDefault, assert only the primary settings.json differs, snapshot(userTarget) labels managedBy 'pin', and clearing the pin re-inherits the default.  
  Why: The primary-pin variant is the most wiring-heavy: a scope-'profile' pin must compile into a scope-'user' row via home.profileId, plus IPC tierProfileId resolution (agent-settings.ts:374-377); no gate currently proves it.

## Winget/Homebrew install manifests  (implemented: yes)

> Expected: Winget and Homebrew cask manifests in packaging/ pin official GitHub release artifacts by sha256, regenerate from real artifact bytes via one command (scripts/update-manifests.mjs), and are continuously validated in CI so upstream submission is a copy-paste PR.

- **[HIGH · bug] Release re-run --clobber silently invalidates pinned manifest hashes; no gate detects it**  
  Where: `.github/workflows/release.yml:245`  
  Evidence: release.yml:12-16 allows dispatch re-runs against an existing tag; ensure-release demotes to draft only when NO feed files exist (lines 50-53), so a published release stays live while `gh release upload --clobber` (line 245) replaces assets with rebuilt, non-byte-identical binaries.  
  Recommendation: Add a release.yml step after upload: if packaging manifests' PackageVersion/version equals the tag, sha256 the just-uploaded .exe/.dmg and fail (or auto-regenerate) on mismatch with the committed pins.  
  Why: Committed pins (winget installer.yaml:12, cask:4) then mismatch published bytes; every winget/brew install hard-fails hash verification — exactly the first-install drift the manifests exist to prevent.

- **[MEDIUM · gap] CI manifest validation never verifies pinned sha256/URL against the published release**  
  Where: `.github/workflows/ci.yml:564`  
  Evidence: manifests-winget runs only `winget validate --manifest packaging/winget` (ci.yml:564-566) and manifests-brew only `brew style` (line 580); both gated to dispatch or the 03:30 cron (lines 549, 570) — schema/style checks that never fetch the InstallerUrl or compare hashes, and never run on PRs touching packaging/.  
  Recommendation: In the nightly manifest jobs, curl each pinned InstallerUrl/cask url and compare sha256 to the committed pin; add push/pull_request path filters for packaging/** so edits validate pre-merge.  
  Why: docs/10:149-161 promises hashes verified against release assets, but that was a one-time manual claim (docs/10:163-165); drift from clobber, a hand-edit, or a deleted asset reaches users with green CI.

- **[MEDIUM · gap] Winget manifest lacks ProductCode/AppsAndFeaturesEntries for a self-updating NSIS app**  
  Where: `packaging/winget/MoggingLabs.Workspace.installer.yaml:9`  
  Evidence: Installers block (lines 9-12) carries only Architecture/InstallerUrl/InstallerSha256; no ProductCode or AppsAndFeaturesEntries, while the installed app self-updates via electron-updater (docs/10:85-104), moving ARP DisplayVersion past PackageVersion.  
  Recommendation: Emit ProductCode (electron-builder's per-user uninstall key for appId ai.mogginglabs.workspace) and an AppsAndFeaturesEntries block from the winget template in scripts/update-manifests.mjs (around line 80).  
  Why: winget correlates nullsoft installs via ARP heuristics; without ProductCode/DisplayVersion mapping, winget upgrade/uninstall mis-correlate or offer downgrades once the app auto-updates. (confidence: medium)

- **[MEDIUM · behavior-mismatch] Cask auto_updates true while mac updater is inert unsigned — tap users stranded**  
  Where: `packaging/homebrew/Casks/mogginglabs-workspace.rb:11`  
  Evidence: Cask emits `auto_updates true` (generated at scripts/update-manifests.mjs:128), but docs/10 platform matrix (line 14) states macOS auto-update is 'inert until signed — Squirrel.Mac refuses unsigned updates'. `brew upgrade` skips auto_updates casks unless --greedy.  
  Recommendation: In update-manifests.mjs caskTail, omit auto_updates (optionally add a livecheck on GitHub releases) until signing/notarization lands; re-add it in the same commit that flips signing on.  
  Why: docs/10:178-181 says the tap path 'ships today'; a tap user gets updates from neither brew (skipped) nor the in-app updater (refuses unsigned) — silent version stranding on the first-install path. (confidence: medium)

- **[MEDIUM · docs-drift] RELEASING.md instructs hand-publishing the draft and still promises mac-x64**  
  Where: `docs/RELEASING.md:13`  
  Evidence: RELEASING.md:12-14: 'curate the body … and publish it'; line 3 lists 'mac-x64'. release.yml:305-310 makes the publish job 'the ONLY hand that flips it live'; docs/10:137-139 says 'never flip --draft=false yourself'; mac x64 is deferred (docs/10:62-69, electron-builder.yml:170-174).  
  Recommendation: Rewrite step 3 to say the workflow's publish job flips the draft live after feed verification (curate notes on the draft only), and drop mac-x64 from line 3 until Intel returns.  
  Why: RELEASING.md is the operator playbook; following it as written recreates the v0.16.0 premature-publish outage the publish-after-assets law exists to prevent, and misstates the shipping platform set.

- **[LOW · test-gap] No test covers update-manifests.mjs despite a shipped URL-derivation regression**  
  Where: `scripts/update-manifests.mjs:149`  
  Evidence: grep for update-manifests/winget/cask across tests/ and src/main/smokes returns nothing; the script's own comments (lines 143-148) document that a hardcoded dotted cask URL previously 404'd every `brew install` while the sha256 beside it was correct.  
  Recommendation: Add a unit test in tests/unit that runs the generator against a fixture dir of dummy artifacts (win exe + one/two dmgs, prerelease version) and snapshots the four emitted manifests, asserting URLs, hashes, and the version-mismatch exit path.  
  Why: Version-regex parsing (line 38), multi-version refusal (line 41), #{version}/#{arch} substitutions (lines 149, 161), and the arm-only vs dual-arch cask branches are string-munging that already broke installs once and can regress unnoticed.

## Perf and perception budgets vs shipped smokes  (implemented: partial)

> Expected: docs/05 pins a machine budget at 16 panes (gap ≤150ms, ≥30fps, ≤300MB, ≥12 WebGL) and docs/07 pins perception budgets (≤100ms actions, ≤60ms echo, 0 frames >100ms under churn and 16-agent torrent, ≤1000ms cold start), all asserted by MOGGING_MILESTONE/PERCEPTION/FLICKER smokes that fail the gate.

- **[HIGH · bug] Echo-latency gate fails open: total echo breakage passes MOGGING_PERCEPTION**  
  Where: `src/main/smokes/perception-smoke.ts:167`  
  Evidence: Pass clause is `(echoMedian === -1 || echoMedian <= B.echoMs)`. echoMedian stays -1 when pane 1 is absent or when ALL samples hit the 1500ms lost-sample timeout (line 111) — i.e. echo latency >1.5s, or terminal:data never firing, yields -1 and PASSES.  
  Recommendation: Treat echoMedian === -1 as failure (require pane1 && samples.length >= 4), and remove each terminal:data handler after its sample resolves (currently up to 42 leak; stale pane-1 data right after t0 records falsely fast samples that best-of-6 keeps).  
  Why: docs/07:58 promises the smoke 'fails on any budget line above'; the worst possible echo regression (dead or >1.5s round trip) is invisible, and echo is the one budget softEchoMs says is never relaxed.

- **[HIGH · behavior-mismatch] docs/07 hard line '0 frames >100ms under 16-agent torrent' asserted by no smoke**  
  Where: `src/main/smokes/milestone-smoke.ts:168`  
  Evidence: milestone budgetOk checks only `stress.maxGapMs <= 150` plus fps/heap/idle; `longFrames100` (line 82) is computed for the 16-pane 4s torrent but never asserted. MOGGING_PERCEPTION's torrent gate (perception-smoke.ts:150,170) covers only 8 panes for 2s.  
  Recommendation: Add `stress.longFrames100 === 0` (threshold via softGapMs so CI soft mode relaxes loudly) to milestone budgetOk; baseline measured 0 long frames twice, so headroom exists.  
  Why: A recurring 100-150ms stall that only appears at 16 panes passes both smokes while violating docs/07's hard budget row — exactly the '16 agents, nothing freezes' wedge scenario.

- **[MEDIUM · test-gap] Home/Board view-toggle budget silently skipped if the button selector drifts**  
  Where: `src/main/smokes/perception-smoke.ts:165`  
  Evidence: `(homeMax === -1 || homeMax <= B.actionMs)` — homeMax is -1 whenever `querySelector('.titlebar-right .icon-btn[aria-label="Board"]')` (line 76) finds nothing, and the smoke passes. Comment at lines 72-75 shows the selector already drifted once (Home -> Board).  
  Recommendation: Fail when homeBtn is null (return pass:false with error 'Board toggle not found'), or assert homeTimes.length === 4 inside the pass clause.  
  Why: A hard docs/07 budget line (full-app view <-> grid <= 100ms) vanishes without any red on the next aria-label or titlebar refactor; the gate reports pass while measuring nothing.

- **[MEDIUM · gap] Cold-start <= 1000ms budget line has no enforcement anywhere**  
  Where: `docs/07-perception-budget.md:29`  
  Evidence: docs/07 table pins 'Cold start -> interactive UI (packaged): <= 1000 ms' as hard, but the enforcement section (lines 54-65) lists no smoke for it, and grep across src/ finds no startup-to-interactive measurement (only daemon 'cold-start restore' semantics, e.g. src/pty-daemon/session.ts:1224).  
  Recommendation: Add a startup smoke (main records app-ready -> renderer first double-rAF paint, asserts <=1000ms packaged / reports in dev), or move the row to an explicit 'tracked manually, not asserted' section of docs/07.  
  Why: docs/07's headline is 'asserted, not eyeballed', and docs/03 sells 'leanness and fast startup' as a wedge; this line can regress with no gate turning red.

- **[MEDIUM · docs-drift] docs/05 + docs/07 still describe unconditional GL release-on-hide the product repealed**  
  Where: `docs/05-perf-budget.md:48`  
  Evidence: docs/05:48-51 'releases it when its workspace is hidden', docs/07:41-42 'hidden panes release only after a 1.5s quiet period', docs/07:63 'a hidden workspace must still release all its contexts' — vs pane-webgl.ts:135: hidden panes keep contexts warm under a pressure budget (default 16), releasing only over cap.  
  Recommendation: Rewrite docs/05 'How the budget is met' and docs/07 'How it is held' / MOGGING_FLICKER bullet to describe pressure-driven warm-keep (glBudget=16, evict-hidden-at-acquire, release only over cap; __moggingGlBudget=0 dev override pins the machinery).  
  Why: Both smokes pin the opposite (flicker 2c asserts warmKept===8; milestone phase B forces __moggingGlBudget=0 to see a release, calling the docs' rule 'a law the product repealed'); tuning from the docs would re-break the switch-flicker fix.

- **[LOW · docs-drift] BUDGET provenance drift: wrong path, undocumented CI relaxation, stale comment**  
  Where: `docs/05-perf-budget.md:10`  
  Evidence: docs/05:10 cites `src/main/milestone-smoke.ts` (real: src/main/smokes/milestone-smoke.ts); the table states 150ms/30fps unconditionally while MOGGING_CI_GPU=soft relaxes gap x4, fps /3 (smoke-shell.ts:191-210); milestone-smoke.ts:35 says soft mode 'relaxes ONLY this' yet line 38 also softens minAvgFps.  
  Recommendation: Fix the path at docs/05:10, note in the docs/05 table that MOGGING_CI_GPU=soft loudly relaxes gap (x4) and fps (/3) on software-GL CI only, and correct the milestone-smoke.ts:35 comment to cover both softened gates.  
  Why: The BUDGET table is declared source of truth; a wrong path plus an unmentioned relaxation regime and a self-contradicting comment mislead anyone auditing what CI actually enforces.

## Local endpoint token custody and lifecycle  (implemented: partial)

> Expected: The app opens a token-authed local pipe/socket and writes a 0600 endpoint file (browser-control.json) that bin clients read to authenticate; unauthenticated connections are dropped within seconds, the file dies with the app, and Windows/macOS behave identically (docs/06, ADR 0006/0008).

- **[HIGH · bug] No pre-auth timeout or buffer cap: unauthenticated sockets can hold main hostage**  
  Where: `src/main/mcp-endpoint.ts:384`  
  Evidence: The connection handler (mcp-endpoint.ts:384-399) has no auth timer and grows `buf += chunk` unbounded; a non-hello frame only destroys the socket after a newline arrives (L442). The daemon transport it claims to mirror destroys unauthed sockets after 3s (src/pty-daemon/transport.ts:90-92).  
  Recommendation: In the connection handler add a 3s setTimeout that destroys the socket if !authed (clear on welcome), and destroy any socket whose `buf` exceeds a cap (e.g. 256KB), matching the daemon transport's posture.  
  Why: docs/06 and ADR 0006 promise unauthed drops in ~3s. Any local process can connect to the pipe and stream newline-free bytes: main's heap grows unbounded (docs/05 budget) until OOM — no token needed.

- **[HIGH · behavior-mismatch] connection.rpc MCP-proxy path attaches OAuth tokens with no grant or pane gate**  
  Where: `src/main/mcp-endpoint.ts:196`  
  Evidence: REST-bridge route passes writeGranted: resolveWriteAllGranted(boundPane), fail-closed for paneless callers (mcp-endpoint.ts:176-180); the MCP-proxy route (L184-219) forwards any payload verbatim with the decrypted OAuth token attached. mogging-connection.mjs:56 admits 'The MCP proxy path never reads it'.  
  Recommendation: In handleConnectionRpc, gate tools/call on the MCP-proxy path with the same resolveWriteAllGranted(boundPane) check the REST bridge uses (or require pane binding for connection.rpc), refusing writes for paneless/ungranted sessions.  
  Why: A paneless hello needs only the browser-control.json token (L412-416), so that file alone lets any same-user process issue write tools/call on every OAuth-connected service — unlike the fail-closed REST/board/brain write paths. (confidence: medium)

- **[MEDIUM · gap] browser-control.json has no pid; crash-stale file and swallowed listen error mislead**  
  Where: `src/main/mcp-endpoint.ts:596`  
  Evidence: The file is written as { version, address, token } only (L596); listen errors are swallowed (L591-593); nothing unlinks a crash-stale file before listen. The daemon endpoint carries pid+build and clients verify liveness via endpointLive (src/main/daemon-client.ts:63-66) and unlink stale files (L304-310).  
  Recommendation: Write { version, address, token, pid: process.pid } atomically (temp + renameSync), unlink any existing browser-control.json at the top of startMcpEndpoint, and log/clientLog the server 'error' event instead of an empty handler.  
  Why: After a crash the stale file survives; if the next start's listen fails, bin clients dial a dead address/old token and report 'app is not running' while it runs. No pid field means no client can ever distinguish stale from live.

- **[MEDIUM · docs-drift] 0600 mode is a no-op on Windows; pipe never SID-restricted as ADR 0006 promises**  
  Where: `src/main/mcp-endpoint.ts:596`  
  Evidence: writeFileSync mode 0o600 (L596) is ignored on Windows; ensureRuntimeDir skips chmod on win32 with no ACL equivalent (src/backend/platform/runtime-paths.ts:42-46); no security descriptor is set on the pipe (mcp-endpoint.ts:57-60). ADR 0006 promises a pipe 'restricted to the current user's SID' and 0600 files.  
  Recommendation: Tighten the runtime dir ACL on win32 inside ensureRuntimeDir (icacls owner+SYSTEM only, inheritance removed) as the Windows analogue of chmod 0700, and amend docs/06 + ADR 0006 to state the actual Windows mechanism.  
  Why: On Windows the trust-root token's protection rests solely on inherited %LOCALAPPDATA% ACLs (broken if LOCALAPPDATA points at a shared path) — silent divergence from the documented custody model and the identical-platform promise.

- **[MEDIUM · bug] stopMcpEndpoint leaves authed sockets serving; token never invalidated**  
  Where: `src/main/mcp-endpoint.ts:603`  
  Evidence: stopMcpEndpoint calls server.close() and unlinks the file (L603-615) but never destroys the sockets in authedSocks (L113) and never clears the module-level `token`; net.Server.close only stops new connections.  
  Recommendation: In stopMcpEndpoint, iterate authedSocks calling sock.destroy(), clear the set, and reset token = '' so no stale credential remains valid or in memory after teardown.  
  Why: Clients connected before stop keep full access — including connection.rpc with app-attached OAuth tokens — after the endpoint is 'stopped'. Bounded today (stop rides before-quit), but any stop/start rotation would fail to revoke sessions.

- **[MEDIUM · test-gap] No test coverage for endpoint auth handshake, rotation, or stale-file lifecycle**  
  Where: `src/main/smokes/mcp-smoke.ts:244`  
  Evidence: No file under tests/ references mcp-endpoint, browser-control, or endpoint-client (grep empty); the only custody assertion anywhere is mcp-smoke's token-hygiene grep (mcp-smoke.ts:244-260). Wrong-token refusal, double-hello, paneToken rejection, unauth idle, and crash-stale discovery are unasserted.  
  Recommendation: Add a unit test booting startMcpEndpoint against a temp runtime dir asserting: wrong token gets error+destroy, correct token gets welcome, bad paneToken refused, pre-auth non-hello frame destroyed, and stopMcpEndpoint removes the file.  
  Why: The trust-root handshake for every bin client is enforced only by code inspection; a regression (dropping the token comparison, breaking paneToken verify) would pass the entire suite.

- **[LOW · behavior-mismatch] macOS socket not chmod 0600 (daemon's is); crashed runs leak .sock files**  
  Where: `src/main/mcp-endpoint.ts:594`  
  Evidence: The daemon chmods its unix socket to 0600 after listen (src/pty-daemon/index.ts:138); the browser endpoint's listen callback (mcp-endpoint.ts:594-600) does not, and startup only unlinks the CURRENT pid's sock path (L379), so browser-<oldpid>.sock files from crashed runs accumulate forever.  
  Recommendation: chmod the socket to 0o600 in the listen callback (non-win32), and at startMcpEndpoint sweep runtimeDir for browser-*.sock entries whose embedded pid is not alive, unlinking them.  
  Why: docs/06 promises a '0600 unix socket'; the 0700 parent dir mitigates exposure, but the sibling endpoints diverge and crash residue accumulates on macOS only — a platform-parity and hygiene gap.

## Appendix — claims refuted by adversarial verification

- **control-api**: Layout verbs ride an unauthenticated deep link, not the promised authed control plane — REFUTED: Traced mogging.mjs:759-773 to deep-link.ts to controller. docs/02:54-56 and docs/08:27-29 document these verbs on the deep-link relay, so no trust-model mismatch. Guards: sanitizeControl deep-link.ts:43-81; live-pane confirm controller.ts:819-834. Residual docs/06 table gap: low.
- **browser-dock**: Materialize-on-demand with the dock closed likely never attaches (webview in display:none) — REFUTED: Reproduced in repo's Electron 39.8.10: a webview appended under display:none attaches and fires dom-ready/getWebContentsId (OOPIF webviews load like hidden iframes; premise only held pre-Electron 5), so materializeGuest resolves, not 'noview'. Only a smoke-coverage nit remains (info).
- **ipc-preload-contracts**: explorer:root lets the renderer set its own action-guard boundary — REFUTED: Mechanics right, impact false. window.ts:5-9 scopes blast radius to network/nav/window.open, not OS exec. daemon-relay.ts:379-422 terminal:spawn takes renderer-supplied cwd/run for arbitrary PTY exec on the same allowlist (preload:8), as does agents.ts:192. Zero escalation; informational at most.

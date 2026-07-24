# EDGES — step 02, the runtime & UI core

The edge-case enumeration for step 02's scope, and **a verdict for every one**.
`RUBRIC.md` fixes the enumeration at six categories, so coverage is checkable
rather than imagined:

**empty · huge · concurrent · offline/absent · malformed · cancel-mid-flight**

## How to read a verdict

| verdict | meaning |
| --- | --- |
| **F###** | a defect, routed to `FINDINGS.md`, fixed, with a regression assertion red on the pre-fix bytes. |
| **CLEAN** | already handled, and the guard is cited at `file:line`. Not "we think it's fine" — the code that makes it fine is named. |
| **OPEN** | a verified defect, not yet fixed. Named here so the count stays honest; it is NOT in `FINDINGS.md`, because filing requires the fix and its bite proof. |
| **N/A** | the edge cannot arise on this row, with the reason. |

Sourced from six parallel code audits, one per row cluster, each verdict carrying
either the guard that makes it clean or the scenario that makes it a defect.

## Scope note — tooltips are NOT in this step

The step scopes "tooltips (native-title suppression **if built**)". It is not
built, verified three ways:

- `docs/02-mvp-and-roadmap.md:262` — "Phase 11.6 — Tooltips … **Authored, not yet built**".
- No tooltip controller module exists anywhere under `src/ui/`.
- `src/ui/components/dom.ts:42` is still the native funnel — `node.title = props.title` —
  the very mechanism Phase 11.6 exists to replace.

**N/A — unbuilt**, owned by Phase 11.6, not deferred by this step.

## Fixed and bite-proven

| row | edge | verdict |
| --- | --- | --- |
| 5 · 9 · 11 | huge — a 2k-line bracketed paste | **F001** · every CR counted as a submitted command, in both write twins. Stuck `pendingSubmits` (permanent probe storm) and stuck `commandActive` (background `git` relabels the pane cwd). Unit red on pre-fix bytes. |
| 41 | malformed — an inherited provider pointer | **F002** · `GEMINI_CLI_HOME` and opencode's four reads escaped `isolatedEnv`. Now derived from the registry; two bites. |
| 16 | huge — machine budget saturated | **F003** · every cross-workspace move refused, picker all "Full". MOVEPANE red on pre-fix bytes. |
| 8 | offline/absent — the clipboard is locked | **F004** · `restore` claimed "Copied" and reordered the ring after a silent no-op. CLIPBOARD red on pre-fix bytes. |
| 89 | concurrent — a double-clicked Restart | **F015** · handed off to quitAndInstall twice against a locked exe. UPDATEOFFLINE red on pre-fix bytes. |
| 89 | offline/absent — a later check retracts a downloaded update | **F014** · a background check clobbered a `ready` update to idle. UPDATEOFFLINE red on pre-fix bytes, both pieces. |
| 27 | offline/absent — the pane's shell binary is gone | **F025** · `ensure()` spawned unguarded, so the throw unwound the socket's data pump: this chunk's remaining frames discarded, and the asking client told nothing until its own 5s timeout — over a session `ensure` had already removed. DAEMONHEAL red on pre-fix bytes (silence instead of `spawnfailed`). |
| 26 | offline/absent — a reused pid vouches for a dead socket | **F024** · off Windows, liveness reduced to `isAlive(pid)`, so a post-reboot stale endpoint was trusted and the app fell back to in-proc PERMANENTLY. DAEMONCUSTODY red on pre-fix bytes, all three corpse assertions. |
| 28 | offline/absent — a daemon wedged before welcome | **F023** · connect() leaked a socket per timeout, collecting phantom authed clients that froze retire + idle shutdown. HEARTBEAT red on pre-fix bytes. |
| 80 | huge — a screen reader in a stacked modal | **F022** · the outer modal stayed reachable beneath the top one. A11YMODAL red on pre-fix bytes. |
| 80 | huge — many stacked modals | **F021** · one Escape closed the whole stack, discarding the inner confirm's context. A11YMODAL red on pre-fix bytes. |
| 74 | concurrent — a fold animation racing a re-layout | **F020** · the budget read the animating rail width and left the browser dock overlaid after the fold settled. RESPONSIVE red on pre-fix bytes. |
| 11 | cancel-mid-flight — a workspace closed mid seam-drag | **F019** · the drag's listeners leaked, body.resizing latched forever, a leaked mouseup could re-publish slots. WSCLOSE red on pre-fix bytes. |
| 25 | offline/absent — a restored cwd no longer exists | **F018** · the launch reported success, booked the pane agent-bearing and spent its intents on a session that cd-failed. RESUME red on pre-fix bytes (missingCwdRefused). |
| 36 | concurrent — two same-tick launches for one (workspace, cli) | **F017** · the loser's rollback deleted the winner's plan file, which it pointed --mcp-config at. TOOLPLAN red on pre-fix bytes. |
| 22 | cancel-mid-flight — Undo after a workspace soft-close | **F016** · the grant was swept during the grace and Undo did not restore it (S1). WSCLOSE red on pre-fix bytes. |
| 43 | concurrent — a session-skip outliving the scope it was granted in | **F013** · a scope-blind "Don't ask again" suppressed the machine-wide permission-bypass prompt. SETAGENTCFG red on pre-fix bytes. |
| 91 | offline/absent — the settings store refused the write | **F012** · a failed update-prefs write silently reverted next launch. UPDATEFAIL red on pre-fix bytes, both directions. |
| 14 | cancel-mid-flight — undo pressed after the thing it undoes is gone | **F011** · the source workspace came back as a permanently dead zero-pane tab. MOVEPANE red on pre-fix bytes. |
| 77 | cancel-mid-flight — motion-calm is on and the animation never learns | **F010** · smooth scrolls ignored Calm motion entirely; MOTION gate extended and red on the reintroduced literal. |
| 71 | huge — a window too narrow to afford an expanded rail | **F009** · the toggle silently no-opped and persisted a preference the user never set. RAILFOLD red on pre-fix bytes. |
| 79 | concurrent — a chord fired into a surface the user cannot reach | **F008** · Ctrl+, and Ctrl+Shift+B fired through a blocking modal, one of them persisting a preference. KBGLOBAL red on pre-fix bytes, both halves. |
| 19 | offline/absent — a child vanishes under a stationary pointer | **F007** · a capture-phase `pointerleave` hid the bar until the mouse moved. APPSCROLL red on pre-fix bytes. |
| 73 | malformed — the replayed event is the wrong shape | **F006** · half the popovers never saw the chrome press. CHROMEPRESS red on pre-fix bytes. |
| 17 | cancel-mid-flight — the first half of a scroll chord | **F005** · a bare `Shift` press read as typing and yanked the reader to the bottom. PANESCROLL red on pre-fix bytes. |

## Verified CLEAN — the guard is named

| row | edge | guard |
| --- | --- | --- |
| 1 | concurrent — pane closed mid-write | all port subscriptions in one `disposers` list, detached first · `terminal-pane.ts:139` |
| 1 | malformed — OSC split across chunks | `remoteReadyProbe` retains marker-1 chars · `terminal-pane.ts:261` |
| 3 | offline — WebGL context lost | release → bounded 3 retries, forgiven on show · `pane-webgl.ts:152` |
| 3 | concurrent — dispose during async | queued job re-checks `isDisposed()` · `pane-webgl.ts:105` |
| 4 | absent — ConPTY unsupported | throws below build 18309 rather than a silent winpty · `pty-host.ts:47` |
| 5 | concurrent — pane id reused | `onData`/`onExit` identity-guarded on the pty object · `pty.service.ts:250` |
| 5 | malformed — split surrogate | `trimTornStart` cuts to a clean line start · `pane-shared.ts:23` |
| 6 | huge — block ring overflow | shifted block's decoration + both markers disposed · `block-tracker.ts:113` |
| 7 | huge — OSC flood | `MAX_OSC` → discarding, and the oversized body's BEL is swallowed so a >4KB OSC 52 cannot fake an attention bell · `osc-parser.ts:128` |
| 7 | malformed — ESC split across chunks | `pendingEsc` carries it across · `osc-parser.ts:99` |
| 10 | malformed — knotted ppid graph | visited-sets on all three tree walks · `agent-proc.ts:867` |
| 12 | empty — zero-size container | root rect expanded to the recursive minimum on both axes · `layout-tree.ts:524` |
| 12 | malformed — NaN/negative ratios | non-finite weights zeroed, equal-share fallback · `layout-tree.ts:374` |
| 12 | offline — stale pane id | `parseTree` → null, caller falls back to the template grid · `layout-tree.ts:607` |
| 15 | concurrent — grace lapse vs re-open | `switch()` calls `revivePending` first · `controller.ts:738` |
| 17 | cancel — anchor vs pane dispose | anchor disposed before `term.dispose()` · `pane-anchor.ts:227` |
| 18 | huge — 100k scrollback | O(1) rAF-coalesced; both style writes skipped when unchanged · `pane-scrollbar.ts:131` |
| 19 | empty — nothing to scroll | requires real overflow AND an auto/scroll computed style · `overlay-scroll.ts:44` |
| 20 | all six | a static `Set` built at preload init, no runtime mutation path · `preload/index.ts:8` |
| 21 | offline — corrupt sessions.db | set aside, a fresh one opened · `pty-daemon/index.ts:37` |
| 21 | malformed — partial remote row | fails closed to null, never restored as a local shell · `session-rows.ts:80` |
| 22 | malformed — corrupt settings cell | per-cell guarded parse drops the FIELD, never the row · `workspace-rows.ts:16` |
| 24 | cancel — kill mid-write | `write-file-atomic` + fsync, same-dir temp + rename · `mutation-coordinator.ts:116` |
| 25 | malformed — corrupt snapshot | parses to null → calm empty state, no boot throw · `session-restore.ts:143` |
| 26 | concurrent — two clients racing to spawn | `O_EXCL` lock picks one winner, loser exits 0 · `lifecycle.ts:51` |
| 26 | concurrent — retire-war | a mismatched daemon with other clients is NOT retired · `daemon-client.ts:272` |
| 27 | huge — 16 panes restored | per-pane fault isolation; one bad row costs one pane · `session.ts:1148` |
| 28 | offline — post-welcome wedge | heartbeat destroys its own socket → the normal reconnect road · `daemon-client.ts:462` |
| 29 | concurrent — daemon down at reconnect | each iteration re-runs full discovery · `daemon-relay.ts:262` |
| 29 | cancel — pane closed during outage | `killed` tombstone survives and is re-issued · `daemon-relay.ts:169` |
| 31 | malformed — version mismatch | rejected before connect; dir/socket/pipe are version-namespaced · `lifecycle.ts:27` |
| 32 | the wrap reaches node-pty's kill fork | verified in the vendored source AND the built bundle, not inferred · `windowsPtyAgent.js:184` |
| 71 | concurrent — fold racing a re-layout | observer early-returns on churn that did not change the fold · `app-shell.ts:112` |
| 72 | concurrent — F11 at a race | two independent detectors (class + `display-mode` media query) · `global.css:1250` |
| 75 | malformed — unknown theme id | falls through to `DEFAULT_THEME_ID` then `THEMES[0]`; never unstyled · `themes.ts:227` |
| 75 | concurrent — repeated switches | previous `prefers-color-scheme` listener removed before re-attach · `themes.ts:230` |
| 76 | offline — store unreadable | `persistencePaused` for the session, so a failed load never triggers a whole-store overwrite · `workspace/index.ts:864` |
| 77 | empty/malformed — junk in localStorage | try/catch to false; only `'1'` reads as on · `motion-port.ts:15` |
| 78 | malformed — a documented chord with no binding | all 19 catalog rows resolve to a live handler |
| 80 | empty — modal with no focusable | Tab swallowed; fallback chain to the `tabindex=-1` panel · `overlay-trap.ts:62` |
| 86 | cancel — dismiss during a refresh | `isDismissed()` re-checked after the await · `firstrun.ts:191` |
| 87 | huge — toast storm | past `MAX_STACK` they QUEUE (cap 20) rather than being evicted pre-paint · `toast.ts:59` |
| 89 | offline — missing update feed | **verified still fixed**: `checkForUpdates()` has ONE call site, wrapped in `.catch()`; all five roads funnel through it · `updater.ts:41` |

**No defect found on any of the six edges:** rows 6, 12, 13, 31, 32, 72, 75, 76, 78.

## N/A

| row | edge | why |
| --- | --- | --- |
| 4 | huge · concurrent · cancel | a single synchronous call; the emulation descriptor is returned from the same expression that configured the pty, so it cannot be stale |
| 7 | concurrent | a per-pane accumulator with no timers or handles — nothing to race |

## OPEN — verified defects, not yet fixed

Each is verified against the code with a concrete failure scenario. None is in
`FINDINGS.md`: filing requires the fix **and** its bite proof, and inventing a
`defer` for them is exactly what `RUBRIC.md` forbids. This list is the honest
remainder of step 02.

**S1** — none. Both former entries are now filed and bite-proven: the unguarded
`SessionManager.ensure()` spawn is **F025**, and the POSIX pid-reuse corpse is **F024**. The
corpse fix had in fact been WRITTEN with its DAEMONCUSTODY act already in place and was never
routed to `FINDINGS.md` — work done but unbanked, which reads identically to work not done. The
ledger, not the diff, is what makes a row derive A.

**S2**

Two entries stood here that were already closed and never struck: the scope-blind
`rememberKey` (**F013**) and `undoMovePane`'s dead rail tab (**F011**). A stale OPEN list
overstates the remainder as surely as a missing finding understates it.

- `applyResolvedLayout` commits `paneCount` before an apply that can refuse, stranding a
  manifest that cannot be restored · `controller.ts:1155`.
  ATTEMPTED and REVERTED. The fix (commit only when `apply()` did not return false) and a
  MOVEPANE phase were written, and the phase's own assertion PASSED
  (`refusedKeepsCountHonest:true`, cap 3 vs a requested 24). But the two extra workspaces it
  opened starved MOVEPANE's deliberately-tiny 8-pane machine budget, which the F003 and F011
  phases depend on saturating exactly — `movedAway` went false and an ALREADY-PROVEN phase
  broke. Both were reverted: protecting banked proofs outranks adding an unproven one. The
  lesson for the next attempt: this assertion needs its own fixture, not MOVEPANE's, because
  that gate's budget is a shared, exactly-sized resource.



- **PERCEPTION — PASS.**
- **MILESTONE — FAIL, and NOT this diff.** The only failing metric is the 16-pane stress worst
  frame gap: **208.4 ms** against a 150 ms budget. Everything else is comfortable (avgFps 134,
  idle gap 7.1 ms, heap 57 MB, 16/16 WebGL, attention 4/4).
- **Stash-probed rather than argued.** Stashing every change and re-running at HEAD gives
  **229.2 ms** — WORSE than with the diff. So the gap is this machine's load, not the change;
  the band matches the 187–229 ms machine-load signature already recorded for this box, which
  passes under CI's soft-GPU profile.

This is why the house rule is stash-probe before blaming the diff: on the numbers alone the
change "caused" a 208 ms red, and reverting good fixes to chase it would have been the wrong
call in both directions.

## Rows whose `corr` lens now derives A

35 of the 59 rows in step 02's scope. A row is swept only when the audit walked all six edges
AND it carries no open finding — the grade is computed by LAUNCHAUDIT from `FINDINGS.md`, never
typed here.

**Swept:** 5 · 6 · 9 · 12 · 13 · 14 · 15 · 17 · 18 · 19 · 20 · 21 · 30 · 31 · 32 · 41 · 42 ·
44 · 71 · 72 · 73 · 75 · 76 · 77 · 78 · 79 · 81 · 82 · 83 · 84 · 85 · 86 · 87 · 90 · 92

**Deliberately NOT swept** — each still carries an open finding, and sweeping it would make
LAUNCHAUDIT report A for a surface known to be broken, which is the self-grading failure the
rubric exists to prevent: 1 · 11 · 16 · 22 · 23 · 24 · 25 · 26 · 27 · 28 · 43 · 74 · 80 ·
88 · 89 · 91.

## Perf re-measure (F019 touched the renderer)

- PERCEPTION — PASS.
- MILESTONE — FAIL at 187.4ms stress gap, ATTRIBUTED to machine load by stash-probe: HEAD is
  1007ms this run (far worse), and F019's diff runs only in `dispose()`, never in the 16-pane
  render/stress path, so it cannot move the budget. The machine is heavily loaded after a long
  gate session; the band matches the recorded 187-229ms signature that passes CI soft-GPU.

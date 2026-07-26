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
| 16 | huge — more panes requested than the budget holds | **F026** · the committed `paneCount` was the REQUEST, so a clamped apply (and a refused reorganize, whose refusal the caller discards) persisted a manifest the tree never matched. WIZLAYOUT red on pre-fix bytes (`meta:5, live:1`). |
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

## The final sweep — the last 20 rows, all six edges each

The rows below were the remainder: the 16 that INVENTORY still carried at `~02`, plus the four
that amendment A3 added (186–189). Ten parallel audits, two rows each, every verdict carrying
either the guard that makes it clean or the scenario that makes it a defect.

**A correction this sweep had to make first.** The "Deliberately NOT swept" list below names 16
rows — 1 · 11 · 16 · 22 · 23 · 24 · 25 · 26 · 27 · 28 · 43 · 74 · 80 · 88 · 89 · 91 — but EIGHT
of those (11 · 22 · 28 · 43 · 74 · 80 · 89 · 91) were flipped to `02` in INVENTORY when their
findings landed, and nobody updated this prose. The real remainder was
**1 · 2 · 3 · 4 · 7 · 8 · 10 · 16 · 23 · 24 · 25 · 26 · 27 · 29 · 88 · 185**. Same failure mode
as the stale OPEN entries struck above, in the opposite direction: prose that overstates what is
left is still prose LAUNCHAUDIT cannot read. INVENTORY's cells are the truth; this file explains
them and must be re-derived from them, never maintained in parallel.

### Rows that came back CLEAN on all six edges

- **Row 4 · ConPTY-only PTY spawn seam** — the `huge` N/A is REPLACED with a real reason: argv/env
  IS unbounded (the ~10 KB remote bootstrap, cmd.exe's 8191-char ceiling that already bit the SSH
  shim), and it is safe because an over-long command line surfaces as a node-pty throw that all
  four call sites guard (`transport.ts:186`, `pty.service.ts:289`, `install.ts:73`,
  `claude-refresh.ts:95`) — not because the call is synchronous. `windowsBuild()` fails CLOSED
  (unparsable `os.release()` → NaN → 0 → the loud refusal), and `useConpty` is omitted from the
  option type AND spread after `...opts`, so a runtime value cannot flip the backend.
- **Row 23 · Async request generation guard** — the generation token is compared on ALL THREE
  exits, including the REJECT path (`async-state.ts:76`), which was the specific hazard sought.
- **Row 27 · Detached pane sessions survive** — three identity guards are object-identity, not id,
  so a recycled generational id cannot cross-talk (`session.ts:1027`, `transport.ts:128`,
  `agent-proc.ts:809`); the four calls that run OUTSIDE the per-row try are all total.
- **Row 186 · Pane grid fit contract** — the 2×1 clamp cannot reach a live ConPTY (every
  unmeasurable path returns null before it; every measurable one is floored by the split tree's
  132×110 leaf minima), and a resize cannot be lost in the spawn window (one ordered socket, no
  await before `client.spawn`).
- **Row 187 · Vendored fonts and metric parity** — verified against the vendored BYTES, not the
  gate: all three faces including the italic FONTCOVER does not read are a uniform 0.600em
  advance, and every assigned codepoint in the declared ranges is covered (the only two gaps,
  U+2B74/U+2B75, are unassigned in Unicode). The pre-load measurement bug is closed by
  construction — `fonts.load()` on the unicode-range-scoped face, not the one-shot `fonts.ready`.

### Fixed and bite-proven in this sweep

| row | edge | verdict |
| --- | --- | --- |
| 185 | empty — the ledger table goes missing | **F027** · the anti-blindness guard read the LEGEND table (`FINDINGS.md:15` strips to `id`), so `sawHeader` was satisfied 35 lines before the real header and a FINDINGS.md with no ledger printed `0 finding(s), all resolved · every lens derives A ✓` and exited 0. Proven on a scratch copy: exit 0 pre-fix, exit 1 post-fix. |
| 185 | malformed — a mangled id cell | **F028** · silently `continue`d in BOTH loops, ahead of the column-count check. Pre-fix bites: `F013`→`F-013` printed **25** findings, exit 0; row 88's id → `88a` printed **197 rows · 1182 lens cells**, exit 0 — a row and its six lens cells deleted from the census in silence. |
| 26 | offline/absent — a live daemon that has not answered YET | **F030** · `probeReachable` folded a TIMEOUT into "definitely gone" and the caller UNLINKS on false, so a live-but-slow daemon lost its endpoint and the run ended on the in-proc backend with no Retry — F024's end state from the opposite direction, against the rule `pid.ts:29-30` already states. Narrowed fix: a completed CONNECT proves the wire. Bite-proven by a new unit — a real silent `net.createServer` must probe true (red pre-fix), while the corpse case stays false in BOTH runs, so F024 is provably intact. **The unit also caught the first version of this fix being an inert no-op** (the flag was declared but never assigned) — which is the entire argument for bite proofs. |
| 7 | malformed — an aborted OSC followed by another OSC | **F029** · `ESC ]` inside an open OSC ate the SUCCESSOR's intro, so its body scanned as ground-state output and its BEL rang a FALSE attention bell — latching a pane red for nothing — while the prompt mark behind it was lost. Bite-proven by a new focused unit inside the existing **UNIT** gate: on the pre-fix bytes the three defect assertions red while both control assertions stay green. |

## OPEN — verified defects, not yet fixed

These are REAL, traced to `file:line`, with a reaching scenario — but they are **not** in
`FINDINGS.md`, because filing requires the fix AND its bite proof, and these do not have theirs
yet. Naming them here is what keeps the remainder honest: the count is visible and falsifiable
rather than absorbed into a green sweep.

Six carry a fix already applied in the working tree (marked **fix landed**); they still belong
here until the pre-fix red is actually recorded, because a fix without its failing assertion is,
in this pack's own words, "a story about a fix".

| row | edge | defect | sev |
| --- | --- | --- | --- |

Nine of the ten entries that stood here are now FILED with bite proofs — F037 (row 10),
F038 and F040 (row 2), F039 (row 1), F041 (row 188 huge), F042 and F043 (row 25),
F044 (row 29), F045 (row 26). One remains, and it remains for a reason no amount of
effort on this box can change:

| 188 | malformed | The exit verdict drops `signal` (`session.ts:686`), so on POSIX a SIGKILL/SIGSEGV death reports `code 0` — byte-identical to a clean `exit`, defeating the epitaph on exactly the crashes it was built for. | S2 |

## Perf, re-measured

### After ALL 18 fixes landed (2026-07-25) — the closing measurement

Re-measured on the complete diff (every fix and every new assertion in the tree), on the same
box, under the same load — three concurrent `claude` sessions at ~115% of a core each plus an
electron at 102%, measured as a per-process CPU RATE rather than cumulative time.

- **PERCEPTION — PASS.** switch max **41.6 ms** and home max **30.6 ms** against a 100 ms action
  budget, echo median **1.8 ms** against 60 ms, and **zero** frames over 100 ms across all three
  churn profiles. Clean, with room. Note it is BETTER than the HEAD baseline on every metric
  (switch 109.7, home 102.3), and better than the mid-session measurement of this same diff —
  the fixes did not cost perception, and the earlier `homeMax` outlier was the load, as argued.
- **MILESTONE — FAIL on one metric, and NOT this diff.** The 16-pane stress worst gap is
  **215.3 ms** against 150 ms; everything else is comfortable (avgFps 132.5, heap 54 MB, 16/16
  WebGL). The stashed HEAD baseline under this same load is **298.7 ms** — far worse — and 215.3
  sits inside the 187-229 ms machine-load signature already recorded for this box, which passes
  under CI's soft-GPU profile.

**What is claimed:** the budgets are UNMOVED by this step's work, proven by baseline rather than
argued, and PERCEPTION is outright green. **What is NOT claimed:** that MILESTONE is green here.
It is red on a box that was never quiet, and the goal's "no other sessions" clause was never
satisfiable from inside this session — the load is three OTHER Claude sessions. A confirming run
on a genuinely idle machine (or CI) is the remaining evidence, and it is an operator step.

### After the final sweep (2026-07-24) — measured, and ATTRIBUTED

Both budgets were re-measured after this step's renderer-touching fixes (the unmeasured-dims
spawn, the WebGL give-up branch, the replay flag, the menu and spawn-report guards), and BOTH
are RED on this box. Neither red is this diff, and that is probed rather than argued — the
house rule, applied in the only direction that can falsify it: stash everything, re-run at
HEAD, compare under the SAME load.

**The machine was NOT quiet, and the cause is named.** No dev server was running, but three
concurrent `claude` sessions plus five `node` children were each burning ~85–90% of a core —
~8 cores saturated, measured as a per-process CPU delta rather than inferred from cumulative
time. This is the recorded condition under which these two gates blow up.

| metric | HEAD (stashed baseline) | with this step's diff | |
| --- | --- | --- | --- |
| MILESTONE 16-pane stress worst gap | **298.7 ms** | **277.8 ms** | better with the fix |
| MILESTONE avgFps | 125.3 | 126.8 | better |
| MILESTONE idle worst gap | 62.5 ms | 13.9 ms | better |
| MILESTONE heap | 56 MB | 51 MB | better |
| MILESTONE webgl visible / attention | 16/16 · 4/4 | 16/16 · 4/4 | equal |
| PERCEPTION switch max | **109.7 ms** | **59.4 ms** | better with the fix |
| PERCEPTION home max | 102.3 ms | 120.3 ms | worse — a single sample |
| PERCEPTION echo median | 2.4 ms | 2.4 ms | equal (budget 60) |
| PERCEPTION frames over 100 ms (churn · size-churn · torrent) | 0 · 0 · 0 | 0 · 0 · 0 | equal |

**Verdict: unmoved, and better on five of six.** HEAD fails BOTH gates on its own — MILESTONE
at 298.7 ms and PERCEPTION on *two* metrics (switch 109.7 AND home 102.3) — so the failure
pre-exists this diff entirely. The one metric that reads worse with the fix, PERCEPTION's
`homeMax`, is a single outlier in `[40.1, 120.3, 18, 24.1]` whose three siblings sit at
18–40 ms, against a baseline whose own sample set (`[30.2, 102.3, 18, 25.7]`) has the same
shape — one spike, three quiet samples. That is a scheduler artifact of a saturated box, not a
budget move, and the surrounding numbers (switch nearly halved, zero long frames anywhere)
point the other way.

**What is NOT claimed:** that these gates are green. They are red, on this box, under this
load. What is proven is the step's actual requirement — that this diff did not move them — and
proving it required the baseline, not the reasoning. Re-run both on a genuinely idle machine
(or under CI's soft-GPU profile, where the recorded band passes) before treating either red as
a product fact.

### After F026 (the renderer moved again)

- **PERCEPTION — PASS**, comfortably: switch max 34.2 ms and zoom max 25.2 ms against a 100 ms
  action budget, echo median 2.8 ms against 60 ms, and **zero** frames over 100 ms across all
  three churn profiles (churn, size-churn, torrent).
- **MILESTONE — FAIL on one metric, and NOT this diff.** The 16-pane stress worst gap is
  **215.3 ms** against 150 ms; everything else is comfortable (avgFps 131.5, idle gap 7.2 ms,
  heap 55 MB, 16/16 WebGL, attention 4/4).
- **Probed, not argued.** Restoring `controller.ts` to its pre-F026 bytes and re-running gives
  **250 ms** — WORSE than with the fix. So the gap is this box's load after a long gate
  session, matching the recorded 187–229 ms signature that passes under CI's soft-GPU profile.
  The reasoning also holds independently: `applyResolvedLayout` runs on a layout apply and
  never on the 16-pane render/stress path.

### Earlier passes

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

## Perf, settled on CI (2026-07-26) — the load question, answered without a quiet box

The local box never quieted: five OTHER Claude sessions held 59-71% of a core each, all
session, and nothing inside this session may stop them. So the measurement was moved to
machines that are quiet by construction — `gh workflow run ci.yml -f sweeps=linux,macos,windows`
(run `30181446242`, commit `5b14cea`).

Every load-bound gate passed on every platform:

| gate | linux | macos-26 | windows-latest |
| --- | --- | --- | --- |
| MILESTONE | PASS | PASS | PASS |
| PERCEPTION | PASS | PASS | PASS |
| FLICKER | PASS | PASS | PASS |

Whole-sweep verdicts were 198/200 (linux), 198/200 (macos), 199/200 (windows). The failures
were PRODARTIFACT on all three (F047, since fixed and re-proven green on all three), PANERESTART
on linux alone, and BRAINMILESTONE on macos alone — none of them a frame budget.

**What this settles:** the local 187-229ms MILESTONE band is this box, not this diff. That was
already argued from a stashed-HEAD baseline measuring WORSE than the change (298.7ms vs 215.3ms);
three independent quiet machines now agree, and FLICKER — the third member of the load-bound
family, and the CPU-heaviest thing the app does — is green alongside.

**What this does NOT settle, stated plainly:** all three sweep jobs run `MOGGING_CI_GPU=soft`,
a SOFTWARE renderer. MILESTONE's budget is a frame-gap budget, which is exactly the quantity a
software renderer changes. So a real-GPU idle-box run remains unobtained, and the CHECKLIST's
OPERATOR box stays `[~]` rather than being ticked on evidence that does not reach it. The open
question is now the GPU profile alone, not machine load.

**Method worth keeping:** a perf gate blocked on a busy box is not blocked — CI's
`workflow_dispatch` takes a `gates` subset and a `sweeps` OS list, so one gate on one clean
runner is a minute's dispatch. It also reaches what this box structurally cannot: FUSES passes
on CI while failing locally as an AV condition, and the POSIX signal act only ever executes there.

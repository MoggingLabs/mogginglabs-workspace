# Layout slot choice, pane placement, and foreground liveness (2026-08-03/04)

Findings from two working sessions on the layout stack, recorded here because
`findings-ledger.md` is the only place a finding can be watched as it ages. These did not
come from the two audit passes; they came from a redesign of the "New terminal…" surface
and from following two user-reported symptoms down to their causes.

The ledger's `session/` rows cite this document. Every `fixed` row names **the guard that
closed it**, which is the ledger's own rule for that status.

---

## SLOT SELECTION

**[CRITICAL · bug · confirmed] `templateLocals` took a free slot-numbering hole ahead of a live slot, killing a running agent**
Surface: layout-slot-selection — `src/ui/features/layout/grid-layout.ts:360`
Evidence: the chooser walked slot numbers ascending accepting `live || free` and stopped at
`count`. Close pane 3 of 5 — `removeLeaf` does not renumber and `serializeTree` deliberately
preserves ids (`layout-tree.ts:535-553`), so the gap outlives a restart — then reorganize at
the SAME count of 4: it returned `[1,2,3]+[4]`, dropping live slot 5. `rebuild` republished
without it, `publishSlots` → `terminal/index.ts:31` disposed the pane and killed its PTY.
The doc comments at `grid-layout.ts:353-358`, `:384-392` and `controller.ts:1455-1457` all
claimed "live panes reused first"; the code never did.
Recommendation: extract the rule to a pure module; take ALL live slots first.
Guard: `src/ui/features/layout/slot-selection.ts` (`selectLayoutSlots`), 19 assertions in
`tests/unit/slot-selection.test.ts`, and WIZARDISO phase (d), which closes a middle pane and
asserts NEGATIVELY that an equal-count reorganize shows no confirm and kills nothing.

**[HIGH · bug · confirmed] The pane cap could evict live panes**
Surface: layout-slot-selection — `src/ui/features/layout/grid-layout.ts:361`
Evidence: `templateLocals` clamped `count` to `this.limit()`, and `limit()` charges the
machine budget for panes in OTHER workspaces (`grid-layout.ts:281-284` →
`pane-capacity.ts:132-159`). On a small machine with other workspaces open it can fall below
this workspace's own live count — so every apply evicted, and a same-count reorganize was
refused with no message at all.
Recommendation: the ceiling governs GROWTH, never eviction.
Guard: `selectLayoutSlots`'s `Math.max(live.length, limit)` ceiling, plus "the cap bounds
growth, never the panes that already exist" in `tests/unit/slot-selection.test.ts`.

**[HIGH · bug · confirmed] Reading order and slot order diverge, so the painter labelled locked tiles with the wrong terminals**
Surface: pane-placement — `src/ui/features/workspace/controller.ts:1718`
Evidence: `livePaneTiles` read `view.layout.paneIds()`, whose doc claimed "IN THE ORDER
`templateLocals` will hand them back". It is not: `paneIds()` → `liveLocals()` → `leafIds()`
is a depth-first tree walk (`layout-tree.ts:124`), while `templateLocals` orders by rects.
Split right, then split the left pane down: the tree walks `1,3,2` and the screen reads
`1,2,3`. Every locked tile in a nested layout wore another terminal's name.
Recommendation: add a reading-order accessor and use it wherever the order is meant to match
what the user sees.
Guard: `GridLayout.liveOrder()`; `tests/unit/layout-slot-choice.test.ts` proves the two
orders genuinely diverge on a real `computeLayout` before asserting the fix; WIZARDISO's
READING ORDER phase builds a nested fixture in the live app and compares `liveOrder()`
against the on-screen rects.

**[MEDIUM · bug · confirmed] The confirm dialog named one slot set and the apply could use another**
Surface: layout-slot-selection — `src/ui/features/workspace/controller.ts:1417`
Evidence: `peekTemplate` ran before `await confirmDialog(...)`, `applyResolvedLayout` read it
again, and `templateLocals` ran a third time inside `apply`/`applyRegions`. Each read
`liveLocals()`, `leafRects` and `limit()` live. During the await a ResizeObserver can
reorder rects, a pane can open or close, `limit()` can drop, and — via the control-API
`open` verb or a soft-close grace lapsing — the ACTIVE WORKSPACE can change.
Recommendation: resolve once at the door, carry it as a value, and refuse visibly if it no
longer holds.
Guard: `ResolvedSet` + `checkResolvedSet` in `slot-selection.ts`; `tests/unit/
slot-selection.test.ts` covers pane-closed, pane-OPENED, id-taken, foreign and re-homed;
`workspace-slots.test.ts` asserts every door resolves before its first yield, exactly once.

**[MEDIUM · bug · confirmed] The manifest recorded the requested pane count, not the landed one**
Surface: layout-slot-selection — `src/ui/features/workspace/controller.ts:1353`
Evidence: `a.meta.paneCount = count` after an apply that may have built a shorter grid (the
slot-id space can run out). `parseTree` rejects on `ids.length !== expectedCount`, so the
next restore threw the whole arrangement away and fell back to a template.
Guard: `a.meta.paneCount = a.layout.paneCount`, pinned in `tests/unit/workspace-slots.test.ts`.

---

## PLACEMENT SURFACE

**[MEDIUM · bug · confirmed] `--wz-ctl` was scoped to `.wizard`, so every borrowed control elsewhere collapsed**
Surface: pane-placement — `src/ui/styles/global.css:4440`
Evidence: the token was declared only on `.wizard`. The New-terminals modal renders
`.wizard-chip`, `.wizard-select > select`, `.wizard-custom-input` and `.wizard-agent-row
.stepper` outside `#view-wizard`, so every `height: var(--wz-ctl)` was invalid at
computed-value time and fell back to `auto` — the ragged chip row in the user's screenshot.
Guard: hoisted to the `:root` token block; `tests/unit/new-terminals.test.ts` asserts it is
in `:root` and no longer scoped.

**[LOW · bug · confirmed] `.ntm-slot` read a border-radius token that has never existed**
Surface: pane-placement — `src/ui/styles/global.css:2201`
Evidence: `border-radius: var(--r-2)`. `--r-2` appears nowhere else in the repo; the
declaration was invalid at computed-value time, so every slot tile rendered as a hard square
beside a palette of pills.
Guard: the rule was deleted with the strip it belonged to; `new-terminals.test.ts` asserts
no rule READS `var(--r-2)` and that the defined radius stops all still exist.

---

## LIVENESS

**[HIGH · gap · confirmed] Destructive confirms could not see a plain foreground process**
Surface: pane-liveness — `src/ui/features/workspace/controller.ts:149`
Evidence: `inspectLive` counted an agent session or `busy`/`attention`. A pane running `vim`
in a plain shell is DOUBLY blocked from ever reaching either: `ActivityTracker.shellCmdStart`
refuses to author a never-spoken pane's first verdict (`activity.ts:396-403`), and
`setPaneState`'s tracked gate drops untracked panes entirely (`attention-port.ts:78-83`). So
shrinking a layout, or closing a pane or workspace, destroyed unsaved work with no warning
and no way for any predicate change to notice. The truth existed —
`AgentProcessDetector.foreground` → `DetectedProcessContext` (`agent-proc.ts:71-78`), already
documented as proving "a foreground descendant of the pane shell owns this process context"
— but died in the backend as a cwd-precedence input, and its only IPC derivative
(`CwdEvent.source === 'process'`) is lossy in the wrong direction.
Recommendation: a dedicated event and port, never routed through the attention port — that
one drops untracked panes and lights dots, and a red dot for `vim` is the cross-surface lie
ALERTAGREE forbids.
Guard: `PaneForegroundEvent` (daemon protocol **v12**), `src/ui/core/terminal/
foreground-port.ts`, `src/ui/features/workspace/live-panes.ts` (22 assertions in
`tests/unit/live-panes.test.ts`, including both copy contracts the smokes pin), and WSCLOSE
arm 0a, which types a real command into a real PTY and asserts the dialog reads
"This pane is still running ping." — no agent, no session, no attention state.

**[LOW · bug · confirmed] Two spawn-run command starts published nothing**
Surface: pane-liveness — `src/pty-daemon/session.ts:752`, `:790`
Evidence: `this.cwdState.acceptCommandStart()` bare, unlike `:1063` which wraps it in
`publishCwd`. A spawn-run and a deferred launch therefore armed the command-in-flight state
without announcing it — a pre-existing cwd blind spot, and a liveness one once the
foreground signal rode the same publish.
Guard: both wrapped; CWD (daemon) and TYPEDCOST cover the publish path.

---

## PALETTE

**[MEDIUM · bug · confirmed] `Layout: N panes` bypassed the plan cap and offered itself off-grid**
Surface: panes-layout — `src/ui/features/workspace/index.ts:800`
Evidence: this is the existing ledger row `panes-layout/F2`, re-confirmed at HEAD.
`requestApplyTemplate` never clamped to `effectiveMaxPanes` and never called
`refusePaneCap`; `templateLocals` clamps only to `limit()` (capacity), not the entitlement.
Separately, the `layout:${n}` rows alone carried no `enabled` predicate — unlike every
sibling — so they read as runnable on Home, where the verb silently returns false.
Recommendation: gate both doors, floored at the current pane count (rearranging what exists
allocates nothing), and REFUSE rather than clamp — a template is a whole-grid request behind
a row that says "16 panes".
Guard: the cap gate in `requestApplyTemplate` and `requestReorganize`, `layoutCeiling()`
behind the rows' `enabled`, source assertions in `tests/unit/layout-slot-choice.test.ts`,
and CHROMEUX's `l-pane-floor`, which now drives the palette ROW (previously only the verb)
and proves it reaches the grid.

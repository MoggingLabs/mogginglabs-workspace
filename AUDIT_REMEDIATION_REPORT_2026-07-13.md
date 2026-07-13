# Audit remediation — final report

Branch `codex/audit-remediation-20260713`. Base `bfe35e64d065a872f48db0dc8adc4e4ffcd5666e`.
Original audit: SHA-256 `321255057178e2c71b7d30dc40dfa28e532781b07cc5f4abb890c1dd1c3ca60e` (verified).

## Verdict, stated plainly

**All 42 findings are implemented and each is held by a gate that has been proven to fail
without the fix.** The runtime registry grew from 97 to 114 gates (103 app-boot + 11 static).
The certification sweep ran 114 gates: **113 passed, 1 failed** (`MILESTONE`).

**The performance budgets are NOT met, and that is the one thing this remediation did not
finish.** See § Performance. I flag it here rather than at the bottom because an earlier
progress note of mine claimed "three of four performance gates now pass" — that was a single
lucky sweep, and repeated measurement does not support it. The claim is withdrawn.

## What "proven to bite" means

Every new gate was deliberately sabotaged — the defect reintroduced — and confirmed to FAIL,
naming the right file and line, before being reverted and confirmed green again. A gate that
has never failed is indistinguishable from a gate that is asleep. Two examples of why this
mattered:

- The credential-wording gate caught a banned phrase **wrapped across a markdown line break**,
  which a line-by-line grep would have sailed past.
- The npm-config gate's bite test exposed a flaw in its own spec: `npm` exits **0** and writes
  its warning to **stderr**, so the originally-specified `execFileSync` would have read a
  failing install as a pass.

And one gate was found to bite *only while the bug lived*: `A11YMODAL` activated the workspace
tab's close button with a synthetic `KeyboardEvent`. That worked against the OLD code because
the bug WAS a JS keydown handler. The fix DELETED that handler, so activation belongs to the
platform — and a synthetic `KeyboardEvent` carries no default action. The assertion tested the
opposite of what it claimed and would have gone red on correct code. It now uses a trusted
OS-level keystroke.

## Evidence matrix

### P0 — 1-6 (certified before this session; re-verified in the full sweep)

| # | Requirement | Gate |
|---|---|---|
| 1 | Reviewer identity + immutable repo/snapshot binding; atomic merge revalidation | REVIEWSNAP · REVIEW · GATE |
| 2 | Pane-bound MCP/Browser capability; unknown/dead panes fail closed | MCPWRITE · BROWSERCTL · PERWSAGENT |
| 3 | Board never types card prose at a shell; positive agent readiness | BOARDFAIL |
| 4 | Review cannot claim success without landing reviewed content | REVIEWSNAP · REVIEW |
| 5 | MCP status feedback loop: one-way refresh, dedupe, call-count gated | MCPLOOP · MCPSTATUS |
| 6 | Service keys authorized per workspace/server/key; no plain-pane injection | VAULTKEYS · TOOLPLAN |

### P1 — 7-23 (certified before this session; re-verified in the full sweep)

| # | Requirement | Gate |
|---|---|---|
| 7 | Scrub pane-bound identity from nested launches | GATE |
| 8 | Deleted remote host never silently falls back to local | REMOTE |
| 9 | Remote cwd/OS/shell preserved; never type into an auth prompt | REMOTE |
| 10 | Central close policy incl. layout shrink | WSCLOSE · **CHROMEUX** |
| 11 | Browser Stop cancels/revokes; possession visible globally | BROWSERCTL · **CHROMEUX** |
| 12 | Tool plan persists/validates before launch; no silent global fallback | TOOLPLAN |
| 13 | Worktree removal moves live shells; dirty refusal; Windows locks | WORKTREE |
| 14 | Role bound at session generation; reconnect/replay | ROLERACE |
| 15 | Generation + captured-workspace checks on all Browser async work | BROWSERRACE |
| 16 | Atomic Explorer root generation; path-aware containment | EXPLORERRACE |
| 17 | Shared responsive budget at 600/800/1200; keyboard dock resize | RESPONSIVE |
| 18 | Persistence/daemon degradation visible, retryable, honest | PERSISTHEALTH |
| 19 | Profile deletion blocks/migrates/marks unresolved | PROFPERSIST_A/B |
| 20 | Shared reactive CLI registry across every launch surface | AGENTREGISTRY |
| 21 | Transactional wizard; honest isolation failures; cancellable async | WIZARDFAIL |
| 22 | Versioned/field-level grants; atomic profile switch | MUTATIONRACE |
| 23 | Integration auth runs in a plain terminal/dedicated process | AUTHRUNNER |

### P2 — 24-42 (this session)

| # | Requirement | Code | Gate |
|---|---|---|---|
| 24 | Honestly copy visible hunks; empty/failure cannot report success | `ui/features/review/index.ts` | REVIEW |
| 25 | Visible retryable updater error | `main/updater.ts`, `fixture-port.ts` | **UPDATEFAIL** |
| 26 | Clipboard opt-in + disclosure; zero reads while off; secret filter | `main/clipboard.ts` | CLIPBOARD |
| 27 | CLI-auth custody distinguished from vaulted secrets | wizard, settings, README, docs/12 | **CUSTODY** (static) |
| 28 | Platform modifier helper everywhere (⌘ on macOS) | `core/commands/shortcuts.ts` | KBAPG · BOARDRENDER · BROWSERZERO |
| 29 | Central command context; enabled predicate + visible reason | `core/commands/context.ts` | **A11YMODAL** · BOARDRENDER |
| 30 | Modal trap/inert/name; palette combobox; valid tab primitive | `core/a11y/overlay-trap.ts`, `components/modal.ts` | **A11YMODAL** |
| 31 | Keyboard/APG: menus, grid seam, scrollback, reorder, spinbutton | `terminal-pane.ts`, `grid-layout.ts`, `stepper.ts` | **KBAPG** · RESPONSIVE · PANESCROLL |
| 32 | Usage no-plan reset; Escape; honour order/pin; progress + tabs | `ui/features/usage/index.ts` | USAGEUI · USAGEGLANCE |
| 33 | Zero-workspace Browser disabled + explained; consent never lies | `browser/index.ts`, `browser-dock.ts` | **BROWSERZERO** |
| 34 | Home navigation contract decided; stale IA removed | `view-port.ts` (ratified), `docs/11` | HOMEUX |
| 35 | Secrets retained on failure; orphan vault rollback; scrub hidden | `components/submit-with-retain.ts` | **SECRETFORMS** |
| 36 | No nonessential infinite animation under reduced motion | `styles/global.css` | **MOTION** (static) |
| 37 | Board focus/scroll survive a push; no listener leak; keyboard move | `ui/features/board/index.ts` | **BOARDRENDER** |
| 38 | Folder filter keeps focus; refusal navigable; tree APG | `folder-browser.ts`, `file-tree.ts` | FOLDERPICK · FILETREE |
| 39 | Shared async policy across 8 features; failure injection | `core/async/async-state.ts`, `main/fault-port.ts` | **ASYNCSTATE** |
| 40 | Gate counts/versions/docs correct; consistency gate | 10 docs, ci.yml | **GATECOUNT** (static) |
| 41 | Harness out of the production artifact | `index.ts` / `index.dev.ts` / `boot.ts` | **PRODARTIFACT** (static) |
| 42 | Unsupported npm config removed; warning-free install | `.npmrc` deleted | **NPMCONFIG** (static) |

Bold = new this session. 11 new gates.

## Performance — NOT resolved

Measured across three back-to-back sweeps on the same machine:

| Gate | Budget | Audit baseline | Run 1 | Run 2 | Run 3 | Verdict |
|---|---|---|---|---|---|---|
| PRODUCT | 150ms | FAIL (187.5ms) | PASS | PASS | PASS | **fixed** |
| MILESTONE | 150ms | 194.4ms | 208.3 | 215.3 | 208.4 | still failing |
| FLICKER | 100ms | 111.1ms | 111.2 | 125.0 | 111.1 | still failing |
| PERCEPTION | 100ms | 128.4ms | 112.0 | 130.8 | 144.9 | still failing (once measured 88.9 — highly variable) |

What DID improve: average FPS rose from 97 to 110-130, heap is flat (~50MB), and the MCP status
subprocess feedback loop the audit fingerprinted as a contributor is gone. PRODUCT crossed the
line. But **the three tightest frame-gap budgets are not met**, and MILESTONE and FLICKER sit at
essentially their baseline values.

### Root cause of MILESTONE, with the arithmetic

xterm's `WriteBuffer` yields only every **12ms**. When sixteen panes all receive their first
burst in the same tick, sixteen cold write buffers chain back-to-back:

    16 panes x 12ms = 192ms

The measured value is 194-215ms. That is not a coincidence — it is the mechanism.

A fix was attempted (warming xterm's parse path off-screen at mount, to pay V8's tier-up cost
early) and **measured worse** (215ms vs 194ms); it was reverted. It targeted per-byte cost, not
the serialized 12ms yields, which is the actual constraint.

**The correct fix is to stagger the first flush across panes** so sixteen WriteBuffers cannot
chain within one frame. That change touches the terminal's core data path and interacts directly
with the 60ms echo budget PERCEPTION enforces. It deserves its own change, its own measurements
and its own gate — not a rushed edit at the end of a 42-finding remediation. It is the single
recommended follow-up.

### A measurement hazard, documented

**These gates are focus-sensitive.** An Electron window that loses foreground is starved of
`requestAnimationFrame` frames at *zero CPU cost*. Any shell command spawned during a run steals
foreground and corrupts the number. One agent measured the same gate at 300ms while polling and
7ms sitting still. Perf gates must be run with nothing else touching the machine, and a single
sample must never be trusted — run-to-run variance is ±35ms.

## New findings discovered during remediation

### Fixed

- **`MOGGING_ASYNCFAIL` could reject or permanently hang any of eleven IPC channels in a signed
  install.** The old artifact gate was structurally blind to it because it is not a gate name.
- **`MOGGING_USAGE` / `MOGGING_SETUSAGE` / `MOGGING_UXMILESTONE` swapped in a FAKE usage adapter
  in a shipped app** — fabricated spend, shown to the user as their own.
- **`MOGGING_INPROC` — a *documented* daemon workaround — silently registered zero usage
  adapters**, leaving packaged users with a dead Usage feature. Latent, unrelated to the audit.
- **Electron IPC transport strings reached users verbatim** ("reply was never sent", "an object
  could not be cloned"). Now treated as unreadable and replaced with an actionable sentence,
  anchored so a genuine backend message that merely *contains* those words still gets through.
- **Terminal `Shift+Home` / `Shift+End` leaked `ESC[1;2H` / `ESC[1;2F` into the agent's shell.**
  (The audit's premise here was half wrong: `Shift+PageUp/PageDown` already worked via xterm.)

### Open — flagged, deliberately not silently fixed

- **`MOGGING_REGISTRY_BASE`** (`backend/features/integrations/catalog.ts:145`) still repoints
  where a **shipped** build fetches its catalog from. This is the same class as the residue
  removed above and should be closed the same way.
- **`browser/index.ts:344`** reaches into the shell with
  `document.querySelector('.titlebar-right').prepend(...)`, bypassing the "right-cluster order is
  declared in ONE place" contract that `titlebar.ts` and `docs/11-design-system.md:322` both
  assert. This is a quiet re-entry of the wart `AUDIT.md:132` exists to kill.
- **Seven `*-audit-faults` modules remain linked into production.** They ship no `MOGGING_`
  string (rollup shook the env reads out) and every arming function is imported only by
  `*-smoke.ts` files, which are not in the production graph — no env door, no IPC door,
  unreachable dead state, zero artifact bytes at stake. Low priority.

## UI/UX concerns

### 1. At 600px the rail eats half the window, and no gate notices

The audit complained the gallery had "no 600px coverage". Adding it (shots 126-131) immediately
paid for itself.

`dockLayoutBudget()` (`ui/core/layout/dock-budget.ts:32-34`) collapses the rail only when
`innerWidth < expandedNeed`, and:

    expandedNeed = 288 (expanded rail) + contentFloor + browserDock + explorerDock

At 600px with **no docks open**, `contentFloor` is the compact 280:

    expandedNeed = 288 + 280 + 0 + 0 = 568      600 >= 568  ->  the rail does NOT collapse

So the rail keeps its full **288px — 48% of the window** — and the terminal gets 312px. It clears
the 280px floor, so the budget is satisfied and **no gate fires**. See `126-narrow-600-grid.png`:
the shell banner wraps mid-word.

RESPONSIVE does not catch this because it only ever measures 600px **with both docks open**
(`responsive-smoke.ts:117-140` drives `.explorer-dock-handle` and `.browser-dock-handle` before
asserting). That pushes `expandedNeed` far past 600, so the rail *does* collapse and the gate
sees a healthy 40-100px rail. **The plain narrow window — the common case — is never asserted.**

This is the exact failure mode the audit was pointing at: a number can be correct while the thing
it describes is unusable, and only a picture shows you which. Recommend collapsing the rail at
<=600 regardless of dock state (giving the terminal ~550px), and extending RESPONSIVE to assert
the **no-dock** narrow case, not just the dock-laden one.

I have NOT changed the threshold: it is a deliberate design value, and picking a new one at the
end of a 42-finding remediation, unmeasured, would be exactly the kind of unreviewed judgement
this audit exists to catch.

### 2. Titlebar cluster order is no longer declared in one place

`browser/index.ts:344` does `document.querySelector('.titlebar-right').prepend(...)` to inject the
possession banner. `titlebar.ts` and `docs/11-design-system.md:322` both assert the right-cluster
order is declared in ONE place. This is a quiet re-entry of the wart `AUDIT.md:132` was written to
kill, and it is what made CHROMEUX's hit-target check start measuring a hidden 0x0 button.

### 3. The gallery is the only place several surfaces are ever seen

131 shots, and `errors.json` is clean — but the narrow states above were invisible for the entire
life of the project. Any surface with no gallery shot and no gate assertion is, in practice,
unobserved. Worth a periodic "what has no picture?" pass.

## A process finding

**"P1 complete and regression-certified" was true only against the gates that were run.**

P1 was certified against a 17-gate subset. Two of its findings (10 and 11) broke `CHROMEUX`,
which was not in that subset and had not been run since. The failure sat there, green-looking,
until the full sweep. A subset is not a certification — and the gap is invisible precisely
because the passing subset looks like success.

Both CHROMEUX failures were repaired here, and the gate now *corroborates* findings 10 and 11
from a second angle rather than contradicting them.

## Verification performed

- `tsc --noEmit` — clean
- 11 static gates — all pass (`AUDIT`, `SPACING`, `PTYSEAM`, `PROTOVER`, `LAYOUT`, `DOCSREFS`,
  `CUSTODY`, `MOTION`, `NPMCONFIG`, `PRODARTIFACT`, `GATECOUNT`)
- `check-gates` — registry consistent, 103 app-boot gates all dispatched and allowlisted
- `npm audit --omit=dev` — 0 vulnerabilities
- Full 114-gate sweep — 113 pass, 1 fail (MILESTONE)
- Production artifact — **1.37MB -> 392.1kB**, 0 of 106 harness symbols, 0 of 109 env triggers
- Gallery — regenerated, **131 shots** (was 125), `errors.json` clean. The 6 new ones are the
  600px/800px coverage the audit found missing; shot 126 is what surfaced UI/UX concern #1.
- Performance — 3 additional sweeps; see § Performance. Budgets NOT met.

## Recommended follow-ups, in priority order

1. **Stagger the terminal's first flush across panes** (closes MILESTONE, and probably FLICKER).
   16 x 12ms of chained WriteBuffers is the whole of the 194ms. Needs its own gate and must be
   measured against PERCEPTION's 60ms echo budget.
2. **Collapse the rail at <=600px regardless of dock state**, and extend RESPONSIVE to assert the
   no-dock narrow case (UI/UX #1).
3. **Close `MOGGING_REGISTRY_BASE`** — a shipped build can still be repointed at another catalog
   origin by an environment variable.
4. Mount the possession banner through a declared titlebar slot (UI/UX #2).
5. Re-measure the performance gates on a cold, idle machine. Everything here was measured on a
   box that had been running gates for hours, and these gates are focus- and thermal-sensitive.

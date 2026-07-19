# Phase 11 — Files: the sidebar that watches your agents work

Sequenced task prompts for Phase 11 of **MoggingLabs Workspace**: sixteen
agents can be writing into a workspace at once, and the app shows their
OUTPUT (terminals, blocks, attention) but not their FOOTPRINT — today the
only file surfaces are the wizard's dirs-only folder browser, a boolean
dirty chip, and the worktree diff modal. This pack adds the **file
explorer**: a right-side sidebar with the workspace's folder open in a
pretty, virtualized, git-decorated tree that updates live as agents write —
toggled from the FAR RIGHT of the app bar (`panel-right`, mirroring the
rail's `panel-left` at the far left). References, each taken for its best
organ (sourced receipts: `RESEARCH.md`): BridgeSpace's file sidebar (the
competitor surface, answered with custody + receipts), VS Code's
virtualized list-wearing-a-tree + decoration provider + watcher tiers, the
tmux-sidebar virtues (one-key toggle, remembered width, never steals
focus), and the orchestrators' changed-files convergence (Nimbalyst,
Manaflow), folded in as the Changes lens. Same format as
`prompts/phase-1..9/` (each step self-contained + pasteable as a `/goal`,
**≤ 3950 chars**). Execute in order; independent of the
authored-and-holding phase-9.

> **The custody stance (codified as ADR 0010 in step 01, binding on every
> step)**: the explorer is a WINDOW, not a manager. v1 is read-only —
> browse, open, reveal, copy, send-to-pane; no create/rename/delete/move,
> no in-app editor (deferred, not refused — recorded in the ADR). Opening
> delegates to the OS and the user's own tools: ADR 0002's neutrality
> extended to files — we organize, we never replace their editor. Nothing
> is indexed, nothing is walked recursively; names are read one level at a
> time, on demand; paths never enter telemetry (ADR 0005).

> **The tree doctrine**: ONE virtualized flat list wearing tree semantics —
> the VS Code lineage (RESEARCH §2) re-implemented clean-room in vanilla TS
> on the Phase-5 tokens and house components (ADR 0004: zero new runtime
> deps — no tree lib, no watcher lib, no icon pack; glyphs live in
> `icons.ts`). Because rows virtualize, tree ARIA is non-negotiable:
> `role=tree`/`treeitem`, `aria-expanded`, and
> `aria-level`/`aria-setsize`/`aria-posinset` on every row, roving
> tabindex. Filenames are untrusted content — `textContent` only,
> everywhere.

> **The liveness law: watch what's visible, nothing else.** One
> non-recursive `fs.watch` (node built-in) per EXPANDED directory,
> coalesced into batched refreshes (RESEARCH §6), pool capped with LRU
> eviction, jittered-poll fallback when a watcher refuses (network drives,
> EMFILE), everything suspended while the window is hidden or the explorer
> closed. The docs/05 rationale that rejected recursive watchers (the
> node_modules trap) stays law.

> **Numbering deconfliction**: phase-9 (authored, holding) reserves
> `docs/15-loops.md` + ADR 0009 — both stay untouched. This pack takes
> `docs/16-files.md` + ADR **0010** and seven new gates (sweep **76 → 83**
> as of authoring, 2026-07-10 — steps say "grows by one" so the pack
> survives other work landing first). Nothing here touches the daemon:
> protocol stays **v5** and `PROTOVER` keeps proving it.

> **Ground truth**: the browser dock is the layout precedent — an `<aside>`
> flex sibling of `#content` (`browser/index.ts:178`) with its own
> pointer-capture width handle (:314-331) and KV persistence
> (`browser.open` / `browser.width` via `SettingsStore.getSetting`,
> `settings-store.ts:187`). The titlebar is a 3-column grid whose right
> cluster appends `(left, right, board, settings)` (`titlebar.ts:92`)
> under a blanket `#titlebar button { -webkit-app-region: no-drag }` rule
> (`global.css` ~1000) — 03 adds a `titlebarEnd` slot AFTER Settings.
> `fs:listDir` is one-level dirs-only BY CONTRACT ("Files are never
> listed", `fs.ipc.ts`) — the explorer gets its own files-bearing verbs
> and FOLDERPICK keeps passing untouched. `git/probe.ts` already runs
> `status --porcelain=v2` every 2.5s per tracked cwd and DISCARDS the file
> lines — 05 parses what we already pay for. Budgets are the veto: 16
> panes, worst gap ≤ 150ms, heap ≤ 300MB (docs/05); workspace switch
> ≤ 100ms, 0 frames > 100ms under torrent (docs/07). Free shortcut:
> `Ctrl+Shift+E` (taken: B rail · U browser · D split · G board · C/V
> clipboard).

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-list-service.md` | ADR 0010 + the explorer contract slice (files+dirs listing, typed refusals, caps, watch verbs defined) + backend service; FSLIST green, zero UI |
| 02 | `02-file-tree-component.md` | The virtualized tree component — lazy children, APG keyboard, tree ARIA, indent guides, type-ahead; FILETREE green on a 10k-row fixture |
| 03 | `03-explorer-dock-and-toggle.md` | The right-side dock + FAR-RIGHT titlebar toggle + `Ctrl+Shift+E` + palette verb + width/open persistence + per-workspace re-rooting; EXPLORER green |
| 04 | `04-liveness.md` | The liveness law implemented — per-expanded-dir watchers, coalesced batches, capped pool + LRU, poll fallback, suspend rules; TREELIVE green |
| 05 | `05-git-decorations.md` | Per-file M/A/U/D/C badges riding the EXISTING GitMonitor tick, color-only folder propagation, check-ignore dimming, the Changes lens; TREEGIT green |
| 06 | `06-file-actions.md` | Open/reveal (first `shell.openPath` in the app — injectable + smoke-spied), copy path(s), send-to-pane (quoted, never Enter-terminated), drag, the house context menu; FILEACT green |
| 07 | `07-files-milestone.md` | docs/16-files.md + gallery completeness + FILESMILESTONE end-to-end + full 3-OS sweep at 83 gates; pack freeze |

## Overall Definition of Done
- One click or `Ctrl+Shift+E` on the FAR-RIGHT titlebar button opens a
  right-side explorer with the active workspace's folder open; switching
  workspaces re-roots it (remembered expansion) within the 100ms
  perception budget; a workspace without a folder gets an EmptyState,
  never a crash.
- It is PRETTY: tokens only, both themes, AA-measured badges and inks,
  indent guides, house glyphs, gallery states staged — a surface that
  would grade A in the 8.5 audit language.
- It is LIVE: an agent writing files into an expanded dir appears within
  ~1s as ONE coalesced update; a closed explorer costs zero — no watchers,
  no listings, no git traffic beyond what shipped before this pack.
- It answers "what did my agents touch": M/A/U/D/C badges, folder color
  propagation, ignored dimming, and the Changes lens with a live count.
- Read-only custody holds by construction: no write verb exists on any
  explorer channel; open/reveal delegate to the OS; send-to-pane types,
  the user executes.
- Both perf budgets unchanged (MILESTONE + PERCEPTION re-measured with the
  explorer OPEN among 16 panes); every pre-existing gate untouched and
  green; the seven new gates green on local Windows + all three CI OSes.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; static gates green
  (AUDIT · SPACING `--max 0` · PTYSEAM · PROTOVER).
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation;
  MILESTONE + PERCEPTION re-run after any renderer-touching step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **Read-only, by contract** — explorer channels expose
  list/watch/open/reveal only; a write verb is a review rejection, not a
  config option.
- **Zero new runtime deps** — no tree, watcher, or icon libraries;
  RESEARCH informs, house code ships (the 8.5 design-source rule).
- **Tokens only**; AA measured for every new ink/fill pair, both themes.
- **Never steal focus** — opening, closing, refreshing, or live-updating
  the explorer never moves focus out of a pane (tmux-sidebar's virtue,
  smoke-asserted). Attention is sacred: no explorer update may clear or
  mask a pane's attention state.
- **Paths are user content** (ADR 0005): never in telemetry — counts and
  booleans only; gallery fixtures keep usernames out of visible crumbs.
- **Budgets are the veto** — a prettier tree that costs frame time loses.
- Existing gates stay untouched: FOLDERPICK's dirs-only contract, the
  dock possession guard, the CHROMEUX ladder, protocol v5.

## Parallelization
01 → 02 → 03 is the spine. After 03, two lanes: Lane A (04 → 05, the live
+ decorated tree), Lane B (06, actions). 07 needs both lanes. Solo
execution runs 01 → 07 in order (house rule: no parallel agents).

## Freeze — Phase-11/07 (2026-07-12)

Every step shipped with its gate green, and `MOGGING_FILESMILESTONE` — the pack's
**only authority on "Phase 11 done"** — composes the whole promise in one fixture
world: a **real shell pane** writes into the workspace, and the explorer shows it,
decorated, live, and actionable. Receipts, measured numbers, and platform finds:
[`REPORT.md`](REPORT.md). The book: [`docs/16-files.md`](../../docs/16-files.md).

| Step | Gate | Done |
|---|---|---|
| 01 — ADR 0010 + contracts + the read service | FSLIST | ✅ |
| 02 — the virtualized tree | FILETREE | ✅ |
| 03 — the dock + the far-right toggle | EXPLORER | ✅ |
| 04 — the liveness law | TREELIVE | ✅ |
| 05 — git decorations + the Changes lens | TREEGIT | ✅ |
| 06 — actions + the house context menu | FILEACT | ✅ |
| 07 — the book, the gallery, the milestone | FILESMILESTONE | ✅ |

**The freeze gates (measured, not asserted):**

- **The composed surface holds both budgets.** 16 panes + the explorer OPEN + a
  write torrent: **142.8 avg fps** (≥30) · **worst gap 25.1ms** (≤150) · **heap
  20MB** (≤300) · **0 frames > 100ms**. Workspace switch with the explorer open:
  **50ms** (≤100).
- **An agent's footprint appears within a second.** A scripted shell pane created a
  file (**185ms**) and deleted one (**177ms**), in **2** coalesced batches.
- **Zero costs zero.** A collapsed dir: **0 batches** from 20 writes. A hidden
  window: **0 handles, 0 polls**. A closed explorer: **0 handles, 0 polls, 0 git
  events**. A non-repo workspace: **0 git traffic**.
- **Attention is sacred.** A pane that needed input at the start still needed it at
  the end of the whole composed run.
- **ADR 0005 sweep**: exactly ONE telemetry call in the entire Phase-11 surface, and
  its props are `{ open }` — a boolean. No path, no filename, anywhere.
- **ADR 0010 sweep**: twelve explorer channels, **zero write verbs**, and **zero
  mutating fs APIs** reachable from the explorer's backend or main. Read-only holds
  *by construction*, not by vigilance. Protocol still **v5**.
- **Nothing executes.** After typing eight hostile filenames (`$(rm -rf).txt`,
  `&echo pwned&.txt`, …) into a live shell, the pane still showed **one prompt**.

**Certification — PENDING the operator.** Two things are deliberately not done here:

1. The **full uncut local sweep** (182 gates). House rule: Claude runs targeted gate
   subsets, never the full sweep — that run is the operator's. All seven new gates
   are green, as is every gate they could plausibly disturb (REPORT.md §5).
2. The **three-OS CI dispatch**, which needs a push. `ci.yml` requires **no edit**:
   its sweep jobs take a `MOGGING_GATES` input where empty = *all* gates, so the
   seven new `qa-smokes.sh` rows are swept automatically.

Until both land, the certification row below stays honest rather than decorative.

| Environment | Sweep | Result |
|---|---|---|
| local Windows (targeted) | the 7 new gates + every gate they touch | ✅ green |
| local Windows (full, 182 gates) | — | **PENDING** (operator) |
| CI linux · macOS · windows | — | **PENDING** (operator dispatch) |

# Phase 11 research — where each organ of the explorer comes from

Research run 2026-07-10 (web, sourced; verbatim quotes marked). This file is
the receipts behind the pack's design decisions. Confidence notes inline —
vendor marketing is labeled as such. bridgemind.ai serves HTTP 403 to
non-browser fetchers, so its quotes came via search snippets of the named
pages: high-fidelity, not eyeball-verified against the rendered site.

## 1. BridgeSpace (BridgeMind) — the competitor surface to answer

- Our own dossier already names the surface: BridgeSpace ships "integrated
  code editor + file tree; Git sidebar with status/diff/commit/worktree"
  (`docs/03-research-synthesis.md` §1), and our side has carried "integrated
  editor + file tree" as an unbuilt Phase-4 differentiator ever since
  (docs/03 §"Phase 4 — Differentiators").
- Product page, MARKETING (bridgemind.ai/products/bridgespace): "BridgeSpace
  puts your terminals, code editor, file browser, and AI agent task board in
  one native desktop app — so you can orchestrate agents, manage projects,
  and ship without switching contexts." And the money quote for THIS pack:
  "A file tree, an editor, and an embedded browser live beside the grid.
  Read the diff, open localhost, and review what your agents shipped — the
  loop closes in the same window."
- Docs, MARKETING (docs.bridgemind.ai/docs/bridgespace): "The file sidebar
  provides a full tree view of your project directory with expand/collapse,
  file icons, and drag-and-drop support."
- Changelog, MARKETING (bridgemind.ai/changelog): "The sidebar gains Git
  status, diff, branch, commit, and worktree flows so builders can manage
  repository changes without leaving BridgeSpace."
- **What could NOT be verified:** which side the sidebar sits on, what it
  actually looks like, virtualization/perf, gitignore awareness, icon
  licensing — no screenshots retrievable, pages 403. → We answer the
  surface itself: same promise, read-only custody (ADR 0010), stated
  budgets, receipts.

## 2. VS Code Explorer — the mechanics gold standard

- **A virtualized list wearing a tree costume.** The "Lists And Trees" wiki
  (github.com/microsoft/vscode/wiki/Lists-And-Trees): "It can render a
  collection of elements in a scrollable view, while making sure only the
  visible elements actually end up in the DOM at any given point in time." /
  "At its core, the List is a virtual rendering engine." / "You can easily
  add 100k elements to it without breaking a sweat." / "By leveraging the
  virtual rendering functionalities of the list we can use composition to
  create a tree widget." Perf receipt: 20k problems across 10k files,
  Collapse All 30,000ms → 625ms (48×). Widget source:
  `src/vs/base/browser/ui/tree/` (indexTree → objectTree → asyncDataTree;
  `compressedObjectTreeModel.ts` is compact-folders at the model layer).
  Rolled out to the File Explorer in v1.31 with type-ahead keyboard modes.
  → 11/02 is this shape, clean-room: flat visible-rows array + tree ARIA.
- **Indent guides** are a setting family, not decoration:
  `workbench.tree.renderIndentGuides` (`onHover` default | `always`),
  `workbench.tree.indent`, themable `tree.indentGuidesStroke` (v1.36).
- **Icons are THEMES, and the licensing catch is real.** The built-in Seti
  icon theme "uses the icons from seti-ui" — a third-party MIT project;
  codicons are dual-licensed: "Creative Commons Attribution 4.0" for the
  icon content + MIT for the code. VS Code's icon art is not ours to lift.
  → house glyphs only (`icons.ts`), no icon-pack dependency.
- **Git decorations** (v1.18 release notes): "we added support to the File
  Explorer to show modified, added, conflicting, and ignored files in a
  different color and with a badge", with split toggles
  `explorer.decorations.colors` / `explorer.decorations.badges`. The badge
  letters M/U/A/D/C/R are community-documented rather than
  release-note-enumerated (confidence: high, secondary-sourced). Parent
  propagation is a public API flag — `FileDecoration.propagate`: "A flag
  expressing that this decoration should be propagated to its parents" —
  and folders pick up the COLOR, not the letter. → 11/05 copies exactly
  that split: letter + color on files, color-only on ancestors.
- **Click model** (user-interface docs): "When you single-click or select a
  file in the Explorer view, it is shown in a preview mode and reuses an
  existing tab" / "use double-click to open the file … a new tab is
  dedicated". We ship no editor (ADR 0010), so the mapping is: single-click
  selects, Enter/double-click opens EXTERNALLY.
- **Auto-reveal** has had an off switch since 2016 (`explorer.autoReveal`)
  — reveal-jumping annoys people. → our "you are here" tint (11/03)
  highlights, never scrolls, never expands.
- **.gitignore awareness**: `explorer.excludeGitIgnore` (v1.68), off by
  default, "negated globs such as `!package.json` are not parseable", and
  it stops at the first .gitignore (microsoft/vscode#189951). → we never
  parse .gitignore ourselves: `git check-ignore --stdin` batches, cached
  (11/05).
- **`explorer.compactFolders`** (v1.41, default on) — single-child chains
  render as `a/b/c`. Deliberately DEFERRED in ADR 0010 (recorded, not
  refused): it complicates every keyboard/ARIA/decoration path for a
  payoff our shallow-to-medium workspace trees rarely see.
- **File watching, the architecture worth copying** ("File Watcher
  Internals" wiki): "recursive: `ParcelWatcher` via `parcel-watcher`" /
  "non-recursive: `NodeJSWatcherLibrary` via `fs.watch`" / suspended paths
  fall back to "a polling watcher on the path (`fs.watchFile`) with a delay
  of `5s`". Even VS Code hedges the native dep: "event correlation is
  disabled again for TS extension given instability in parcel watcher"
  (Sept 2024). → our liveness law needs only their NON-recursive tier:
  `fs.watch` per expanded dir + poll fallback, zero new deps (11/04).

## 3. cmux ×2 / Manaflow — what terminal-first products chose

- The name covers two products under the manaflow-ai org (the rename
  itself: UNVERIFIED verbatim). Current **cmux** (cmux.com): "Free and open
  source native macOS terminal built on Ghostty"; its sidebar is SESSION
  metadata — "Vertical tabs: sidebar shows git branch, working directory,
  ports, and notification text"; "Notification rings: panes light up when
  agents need attention". **No file tree, no explorer panel anywhere** in
  the README or the site.
- **Manaflow** (the orchestrator formerly published as cmux): "Every run
  spins up an isolated VS Code workspace … with the git diff view,
  terminal, and dev server preview ready" — its file surface is literally
  an embedded VS Code per task.
- Signal: the terminal-first product chose session metadata; the
  review-first product outsourced files to a whole IDE. Nobody in this pair
  hand-built a lean tree beside terminals — the exact gap 11 fills.

## 4. The tmux world — the virtues to keep

- tmux itself: "tmux is a terminal multiplexer. It lets you switch easily
  between several programs in one terminal…" (tmux wiki) — no file features
  in its self-description; an explorer is always bolted on.
- **tmux-sidebar** (tmux-plugins) is a design spec in four quotes: it "does
  one thing: it opens a tree directory listing for the current path";
  "smart sizing — Sidebar remembers its size, so the next time you open it,
  it will have the exact same width"; "toggling — The same key binding
  opens and closes the sidebar"; and it "does not move cursor to it".
- ranger ("console file manager with VI key bindings"), yazi ("terminal
  file manager written in Rust, based on non-blocking async I/O" — "All I/O
  operations are asynchronous"), and nvim-tree round out the family.
- → codified in this pack: one-key toggle (`Ctrl+Shift+E`), remembered
  width (KV), NEVER steals focus from a pane (smoke-asserted, 11/03),
  async listing everywhere.

## 5. Agent orchestrators — the changed-files convergence

- **Nimbalyst** (ex-Crystal, stravu — the repo says Crystal "is now
  Nimbalyst", Feb 2026): "Every AI edit is surfaced as a diff you can
  inspect and approve before it lands in your file." / "See the files
  modified in a session. Open them. Manage git state." — a per-session
  CHANGED-FILES list, not a project tree.
- **Conductor** (conductor.build): "Run parallel coding agents on your Mac"
  — the review surface is change/diff-centric; no tree named (UNVERIFIED
  beyond the homepage). **Sculptor** (imbue.com): syncs the agent's work to
  YOUR repo so your own IDE browses it ("keeping your files and git state
  synced so you can collaborate directly from your IDE") — delegation as a
  feature. **Terragon**: branch/PR flow; since wound down.
- Pattern: among orchestrators the winning file surface is "what changed",
  not "everything". → the **Changes lens** (11/05): the same tree,
  filtered to the git status list, count-badged — full tree AND
  changed-files in one widget, which none of them ship together.

## 6. Implementation receipts — watching, coalescing, ARIA

- **@parcel/watcher** (github.com/parcel-bundler/watcher): "Events are
  throttled and coalesced for performance during large changes like git
  checkout or npm install, and a single notification will be emitted with
  all of the events at the end." That sentence is 11/04's batching spec —
  re-implemented over per-dir `fs.watch`, no native dep. (chokidar v4 for
  contrast: dependency count "from 13 to 1", "removes support for globs".)
- **WAI-ARIA APG treeview** (w3.org/WAI/ARIA/apg/patterns/treeview): "All
  tree nodes are contained in or owned by an element with role tree." /
  "Each element serving as a tree node has role treeitem." / aria-expanded
  false/true per state; and the clause that binds US specifically:
  aria-level, aria-setsize, aria-posinset are required when the full set is
  NOT in the DOM — i.e. mandatory once virtualized. Arrows: "Right arrow:
  When focus is on a closed node, opens the node; focus does not move." /
  "Left arrow: When focus is on an open node, closes the node."
- **Roving tabindex** (APG keyboard practices): "The tab sequence should
  include only one focusable element of a composite UI component." — one
  `tabindex="0"` row, the rest `-1`, moved on arrows.
- **Virtualization thresholds are folklore** — no authoritative N exists.
  The honest rule: node_modules alone is tens of thousands of entries, so
  the tree virtualizes from day one, as VS Code's does.

## 7. What we ship that none of them do

1. **A live window on AGENT writes**: the tree updates as sixteen agents
   write (coalesced batches under the liveness law), badges ride the git
   tick the app already pays for, and the Changes lens answers "what did
   they touch" — no rival pairs a real tree with agent-fleet liveness.
2. **Neutral custody**: read-only, opens YOUR editor and YOUR file manager
   (ADR 0002's neutrality extended to files by ADR 0010) — not half an
   IDE, no lock-in.
3. **Liveness with zero new deps under stated budgets**: watch-what's-
   visible `fs.watch` + coalescing + poll fallback, smoke-proven against
   the docs/05 and docs/07 numbers. Competitors state no budget at all.
4. **Receipts**: an ADR stance, AA-measured decorations in both themes,
   gallery states, seven gates in a three-OS sweep. BridgeSpace's tree is
   a changelog sentence; ours is a certified surface.

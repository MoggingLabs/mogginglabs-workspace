# ADR 0010 — The explorer is a window, not a manager

- **Status:** accepted (Phase 11/01, 2026-07-11)
- **Extends:** ADR 0002 (never broker provider auth — neutrality, here extended
  to files) · ADR 0004 (layered feature-sliced architecture; zero new runtime
  deps) · ADR 0005 (observability: counts and booleans only)
- **Sources:** `prompts/phase-11/RESEARCH.md` (sourced receipts),
  `docs/03-research-synthesis.md` (the wedge + the unbuilt differentiator),
  `docs/05-performance.md` (the budgets and the node_modules trap),
  `docs/09-swarm.md` (humans own the review gate)

## Context

Phase 11 adds the file explorer: sixteen agents can be writing into a
workspace at once, and the app shows their OUTPUT (terminals, blocks,
attention) but not their FOOTPRINT. The obvious build — and the competitor's
(BridgeSpace ships "integrated code editor + file tree") — is half an IDE:
a tree that also creates, renames, deletes, moves, and edits. That build
attacks both of the product's load-bearing assets at once: rendering
reliability (a file manager's write paths demand undo, conflict handling
against sixteen concurrent writers, and trash semantics — none of which
serve the watching job) and the hardened, neutral posture (ADR 0002: the
user's tools are theirs; we broker nothing and replace nothing). This ADR
fixes the explorer's custody stance before any UI exists, so every later
step (tree, dock, liveness, decorations, actions) inherits it by
construction rather than by review vigilance.

## Decision

**(a) v1 is read-only: browse, open, reveal, copy, send-to-pane.**
Create/rename/delete/move and an in-app editor are **DEFERRED with
rationale, not refused**: the wedge is *watching agents work*, and every
user of this app already owns an editor and a file manager they trust. A
write surface is a different product organ — it needs undo, deletion
custody (trash vs unlink), and a concurrency story against a fleet of
writing agents — and it earns its own ADR the day the watching job proves
insufficient. Deferred means recorded and re-openable; the deferred list
is at the end of this document.

**(b) Opening delegates to the OS and the user's own tools.** ADR 0002's
neutrality extended to files: "open" hands the path to the OS default app,
"reveal" to the OS file manager, "send-to-pane" types a quoted path into
the user's own shell and never presses Enter. We organize their view of
the files; we never interpose on how they act on them. No in-app viewer,
no in-app editor, no "lite" preview that grows into one.

**(c) Reads are one level, on demand.** `explorer:list` returns the names
of ONE directory; expanding a folder asks again. Nothing is indexed,
nothing is walked recursively, no background crawl "warms" anything —
`node_modules` alone is tens of thousands of entries, and the docs/05
budgets are the veto. This is the same scope sentence `fs:listDir` already
lives by; the explorer's verbs add files to the listing, not depth.

**(d) The liveness law: watch what's visible, nothing else.** One
non-recursive `fs.watch` per EXPANDED directory, coalesced into batched
`explorer:changed` events, pool capped with LRU eviction, jittered-poll
fallback when a watcher refuses, everything suspended while the window is
hidden or the explorer closed. A closed explorer costs zero. Step 11/04
implements this; 11/01 defines the watch verbs in the contract now so no
later step invents a wider surface to fit under.

**(e) Paths never reach telemetry.** ADR 0005 applied verbatim: a path is
user content. Explorer telemetry, if any, is counts and booleans —
never a name, a path, or a fragment of either.

**(f) Zero new runtime dependencies.** No tree library, no watcher
library, no icon pack (VS Code's icon art is licensed third-party content,
not ours to lift — RESEARCH §2). House code on the Phase-5 tokens;
`fs.watch` is the only watching primitive.

### Explicitly forbidden

A reviewer rejects these on sight; none is a config option:

- **Recursive watchers** — no `fs.watch(..., { recursive: true })`, no
  native recursive-watcher dependency. The liveness law (d) is the whole
  watching surface.
- **Any write verb on explorer channels** — no channel whose handler can
  reach a mutating fs API. Read-only by construction: the verb does not
  exist to typecheck against.
- **Compact folder chains** (`a/b/c` single-child rendering) — deferred,
  not planned (RESEARCH §2): it complicates every keyboard, ARIA, and
  decoration path for a payoff our shallow-to-medium workspace trees
  rarely see.

## Research lineage

Each organ is taken from the reference that does it best
(`prompts/phase-11/RESEARCH.md`, sourced): BridgeSpace names the
competitor surface — a file tree beside terminals — which we answer with
read-only custody and receipts instead of half an IDE (§1); VS Code
supplies the mechanics gold standard — the virtualized list wearing a tree
costume, decoration split, and the NON-recursive tier of its watcher
architecture — re-implemented clean-room with zero new deps (§2, §6);
tmux-sidebar contributes the virtues (one-key toggle, remembered width,
never steals focus) (§4); and the agent orchestrators' convergence on
"what changed, not everything" becomes the Changes lens riding git state
we already pay for (§5). The terminal-first products ship no tree at all
and the review-first ones embed a whole IDE (§3) — the lean, live,
read-only tree between those poles is the gap this phase fills (§7).

## Consequences

- Later steps inherit the stance structurally: the tree (11/02) renders
  what `explorer:list` returns; liveness (11/04) implements (d) against
  the verbs 11/01 froze; actions (11/06) are delegation verbs only.
- `fs:listDir` stays dirs-only BY CONTRACT ("Files are never listed" — it
  picks a working folder); the explorer gets its own files-bearing verbs.
  Shared path canonicalization is extracted, not forked, so the two
  listings can never drift apart on what a path means.
- We forgo file-management feature parity with IDE-shaped competitors.
  The bet: users keep their editor and file manager; what they lack is a
  live window on what their agents touched.
- The daemon is untouched: every explorer verb is app-side (protocol
  stays v5).

### Deferred (recorded, re-openable — each behind its own future ADR)

- **Write verbs**: create / rename / delete / move.
- **An in-app editor** (or any file-content viewer that would grow into one).
- **Compact folder chains** (`explorer.compactFolders`-style rendering).

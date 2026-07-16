# 18 — The Board (v2): per-project kanban that launches, coordinates, and pulls

Phase-3/05 shipped the board as one app-global surface whose cards launch
agents. Board v2 keeps that whole loop (docs/08) and rebuilds the model around
three ideas: **boards are keyed by project**, **main is the one writer**, and
**agents get full, guarded control**. Card text remains USER CONTENT — local db
only, never telemetry/notify/logs (ADR 0005), with ADR 0015's one explicit,
twice-confirmed exception (push-to-GitHub).

## Boards are projects

One board per **project** — the repo root for a git checkout, the folder
otherwise — created automatically the first time anything resolves it. The
load-bearing case: a **linked worktree resolves to its parent repo**, so every
`.mogging/worktrees/<slug>` agent workspace shares its project's board. Two
workspaces on one repo: one board. No workspace at all: the **Unfiled** board,
so the surface works before a project is open. Identity comparison is
case-folded on Windows; the stored key keeps its real casing (it is also the
directory the queue launches into and `gh` runs against).

The board view follows the ACTIVE workspace; the head's name is a switcher to
every other board. Pre-v2 cards migrate on first touch — to their launch
workspace's project board, or to Unfiled when the workspace is gone. Nothing is
deleted.

## Main is the one writer (why agents can't trample anyone)

Every mutation — the UI's, an agent's, a rule's, the queue's — lands in the main
process as a **field-level patch**, serialized by construction (better-sqlite3
is synchronous). Every card carries a `revision`; a write may carry
`expectedRevision`, and a stale one is refused with reason `conflict` **and the
fresh card in the reply** — a concurrent edit is never silently lost. The UI
always sends it; agents may omit and take field-level last-write-wins. Every
accepted write broadcasts `board:changed`, so the open board repaints whoever
wrote. Every write lands in the card's **activity log** (who/what/when — human,
`pane N`, `queue`, `sync`; local, capped, deleted with its card).

**The claim rule:** `paneId` is the ONE working-pane concept — set by a launch
or an agent's `claim_card`, cleared when the pane dies or on `release_card`. An
agent's write to a card worked by ANOTHER live pane refuses with the owner named
(`comment_card` stays free — coordination is never blocked). Humans are never
claim-blocked. A dead pane's claim never blocks anyone.

## What agents can do (docs/14's grant, widened)

Reads (always, pane-scoped to the caller's project board): `list_board`
(board meta + live cards), `get_card` (one card + activity tail). Writes
(behind the SAME per-workspace grant, default `none`): `create_card`,
`update_card` (title/notes/column/priority/labels/blocked + reorder + optional
CAS), `claim_card` / `release_card`, `comment_card`, `archive_card`. There is
deliberately **no delete tool**: agents archive; deleting is a human verb. Every
write receipts onto the target pane and the per-workspace trail, attributably.

## Flow practice (what the lanes now say)

Five lanes: **Backlog → To do → Doing → Review → Done** (semantic, not
custom — the orchestration loop binds to them; To do is the queue's ready
line). Per-board, in Board settings: **WIP limits** per lane (the head wears
`n / limit`, amber when over — a cue, never a hard block), an **aging cue**
(a card idle N days in Doing/Review wears `idle Nd` and a dashed border), and
**auto-archive** for Done (default 14 days; archived cards stay queryable and
restorable). Cards carry priority (urgent/high/normal/low — left edge + order
of concern), labels (neutral chips + deterministic color dots), due dates
(overdue turns danger), and a blocked flag with its reason. The head holds a
text + priority filter; within-lane order is real (drag with an insertion line,
or the ⋯ menu's Move up/down) and is what the queue consumes.

## GitHub, two-way (ADR 0015)

Bind the board to its repo (detected from the origin remote), **import** open
issues as linked backlog cards (idempotent), **auto-link** the PR for a card's
worktree branch when it enters Review (opt-in rule), and let inbound rules move
cards (`PR merged → Done`, `issue closed → Done` — each opt-in). WRITE-BACK
(create/close issues, via your own `gh`) is per-board, default OFF, risk-
confirmed — see the ADR for the whole wall.

## The queue — the board pulls (Phase-9′'s organ, scoped)

Per board, **default OFF**: when a slot frees, the top To-do card launches the
configured provider in its own worktree with the card as its first prompt —
`startOnCard`, the same seam as the human verb. Enabling it is an explicit risk
confirm (unattended launches spend real quota). The engine enforces what the
spec promises rather than advising it:

- **maxConcurrent** (live queue-launched agents) and **launchesPerHour** — a
  hard ceiling, recorded BEFORE each launch so a crash over-counts, never under.
- **Self-pause** after two consecutive FAILED handoffs, reason stored and worn
  in the board head; re-enable is the human's act.
- The kill switch is the settings toggle — stopping needs no ceremony.

A handoff **hands only to the provider it launched** ('shell' keeps the open
door — a plain terminal hands to whatever the user starts; an unknown provider
id hands to nothing, ever). A card unbound or moved mid-launch fails the
handoff closed — the queue's view of the board is push-fed live, not a
tick-time snapshot.

## Enforcement

| Gate | Bites on |
|---|---|
| `MOGGING_BOARDV2` | project identity (repo/worktree/folder/unfiled), migration, CAS refusal-with-fresh-card, within-lane ordering, live push repaint, archive round-trip, activity |
| `MOGGING_BOARDMCP` | scoped reads, full CRUD behind the grant, claim exclusivity naming the owner, CAS over the wire, archive-not-delete, receipts + trail attribution |
| `MOGGING_BOARDUX` | the visual system: chips row, counts, WIP over-limit, priority/labels/blocked/overdue/aging cues, filter narrowing, detail modal + activity, archived viewer, AA across four themes |
| `MOGGING_BOARDGH` | ADR 0015's wall + rules, on a fixture gh world, zero network |
| `MOGGING_BOARDQUEUE` | default-off, the risk confirm (checkbox alone never enables), top-of-To-do pull, budget ceiling, fail-pause with the banner |
| `MOGGING_BOARD` / `BOARDFAIL` / `BOARDRENDER` | the Phase-3 loop, the fail-closed handoff, and the rebuild-survival laws — unchanged and still held |

See also: docs/08 (the orchestration loop), docs/09 (swarm + the injection
model), docs/14 (grants and the tool catalog), ADR 0015.

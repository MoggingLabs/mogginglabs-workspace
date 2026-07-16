# ADR 0015 — Board ↔ GitHub write-back rides the user's gh, behind a per-board grant

- **Status:** accepted (2026-07-16)
- **Relates to:** ADR 0002 (never broker provider auth) · ADR 0008 (protocols, not
  plugins) · docs/14 direction 5 (the adapter ladder) · docs/18 (the board)

## Context

Direction 5's GitHub adapter was **read-only by design**: a board card links to a
PR/issue, the app observes it through the user's own `gh`, and "Never a mutation"
was a stated property of the rung. Board v2 binds a whole BOARD to a repository
(one board per project), and the useful loop wants two writes: *push a card to
GitHub as an issue* (so a local task becomes visible to the team) and *close the
linked issue* (so landing work closes its ticket). That deliberately retires the
read-only invariant — this ADR is the record of how far, and no further.

## Decision

1. **Reads stay ungated.** Detect the origin remote, import open issues as
   backlog cards, look up the PR for a card's worktree branch, poll link status —
   all ride the user's own `gh`/`git`, all remain grant-free, exactly like the
   direction-5 adapter.
2. **Writes exist, and they are walled.** `gh issue create` / `gh issue close`
   run **only** when the board's `github.writeBack` grant is ON — per board,
   default OFF, and flipped only through an explicit risk confirm that says what
   leaves the machine (the card's title and notes, to a repo other people watch).
   Refusals name the wall: "write-back is OFF for this board — enable it in Board
   settings."
3. **Custody is unchanged.** The app still holds **no** GitHub credential: every
   read and write shells out to the user's own `gh`, which authenticates itself
   (stronger than `gh auth token` — the token never enters our process). A reason
   string never carries a token.
4. **No silent mutation path.** Writes happen on an explicit human verb (the
   card's "Push to GitHub…" / "Close linked issue…", each with its own confirm)
   — never automatically. The per-board RULES (`PR merged → Done`,
   `issue closed → Done`, `auto-link PR`) are **inbound or read-only** and are
   individually opt-in; no rule performs a GitHub mutation in v1.
5. **Agents never call write-back directly.** The MCP surface grants agents the
   BOARD (create/update/claim/comment/archive, ADR 0008's workspace grant); the
   board↔GitHub mirroring stays the app's one write path. An agent that wants an
   issue filed creates a card and says so; the human (or a future, separately
   granted rule) pushes it.

## The one deliberate exception to "card text never leaves the machine"

ADR 0005 keeps card text out of telemetry, notify payloads, and logs — that all
still holds. `ghPush` sends the card's title/body to GitHub **because the user
explicitly asked it to, twice** (the standing per-board grant + the per-act
confirm). That is the entire exception, and it is why write-back has its own
grant instead of riding the workspace integrations grant.

## Enforcement

`MOGGING_BOARDGH` drives the real handlers against a fixture gh world (zero
network): detect + import + idempotent re-import, the write-back WALL (refusal
names the grant; **zero** `gh` mutation subprocesses while off), the UI risk
confirm (checkbox alone never enables; Cancel keeps it off), push/close with the
grant on, and the inbound rules (off = no move; on = Done + narrated activity).

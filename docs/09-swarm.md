# The swarm — roles, mailbox, ownership

Phase 4 turns a directed fleet into a coordinated one. Three primitives, all riding
the ONE authed daemon socket (protocol v3), all in-memory (coordination, not a
database), all invisible to telemetry by design (ADR 0005).

## Roles (4/01)

Every pane can be named `architect`, `worker`, or `reviewer` — by the wizard's Swarm
preset, the workspace manifest (persisted; restore re-announces it), or
`mogging role <pane> <role>`. Roles show as a chip in the pane header, enrich
`mogging list`, and travel with every mail message. The `reviewer` role becomes
load-bearing in 4/03 (the merge gate).

## Mailbox (4/01)

A daemon-mediated message bus. Agents PULL — the mailbox never writes into a PTY.

```sh
mogging mail send --to all "API frozen — see src/contracts/api.ts"   # inside a pane
mogging mail send --to 102 "your turn on the parser"
mogging mail read            # my messages (+ broadcasts), oldest first
mogging mail read --since 41 --json
```

Identity is implicit inside panes (`MOGGING_PANE_ID`); a human shell sends as `human`.
Bodies cap at 16 KB; the daemon keeps the last 500 messages; everything dies with the
daemon on purpose.

## Ownership ledger (4/02)

Two agents editing one file is the swarm failure mode. Before touching files, an
agent CLAIMS repo-relative globs; overlapping claims are refused with the owner named:

```sh
mogging claim "src/ui/**"        # exit 0 — granted
mogging claim "src/ui/app.ts"    # (from another pane) exit 5 — DENIED, owner named
mogging release "src/ui/**"      # or: mogging release --all
mogging owners [--json]          # the full map, also live in every pane: ⋯ -> Show claims
```

- Claims contest ownership **per workspace** (one repo wall referees itself).
- Overlap testing is CONSERVATIVE: only a pure-literal path divergence proves two
  globs disjoint — wildcards deny by default. A denied claim never flaps to granted
  without an explicit release.
- A pane's claims **auto-release when its session exits**. Claims come only from
  panes — humans don't claim territory; humans own the review gate.
- The ledger ADVISES. It never blocks PTY writes or file I/O — the reviewer gate
  (4/03) is where strays get caught, with a diff in hand.

## The contract agents are told (first prompt material)

> You share this repo with other agents. Before editing any file:
> `mogging claim "<glob>"` — if DENIED, coordinate via
> `mogging mail send --to <owner> …` or pick different files. Release with
> `mogging release --all` when done, then `mogging mail send --to all` a summary and
> notify the reviewer. Never edit paths you don't own.

## Wire surface (v3 additions)

| Verb | Message | Reply |
|---|---|---|
| mail send | `mail-send {from, to, body}` | `mailed {id}` |
| mail read | `mail-read {since?, for?}` | `mail {messages}` |
| role | `set-role {id, role}` | `role-set {id, ok}` |
| claim | `claim {from, pattern}` | `claimed {id}` · `claim-denied {pattern, ownerPaneId}` |
| release | `release {from, pattern?/all}` | `released {count}` |
| owners | `owners {}` | `owners {claims}` — also PUSHED to every client on change |

CLI exit codes: 0 ok · 1 unknown pane · 2 usage/not-in-a-pane/bad pattern · 3 no
daemon · 4 auth · **5 claim denied**.

Enforced by `MOGGING_SWARM` + `MOGGING_LEDGER` (isolated, via `scripts/qa-smokes.sh`).

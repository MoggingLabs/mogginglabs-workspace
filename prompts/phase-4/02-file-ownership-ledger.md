Two agents editing one file is the swarm failure mode. Add an **exclusive ownership
ledger**: an agent claims path globs before touching them; overlapping claims are
REFUSED with the owner named; humans see who owns what at a glance.

## Steps
1. **Protocol v3 additions** (`src/contracts/daemon/protocol.ts`):
   `Claim { id, paneId, role?, pattern, ts }`. ClientMessage += `claim { pattern }`,
   `release { pattern | all }`, `owners {}`; ServerMessage += `claimed { id }`,
   `claim-denied { pattern, ownerPaneId }`, `owners { claims }`. Patterns are repo-
   relative globs (`src/ui/**`), max 256 chars, validated shape (no `..`, no drive
   roots). Ledger scoped **per workspace ordinal** (panes of one repo wall).
2. **Daemon** (`src/pty-daemon/ledger.ts`): in-memory claim set + overlap test
   (glob-vs-glob via prefix/segment comparison — conservative: when in doubt, DENY).
   A pane's claims auto-release when its session exits. `owners` returns the live set.
3. **CLI**: `mogging claim <pattern>` (exit 0 granted / **5 denied** — new code,
   stderr names the owner pane), `mogging release <pattern|--all>`, `mogging owners
   [--json]`. Implicit identity via `MOGGING_PANE` (a claim from outside a pane is
   exit 2 — humans don't claim, humans own the gate).
4. **UI surface**: pane ⋯ menu → "Show claims…" (modal list: pattern + owner role);
   a compact `.pane-claims` count chip in the pane header when a pane holds claims
   (event-driven: daemon broadcasts `owners` on change over the existing relay).
5. **Agent guidance**: `docs/09-swarm.md` section — the contract agents are told in
   their first prompt: *claim before you edit, release when done, mail the reviewer*.
   (Enforcement is social + reviewable — the ledger is the referee, 03 is the gate.)
6. **Smoke** (`MOGGING_LEDGER`): isolated boot, 2 panes → pane 1 claims `src/a/**`
   (granted) → pane 2 claims `src/a/x.ts` (DENIED, owner=pane 1, exit 5) → pane 2
   claims `src/b/**` (granted) → `owners` lists both → pane 1 releases → pane 2 can
   claim → killing pane 1's session auto-releases (assert via owners). Chip renders.
   Result JSON + qa-smokes entry.

## Files
- `src/contracts/daemon/protocol.ts` · `src/pty-daemon/ledger.ts` + `transport.ts`
- `bin/mogging.mjs` · terminal-pane chip + claims modal · `docs/09-swarm.md`
- `src/main/ledger-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Overlapping claims are impossible; denials name the owner; exits release; the human
  can always see the full ownership map (CLI + UI) in under a second.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_LEDGER` green isolated; `MOGGING_SWARM` + `MOGGING_CONTROL` still green.

## Guardrails
- The ledger ADVISES the swarm and the reviewer — it must NOT block PTY writes or
  file I/O (we never intercept an agent's disk access; the gate (03) catches strays).
- Claim patterns are paths: local state only, never telemetry/logs (counts fine).
- Deny-by-default on overlap ambiguity; a denied claim must never flap to granted
  without an explicit release.

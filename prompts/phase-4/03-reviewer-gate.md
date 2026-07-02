The last line of defense gets teeth: worktree branches merge ONLY with a **reviewer
sign-off** — from the swarm's reviewer pane or an explicit human override. 3/04's
review surface stays the door; this step adds the lock.

## Steps
1. **Protocol v3 additions**: ClientMessage += `approve { branch }`, `approvals {}`;
   ServerMessage += `approved { branch, byPaneId, byRole }`, `approvals { list }`.
   Only a connection bound to a pane whose role is `reviewer` may `approve` (else
   `error: notreviewer`). Approvals live in daemon memory, keyed by branch name,
   cleared when the branch's worktree is removed.
2. **CLI**: `mogging approve <branch>` (exit 0 · **6 notreviewer** · 3/4 as usual),
   `mogging approvals [--json]`. The reviewer agent's loop becomes scriptable:
   `mogging mail read` → review the diff (its own worktree checkout or `mogging
   capture`) → `mogging approve mogging/<slug>`.
3. **Backend** (`src/backend/features/review/`): `mergeBranch` gains a
   `gate: { approved: boolean; override?: string }` parameter — main consults the
   daemon's approvals (via the existing relay client) before calling it; unapproved +
   no override → typed refusal `{ ok:false, state:'ungated' }`. NOTHING else in the
   merge path changes (clean-repo check, --no-ff, conflicts pause).
4. **UI** (review modal): footer shows the gate state — "Approved by reviewer (pane
   N)" (green) or "No reviewer sign-off". Unapproved: the merge button becomes
   **"Override & merge…"** requiring the typed word `override` (distinct from
   `merge`), so a human can always land — deliberately. Board: a bound card whose
   branch gains approval shows a ✓-chip (suggest Review lane; the human still moves it).
5. **Smoke** (`MOGGING_GATE`): isolated boot + temp repo → worktree with a committed
   change → merge attempt via `review:merge` → `state:'ungated'` → `mogging approve`
   from a NON-reviewer pane → exit 6 → set pane role reviewer → approve → exit 0 →
   merge succeeds → second worktree: human path — override merge with the typed word
   asserted at the IPC layer (`override: 'override'` required verbatim). Result JSON +
   qa-smokes entry.

## Files
- `src/contracts/daemon/protocol.ts` · `src/pty-daemon/transport.ts` (+ approvals map)
- `bin/mogging.mjs` · `src/backend/features/review/index.ts` · `src/main/review.ts`
- review modal + board chip touches · `src/main/gate-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- An unapproved branch cannot merge through the app — not by click, not by CLI —
  except via the explicit typed human override; approvals are role-checked at the
  daemon, not trusted from the client.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_GATE` green isolated; `MOGGING_REVIEW` + `MOGGING_ORCHESTRATION` still
  green (orchestration's merge step now sets a reviewer role first — update it
  INTENTIONALLY, keeping every other assertion).

## Guardrails
- The gate gates OUR merge verb only — never rewrite git config/hooks in the user's
  repo; a user merging in their own terminal is their right.
- Role checks happen daemon-side against the authenticated pane binding — a client
  claiming "I'm a reviewer" in the payload is ignored.
- Approval state is coordination data: memory only, never persisted or telemetered.

Registered ≠ everywhere. Twenty connected tools in every agent's context
is pollution — research §8's named risk. This step gives scoping a
MECHANISM: a per-workspace **tool plan** (which servers, per CLI),
chosen at creation, materialized at PANE LAUNCH — the seam the vault
keys ride (08). MINIMAL by default: the house server + the template's
picks, nothing else.

## Steps
1. **The plan** (`@contracts/integrations`): `WorkspaceToolPlan
   { workspaceId, entries: { [serverId]: 'all-clis' | cliId[] },
   inheritGlobal: boolean }`, stored with workspace settings. TWO tiers
   in the UI: GLOBAL (06's user-home writes, "everywhere") and WORKSPACE
   (the plan). New workspaces: house server + the TEMPLATE's picks
   (templates gain `tools`), `inheritGlobal: false`.
2. **Materialization at launch**: the launcher composes each pane's
   ACTUAL set (plan ∪ inherited global, filtered to its CLI) and hands
   it over the way THAT CLI supports — launch flag preferred (Claude
   Code `--mcp-config <userData path>`: no file in the worktree);
   project-scope file only where no flag exists (managed marker,
   excluded via the worktree's info/exclude — agents never see plan
   files in `git status`). Per-CLI mechanism = capability-table data,
   dev-verified (7/01). Daemon v3 untouched: flags/env ride the spawn
   request.
3. **The picker in the wizard**: creation gains a compact Tools row —
   chips of CONNECTED integrations (11's registry), template picks
   pre-checked, "everywhere" tools locked-on with a GLOBAL badge. One
   click per tool, no config vocabulary. Editable later in the
   § Integrations per-workspace subsection, beside the grants.
4. **The matrix — see who has what**: the subsection renders tools ×
   CLIs, three cell states (global · planned · off) + the per-pane truth
   line ("launched with {n} servers; {m} pending restart" — 11's nudge
   composes). The catalog grid (07) gains a per-row badge ("in 3 of 5
   workspaces").
5. **TOOLPLAN smoke** (`MOGGING_TOOLPLAN`, env-gated, in qa-smokes.sh):
   fixture homes + CLI shims + scripted frames: (a) a plan of A,B for
   claude and A for codex materializes EXACTLY that (launch args/files
   per dialect); (b) an agent in the scoped pane lists ONLY the planned
   servers; (c) unplanned global absent; `inheritGlobal` brings it back;
   (d) no plan file visible to git in the worktree (status grep); (e) a
   plan edit flips 11's restart-needed on live panes; (f) template picks
   land in a new workspace's plan; (g) matrix cells match materialized
   truth. Verdict `out/toolplan-result.json`; zero network.

## Files
- `src/contracts/integrations` (plan; template `tools`) ·
  `@backend/features/integrations/plan.ts` · the pane launcher · wizard
  Tools row · `settings/integrations.ts` · toolplan-smoke.ts ·
  qa-smokes.sh · gallery (picker + matrix)

## Definition of Done
- Dev-verified (books, dated): two real workspaces, Sentry planned in
  one — agents in each list exactly their plan; the matrix shows the
  difference at a glance; a template workspace arrives pre-scoped.
- A pane's context carries ONLY its plan: unplanned tools appear in no
  tools/list frame of its CLI (frames in the books).
- TOOLPLAN gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION rerun.

## Guardrails
- Scoping is CONTEXT hygiene, not security: the reviewer gate and the
  grants (03/04) stay the boundary; a plan never widens a grant.
- Nothing lands in the worktree that git can see — flags first, excluded
  files only where no flag exists (6/03 canonical-path care on win32).
- The plan changes WHERE servers appear, never their auth: tokens stay
  with the CLIs, keys stay vault slots (08); materialized configs carry
  pointers only (0008.h).
- Minimal by default is the point: an empty plan is valid and honest —
  never auto-add beyond the template.

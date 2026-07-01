# 06b — Provider-mix workspace templates

**Prereq:** `05` green + `06` green — this **composes** the workspace/layout (05) and the
single-CLI launcher (06); it adds no new launch or layout mechanics of its own.
**Shared context:** `README.md` + `docs/adr/0002-never-broker-provider-auth.md` +
`06-agent-launcher.md` (the per-CLI adapters this builds on).

## Goal
Let the user open a whole workspace from a **template** that specifies **how many panes run
each provider** — e.g. "2× Claude Code + 1× Codex + 1× Gemini". Picking (or building) a
template creates a new workspace whose grid matches the total pane count and **auto-launches
each pane's assigned CLI** into its pane at the workspace cwd, each **self-authenticated**
(BYO). It's the one-click "spin up my agent lineup" flow, layered on 06's launcher.

## Concept
A **template** = a name + a **provider mix**: a list of `{ provider, count }` (providers = the
06 CLI roster — claude / codex / gemini / aider / opencode — plus a plain `shell`). The **total
count** selects the grid template from 05 (1/2/4/6/8/9/12/16); if the total isn't an exact grid
size, round up to the next and **pad the remainder with `shell` panes** (or extend 05's grid set
for the odd sizes). Each slot in the resulting layout carries a **provider assignment**; on open,
that slot's pane launches the assigned CLI via 06's adapter. Presets ship built-in; users build +
save their own.

## Steps
1. **Template model + store** — `src/backend/features/templates/` (Electron-free): a
   `ProviderMixTemplate` (`{ id, name, mix: { provider, count }[] }`), the built-in presets, and
   a `resolveLayout(mix)` that maps a mix → `{ paneCount, assignments: provider[] }`. Persist via
   05's app-settings store (a new `templates` table + a per-workspace `assignments` map:
   pane-id → provider). **Metadata only — providers + counts, never credentials (ADR 0002).**
2. **Template builder/picker UI** — `src/ui/features/templates/`: a dialog to pick a preset or
   build a custom mix — a **count stepper per provider**, live-previewing the resulting grid and
   total panes — then "Open workspace". Use 06's `detect()` to **disable providers not installed**.
3. **Open-from-template flow** — composes 05 + 06: create a workspace (05) with the resolved
   layout; record each slot's provider assignment; each pane launches its assigned CLI (06
   adapter `launchCommand(cwd)`) at the workspace cwd. Label panes by provider + per-pane state (06).
4. **Persist assignments + restore** — persist the workspace's pane→provider map (05 store); on
   relaunch, restore re-launches each pane's CLI via its adapter `resume` (03/05 restore), so a
   template workspace **comes back with the same lineup**. No credentials persisted, ever.
5. **Never broker auth** — templates only choose WHICH command each pane runs; every CLI
   self-authenticates (ADR 0002). A template carries providers + counts, never tokens.

## Files
- `src/backend/features/templates/**` (model, presets, `resolveLayout`, persistence),
  `src/ui/features/templates/**` (builder/picker), `src/contracts/ipc/templates.ipc.ts`
  (+ channels spread into `channels.ts` `AllChannels`). Extends `05`'s workspace store + `06`'s
  adapters — it does **not** reimplement layout or launch.

## Definition of Done
- Pick/build a template ("2 Claude + 1 Codex + 1 Gemini") → a new workspace opens with the
  matching grid, **each pane running its assigned CLI** at the workspace cwd, self-authenticated.
- Custom templates **save + reappear**; a template workspace **restores its lineup** on relaunch.
- Providers not installed are **disabled** in the builder (via 06 `detect()`).

## Checks that must be green
- Template smoke: open a mixed template (e.g. `2× shell + 1× claude`), assert the resolved pane
  count + each pane's launched command match the mix, and that restore brings the lineup back → green.
- `npm run typecheck` → 0; `npm run build` → ok; boundaries clean; **secret-audit**
  (templates persist providers/counts only — no credentials anywhere).

## Guardrails
- **ADR 0002** — templates never store/inject/proxy auth; they select commands, the CLIs self-auth.
- **Decoupled** — `templates` composes `workspace` (05) + `agents` (06) through `@contracts` +
  the existing ports; it does not reach into their internals. Keep `@backend` Electron-free.
- **Reuse, don't duplicate** — 05's grid templates for layout, 06's adapters for launching.

## Where this sits
06 is the **primitive** (launch one CLI into one pane). 06b is the **composition** (a named mix
of providers → a whole workspace that launches the lineup). Kept separate so each is
independently testable and either can evolve without the other. Runs after 06, before 07
(packaging).

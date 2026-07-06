The machinery is built (06–12); this step makes it FEEL effortless.
Four UX debts, one pass: a cold start with no guided path, failures
that only change a chip, integrations missing from the palette, and
config-dialect copy shown to people who never edit dotfiles. Polish is
spec, not garnish — every piece lands with asserts.

## Steps
1. **Connect your stack** — the guided flow: a "Set up integrations…"
   entry in § Integrations AND a new first-run checklist item
   deep-linking to it. Walks the roster in site order, filtered to
   DETECTED CLIs: per tool — Connect (prefilled) → Authorize with
   per-CLI progress → next. Skippable per tool, resumable (KV progress,
   survives restart), quits cleanly; ends on the workspace-plan reminder
   ("scope per workspace — minimal is the default"). Nobody is forced
   through it; the grid stays primary.
2. **Failure shoulder-taps**: a `connected → needs-auth` TRANSITION
   (11's registry) lands ONE quiet toast per (server × CLI) per
   token-epoch — the 7/09 single-fire discipline, KV-keyed, re-armed on
   repair — with Re-authorize as the action. Recovery is silent (the
   chip settles); no storms, no repeat nags.
3. **Palette verbs**: the command box learns the surface — "Connect
   {tool}…", "Authorize {tool} on {cli}", "Add/remove {tool} in this
   workspace", "Open integrations matrix", "Restart panes to pick up
   tools". The existing command registry; every verb routes to the one
   home or existing actions — no new capability, new reach.
4. **Words and empty states**: every diff preview gains a one-line
   plain summary ("Adds Sentry to Claude Code — all workspaces");
   § Integrations empty state = one CTA into the guided flow (the 5/05
   lesson); the matrix empty state explains plans in a sentence; the
   catalog grid gets the 7/12 grammar — category groups (the site's
   queue/wall/media), connected-first sort, search; an in-app privacy
   block (the usage-tab pattern) states the custody rule in user words
   + the docs/14 pointer.
5. **INTEGUX smoke** (`MOGGING_INTEGUX`, env-gated, in qa-smokes.sh):
   fixture homes + CLI shims — (a) the guided flow walks two fixture
   tools end to end, skip works, progress survives restart; (b) a
   needs-auth flip fires exactly ONE toast per epoch (KV re-fire grep),
   the action routes to Re-authorize, recovery fires none; (c) each
   palette verb executes; (d) empty states render with CTAs; (e) the
   plain summary names the writer's actual target (cli + scope);
   (f) privacy block present; grid groups + sort asserted. Verdict
   `out/integux-result.json`; zero network.

## Files
- `settings/integrations.ts` (flow, empty states, privacy block) ·
  first-run checklist item · toast wiring · command registry entries ·
  diff-preview summary · integux-smoke.ts · qa-smokes.sh · gallery
  (flow, toast, empty states)

## Definition of Done
- Dev-verified (books, dated): a FRESH machine goes checklist → guided
  flow → two real tools connected + authorized → a workspace scoped —
  no docs consulted, wall-clock minutes recorded.
- Killing a token at the vendor produces exactly one toast whose button
  repairs it — then silence.
- Every integrations action is palette-reachable (listed in the books).
- INTEGUX gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION rerun.

## Guardrails
- The guided flow ORCHESTRATES existing steps (06 Connect, 07
  Authorize, 09 plans) — zero new write paths; needing one means a step
  above was incomplete.
- Toast copy carries tool + CLI names IN-APP only; telemetry stays
  counts/booleans (ADR 0005); single-fire is KV-epoch-keyed (7/09).
- Palette verbs are routes, not capabilities.
- Plain summaries derive from the SAME writer data as the diff — never
  a hand-maintained string that can drift.

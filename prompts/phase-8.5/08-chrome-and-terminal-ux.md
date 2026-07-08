Chrome + terminal-surround UX (Phase-8.5/08). The frame the user lives in
all day: titlebar, workspace tabs, pane headers, the browser dock's chrome,
and the shortcuts overlay. Phases 6–8 bolted chips onto these (usage gauge,
MCP chip, agent-browsing dot, attention states) without a layout pass —
this step gives the chrome one density rhythm and executes the AUDIT.md
removals for affordances the product outgrew. Terminal CONTENT is
untouchable (budgets, docs/07); everything around it is in scope.

## Steps
1. **Titlebar**: one ordered system — left (app/home), center (workspace
   tabs), right (usage gauge · MCP chip · browser globe · settings) with
   token gaps and a shared icon-button hitbox size; overflow rules for
   many tabs (scroll + fade, not shrink-to-unreadable). The
   window-control overlay + fullscreen chrome classes (5/04) unchanged.
2. **Workspace tabs**: identity color dot, name, attention/busy state
   (the `data-attention` contract stays), agent-browsing dot (8/07c),
   close affordance on hover — spaced on the scale, active tab clearly
   heavier. Middle-click close if AUDIT.md verdicts want it; drag-reorder
   only if already present (no new mechanics here).
3. **Pane headers**: the densest strip in the app — title, branch chip,
   role chip, state dot, mcp chip, expand/close. One height, one gap
   token, chips truncate with tooltips instead of wrapping; the header
   never grows the pane's chrome budget (measure before/after — docs/05).
   The pane ⋯ menu ordered by frequency; stale items from AUDIT.md
   removed with rationale.
4. **Dock chrome + shortcuts overlay**: the dock header (URL, profile
   toggle, possession banner, consent copy) on the same rhythm — the
   possession/"agent holds the wheel" surface must stay UNMISSABLE
   (that's its job) while sitting cleanly; the `?` shortcuts overlay
   becomes a two-column token grid grouped by area, fed from the same
   data the Settings page renders (KB-01: one source).
5. **CHROMEUX smoke** (`MOGGING_CHROMEUX`, env-gated, qa-smokes.sh):
   (a) titlebar right-cluster buttons share hitbox size + gap (computed);
   (b) 8 workspaces → tabs overflow with scroll affordance, none below
   min readable width; (c) a pane with branch+role+mcp fixtures renders
   one-line header, chips truncated not wrapped (height assert ==
   single-line height); (d) the attention data-attribute contract on
   tabs/panes still fires from a fixture notify (ATTENTION-gate reuse);
   (e) shortcuts overlay opens on `?`, groups render, and its rows match
   the Settings page's data (count equality); (f) dock possession banner
   still renders over agent control (PERWSAGENT hooks intact). Verdict
   `out/chromeux-result.json`.

## Files
- shell/titlebar + workspace-tab + pane-header + dock-chrome CSS/TS
  (`src/ui/core/shell`, `src/ui/features/workspace`, `terminal`,
  `browser`) · `src/ui/features/shortcuts/` · `src/main/chromeux-smoke.ts`
  · main dispatch · qa-smokes.sh row · gallery (both themes)

## Definition of Done
- The chrome reads as one system: consistent hitboxes, gaps, chip
  truncation — no wrapped pane headers at any pane count.
- Every attention/possession/consent surface is as loud as before or
  louder — polish never dims a safety signal.
- ATTENTION, MULTIPANE, PERWS, PERWSAGENT, KBSHORTCUTS gates still
  green; CHROMEUX green; count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE + FLICKER re-run (chrome
  touches the frame budget).

## Guardrails
- xterm content, renderer settings, and the terminal draw path are OUT
  of scope — docs/05 and docs/07 budgets are the veto.
- Safety surfaces (possession banner, consent copy, attention states)
  may be restyled, never reduced, relocated behind disclosure, or made
  subtler.

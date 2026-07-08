Chrome + terminal-surround UX (Phase-8.5/08). The frame the user lives in
all day: titlebar, workspace rail, pane headers, dock chrome, shortcuts
overlay. One density rhythm + the AUDIT.md removals. Terminal CONTENT is
untouchable (docs/05, docs/07). **Read AUDIT.md § Chrome first — premises
you'd assume are FALSE**: there is no titlebar MCP chip (it's per-pane); the
center cell is the palette trigger, not tabs; pane-header 3/6px are
SANCTIONED; `.pane-badge`'s "smoke DOM contract" comment is a lie.

## Steps
1. **Titlebar**: fix the port lie — `feature-registry.ts:7` calls
   `titlebarLeft` "after the brand"; `titlebar.ts:86` mounts BOTH slots
   inside `.titlebar-right`. Declare the right cluster's order (today it's
   feature-registration order). Hoist darwin's `padding-left: 84px` (a
   correct traffic-light inset) to `--traffic-light-inset`, sourced from
   `main/window.ts:24`. Drop `.update-dot`'s margin. Hitboxes + gaps: keep.
2. **Workspace rail**: identity ramp, `data-attention` latch and the
   zero-layout-shift `::before` bar are well-built — KEEP. Add the missing
   scroll-edge fade. Fix the collapsed-rail collision (agent dot over
   `.ws-attn`).
3. **Pane headers**: fixed 28px, chips `flex:none`, title ellipsises —
   correct, KEEP. Fix: `.pane-head-left` has no `overflow` (four lit chips
   in a narrow pane spill into the branch chip); `.pane-role` has no
   `max-width` and no tooltip; `.pane-mcp` breaks its three siblings on
   every axis (size, padding, radius, unset `line-height`) and lives 1300
   lines away — co-locate and align. On a remote pane the state dot is no
   longer the leading glyph (`terminal-pane.ts:391`). ⋯ menu items are all
   live — KEEP; reorder by frequency only.
4. **Dock chrome + shortcuts overlay**: dock header on the same rhythm,
   possession UNMISSABLE; the `?` overlay a two-column token grid fed from
   Settings' own data (KB-01: one source).
   **BLOCKER (AUDIT.md § Blockers) — land FIRST, before any dock restyle**:
   `.browser-agent-label`, `.browser-confirm-text`,
   `.browser-agentweb-note-text` have NO CSS rule, and NO smoke asserts any
   `.browser-*` class. Guard it: while `driving`, `.browser-dock` carries
   `agent-driving`, the banner is not hidden, `.browser-agent-stop` is
   hit-testable, `.browser-agent-label` has text at computed `>= 11px`,
   non-transparent.
5. **CHROMEUX smoke** (`MOGGING_CHROMEUX`, env-gated, qa-smokes.sh):
   (a) right-cluster buttons share hitbox + gap (computed); (b) 8 workspaces
   → rail scrolls with an edge fade, tabs never shrink; (c) a pane with
   remote+role+claims+mcp fixtures renders a ONE-LINE header, chips
   truncated not wrapped, cluster never overflowing the branch chip; (d) the
   `data-attention` contract still fires; (e) the `?` overlay's rows match
   Settings' (count equality); (f) step 4's possession guard. Verdict
   `out/chromeux-result.json`.

## Files
- titlebar · workspace-tab · pane-header · dock-chrome CSS/TS (`core/shell`,
  `features/workspace`, `terminal`, `browser`) · `features/shortcuts/` ·
  `src/main/chromeux-smoke.ts` · main dispatch · qa-smokes.sh · gallery

## Definition of Done
- One system: consistent hitboxes, gaps, chip truncation — no wrapped pane
  headers at any count; the chrome bucket clears § Enforcement (18→0).
- Every possession/consent/attention surface as loud as before — and now
  TESTED (step 4's guard).
- ATTENTION, MULTIPANE, PERWS, PERWSAGENT, KBSHORTCUTS still green;
  CHROMEUX green; count bumped.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE + FLICKER re-run.

## Guardrails
- xterm content and the terminal draw path are OUT of scope; budgets veto.
- Pane-header 3/6px are SANCTIONED; judge titlebar, rail, dock and overlay
  strictly, pane headers by the off-ramp.
- Safety surfaces may be restyled, never dimmed, shrunk, or hidden behind
  disclosure.

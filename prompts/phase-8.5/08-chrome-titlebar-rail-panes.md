Chrome: titlebar, rail, pane headers (Phase-8.5/08). Terminal CONTENT is untouchable
(docs/05, docs/07). **Read AUDIT § Chrome first — premises you'd assume are FALSE**:
there is no titlebar MCP chip (it is per-pane); the centre cell is the palette
trigger, not tabs; pane-header 3/6px are SANCTIONED; `.pane-badge`'s "smoke DOM
contract" comment is a lie — zero smokes reference it.

## Steps
1. **Titlebar** (B): fix the port lie — `feature-registry.ts:7` calls `titlebarLeft`
   "after the brand"; `titlebar.ts:86` mounts BOTH slots inside `.titlebar-right`.
   Declare the right cluster's order (today: registration order). Hoist darwin's
   `padding-left: 84px` — a *correct* traffic-light inset — to
   `--traffic-light-inset`, from `main/window.ts:24`. Hitboxes/gaps: keep.
2. **Bug #11**: the grid-layout button is offered on Home, Board and Settings, where
   no grid exists; clicking it calls `applyTemplate()` against the hidden active
   workspace. Add the view-scoped rule. REMOVE #16: `.layout-menu-tile` + the ad-hoc
   tile builder → `createLayoutGridPicker()` with a `compact` variant — today
   `.layout-menu-tile .layout-tile-count` overrides another component's class.
3. **The radius ramp — the audit's last unresolved either/or.** Radius has **no**
   off-ramp (`--r-sm/md/lg/full`), yet chrome ships `3px`/`4px`/`5px`/`6px` radii
   with no token behind three. Decide once: add `--r-xs: 3px`, or fold into
   `--r-sm`. Record it in docs/11 — an undecided ramp is how the next drift starts.
4. **Workspace rail** (A−): identity ramp, `data-attention` latch and the
   zero-layout-shift `::before` bar are well-built — KEEP. Its one gap is the missing
   scroll-edge fade at 8+ workspaces. **Bug #10**: collapsed-rail collision — the
   agent-browsing dot sits on `.ws-attn`, two "look here" signals on 8px. REMOVE #12.
5. **Pane headers** (B+): fixed 28px, chips `flex:none`, title ellipsises — correct
   by design, KEEP. **Bug #9**: `.pane-head-left` has no `overflow`, so a narrow pane
   with remote+role+claims+mcp lit spills into the branch chip; `.pane-role` has no
   `max-width`, no tooltip; `.pane-mcp` breaks its siblings on every axis and lives
   1300 lines away — co-locate and align. **Bug #12**: on a remote pane the state dot
   is no longer the leading glyph (`terminal-pane.ts:391`), contradicting its own
   comment and `global.css:1574`. REMOVE #11 (the `.pane-badge` CSS — keep the class
   — and both lying comments) and #19. ⋯ items: reorder only.
6. **CHROMEUX smoke** (`MOGGING_CHROMEUX`): (a) right-cluster buttons share hitbox +
   gap (computed); (b) 8 workspaces → rail scrolls with an edge fade, tabs never
   shrink; (c) a pane with remote+role+claims+mcp renders a ONE-LINE header, chips
   truncated not wrapped, state dot leading; (d) the grid button is ABSENT on Home,
   Board and Settings (bug #11's test); (e) `data-attention` still fires;
   (f) grep-assert: no un-tokened radius in chrome; (g) AA via `aa-probe.ts`.
   Verdict `out/chromeux-result.json`.

## Files
- `core/shell/{titlebar,app-shell}.ts` · `features/workspace/` ·
  `terminal/terminal-pane.ts` · `components/grid-preview.ts` · chrome CSS ·
  `chromeux-smoke.ts` · dispatch · qa-smokes.sh · `docs/11` · gallery

## Definition of Done
- AUDIT grades **Titlebar B → A**, **Workspace tabs A− → A**, **Pane headers
  B+ → A**. The radius ramp is decided and documented.
- The `chrome` bucket reaches **0** but `.shortcuts-row`, which is 08b's.
- ATTENTION, MULTIPANE, PERWS, PERWSAGENT, PANEOPS, CHROMEUX green.
  REMOVE #11, #12, #16, #19 ✅; bugs #9, #10, #11, #12 ✅.

## Checks that must be green
- typecheck 0; build ok; boundaries clean; full local sweep.
- PERCEPTION + MILESTONE + FLICKER re-run.

## Guardrails
- xterm content and the draw path are OUT of scope; budgets veto.
- Pane-header 3/6px are SANCTIONED; judge titlebar and rail strictly.
- Attention surfaces may be restyled, never dimmed, shrunk, or hidden.

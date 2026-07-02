Top-level places should own the whole app. Today Home renders beside the workspace
rail (a rail full of workspaces makes no sense on a LAUNCHER), and Settings is a
modal squeezed over whatever was open. Make Home, Settings, and Board true FULL-APP
views: everything below the titlebar is theirs; the rail exists only where it means
something — the grid.

## Steps
1. **View architecture**: `AppView` becomes `'home' | 'grid' | 'board' | 'settings'`.
   The rail moves INSIDE the grid view's responsibility: `#app.view-<x>` classes on
   the ROOT (app-shell owns them, from the view port) and `#rail { display:none }`
   for every non-grid view — Home/Board/Settings stretch across the full width below
   the titlebar. Rail show/hide must not re-mount panes (pure CSS visibility; the
   grid keeps its state — FLICKER/MILESTONE must not notice).
2. **Settings: modal → page** (`src/ui/features/settings/`): a full-app page with a
   left section nav (Appearance · Terminal · Profiles & Hosts · Privacy · About) and
   a scrollable content column — the existing rows/controls MIGRATE (theme seg,
   layout seg, profiles-hosts section, consent checkboxes) into sections, not
   rewritten. Entry: the titlebar gear + `settings:open` now `setActiveView(
   'settings')`; leaving = Esc, the titlebar views, or a back affordance returning
   to the PREVIOUS view (view-port remembers one step of history). The modal
   component stays for the things that ARE dialogs (wizard, review, card editor).
3. **Home + Board full-bleed**: with the rail gone, re-balance both layouts for the
   full width (Home's clamp() hero already scales — re-tune max widths; Board gets
   comfortable lane max-width + centering). The Home keyboard-hint footer and
   Board's header spacing get the 01-scale pass.
4. **Navigation coherence**: titlebar Home/Board/gear buttons become a consistent
   view-switcher trio (active view's button shows a subtle active state); Ctrl+Shift+H
   /G keep working; grid remains the default landing after any workspace action
   (open/switch/create reveal grid exactly as today).
5. **Smokes, intentionally**: PROFILES drives Settings via the gear — update its
   navigation to the page (selectors `.prof-*`, `[aria-label="Add profile"]`,
   `.settings-error` all SURVIVE — only the container changed); FIRSTRUN-style Home
   assertions unaffected; add asserts: opening Settings hides `#rail`, returning to
   grid restores it AND the same active workspace; BOARD smoke gains the no-rail
   assert. Gallery: all four views full-app, both themes.

## Files
- `src/ui/core/shell/view-port.ts` · `src/ui/shell/app-shell.ts` + `titlebar.ts`
- `src/ui/features/settings/` (page refactor) · home/board CSS re-balance
- `src/ui/styles/global.css` · affected smokes (`profiles-smoke.ts`, `board-smoke.ts`)
- gallery updates

## Definition of Done
- Home, Board, and Settings each occupy the entire app below the titlebar; the rail
  appears ONLY in the grid view; Settings is a real page with sections, reachable
  and leavable by keyboard; nothing about grid/pane state is disturbed by view trips.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- PROFILES + BOARD updated and green; SMOKE, ATTENTION, MILESTONE, FLICKER,
  PERCEPTION green (view flips are on the perception path — switch cost ≤ budget).
- Four-view full-app gallery shots, both themes.

## Guardrails
- View switches stay show/hide — NEVER unmount the grid or its panes (the GL-warm
  and scrollback guarantees depend on it).
- Settings state (unsaved form text) survives leaving/returning within a session —
  don't rebuild the page DOM on every entry.
- The wizard/review/card-editor MODALS are correct as modals — this step converts
  only true top-level places; don't over-apply the pattern.
- Selector contract discipline per the pack README (rename WITH the smoke, same step).

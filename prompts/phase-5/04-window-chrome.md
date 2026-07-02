Three window-chrome artifacts make the app feel less native than it is: the command
box lives in the right icon cluster instead of the bar's center; F11 fullscreen
leaves a dead gap where the native controls were (while the left brand stays put);
and the app's rounded bottom corners clip the square corners of edge-touching panes.
Fix the chrome so every window state — restored, maximized, fullscreen — looks
deliberate.

## Steps
1. **Centered command box**: restructure `#titlebar` into a strict 3-column grid
   (`1fr auto 1fr`): left = brand (logo · name · version), CENTER = the command box
   (true window-center via the grid, not content-center), right = the icon cluster +
   native-controls reserve. The command box grows slightly (comfortable click
   target, `Ctrl+K` hint kept); drag-region audit afterward — the box and buttons
   are no-drag, everything else drags.
2. **Fullscreen (F11) handling**: main listens to `enter-full-screen` /
   `leave-full-screen` and pushes a `shell:windowState` event; the renderer sets
   `#app.is-fullscreen`. In fullscreen: the native-controls reserve
   (`env(titlebar-area-width)` padding) collapses to a normal `--sp-3`, the right
   cluster ends flush like the left starts, and the brand keeps its position — no
   dead zone. Verify the overlay env() actually reports correctly on Win11 F11; if
   it doesn't (known Chromium quirk), the class-based override wins. Bonus: same
   event handles MAXIMIZED if any padding differs.
3. **Corner harmony**: Win11 rounds the window's bottom corners; our `#content` /
   grid / pane outlines are square → the bottom-left/right pane borders visibly
   clip. Fix: the app frame's bottom corners get a matching radius
   (`--window-corner: 8px` token — verify the actual Win11 radius empirically via a
   maximized-vs-restored shot; maximized windows are SQUARE, so the radius applies
   only when restored: tie it to the `shell:windowState` class) applied to `#main`'s
   bottom corners and inherited by the grid's outer padding box; the pane's own
   border follows via `border-bottom-left-radius` on the first-column/last-row
   slots — simplest correct version: round the GRID container's bottom corners +
   `overflow:hidden` there so pane borders clip cleanly along the curve. Both
   corners, rail edge included (the rail's bottom-left is the window's bottom-left).
4. **Every-state verification**: MOGGING_SHOT gains window-state variants (restored /
   maximized / fullscreen via `win.setFullScreen(true)`) — shots of the titlebar
   strip + bottom corners at each state, both themes; a probe asserts no element
   overflows the window bounds and the titlebar's right padding is ~sp-3 in
   fullscreen vs `env()`-reserved when restored.

## Files
- `src/ui/shell/titlebar.ts` + `app-shell.ts` · `src/ui/styles/global.css`
- `src/main/shell-chrome.ts` (windowState events) + `src/contracts` ShellChannels
- `src/main/shot.ts` (state variants) · gallery

## Definition of Done
- Command box dead-center of the WINDOW at any width; F11 shows a balanced bar with
  zero dead gap; restored windows show pane/rail borders following the rounded
  bottom corners — nothing reads "cut off"; maximized stays square and clean.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- SMOKE + PERCEPTION + the geometry probes green (titlebar + corner probes added);
  FLICKER green (chrome classes must not thrash layout).
- State-matrix shots (3 window states × 2 themes) in the gallery.

## Guardrails
- The native overlay integration (theme-tinted controls, drag regions) must keep
  working exactly as-is in restored/maximized — fullscreen only ADDS a class.
- Corner radii come from ONE token; panes never get individually-rounded corners
  except where the window curve forces it (the seams stay square 90°, per the
  standing terminal-chrome directive).
- No polling for window state — events only.

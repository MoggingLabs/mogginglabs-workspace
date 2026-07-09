import { app, Menu } from 'electron'

/**
 * The application menu is a POLICY, not a leftover. Until now the app never called
 * setApplicationMenu, so Electron installed its DEFAULT menu — invisible in this
 * frameless window, but its accelerators stayed live: Ctrl+W (close the window),
 * Ctrl+R / Ctrl+Shift+R (reload the whole multi-agent workspace), F11, Ctrl+Shift+I.
 * In an app whose panes host long-running agent CLIs, "Ctrl+R reloads the app" is a
 * standing accident. Those chords survive only where a shell chooses to use them.
 *
 * macOS keeps a real menu because it MUST: on mac, Cmd+C/Cmd+V in ordinary text
 * fields are dispatched by the Edit menu's roles — remove them and copy/paste dies
 * in every input in the app (the classic Electron gotcha). The terminal panes do not
 * depend on this: their paste rides the DOM `paste` event those same roles emit, and
 * the pane's capture listener owns that event (see terminal-pane.handleKey).
 *
 * Windows/Linux get NO menu: Chromium handles clipboard editing in text fields
 * natively there, so the menu bought nothing but the accident surface. What the
 * default menu genuinely provided — fullscreen, and devtools during development —
 * is re-provided deliberately in window.ts (F11 always; F12 / Ctrl+Shift+I in dev
 * builds only). Reload is deliberately NOT re-provided: Ctrl+R belongs to the
 * shells now (reverse-i-search), and a dev reloads from devtools.
 */
export function registerAppMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        // Reload / force-reload / devtools / zoom — development affordances. A packaged
        // app exposes none of them: Cmd+R mid-swarm is the accident this file exists for.
        ...(app.isPackaged ? [] : [{ role: 'viewMenu' as const }]),
        { role: 'windowMenu' }
      ])
    )
    return
  }
  Menu.setApplicationMenu(null)
}

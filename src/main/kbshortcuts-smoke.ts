import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated keyboard-shortcuts smoke (MOGGING_KBSHORTCUTS, UX audit KB-01).
// ? opens a grouped overlay of shortcuts; the SAME list renders on the
// Settings › Shortcuts page; the palette carries a "Keyboard shortcuts" command.
//
// THIS GATE PROVES THE LIST, NOT THE KEYS. It asserts the shortcuts are DOCUMENTED and never
// presses one of them, so it stayed green through a release in which every global chord was dead:
// finding 29's guard mistook xterm's hidden helper <textarea> for a text field, and nothing fired
// while a terminal had focus. Note the dispatch below goes to `window`, so `e.target` is the window
// rather than an element — it could not have caught that even if it had pressed the keys.
// The chords themselves are gated by KBGLOBAL (kbglobal-smoke.ts), which injects real keys over CDP
// and lets the app's own focus choose the target. Keep the two apart, and do not "cover shortcuts"
// by adding rows here.

export function runKbShortcutsSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'kbshortcuts-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES('window.__mogging.workspace.create({ name: "Alpha" })')
      await sleep(1200)

      // 1 ── ? opens the overlay with grouped rows.
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`)
      await sleep(400)
      const overlayRows = await ES<number>(`document.querySelectorAll('.modal-overlay .shortcuts-list .shortcuts-row').length`)
      const overlayHasKbd = await ES<boolean>(`!!document.querySelector('.modal-overlay .shortcuts-row-keys .kbd')`)
      const overlayOk = overlayRows >= 10 && overlayHasKbd

      // 2 ── Esc closes it.
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await sleep(300)
      const closedOk = !(await ES<boolean>(`!!document.querySelector('.modal-overlay')`))

      // 3 ── Settings › Shortcuts renders the same list on its own page.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="shortcuts"]')?.click(), 1)`)
      await sleep(300)
      const settingsPageOk = await ES<boolean>(
        `(() => { const s = document.querySelector('.settings-section[data-section="shortcuts"]'); return !!s && !s.hidden && s.querySelectorAll('.shortcuts-row').length >= 10 })()`
      )

      const pass = overlayOk && closedOk && settingsPageOk
      result = { pass, overlayRows, overlayHasKbd, closedOk, settingsPageOk }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

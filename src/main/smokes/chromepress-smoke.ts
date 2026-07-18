import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ShellChannels } from '@contracts'

// Env-gated native-chrome-press smoke (MOGGING_CHROMEPRESS, 2026-07-18). A press on the
// title bar's -webkit-app-region: drag strip (or the window-control overlay) never
// produces a DOM event — the OS takes the pointer first — so outside-click dismissers
// left popovers open when the user clicked the top bar. The fix: main forwards the press
// (Windows WM_NC*BUTTONDOWN via hookWindowMessage; will-move/will-resize everywhere) as
// shell:chromePress, and app-shell replays it as a synthetic body-target pointerdown.
// The contract this gate holds, end to end on the REAL window:
//   (a) on Windows the NC message hook is actually installed (isWindowMessageHooked);
//   (b) a chrome press closes a REAL open pane ⋯ menu through its own outside-closer;
//   (c) it also closes the title bar's usage popover (a different dismisser, same replay);
//   (d) a will-move burst collapses to ONE renderer delivery (the 150ms debounce).
// The press is injected as win.emit('will-move') — the same listener the OS invokes —
// so the gate bites: a dropped wireChromePress call in boot, a removed shell:chromePress
// channel (the preload allowlist refuses the replay listener), a lost app-shell replay,
// a lost NC hook, and any popover whose outside-close stops covering <body>.

export function runChromePressSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'chromepress-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  // The real gesture, minus the OS: fire the same window event wireChromePress listens
  // to. If boot never wired it, nothing is listening and every closure check fails.
  const press = (): void => {
    win.emit('will-move')
  }
  // Debounce-aware: the forwarder collapses signals inside 150ms, so distinct
  // presses in this gate are spaced past it.
  const pressAndSettle = async (): Promise<void> => {
    await sleep(200)
    press()
    await sleep(250)
  }
  const poll = async (js: string, tries = 20): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js)) return true
      await sleep(50)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Press', paneCount: 1 })`)
      await sleep(1500)

      // (a) Windows: the non-client mouse hooks are installed on the real window.
      const ncHooked =
        process.platform !== 'win32' ||
        ([0x00a1, 0x00a4, 0x00a7] as const).every((m) => win.isWindowMessageHooked(m))

      // Count deliveries through the REAL preload bridge — proves the channel is
      // allowlisted and actually arrives, and feeds the debounce check in (d).
      await ES(
        `(window.__cpCount = 0, window.bridge.on(${JSON.stringify(ShellChannels.chromePress)}, () => { window.__cpCount++ }), 1)`
      )

      // (b) The pane ⋯ menu: open it via its real button, then press native chrome.
      await ES(`(document.querySelector('.pane-act-menu').click(), 1)`)
      const paneMenuOpened = await poll(`(() => { const m = document.querySelector('.pane-menu'); return !!m && !m.hidden })()`)
      await pressAndSettle()
      const paneMenuClosed = await poll(`(() => { const m = document.querySelector('.pane-menu'); return !m || m.hidden })()`)

      // (c) The usage popover: a different feature's own outside-closer, same replay.
      await ES(`(document.querySelector('.usage-gauge').click(), 1)`)
      const usagePopOpened = await poll(`(() => { const p = document.querySelector('.usage-popover'); return !!p && !p.hidden })()`)
      await pressAndSettle()
      const usagePopClosed = await poll(`(() => { const p = document.querySelector('.usage-popover'); return !p || p.hidden })()`)

      // (d) A drag streams will-move every frame; the renderer must hear ONE signal.
      await sleep(300)
      await ES(`(window.__cpCount = 0, 1)`)
      press()
      press()
      press()
      await sleep(400)
      const burstCount = await ES<number>(`window.__cpCount`)
      const debounced = burstCount === 1

      const pass = ncHooked && paneMenuOpened && paneMenuClosed && usagePopOpened && usagePopClosed && debounced
      result = { pass, ncHooked, paneMenuOpened, paneMenuClosed, usagePopOpened, usagePopClosed, burstCount, debounced }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

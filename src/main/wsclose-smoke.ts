import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ControlChannels } from '@contracts'

// Env-gated workspace-close smoke (MOGGING_WSCLOSE, UX audit WS-01). Closing a
// workspace disposes every pane in it — so when a pane has live work it must
// confirm, and either way it soft-closes with a 5-second UNDO grace (the panes
// stay alive until the grace lapses). Drives the real UI:
//   busy pane -> × -> confirm dialog shows -> Cancel keeps it -> × -> Close ->
//   gone from the rail + Undo toast (panes still alive) -> Undo restores it ->
//   × -> Close -> let the grace lapse -> disposed for good.

export function runWsCloseSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'wsclose-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  const xClick = (wsId: string): Promise<unknown> =>
    ES(`(document.querySelector('.workspace-tab[data-ws-id="${wsId}"] .ws-close')?.click(), 1)`)
  const count = (): Promise<number> => ES<number>('window.__mogging.workspace.count()')

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES('window.__mogging.workspace.create({ name: "Alpha", paneCount: 3 })')
      await sleep(1500)
      const meta = await ES<{ id: string; ordinal: number }>('window.__mogging.workspace.active()')
      const wsId = meta.id
      const paneId = meta.ordinal * 100 + 1
      const pane2 = paneId + 1
      const pane3 = paneId + 2
      // Give the pane live work so the close must confirm.
      await ES(`window.__mogging.attention.setPaneState(${paneId}, 'busy')`)
      await ES(`window.__mogging.attention.setPaneState(${pane2}, 'busy')`)
      await ES(`window.__mogging.attention.setPaneState(${pane3}, 'busy')`)
      await ES(`window.__mogging.agents.adopt(${paneId}, 'codex', '')`)
      await ES(`window.__mogging.agents.adopt(${pane2}, 'codex', '')`)
      await ES(`window.__mogging.agents.adopt(${pane3}, 'codex', '')`)
      await sleep(300)

      // Pane chrome, validated control command, and layout shrink all share the
      // same live-work policy. Cancel each and prove no pane disappeared.
      await ES(`document.querySelector('.layout-slot[data-pane-id="${pane3}"] .pane-act-close')?.click()`)
      await sleep(300)
      const paneMouseAsked = await ES<boolean>(`!!document.querySelector('.modal .btn--danger')`)
      await ES(`document.querySelector('.modal .btn--ghost')?.click()`)
      await sleep(250)

      wc.send(ControlChannels.command, { verb: 'close-pane', paneId: pane3 })
      await sleep(300)
      const controlAsked = await ES<boolean>(`!!document.querySelector('.modal .btn--danger')`)
      await ES(`document.querySelector('.modal .btn--ghost')?.click()`)
      await sleep(250)

      await ES(`(window.__mogging.layout.apply(1), 1)`)
      await sleep(300)
      const shrinkAsked = await ES<boolean>(`!!document.querySelector('.modal .btn--danger')`)
      await ES(`document.querySelector('.modal .btn--ghost')?.click()`)
      await sleep(250)
      const cancelsKeptThree = (await ES<number>(`window.__mogging.layout.paneCount()`)) === 3

      await ES(`(window.__mogging.layout.apply(1), 1)`)
      await sleep(300)
      await ES(`document.querySelector('.modal .btn--danger')?.click()`)
      await sleep(500)
      const confirmedShrink = (await ES<number>(`window.__mogging.layout.paneCount()`)) === 1

      // The last pane path becomes the workspace policy (soft close), but the
      // confirmation still precedes any mutation.
      await ES(`document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-act-close')?.click()`)
      await sleep(300)
      const lastPaneAsked = await ES<boolean>(`!!document.querySelector('.modal .btn--danger')`)
      await ES(`document.querySelector('.modal .btn--ghost')?.click()`)
      await sleep(250)

      // Keyboard Delete on the rail is the same policy, not a hard-close path.
      await ES(`(() => { const tab = document.querySelector('.workspace-tab[data-ws-id="${wsId}"]'); tab?.focus(); tab?.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true})) })()`)
      await sleep(300)
      const keyboardAsked = await ES<boolean>(`!!document.querySelector('.modal .btn--danger')`)
      await ES(`document.querySelector('.modal .btn--ghost')?.click()`)
      await sleep(250)
      const allEntryPointsSafe =
        paneMouseAsked && controlAsked && shrinkAsked && cancelsKeptThree &&
        confirmedShrink && lastPaneAsked && keyboardAsked

      // 1 ── × on a workspace with live work opens the confirm dialog.
      await xClick(wsId)
      await sleep(400)
      const dialogShown = await ES<boolean>(`!!document.querySelector('.modal[role="dialog"] .btn--danger')`)

      // 2 ── Cancel keeps the workspace (nothing closed).
      await ES(`(document.querySelector('.modal .btn--ghost')?.click(), 1)`)
      await sleep(400)
      const cancelKept = (await count()) === 1 && !(await ES<boolean>(`!!document.querySelector('.modal-overlay')`))

      // 3 ── × again -> Close -> soft-closed: gone from the rail + an Undo toast.
      await xClick(wsId)
      await sleep(400)
      await ES(`(document.querySelector('.modal .btn--danger')?.click(), 1)`)
      await sleep(500)
      const goneFromRail = (await count()) === 0
      const tabHidden = await ES<boolean>(`(() => { const t = document.querySelector('.workspace-tab[data-ws-id="${wsId}"]'); return !t || t.hidden })()`)
      const undoToast = await ES<boolean>(`!!document.querySelector('.toast-action')`)
      const softClosed = goneFromRail && tabHidden && undoToast

      // 4 ── Undo restores it (its panes never stopped).
      await ES(`(document.querySelector('.toast-action')?.click(), 1)`)
      await sleep(500)
      const restored = (await count()) === 1 && !(await ES<boolean>(`(() => { const t = document.querySelector('.workspace-tab[data-ws-id="${wsId}"]'); return !t || t.hidden })()`))

      // 5 ── Close again and let the 5s grace lapse -> disposed for good.
      await xClick(wsId)
      await sleep(400)
      await ES(`(document.querySelector('.modal .btn--danger')?.click(), 1)`)
      await sleep(6200)
      const disposed = (await count()) === 0 && !(await ES<boolean>(`!!document.querySelector('.workspace-tab[data-ws-id="${wsId}"]')`))

      const pass = allEntryPointsSafe && dialogShown && cancelKept && softClosed && restored && disposed
      result = {
        pass,
        allEntryPointsSafe,
        paneMouseAsked,
        controlAsked,
        shrinkAsked,
        cancelsKeptThree,
        confirmedShrink,
        lastPaneAsked,
        keyboardAsked,
        dialogShown,
        cancelKept,
        softClosed,
        restored,
        disposed
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

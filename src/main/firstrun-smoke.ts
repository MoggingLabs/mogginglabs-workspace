import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated first-run + update-UX smoke (MOGGING_FIRSTRUN, Phase-6/06). Runs with
// MOGGING_FAKE_UPDATE=9.9.9 set by the harness so the update lifecycle replays
// with no network.
//   1. fresh state -> the "Get set up" card is present; row 1 reflects REAL
//      detection (claude is on this dev machine) and row 2 (first workspace) is
//      incomplete
//   2. create a workspace via the dev handle -> row 2 flips done (poll DOM)
//   3. dismiss -> card gone -> refresh -> STAYS gone (persisted in localStorage)
//   4. update flow: the titlebar dot appears during the fake download, then ONE
//      ready toast with BOTH "Restart now" and "Later"; clicking Later dismisses
//      it and it does not re-toast (poll)
export function runFirstRunSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'firstrun-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  // localStorage is shared across a MOGGING_USERDATA iso dir? No — it's per
  // renderer origin, persisted in the userData partition. A fresh iso dir = fresh
  // storage. Clear defensively so the smoke starts truly first-run.
  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await ES(`try{localStorage.removeItem('mogging.firstrun.dismissed')}catch{}`)
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(800)

      const cardPresent = (): Promise<boolean> => ES<boolean>(`!document.querySelector('.firstrun-card').hidden`)
      const rowDone = (i: number): Promise<boolean> =>
        ES<boolean>(`!!document.querySelectorAll('.firstrun-row')[${i}]?.classList.contains('is-done')`)

      const shown = await cardPresent()
      // Row ① must reflect DETECTION TRUTHFULLY, not a fixed answer: its done
      // state equals whether ANY agent CLI is actually on PATH. True on a dev
      // machine (claude installed -> done) AND on CI (nothing installed -> not
      // done, correctly, with install hints shown). Platform-condition the
      // probe, never the claim (the 6/01 TEMPLATE lesson).
      const anyCliInstalled = await ES<boolean>(
        `window.bridge.invoke('agents:detect').then(a => (a||[]).some(x => x.installed))`
      )
      const cliRowDone = await rowDone(0)
      const cliHonest = cliRowDone === anyCliInstalled
      const wsIncomplete = !(await rowDone(1))

      // 2. Create a workspace -> the workspace row advances. On a machine WITH an agent
      // CLI that completes the REQUIRED set, so the card self-dismisses (8.5/06 fixed
      // bug #1: there is no longer an immortal non-optional power-up row blocking it) —
      // and a dismissal IS the row going done. Without a CLI the card stays and row ②
      // visibly ticks. Either is the row advancing; only the pre-06 bug kept it open here.
      await ES(`window.__mogging.workspace.create({ name: 'FR' })`)
      await sleep(400)
      await ES(`window.__mogging.firstrun.refresh()`)
      let wsFlips = false
      for (let i = 0; i < 20 && !wsFlips; i++) {
        wsFlips = (await rowDone(1)) || !(await cardPresent())
        if (!wsFlips) await sleep(300)
      }

      // 3. Dismiss -> gone -> refresh -> stays gone.
      await ES(`document.querySelector('.firstrun-dismiss').click()`)
      await sleep(300)
      const goneAfterDismiss = !(await cardPresent())
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(400)
      const staysGone = !(await cardPresent())

      // 4. Update flow (MOGGING_FAKE_UPDATE replays checking->downloading->ready).
      // The dot appears during download; poll for it.
      let sawDot = false
      for (let i = 0; i < 30 && !sawDot; i++) {
        sawDot = await ES<boolean>(`!document.querySelector('.update-dot').hidden`)
        if (!sawDot) await sleep(300)
      }
      // The ready toast, with BOTH actions.
      let toastOk = false
      for (let i = 0; i < 40 && !toastOk; i++) {
        toastOk = await ES<boolean>(
          `(() => { const t = [...document.querySelectorAll('.toast')].find(t => /is ready/.test(t.textContent||'')); if(!t) return false; const labels = [...t.querySelectorAll('.toast-action')].map(b=>b.textContent); return labels.includes('Restart now') && labels.includes('Later'); })()`
        )
        if (!toastOk) await sleep(300)
      }
      // Click Later -> toast dismisses and does not return.
      await ES(
        `(() => { const t=[...document.querySelectorAll('.toast')].find(t=>/is ready/.test(t.textContent||'')); const later=[...(t?.querySelectorAll('.toast-action')||[])].find(b=>b.textContent==='Later'); later&&later.click(); })()`
      )
      await sleep(1200)
      let reappeared = false
      for (let i = 0; i < 20 && !reappeared; i++) {
        reappeared = await ES<boolean>(`[...document.querySelectorAll('.toast')].some(t=>/is ready/.test(t.textContent||''))`)
        if (reappeared) break
        await sleep(400)
      }
      const laterSticks = !reappeared

      const pass = shown && cliHonest && wsIncomplete && wsFlips && goneAfterDismiss && staysGone && sawDot && toastOk && laterSticks
      result = { pass, shown, anyCliInstalled, cliRowDone, cliHonest, wsIncomplete, wsFlips, goneAfterDismiss, staysGone, sawDot, toastOk, laterSticks }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3500))
  else setTimeout(() => void run(), 3500)
}

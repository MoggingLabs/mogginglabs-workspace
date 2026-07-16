import { app, BrowserWindow, shell } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockdownDebug } from '../window'

// Env-gated renderer-lockdown smoke (MOGGING_LOCKDOWN, ADR 0015 §hardening):
//   (a) the CSP ships as a response HEADER on the app document (main-side ground
//       truth: the onHeadersReceived hook fired for the main frame), includes
//       connect-src 'none', and byte-matches the index.html meta tag — one policy,
//       two carriers, zero drift
//   (b) the trusted renderer is INERT outward: fetch() rejects, location=<remote>
//       is denied (url unchanged, guard recorded it), window.open is denied (no
//       second window, guard recorded it) — and the fixture server counts ZERO
//       hits from any of it, so "denied" means denied at the source, not 404'd
//   (c) the webview browser dock is UNAFFECTED: its guest still navigates to the
//       fixture normally under the strict embedder CSP (its own partition/guards,
//       docs/13 posture untouched)
//   (d) shell.openExternal still works through the ONE sanctioned hop — the
//       browser:openExternal IPC handler — captured at the shell seam (usageglance's
//       stub pattern; no real browser ever opens under a gate)
// The fixture page is served by THIS smoke on 127.0.0.1 — no external network, ever.
const PAGE_TITLE = 'MOG_LOCKDOWN_TEST_4243'

export function runLockdownSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null
  const hits: Record<string, number> = {}

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'lockdown-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        const path = String(req.url ?? '/')
        hits[path] = (hits[path] ?? 0) + 1
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>${PAGE_TITLE}</title><h1>lockdown fixture</h1>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      const base = `http://127.0.0.1:${port}`
      const dbg = lockdownDebug()

      // ── (a) The header carrier: fired for the app document, strict, meta-equal ──
      const headerFired = dbg.headerHits >= 1
      const headerStrict = dbg.policy.includes("connect-src 'none'")
      const meta = await ES<string>(
        `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''`
      )
      // Under a gate the dev relax is off (MOGGING_USERDATA is set), so the meta the
      // document carries must BE the header policy — the no-drift assertion.
      const metaMatches = meta === dbg.policy
      const headerOk = headerFired && headerStrict && metaMatches

      // ── (b) The renderer is inert outward ────────────────────────────────────
      const fetchProbe = await ES<string>(
        `fetch('${base}/xhr').then(() => 'REACHED').catch((e) => 'blocked:' + String(e).slice(0, 60))`
      )
      const fetchBlocked = fetchProbe.startsWith('blocked:')

      const urlBefore = wc.getURL()
      await ES(`{ location.href = '${base}/evil'; 'attempted' }`)
      await sleep(800)
      const navDenied = wc.getURL() === urlBefore && dbg.deniedNavs.some((u) => u.includes('/evil'))

      await ES(`{ window.open('${base}/pop'); 'attempted' }`)
      await sleep(800)
      const openDenied = BrowserWindow.getAllWindows().length === 1 && dbg.deniedOpens.some((u) => u.includes('/pop'))

      // Denied at the SOURCE: none of the three probes ever produced a request.
      const zeroLeaks = !hits['/xhr'] && !hits['/evil'] && !hits['/pop']
      const rendererAlive = (await ES<string>(`document.getElementById('root') ? 'alive' : 'gone'`)) === 'alive'
      const inertOk = fetchBlocked && navDenied && openDenied && zeroLeaks && rendererAlive

      // ── (c) The dock still browses: guest navigation is not this document's ──
      await ES(`window.__mogging.workspace.create({ name: 'Lockdown' })`)
      await sleep(2000)
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(600)
      await ES(`window.__mogging.browser.navigate('127.0.0.1:${port}/dock')`)
      let dockOk = false
      for (let i = 0; i < 30 && !dockOk; i++) {
        await sleep(400)
        dockOk = (await ES<{ title: string }>('window.__mogging.browser.state()')).title === PAGE_TITLE
      }
      const dockServed = (hits['/dock'] ?? 0) >= 1

      // ── (d) The sanctioned hop: browser:openExternal -> shell.openExternal ───
      // Captured at the shell seam so no real browser opens (usageglance's pattern).
      const shellRef = shell as unknown as { openExternal: (u: string) => Promise<void> }
      const origOpen = shellRef.openExternal
      let opened = ''
      shellRef.openExternal = (u: string): Promise<void> => {
        opened = u
        return Promise.resolve()
      }
      await ES(`window.bridge.invoke('browser:openExternal', { url: 'https://example.com/sanctioned' })`)
      await sleep(500)
      shellRef.openExternal = origOpen
      const externalOk = opened === 'https://example.com/sanctioned'

      const pass = headerOk && inertOk && dockOk && dockServed && externalOk
      result = {
        pass,
        headerFired,
        headerStrict,
        metaMatches,
        policy: dbg.policy,
        fetchProbe,
        navDenied,
        openDenied,
        zeroLeaks,
        rendererAlive,
        dockOk,
        dockServed,
        externalOk,
        deniedNavs: dbg.deniedNavs,
        deniedOpens: dbg.deniedOpens,
        hits
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    server?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

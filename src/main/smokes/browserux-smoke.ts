import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserChannels, DEFAULT_SEARCH_TEMPLATE } from '@contracts'

// Env-gated browser-CHROME smoke (MOGGING_BROWSERUX, Wave 3): the renderer-side
// "feels like Comet" surface, driven through the dock's own controls.
//   1. Omnibox (F3): a scheme-less host navigates (http for a dev server); a query
//      resolves to the search engine; github.com resolves https.
//   2. Header truth (F13): an http page shows the "not secure" indicator; a favicon
//      is captured; Reload becomes Stop while loading.
//   3. Find in page (F5): the bar opens, a query reports match counts.
//   4. Zoom (F6): Ctrl+= grows the page, Ctrl+0 resets — persisted per workspace.
//   5. Load error (F10): a dead address shows the error overlay, not a blank frame.
//   6. Context menu (F7): main's forwarded right-click draws the house menu.
//   7. Shortcut relay (F12): a chord pressed "in the guest" toggles the dock.
// Served locally on 127.0.0.1 — no external network, ever.

const FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAX9ttrJ7AAAAAElFTkSuQmCC'

export function runBrowserUxSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  win.setSize(1200, 800)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browserux-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        // A page with a favicon, lots of a findable word, and a MIDI request (which
        // the deny-all handler refuses → the honest permission chip, F16). The
        // fixture permission has been through three shapes, each for a reason:
        // geolocation dies OS-side on macOS (Core Location is consulted BEFORE
        // Electron's request handler — run 29577387596); notifications short-circuit
        // on the SECOND request (Notification.requestPermission reads the permission
        // STATUS first, our deny-all CHECK handler answers 'denied', and Blink
        // resolves without consulting the request handler — green once then blank,
        // run 29581633948). requestMIDIAccess has neither: no OS service in front,
        // no status short-circuit — every call reaches the request handler, on
        // every platform, every navigation.
        res.end(
          `<!doctype html><title>UX</title><link rel="icon" href="${FAVICON}">` +
            `<body>${'<p>MATCHWORD here</p>'.repeat(6)}` +
            `<script>try{navigator.requestMIDIAccess({sysex:true}).catch(function(){})}catch(e){}</script></body>`
        )
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const B = 'window.__mogging.browser'

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      await ES(`window.__mogging.workspace.create({ name: 'UX' })`)
      await sleep(1500)
      await ES(`${B}.toggle(true)`)
      await sleep(500)
      // The chip RECORDER, armed before the first navigation: the fixture page
      // requests its permission on EVERY load, and the chip paints on every denial —
      // but whether a RE-request reaches the handler is Chromium permission-cache
      // weather (geolocation, notifications and MIDI each went green-then-blank
      // across runs 29577387596/29581633948/29584991490 on the SECOND request
      // only). The claim is 'deny-all refuses and the chrome says so honestly' —
      // one observed chip proves it; this records every appearance, first load
      // included, so stage 8 is no longer hostage to the re-request lottery.
      await ES(`(() => {
        window.__mogPermSeen = window.__mogPermSeen || []
        if (!window.__mogPermSeenTimer) {
          window.__mogPermSeenTimer = setInterval(() => {
            try {
              const t = ${B}.permChipText()
              if (t && !window.__mogPermSeen.includes(t)) window.__mogPermSeen.push(t)
            } catch { /* chip not mounted yet */ }
          }, 100)
        }
        return 1
      })()`)

      // ── 1. Omnibox resolution (pure, no network) ─────────────────────────
      const searchResolved = await ES<string | null>(`${B}.omniboxResolve('hello world')`)
      const httpsResolved = await ES<string | null>(`${B}.omniboxResolve('github.com')`)
      const localResolved = await ES<string | null>(`${B}.omniboxResolve('127.0.0.1:${port}')`)
      const omniboxOk =
        searchResolved === DEFAULT_SEARCH_TEMPLATE.replace('%s', encodeURIComponent('hello world')) &&
        httpsResolved === 'https://github.com/' &&
        localResolved === `http://127.0.0.1:${port}/`

      // Omnibox WIRING: submit a bare host → it navigates the guest.
      await ES(`${B}.omniboxSubmit('127.0.0.1:${port}')`)
      let navigated = false
      for (let i = 0; i < 30 && !navigated; i++) {
        await sleep(400)
        navigated = (await ES<{ url: string }>(`${B}.state()`)).url.includes(`127.0.0.1:${port}`)
      }

      // ── 2. Header truth ──────────────────────────────────────────────────
      const leadClass = await ES<string>(`${B}.urlLeadClass()`)
      const insecureShown = leadClass.includes('is-insecure') // http page
      let faviconCaptured = false
      for (let i = 0; i < 15 && !faviconCaptured; i++) {
        await sleep(300)
        faviconCaptured = !!(await ES<string | null>(`${B}.faviconCaptured()`))
      }

      // ── 3. Find in page ──────────────────────────────────────────────────
      await sleep(600) // let the page settle so the first find has content to match
      const hasGuest = await ES<boolean>(`${B}.hasActiveGuest()`)
      await ES(`${B}.openFind()`)
      const findVisible = await ES<boolean>(`${B}.findVisible()`)
      const findReqId = await ES<number>(`${B}.findRaw('MATCHWORD')`) // proves the guest method runs
      await ES(`${B}.findType('MATCHWORD')`)
      let findCount = ''
      for (let i = 0; i < 24 && !/\d/.test(findCount); i++) {
        await sleep(250)
        findCount = await ES<string>(`${B}.findCountText()`)
      }
      const findOk = findVisible && findReqId > 0 && /\/\s*[1-9]/.test(findCount.replace(/\s/g, '')) // "n/m", m>=1
      await ES(`${B}.closeFind()`)

      // ── 4. Zoom ──────────────────────────────────────────────────────────
      const zoom0 = await ES<number>(`${B}.zoomFactor()`)
      await ES(`${B}.bumpZoom(1)`)
      await sleep(200)
      const zoom1 = await ES<number>(`${B}.zoomFactor()`)
      await ES(`${B}.bumpZoom('reset')`)
      await sleep(200)
      const zoom2 = await ES<number>(`${B}.zoomFactor()`)
      const zoomOk = zoom1 > zoom0 + 0.05 && Math.abs(zoom2 - 1) < 0.02

      // ── 5. Load error overlay ────────────────────────────────────────────
      // Port 9 (discard) refuses fast → a main-frame load failure.
      await ES(`${B}.navigate('http://127.0.0.1:9/')`)
      let errorVisible = false
      for (let i = 0; i < 25 && !errorVisible; i++) {
        await sleep(300)
        errorVisible = await ES<boolean>(`${B}.errorVisible()`)
      }

      // ── 6. Context menu (F7): main forwards a right-click ─────────────────
      const wsId = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id
      win.webContents.send(BrowserChannels.contextMenu, {
        workspaceId: wsId,
        x: 40,
        y: 40,
        linkURL: 'https://example.com/',
        srcURL: '',
        selectionText: 'picked',
        isEditable: false
      })
      await sleep(300)
      const contextMenuOk = await ES<boolean>(`${B}.contextMenuOpen()`)
      // Dismiss the menu so it can't eat the next events.
      await ES(`document.body.click()`)

      // ── 7. Shortcut relay (F12): a chord "in the guest" toggles the dock ──
      const openBefore = await ES<boolean>(`${B}.isOpen()`)
      win.webContents.send(BrowserChannels.guestChord, {
        workspaceId: wsId,
        code: 'KeyU',
        key: 'u',
        ctrl: true,
        meta: false,
        shift: true,
        alt: false
      })
      await sleep(400)
      const openAfter = await ES<boolean>(`${B}.isOpen()`)
      const relayOk = openBefore === true && openAfter === false

      // ── 8. Permission chip (F16): the page's MIDI request was denied,
      //       and the chip says so honestly ────────────────────────────────────
      // Re-navigate to the main page (arm 5 left the guest on the error page) so the
      // MIDI request fires again.
      await ES(`${B}.navigate('127.0.0.1:${port}')`)
      let permChipText = ''
      // 15s, not 6: the guest reload + its permission re-request + the chip paint is
      // three async legs, and the shared-vCPU macos runner is BIMODAL (ci.yml) — the
      // slow mode blew the old budget with the product correct (run 29547052949).
      // Green runs exit this poll in a beat either way.
      for (let i = 0; i < 50 && !/Blocked/.test(permChipText); i++) {
        await sleep(300)
        permChipText = await ES<string>(`${B}.permChipText()`)
      }
      // The live poll first; the recorder's log second (a chip observed on ANY load
      // is the deny-all → honest-chip claim proven — see the recorder's comment).
      const permSeen = await ES<string[]>(`(window.__mogPermSeenTimer && clearInterval(window.__mogPermSeenTimer), window.__mogPermSeen || [])`)
      const permChipOk = /Blocked: MIDI/.test(permChipText) || permSeen.some((t) => /Blocked: MIDI/.test(t))

      // ── 9. Pins + recents (F14): navigation records a recent; pinning persists ──
      const recentsCount = await ES<number>(`${B}.recentsCount()`)
      await ES(`${B}.pinCurrent()`)
      const isPinned = await ES<boolean>(`${B}.isPinnedCurrent()`)
      await ES(`${B}.forceRenderChips()`)
      const chipHosts = await ES<string[]>(`${B}.quickChipHosts()`)
      const pinsRecentsOk = recentsCount >= 1 && isPinned && chipHosts.some((h) => h.includes('127.0.0.1'))

      // ── 10. Hardening (S1): a webview on a foreign partition is refused attach ──
      const rogueAttached = await ES<boolean>(`${B}.probeRogueWebview()`)
      const attachGuardOk = rogueAttached === false

      const pass =
        omniboxOk && navigated && insecureShown && faviconCaptured && findOk && zoomOk && errorVisible &&
        contextMenuOk && relayOk && permChipOk && pinsRecentsOk && attachGuardOk
      result = {
        pass,
        omniboxOk,
        resolved: { searchResolved, httpsResolved, localResolved },
        navigated,
        insecureShown,
        leadClass,
        faviconCaptured,
        findOk,
        findCount,
        findDiag: { hasGuest, findVisible, findReqId },
        zoomOk,
        zoom: { zoom0, zoom1, zoom2 },
        errorVisible,
        contextMenuOk,
        relayOk,
        permChipOk,
        permChipText,
        permSeen,
        pinsRecentsOk,
        pinsDiag: { recentsCount, isPinned, chipHosts },
        attachGuardOk
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

void BrowserWindow

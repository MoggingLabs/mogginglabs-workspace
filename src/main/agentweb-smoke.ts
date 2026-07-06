import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentAct,
  agentControlDebug,
  browserDriver,
  confirmPendingActOrigin,
  destroyAgentWebViewForSmoke,
  dockPageEval,
  setAgentConsent,
  setAgentWebVaultProbeForSmoke,
  signedInSitesForSmoke,
  forgetSiteForSmoke
} from './browser-dock'
import { getSettingsStore } from './app-settings'
import { setIntegrationsGrant } from './integrations'
import type { BrowserAgentResult, BrowserAgentVerb } from '@contracts'

// Env-gated agent-web-profile smoke (MOGGING_AGENTWEB, Phase-8/04 — FINDINGS
// Branch C, ADR 0008.e/h). A localhost fixture site (cookie login + a
// state-changing button; a second port = the foreign origin), asserted a–h:
//   (a) the PREVIEW profile is the shipped behavior, byte-for-byte;
//   (b) agent-web ungranted: reads (snapshot) work, ACTS refuse naming grant
//       + origin — and navigate counts as an act;
//   (c) granted + session-confirmed: the click LANDS (with the pending-confirm
//       handshake asserted through the real renderer button);
//   (d) crossing origins raises the origin-change alert;
//   (e) a blocklisted pattern (test-only env) is refused at SAVE and at
//       DISPATCH even when force-persisted — the blocklist beats the grant;
//   (f) forget-site kills the session (logged-out on reload);
//   (g) the login cookie survives view destruction (vault-backed persistence);
//   (h) the vault-less arm (probe hook) gets a NON-persist partition + the
//       honest copy rendered in the chrome.
// Zero external network: both origins are THIS smoke's own 127.0.0.1 servers.

export function runAgentWebSmoke(win: BrowserWindow, mode?: string): void {
  const dev = mode === 'DEV'
  if (!dev) setTimeout(() => app.exit(1), 150000) // safety net (DEV holds on purpose)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const servers: Server[] = []

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'agentweb-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  /** The fixture site: cookie session + a state-changing button. */
  const serveSite = (label: string): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        const loggedIn = /(?:^|;\s*)sid=4242(?:;|$)/.test(String(req.headers.cookie ?? ''))
        res.writeHead(200, { 'content-type': 'text/html' })
        if (!loggedIn) {
          res.end(
            `<!doctype html><title>${label}</title><div id="who">LOGGED_OUT_${label}</div>` +
              `<button id="login" onclick="document.cookie='sid=4242; max-age=86400'; location.reload()">Log in</button>`
          )
          return
        }
        res.end(
          `<!doctype html><title>${label}</title><div id="who">LOGGED_IN_${label}</div>` +
            `<button id="act" onclick="var d=document.createElement('div');d.id='acted';d.textContent='ACTED_4242';document.body.appendChild(d)">Do the thing</button>`
        )
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        servers.push(server)
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const act = (v: BrowserAgentVerb): Promise<BrowserAgentResult> => agentAct(v)
  const pageText = async (): Promise<string> => String((await dockPageEval(`document.body.innerText`)) ?? '')
  const clickInPage = (sel: string): Promise<unknown> | null =>
    dockPageEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)
  const refFor = async (name: string): Promise<string> => {
    const snap = await act({ verb: 'snapshot' })
    return snap.nodes?.find((n) => n.name.includes(name))?.ref ?? ''
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const portA = await serveSite('A')
      const portB = await serveSite('B')
      const originA = `http://127.0.0.1:${portA}`
      const originB = `http://127.0.0.1:${portB}`

      await ES(`window.__mogging.workspace.create({ name: 'Web' })`)
      await sleep(1500)
      const wsId = ((await ES('window.__mogging.workspace.active()')) as { id: string }).id
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      setAgentConsent(true, wsId)

      // ── (a) PREVIEW: the shipped behavior — acts ungated by origins ────────
      await act({ verb: 'navigate', target: originA })
      await sleep(1200)
      const loginRef = await refFor('Log in')
      const previewClick = await act({ verb: 'click', target: loginRef })
      await sleep(1200)
      const previewOk =
        agentControlDebug().profile === 'preview' && previewClick.ok && (await pageText()).includes('LOGGED_IN_A')

      // ── Switch to agent-web (through the real renderer chrome) ────────────
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(800)
      const switched =
        agentControlDebug().profile === 'agent-web' &&
        ((await ES(`window.__mogging.browser.profile()`)) as string) === 'agent-web'

      // The HUMAN navigates + signs in (on purpose, inside the dock).
      browserDriver.navigate(originA)
      await sleep(1200)
      const separated = (await pageText()).includes('LOGGED_OUT_A') // preview's login never bleeds over
      await clickInPage('#login')
      await sleep(1200)
      const signedIn = (await pageText()).includes('LOGGED_IN_A')

      // ── (b) Ungranted: reads work, acts refuse naming grant + origin ───────
      const readSnap = await act({ verb: 'snapshot' })
      const ungrantedRead = readSnap.ok === true && (readSnap.text ?? '').includes('LOGGED_IN_A')
      const actRef = await refFor('Do the thing')
      const ungrantedClick = await act({ verb: 'click', target: actRef })
      const ungrantedNav = await act({ verb: 'navigate', target: originB })
      const ungrantedRefused =
        !ungrantedClick.ok && /ungranted origin/.test(ungrantedClick.reason ?? '') &&
        (ungrantedClick.reason ?? '').includes(originA) && /grant/.test(ungrantedClick.reason ?? '') &&
        !ungrantedNav.ok && /ungranted origin/.test(ungrantedNav.reason ?? '')

      // ── (c) Granted + confirmed: the click lands ───────────────────────────
      setIntegrationsGrant({ workspaceId: wsId, writeTools: 'none', web: 'signed-in', actOrigins: [originA] })
      const needsConfirm = await act({ verb: 'click', target: actRef })
      await sleep(500)
      const confirmPending =
        !needsConfirm.ok && /awaiting the human/.test(needsConfirm.reason ?? '') &&
        agentControlDebug().pendingConfirm === originA &&
        ((await ES(`window.__mogging.browser.pendingConfirm()`)) as string | null) === originA
      await ES(`window.__mogging.browser.confirmPending()`)
      await sleep(500)
      const confirmedClick = await act({ verb: 'click', target: actRef })
      await sleep(400)
      const actedLanded = confirmedClick.ok && (await pageText()).includes('ACTED_4242')

      // ── (d) Origin change raises the alert ─────────────────────────────────
      browserDriver.navigate(originB)
      await sleep(1500)
      const alertText = (await ES(`window.__mogging.browser.originAlertText()`)) as string
      const originAlertOk = alertText.includes(originB) && alertText.includes(originA)

      // ── (e) The blocklist, both ends ───────────────────────────────────────
      process.env.MOGGING_TEST_BLOCK_ORIGIN = `127.0.0.1:${portB}`
      const savedBlocked = setIntegrationsGrant({
        workspaceId: wsId,
        writeTools: 'none',
        web: 'signed-in',
        actOrigins: [originA, originB]
      })
      const editorRefused = !!savedBlocked && !savedBlocked.actOrigins.includes(originB) && savedBlocked.actOrigins.includes(originA)
      // Force-persist the blocked origin (stale/hostile state) — dispatch must
      // still refuse: the blocklist beats anything persisted.
      getSettingsStore()?.setSetting(
        `integrations.grant.${wsId}`,
        JSON.stringify({ workspaceId: wsId, writeTools: 'none', web: 'signed-in', actOrigins: [originA, originB] })
      )
      const bRef = await refFor('Log in') // page B renders logged-out (its own origin's cookie jar)
      const blockedClick = await act({ verb: 'click', target: bRef || 'button' })
      const dispatchRefused = !blockedClick.ok && /blocked origin/.test(blockedClick.reason ?? '')
      delete process.env.MOGGING_TEST_BLOCK_ORIGIN

      // ── (g) The login survives view destruction (vault-backed persistence) ─
      const sitesBefore = await signedInSitesForSmoke()
      const sitesListed = sitesBefore.some((s) => s.host === '127.0.0.1' && s.cookies > 0)
      await destroyAgentWebViewForSmoke()
      await sleep(300)
      browserDriver.navigate(originA)
      await sleep(1500)
      const cookieSurvived = (await pageText()).includes('LOGGED_IN_A')

      // ── (f) Forget-site kills the session ──────────────────────────────────
      await forgetSiteForSmoke('127.0.0.1')
      await sleep(300)
      browserDriver.nav('reload')
      await sleep(1200)
      const forgotten = (await pageText()).includes('LOGGED_OUT_A')

      // ── (h) The vault-less arm: non-persist partition + the honest copy ────
      setAgentWebVaultProbeForSmoke(() => false)
      await destroyAgentWebViewForSmoke()
      await ES(`window.__mogging.browser.setProfile('preview')`)
      await sleep(400)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(600)
      browserDriver.navigate(originA)
      await sleep(1200)
      const dbg = agentControlDebug()
      const noteText = (await ES(`window.__mogging.browser.agentWebNote()`)) as string
      const vaultlessOk =
        dbg.agentWebPersists === false && /No at-rest encryption/.test(noteText) && /until the dock closes/.test(noteText)
      setAgentWebVaultProbeForSmoke(null)

      const pass =
        previewOk && switched && separated && signedIn &&
        ungrantedRead && ungrantedRefused &&
        confirmPending && actedLanded &&
        originAlertOk && editorRefused && dispatchRefused &&
        sitesListed && cookieSurvived && forgotten && vaultlessOk
      result = {
        pass,
        previewOk,
        switched,
        separated,
        signedIn,
        ungrantedRead,
        ungrantedRefused,
        ungrantedReason: ungrantedClick.reason,
        confirmPending,
        actedLanded,
        originAlertOk,
        editorRefused,
        dispatchRefused,
        blockedReason: blockedClick.reason,
        sitesListed,
        cookieSurvived,
        forgotten,
        vaultlessOk,
        noteText
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    for (const s of servers) s.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  // ── DEV mode: the REAL-SITE dev-verify world (books). Builds the agent-web
  // profile against a real external site (default: saucedemo.com — a public
  // demo site with published credentials, made for automation), performs the
  // HUMAN's login as scripted keystrokes (stated in the books), then HOLDS.
  // Touching out/agentweb-dev-grant.flag grants the origin and arms a
  // 60-second auto-confirm loop standing in for the human's banner click —
  // the renderer-button path itself is asserted by the smoke arm above.
  const runDev = async (): Promise<void> => {
    const site = process.env.MOGGING_DEV_SITE || 'https://www.saucedemo.com'
    const origin = new URL(site).origin
    await sleep(1500)
    await ES(`window.__mogging.workspace.create({ name: 'Web' })`)
    await sleep(1500)
    const wsId = ((await ES('window.__mogging.workspace.active()')) as { id: string }).id
    await ES('window.__mogging.browser.toggle(true)')
    await sleep(500)
    await ES(`window.__mogging.browser.setProfile('agent-web')`)
    await sleep(600)
    setAgentConsent(true, wsId)
    browserDriver.navigate(site)
    await sleep(4000)
    // The human's login (scripted): saucedemo's demo credentials, React-safe.
    await dockPageEval(`(() => {
      const set = (sel, val) => {
        const el = document.querySelector(sel)
        if (!el) return false
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const a = set('#user-name', 'standard_user')
      const b = set('#password', 'secret_sauce')
      const btn = document.querySelector('#login-button')
      if (a && b && btn) btn.click()
      return a && b && !!btn
    })()`)
    await sleep(3000)
    const flag = join(app.getAppPath(), 'out', 'agentweb-dev-grant.flag')
    writeFileSync(join(app.getAppPath(), 'out', 'agentweb-dev.json'), JSON.stringify({ held: true, wsId, origin, flag }, null, 2))
    // Hold: poll for the grant flag, then auto-confirm pending acts for 60 s.
    for (;;) {
      await sleep(1000)
      if (!existsSync(flag)) continue
      setIntegrationsGrant({ workspaceId: wsId, writeTools: 'none', web: 'signed-in', actOrigins: [origin] })
      for (let i = 0; i < 60; i++) {
        await sleep(1000)
        const pending = agentControlDebug().pendingConfirm
        if (pending === origin) confirmPendingActOrigin(origin)
      }
      return // arm spent; the world stays up until the dev kills it
    }
  }

  const start = dev ? runDev : run
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void start(), 3000))
  else setTimeout(() => void start(), 3000)
}

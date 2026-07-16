import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserAgentResult, type BrowserAgentVerb } from '@contracts'
import { agentAct, agentControlDebug, dockPageEval, setAgentConsent } from '../browser-dock'
import { SNAPSHOT_NODE_CAP } from '../browser-page-scripts'
import { getSettingsStore } from '../app-settings'
import { isLivePane } from '../daemon-relay'
import { spawnPaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated agent-browser-control smoke (MOGGING_BROWSERCTL, Phase-6/05b):
//   1. consent OFF -> every verb refuses with reason 'disabled'
//   2. consent ON -> against a smoke-local page: navigate, snapshot (sees the
//      button + planted-error trigger), click, type + snapshot-confirms,
//      eval mutates the DOM and a follow-up snapshot sees it, console tail
//      captures a planted error, wait_for resolves on an element that appears
//   3. Stop revokes mid-sequence (a verb after Stop still works only because
//      consent is still ON — Stop drops the in-flight latch, not the grant;
//      then flipping consent OFF makes verbs refuse again)
//   4. the activity trail carries verb NAMES + refs only — never the typed
//      text, the eval body, or page content
//   5. end-to-end via the real MCP server (consent gates the tool calls)
//   6. the driver's hands and eyes (findings B2/B5/B6/B8, F17/F18):
//      `type` lands on a REACT-STYLE TRACKED input (instance value wrapped, change
//      deduped exactly like React's tracker — a bare el.value write must fail it);
//      `click` completes a POINTERDOWN/UP-only widget; snapshot + click reach into
//      an OPEN SHADOW ROOT; a dense page truncates the snapshot at the cap and
//      says so; scroll honors absolute `to:'y'`; eval output is capped
//   7. an idempotent consent-off re-push (what the renderer sends on every
//      workspace switch) must NOT cancel an in-flight page load (finding B3)
//   8. a pane MOVED to another workspace drives ITS workspace's browser under
//      ITS consent — the birth-formula workspace no longer answers (finding B1)
// The pages are served by THIS smoke on 127.0.0.1 — no external network, ever.

export function runBrowserCtlSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browserctl-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  // The main fixture: controls an agent can read, act on, and break on purpose —
  // including the three surfaces the naive driver hands failed on (finding 6 above).
  const MAIN_PAGE =
    `<!doctype html><title>CTL</title>` +
    `<button id="go" onclick="var d=document.createElement('div');d.id='done';d.textContent='clicked';document.body.appendChild(d);console.error('PLANTED_ERR_4242')">Go</button>` +
    `<input id="field" />` +
    // React's inputValueTracking, in spirit: the INSTANCE's value property is wrapped,
    // and an 'input' event only counts when node.value differs from the tracker
    // (updateValueIfChanged). A driver that assigns el.value directly updates the
    // tracker too — the event dedupes to nothing and the status line never moves.
    `<input id="tracked" /><div id="tracked-status">-</div>` +
    `<script>(() => {
      const el = document.getElementById('tracked')
      const status = document.getElementById('tracked-status')
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      let tracked = el.value
      Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return desc.get.call(this) },
        set(v) { tracked = '' + v; desc.set.call(this, v) }
      })
      el.addEventListener('input', () => {
        const now = desc.get.call(el)
        if (now !== tracked) { tracked = now; status.textContent = 'reacted:' + now }
      })
    })()</script>` +
    // A pointer-first widget: it answers pointerdown/pointerup and never a bare click.
    `<div id="pointer-target" role="button" tabindex="0">POINTER_4242</div>` +
    `<script>(() => {
      let down = false
      const el = document.getElementById('pointer-target')
      el.addEventListener('pointerdown', () => { down = true })
      el.addEventListener('pointerup', () => {
        if (!down) return
        const d = document.createElement('div'); d.id = 'pointer-done'; d.textContent = 'pointered'
        document.body.appendChild(d)
      })
    })()</script>` +
    // A button inside an OPEN shadow root — part of what the user sees, so the
    // agent's eyes and hands must reach it.
    `<div id="shadow-host"></div>` +
    `<script>(() => {
      const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' })
      const b = document.createElement('button')
      b.textContent = 'SHADOW_BTN_4242'
      b.addEventListener('click', () => {
        const d = document.createElement('div'); d.id = 'shadow-done'; d.textContent = 'shadow clicked'
        document.body.appendChild(d)
      })
      root.appendChild(b)
    })()</script>`

  // Far more interactive nodes than the snapshot cap — the truncation arm's fixture.
  const densePage = (): string => {
    let rows = ''
    for (let i = 0; i < SNAPSHOT_NODE_CAP + 50; i++) rows += `<div><a href="#r${i}">row ${i}</a></div>`
    return `<!doctype html><title>DENSE</title>${rows}`
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        if (req.url?.startsWith('/dense')) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(densePage())
          return
        }
        if (req.url?.startsWith('/500')) {
          // A server error the page still "loads" — invisible to did-fail-load, caught
          // by the webRequest ring (F11).
          res.writeHead(500, { 'content-type': 'text/html' })
          res.end(`<!doctype html><title>ERR</title><h1>500</h1>`)
          return
        }
        if (req.url?.startsWith('/slow')) {
          // A load that is still in flight when the consent re-push arrives (finding B3).
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(`<!doctype html><title>SLOW</title><div id="slow">SLOW_OK_4242</div>`)
          }, 2500)
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(MAIN_PAGE)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const act = (v: BrowserAgentVerb): Promise<BrowserAgentResult> => agentAct(v)

  const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(app.getAppPath(), 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
        (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    })

  // The official MCP server is launched inside the pane so its app connection
  // is bound by the real daemon-issued pane capability.
  const mcpClient = async (paneId: string): Promise<{
    rpc: (method: string, params?: unknown) => Promise<Record<string, unknown>>
    kill: () => void
  }> => {
    const child = await spawnPaneMcpSmokeClient({
      cli,
      paneId,
      mcpPath: join(app.getAppPath(), 'bin', 'mogging-mcp.mjs')
    })
    return {
      rpc: async (method, params) => {
        const response = await child.rpc(method, params)
        return response.error ? { error: response.error } : (response.result ?? {})
      },
      kill: child.kill
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      // Open the dock so the view exists (agent verbs create it lazily too).
      await ES(`window.__mogging.workspace.create({ name: 'Web' })`)
      await sleep(1500)
      const paneId = String(((await ES<{ ordinal: number }>('window.__mogging.workspace.active()')).ordinal * 100) + 1)
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)

      // ── 1. Consent OFF: verbs refuse ─────────────────────────────────────
      setAgentConsent(false)
      const offNav = await act({ verb: 'navigate', target: `127.0.0.1:${port}` })
      const offSnap = await act({ verb: 'snapshot' })
      const refusedOff = offNav.reason === 'disabled' && offSnap.reason === 'disabled'

      // ── 2. Consent ON: the wheel turns ───────────────────────────────────
      setAgentConsent(true)
      const nav = await act({ verb: 'navigate', target: `127.0.0.1:${port}` })
      await sleep(1200)
      const snap1 = await act({ verb: 'snapshot' })
      const goRef = snap1.nodes?.find((n) => n.name.includes('Go'))?.ref
      const fieldRef = snap1.nodes?.find((n) => n.role === 'input')?.ref
      const sawControls = !!goRef && !!fieldRef

      // type into the field, confirm via a fresh snapshot's eval read
      const typed = await act({ verb: 'type', target: fieldRef ?? '', value: 'HELLO_4242' })
      const fieldVal = await act({ verb: 'eval', target: `document.getElementById('field').value` })
      const typeOk = typed.ok && fieldVal.value?.includes('HELLO_4242') === true

      // click the button -> it appends #done AND logs a planted console error
      const clicked = await act({ verb: 'click', target: goRef ?? '' })
      const waited = await act({ verb: 'wait_for', target: '#done', n: 4000 })
      const clickOk = clicked.ok && waited.ok

      // eval mutates the DOM; a follow-up snapshot must SEE it
      await act({ verb: 'eval', target: `(document.body.appendChild(Object.assign(document.createElement('button'),{textContent:'EVALED_4242'})), 1)` })
      const snap2 = await act({ verb: 'snapshot' })
      const evalSeen = snap2.text?.includes('EVALED_4242') === true || !!snap2.nodes?.find((n) => n.name.includes('EVALED_4242'))

      // the error feedback loop: console tail captures the planted error
      const con = await act({ verb: 'console', n: 50 })
      const sawError = (con.lines ?? []).some((l) => l.includes('PLANTED_ERR_4242'))

      // ── 3. A real long operation owns possession until Stop. The global
      // indicator remains visible with the dock closed in both Board and
      // Settings. Exercise the human-facing global Stop button, not the main
      // process helper directly.
      await ES(`window.__mogging.browser.toggle(false)`)
      const longWait = act({ verb: 'wait_for', target: '#never-arrives', n: 10000 })
      await sleep(500)
      const duringWaitDriving = agentControlDebug().driving
      await ES(`window.__mogging.view('board')`)
      await sleep(150)
      const boardPossessionVisible = await ES<boolean>(`(() => {
        const el = document.querySelector('.browser-global-possession')
        return !!el && !el.hidden && el.getBoundingClientRect().height > 0
      })()`)
      await ES(`window.__mogging.view('settings')`)
      await sleep(150)
      const settingsPossessionVisible = await ES<boolean>(`(() => {
        const el = document.querySelector('.browser-global-possession')
        return !!el && !el.hidden && el.getBoundingClientRect().height > 0
      })()`)
      const globalStopClicked = await ES<boolean>(`(() => {
        const button = document.querySelector('.browser-global-stop')
        if (!(button instanceof HTMLButtonElement) || button.hidden || button.disabled) return false
        button.click()
        return true
      })()`)
      const stoppedWait = await longWait
      await sleep(150)
      const afterStopDriving = agentControlDebug().driving
      const globalHiddenAfterStop = await ES<boolean>(`(() => {
        const el = document.querySelector('.browser-global-possession')
        return !!el && el.hidden
      })()`)
      const afterRevoke = await act({ verb: 'snapshot' })
      const revokeOk =
        duringWaitDriving && boardPossessionVisible && settingsPossessionVisible &&
        globalStopClicked && globalHiddenAfterStop &&
        stoppedWait.reason === 'stopped' && afterStopDriving === false &&
        afterRevoke.reason === 'disabled'

      // ── 4. Trail carries verb names + refs only, NEVER content ───────────
      const trail = agentControlDebug().trail
      const trailJson = JSON.stringify(trail)
      const trailClean =
        trail.length > 0 &&
        !trailJson.includes('HELLO_4242') && // typed text never recorded
        !trailJson.includes('EVALED_4242') && // eval body never recorded
        !trailJson.includes('PLANTED_ERR') && // page content never recorded
        trail.some((t) => t.verb === 'type') // but the verb name IS there

      // ── 5. END TO END VIA MCP: an agent CLI's path, exactly ──────────────
      // Spawn the real MCP server, handshake, list tools, then drive the dock
      // through tools/call — consent OFF refuses, consent ON works.
      const mcp = await mcpClient(paneId)
      let mcpOk = false
      let mcpToolsOk = false
      let mcpRefusesOff = false
      try {
        await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
        const tools = (await mcp.rpc('tools/list')) as { tools?: { name: string }[] }
        mcpToolsOk =
          !!tools.tools &&
          ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_eval'].every((n) =>
            tools.tools!.some((t) => t.name === n)
          )
        // Consent OFF -> the tool call reports an error to the agent.
        setAgentConsent(false)
        const off = (await mcp.rpc('tools/call', { name: 'browser_snapshot', arguments: {} })) as { isError?: boolean }
        mcpRefusesOff = off.isError === true
        // Consent ON -> navigate + snapshot round-trip through MCP.
        setAgentConsent(true)
        await mcp.rpc('tools/call', { name: 'browser_navigate', arguments: { url: `127.0.0.1:${port}` } })
        await sleep(1200)
        const snap = (await mcp.rpc('tools/call', { name: 'browser_snapshot', arguments: {} })) as {
          content?: { text?: string }[]
          isError?: boolean
        }
        const snapText = snap.content?.[0]?.text ?? ''
        mcpOk = snap.isError !== true && snapText.includes('Go') && snapText.includes(`127.0.0.1:${port}`)
      } finally {
        mcp.kill()
      }

      // ── 6. The driver's hands and eyes (B2/B5/B6/B8, F17/F18) ─────────────
      // The MCP arm left the main fixture loaded and consent ON. Controls are
      // addressed by id selector — refs are re-stamped per snapshot.
      // B2: a bare el.value write dedupes to nothing on a tracked input — the status
      // line only moves when the 'input' event carries a REAL change.
      const typedTracked = await act({ verb: 'type', target: '#tracked', value: 'HELLO_react' })
      const trackedStatus = await act({ verb: 'eval', target: `document.getElementById('tracked-status').textContent` })
      const reactTypeOk = typedTracked.ok && trackedStatus.value?.includes('reacted:HELLO_react') === true
      // F18: the pointer-first widget completes only on a real pointerdown/up gesture.
      const pointerClicked = await act({ verb: 'click', target: '#pointer-target' })
      const pointerDone = await act({ verb: 'wait_for', target: '#pointer-done', n: 4000 })
      const pointerOk = pointerClicked.ok && pointerDone.ok
      // F17: the agent's eyes and hands reach into an open shadow root.
      const shadowSnap = await act({ verb: 'snapshot' })
      const shadowRef = shadowSnap.nodes?.find((n) => n.name.includes('SHADOW_BTN_4242'))?.ref
      const shadowClicked = shadowRef ? await act({ verb: 'click', target: shadowRef }) : { ok: false }
      const shadowDone = await act({ verb: 'wait_for', target: '#shadow-done', n: 4000 })
      const shadowOk = !!shadowRef && shadowClicked.ok && shadowDone.ok
      // B8: eval output is capped, with the truncation named.
      const bigEval = await act({ verb: 'eval', target: `'x'.repeat(20000)` })
      const evalCapOk = bigEval.ok && (bigEval.value ?? '').length < 9000 && (bigEval.value ?? '').endsWith('…[truncated]')

      // B6 + B5: the dense page truncates the snapshot at the cap and says so;
      // scroll honors absolute `to:'y'` and stays relative without it.
      await act({ verb: 'navigate', target: `127.0.0.1:${port}/dense` })
      await sleep(1000)
      const denseSnap = await act({ verb: 'snapshot' })
      const truncOk = denseSnap.truncated === true && (denseSnap.nodes?.length ?? 0) === SNAPSHOT_NODE_CAP
      await act({ verb: 'scroll', dy: 1000, to: 'y' })
      const absY = await act({ verb: 'eval', target: 'window.scrollY' })
      await act({ verb: 'scroll', dy: -400 })
      const relY = await act({ verb: 'eval', target: 'window.scrollY' })
      const scrollOk = absY.value === '1000' && relY.value === '600'

      // ── 6b. The HTTP error loop (F11): a 5xx the page still "loads" reaches
      //        network_failures, where did-fail-load never would ────────────────
      await act({ verb: 'navigate', target: `127.0.0.1:${port}/500` })
      await sleep(800)
      const netFails = await act({ verb: 'network_failures', n: 20 })
      const httpRingOk = (netFails.lines ?? []).some((l) => l.includes('500') && l.includes('/500'))

      // ── 7. An idempotent consent-off re-push must not cancel a load (B3) ──
      // The renderer re-sends stored consent on every workspace switch; with consent
      // already OFF that push used to fire agentStop's load-halt at the human's own
      // navigation. Load a slow page, re-push OFF mid-flight, and require the page.
      setAgentConsent(false) // the real transition — allowed to halt (nothing is loading)
      await ES(`window.__mogging.browser.navigate('127.0.0.1:${port}/slow')`)
      await sleep(400) // the request is in flight (the fixture answers after 2.5s)
      setAgentConsent(false) // the idempotent re-push a workspace switch sends
      await sleep(3500)
      const slowBody = await (dockPageEval(`document.body ? document.body.textContent : ''`) ?? Promise.resolve(''))
      const consentRepushOk = String(slowBody).includes('SLOW_OK_4242')

      // ── 8. A MOVED pane answers to ITS workspace, not its birth one (B1) ──
      // Web2's pane keeps its id when it moves into the first workspace; driving with
      // that pane must resolve to the DESTINATION workspace's browser + consent (ON
      // here) — resolving by the birth formula would find Web2's consent (OFF) and
      // refuse 'disabled'.
      const wsA = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id
      setAgentConsent(true, wsA)
      await ES(`window.__mogging.workspace.create({ name: 'Web2' })`)
      const wsB = await ES<{ id: string; ordinal: number }>('window.__mogging.workspace.active()')
      const movedPaneId = wsB.ordinal * 100 + 1
      // Pane spawn is a daemon round-trip: poll until the pane is LIVE and still
      // resolving to Web2 — consent there is OFF, so the refusal reads 'disabled'
      // (an unknown pane reads 'unknown-pane'). The pre-assert splits spawn timing
      // from move resolution.
      let beforeMove: BrowserAgentResult = { ok: false }
      for (let i = 0; i < 40 && beforeMove.reason !== 'disabled'; i++) {
        beforeMove = await agentAct({ verb: 'console' }, { pane: String(movedPaneId) })
        if (beforeMove.reason !== 'disabled') await sleep(250)
      }
      const paneLiveBeforeMove = beforeMove.reason === 'disabled'
      const movedOk = await ES<boolean>(`window.__mogging.workspace.movePane(${movedPaneId}, ${JSON.stringify(wsA)})`)
      // The move persists its paneIds claim through the settings store; poll the act
      // until the claim lands (or the arm times out and reports the last refusal).
      let movedAct: BrowserAgentResult = { ok: false }
      for (let i = 0; i < 20 && movedAct.ok !== true; i++) {
        movedAct = await agentAct({ verb: 'snapshot' }, { pane: String(movedPaneId) })
        if (movedAct.ok !== true) await sleep(250)
      }
      const movedPaneOk = paneLiveBeforeMove && movedOk && movedAct.ok === true
      // On failure these split the two halves of 'unknown-pane': a pane the daemon no
      // longer runs vs. a workspace resolution that missed the persisted paneIds claim.
      const movedDiag = {
        live: isLivePane(String(movedPaneId)),
        workspaces: (getSettingsStore()?.load()?.workspaces ?? []).map((w) => ({
          ordinal: w.ordinal,
          paneCount: w.paneCount,
          paneIds: w.paneIds ?? null
        }))
      }

      const pass =
        refusedOff && nav.ok && sawControls && typeOk && clickOk && evalSeen && sawError && revokeOk && trailClean &&
        mcpToolsOk && mcpRefusesOff && mcpOk &&
        reactTypeOk && pointerOk && shadowOk && evalCapOk && truncOk && scrollOk && httpRingOk && consentRepushOk && movedPaneOk
      result = {
        pass,
        refusedOff,
        navOk: nav.ok,
        sawControls,
        typeOk,
        clickOk,
        evalSeen,
        sawError,
        revokeOk,
        duringWaitDriving,
        boardPossessionVisible,
        settingsPossessionVisible,
        globalStopClicked,
        globalHiddenAfterStop,
        stoppedWait,
        trailClean,
        trailLen: trail.length,
        mcpToolsOk,
        mcpRefusesOff,
        mcpOk,
        reactTypeOk,
        pointerOk,
        shadowOk,
        evalCapOk,
        truncOk,
        scrollOk,
        httpRingOk,
        scrollRead: { abs: absY.value, rel: relY.value },
        consentRepushOk,
        movedPaneOk,
        paneLiveBeforeMove,
        movedOk,
        movedAct: { ok: movedAct.ok, reason: movedAct.reason },
        movedDiag
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

// Reference kept so tree-shaking never drops BrowserWindow's typing import.
void BrowserWindow

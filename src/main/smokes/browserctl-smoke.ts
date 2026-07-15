import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserAgentResult, type BrowserAgentVerb } from '@contracts'
import { agentAct, agentControlDebug, setAgentConsent } from '../browser-dock'
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
// The page is served by THIS smoke on 127.0.0.1 — no external network, ever.

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

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        // A page an agent can read, act on, and break on purpose.
        res.end(
          `<!doctype html><title>CTL</title>` +
            `<button id="go" onclick="var d=document.createElement('div');d.id='done';d.textContent='clicked';document.body.appendChild(d);console.error('PLANTED_ERR_4242')">Go</button>` +
            `<input id="field" />`
        )
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

      const pass =
        refusedOff && nav.ok && sawControls && typeOk && clickOk && evalSeen && sawError && revokeOk && trailClean &&
        mcpToolsOk && mcpRefusesOff && mcpOk
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
        mcpOk
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

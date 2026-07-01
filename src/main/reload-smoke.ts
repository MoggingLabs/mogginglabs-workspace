import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated reload smoke (set MOGGING_RELOAD=1). Starts a long-running counter loop in
// the pane, reloads the renderer, and proves the PTY (owned by main) survived: the
// counter keeps climbing past its pre-reload value (survived) and does not restart at 0
// (no duplicate spawn — PtyService's id-guard held). Writes out/reload-smoke-result.json
// + stdout, then exits (0=pass,1=fail). Dev/test only.
export function runReloadSmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const consoleMsgs: Array<{ level: unknown; message: string }> = []
  const wc = win.webContents
  let done = false

  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string
    let level: unknown
    let message: string
    if (a1 && typeof a1 === 'object') {
      level = a1.level
      message = String(a1.message ?? '')
    } else {
      level = a1
      message = String(args[2] ?? '')
    }
    consoleMsgs.push({ level, message })
    if (level === 3 || level === 'error') errors.push('console.error: ' + message)
  })
  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)))

  const write = (result: object): void => {
    const json = JSON.stringify(result)
    console.log('RELOAD_SMOKE_RESULT ' + json)
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'reload-smoke-result.json'), json)
    } catch {
      // best-effort
    }
  }
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const send = (d: string): Promise<unknown> =>
    ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(d) + '});')

  // Fresh capture hook (re-run per renderer context — the reload creates a new one).
  const HOOK =
    "window.__cap='';window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});"
  // A node loop that prints MARK_<n> every 400ms forever (until Ctrl-C / pty killed).
  const LOOP = `node -e "let i=0;setInterval(function(){process.stdout.write('MARK_'+(i++)+String.fromCharCode(10))},400)"\r`
  const marks = (s: string): number[] => (s.match(/MARK_(\d+)/g) || []).map((m) => Number(m.slice(5)))

  const failOut = (msg: string): void => {
    if (done) return
    done = true
    write({ pass: false, errors: [...errors, msg], consoleMsgs })
    app.exit(1)
  }

  async function phaseB(beforeMax: number): Promise<void> {
    if (done) return
    try {
      await delay(2200) // let the new pane mount + resubscribe
      const bridge = String(await ES('typeof window.bridge'))
      const paneExists = Boolean(await ES('!!document.querySelector(".pane")'))
      await ES(HOOK) // fresh capture in the NEW renderer context
      await delay(3200) // let the still-running loop stream new output into the new pane
      const capAfter = String(await ES('window.__cap'))
      const after = marks(capAfter)
      const afterMax = after.length ? Math.max(...after) : -1
      const afterMin = after.length ? Math.min(...after) : -1

      await send('\x03') // stop the loop
      await delay(400)

      const remounted = bridge === 'object' && paneExists
      const survived = after.length > 0 && afterMax > beforeMax
      const noDuplicate = afterMin > beforeMax // continues above pre-reload max => no restart-at-0, no 2nd loop
      const noErrors = errors.length === 0
      const pass = remounted && survived && noDuplicate && noErrors

      done = true
      write({
        pass,
        remounted,
        survived,
        noDuplicate,
        noErrors,
        beforeMax,
        afterMin,
        afterMax,
        afterCount: after.length,
        bridge,
        paneExists,
        errors,
        note: 'reloaded pane starts blank (scrollback restore is Phase 1); this proves the PTY survived in main and continued.',
        consoleMsgs
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      failOut('phaseB exception: ' + String(e))
    }
  }

  async function phaseA(): Promise<void> {
    if (done) return
    try {
      await delay(1500)
      await ES(HOOK)
      await send(LOOP)
      await delay(2600)
      const before = marks(String(await ES('window.__cap')))
      const beforeMax = before.length ? Math.max(...before) : -1

      // Attach the next-load promise BEFORE reloading so we can't miss it.
      const loaded = new Promise<void>((res) => wc.once('did-finish-load', () => res()))
      wc.reload()
      await loaded
      await phaseB(beforeMax)
    } catch (e) {
      failOut('phaseA exception: ' + String(e))
    }
  }

  wc.once('did-finish-load', () => void phaseA())
  setTimeout(() => failOut('TIMEOUT: reload smoke did not complete'), 70000)
}

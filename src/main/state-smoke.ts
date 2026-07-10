import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated agent-state smoke (set MOGGING_STATE=1). Emits OSC 9 / 133 / 7 onto the
// pane's PTY *output* stream (via a tiny node one-liner run in the shell) and asserts the
// titlebar chip transitions attention/busy/idle. Writes out/state-smoke-result.json +
// stdout, then exits (0=pass,1=fail). Dev/test only.
export function runStateSmoke(win: BrowserWindow): void {
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
    console.log('STATE_SMOKE_RESULT ' + json)
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'state-smoke-result.json'), json)
    } catch {
      // best-effort
    }
  }
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const send = (d: string): Promise<unknown> =>
    ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(d) + '});')

  // Run a node one-liner that writes a raw OSC sequence to stdout, so it lands on the PTY
  // output stream the backend OscParser reads. String.fromCharCode(27/7) = ESC/BEL, which
  // dodges all shell/JS backslash-escaping ambiguity.
  const emitOsc = (payload: string): string =>
    `node -e "process.stdout.write(String.fromCharCode(27)+']${payload}'+String.fromCharCode(7))"\r`

  async function step(payload: string, expected: string | null): Promise<Record<string, unknown>> {
    const before = Number(await ES('window.__states.length'))
    await send(emitOsc(payload))
    await delay(1600)
    const states = (await ES('window.__states.slice(' + before + ')')) as string[]
    const chip = (await ES(
      '(function(){var e=document.querySelector(\'.layout-slot[data-pane-id="1"] .pane-state\');' +
        'return e?{state:e.getAttribute("data-state")}:null;})()'
    )) as { state: string } | null
    const seen = Array.isArray(states) && (expected === null || states.includes(expected))
    return { payload, expected, seen, states, chip }
  }

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      // Launcher-first boot: provision Workspace 1 (pane 1) ourselves. The dot is
      // gated on a tracked provider session — adopt one so the chip reads stay live.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});' +
          'if(m&&m.agents&&m.agents.adopt)m.agents.adopt(1,"claude","");return 1;})()'
      )
      await delay(2500)
      // Ends in `1`, NOT the bridge.on(...) call: bridge.on returns the unsubscriber
      // (a Function), and a script whose completion value is a Function makes
      // executeJavaScript reject with "An object could not be cloned".
      await ES(
        "window.__states=[];" +
          "if(!window.__stateHook){window.__stateHook=true;" +
          "window.bridge.on('terminal:state',function(e){if(e&&e.id===1){window.__states.push(e.state);}});}1"
      )
      await delay(600)

      const attention = await step('9;hi', 'attention')
      const busy = await step('133;C', 'busy')
      const idle = await step('133;D;0', 'idle')
      const cwd = await step('7;file://host/tmp', null) // OSC 7: no state change, must not error

      const noErrors = errors.length === 0
      const pass =
        attention.seen === true && busy.seen === true && idle.seen === true && cwd.seen === true && noErrors

      write({
        pass,
        attention,
        busy,
        idle,
        cwd,
        noErrors,
        errors,
        allStates: await ES('window.__states'),
        consoleMsgs
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      write({ pass: false, errors: [...errors, 'state smoke exception: ' + String(e)], consoleMsgs })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  setTimeout(() => {
    if (done) return
    done = true
    write({ pass: false, errors: [...errors, 'TIMEOUT: state smoke did not complete'], consoleMsgs })
    app.exit(1)
  }, 60000)
}

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

  // An OSC 9/99/777 notification is a low-confidence GUESS, not a verdict: every agent CLI
  // rings it on COMPLETION as much as when blocked, so the tracker holds it for
  // BELL_CONFIRM_MS to see whether an explicit done/needs-input contradicts it, and only an
  // UNCLAIMED bell rings (agent-state/activity.ts). Nothing contradicts these, so they still
  // reach attention — just deliberately later. Outwait the window, or the very next step's
  // 133;C would cancel the pending bell and the ring would never land at all.
  const BELL_WAIT_MS = 2800
  async function step(payload: string, expected: string | null, wait = 1600): Promise<Record<string, unknown>> {
    const before = Number(await ES('window.__states.length'))
    await send(emitOsc(payload))
    await delay(wait)
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

      const attention = await step('9;hi', 'attention', BELL_WAIT_MS)
      const busy = await step('133;C', 'busy')
      const idle = await step('133;D;0', 'idle')
      const cwd = await step('7;file://host/tmp', null) // OSC 7: no state change, must not error

      // (0.8.1) xterm AUTO-REPLIES are not typing: DA2 + DECRPM answers ride the same
      // renderer->pty write channel as keystrokes, and each once cleared the attention
      // latch (a permission-blocked pane's red dot went green — found live 2026-07-10).
      // Re-latch red, write a chunk of pure replies (DA2, DECRPM, focus in/out) into the
      // INPUT path, assert the latch held; then one real keystroke must clear it.
      // RE-ADOPT first: the 133;C→D cycle above read as "the agent exited to shell"
      // and cleared the adopted session (terminal-pane's end-detector) — the dot went
      // hidden and the chip froze at idle. The relatch models a FRESH agent session
      // hitting a permission prompt.
      await ES('(window.__mogging.agents.adopt(1,"claude",""),1)')
      await delay(400)
      const relatch = await step('9;again', 'attention', BELL_WAIT_MS)
      const chip = (): Promise<unknown> =>
        ES(
          '(function(){var e=document.querySelector(\'.layout-slot[data-pane-id="1"] .pane-state\');' +
            'return e?e.getAttribute("data-state"):null;})()'
        )
      await send('\x1b[>0;276;0c\x1b[?2026;2$y\x1b[I\x1b[O')
      await delay(1400)
      const afterReplies = String(await chip())
      const repliesHeld = afterReplies === 'attention'

      // ONLY A SUBMIT ANSWERS A BLOCKED AGENT. The latch used to clear on ANY keystroke, and
      // that was a lie with no way back: an arrow key, a ^C, a stray character each turned a
      // blocked pane's red dot green and claimed it was WORKING — while the agent sat there
      // still blocked, and no CLI re-raises a needs-input it has already raised. Red lingering
      // a beat too long self-heals on the agent's next verdict; a false "working" never heals.
      await send('x') // a bare character is COMPOSING, not answering
      await delay(1400)
      const strayHeld = String(await chip()) === 'attention'
      // Shift+Enter is composing too — it opens a new line inside a prompt you are still
      // writing. Where a terminal can encode it at all it arrives ESC-prefixed, so requiring a
      // BARE CR excludes it for free (isSubmittedInput).
      await send('\x1b\r')
      await delay(1400)
      const shiftEnterHeld = String(await chip()) === 'attention'
      // ...and Enter clears it, into BUSY: the agent said by name that it was blocked on this
      // human, and the human just answered it. Two certainties, so the conclusion is certain.
      await send('\r')
      await delay(1400)
      const afterSubmit = String(await chip())
      const submitClearsToBusy = afterSubmit === 'busy'

      const noErrors = errors.length === 0
      const pass =
        attention.seen === true && busy.seen === true && idle.seen === true && cwd.seen === true &&
        relatch.seen === true && repliesHeld && strayHeld && shiftEnterHeld && submitClearsToBusy && noErrors

      write({
        pass,
        attention,
        busy,
        idle,
        cwd,
        relatch,
        repliesHeld,
        afterReplies,
        strayHeld,
        shiftEnterHeld,
        submitClearsToBusy,
        afterSubmit,
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

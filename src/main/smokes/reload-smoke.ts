import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated reload smoke (set MOGGING_RELOAD=1). Starts a long-running counter loop in
// the pane, reloads the renderer, and proves the PTY (owned by main) survived: the
// counter keeps climbing past its pre-reload value (survived) and does not restart at 0
// (no duplicate spawn — PtyService's id-guard held).
//
// It also gates the ATTENTION-LATCH RELIABILITY CONTRACT (2026-07-10): the loop emits
// one OSC 9 after our last keystroke, latching the pane red BEFORE the reload; after
// the reload the chip must STILL read attention. That holds only if BOTH fixes hold:
// (1) the remounting pane PULLS its state (terminal:stateSync) — the change-only push
//     happened pre-reload and is gone;
// (2) xterm's remount auto-replies (CPR/DA/focus answers to scrollback replay) are not
//     classified as typing (isTerminalReply) — typing clears the latch.
// Writes out/reload-smoke-result.json + stdout, then exits (0=pass,1=fail). Dev only.
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
  // Ends in `1`, NOT the bridge.on(...) call: bridge.on returns the unsubscriber (a
  // Function), and a Function completion value makes executeJavaScript reject with
  // "An object could not be cloned".
  const HOOK =
    "window.__cap='';window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});1"
  // A node loop that prints MARK_<n> every 400ms forever (until Ctrl-C / pty killed).
  // At i===4 (~1.6s in — safely after our last keystroke, which would clear the latch)
  // it emits ONE OSC 9, latching the pane's attention state for the reload assertion.
  const LOOP = `node -e "let i=0;setInterval(function(){if(i===4){process.stdout.write(String.fromCharCode(27)+']9;needs input'+String.fromCharCode(7))}process.stdout.write('MARK_'+(i++)+String.fromCharCode(10))},400)"\r`
  const marks = (s: string): number[] => (s.match(/MARK_(\d+)/g) || []).map((m) => Number(m.slice(5)))
  const chipState = (): Promise<unknown> =>
    ES(
      '(function(){var e=document.querySelector(\'.layout-slot[data-pane-id="1"] .pane-state\');' +
        'return e?e.getAttribute("data-state"):null;})()'
    )

  const failOut = (msg: string): void => {
    if (done) return
    done = true
    write({ pass: false, errors: [...errors, msg], consoleMsgs })
    app.exit(1)
  }

  async function phaseB(beforeMax: number, stateBefore: string): Promise<void> {
    if (done) return
    try {
      await delay(2200) // let the new pane mount + resubscribe
      const bridge = String(await ES('typeof window.bridge'))
      const paneExists = Boolean(
        await ES('!!document.querySelector(\'.layout-slot[data-pane-id="1"] .pane-header\')')
      )
      await ES(HOOK) // fresh capture in the NEW renderer context
      // Re-adopt: the agent-session port is renderer state, so the reload wiped it and
      // the dot is hidden (availability contract). The real product re-adopts through
      // the restore lineup (agents/index.ts launchInPane resume+wasPaneReattached);
      // the dev shim mirrors that. The gate's unhide then runs syncState — "appear
      // with the truth, not the mount default" — which is half the contract under test.
      await ES('window.__mogging.agents.adopt(1,"claude","");1')
      // SHAPE 1 (a fixed sleep standing in for "the thing happened"): 3200ms stood in for "the
      // surviving loop streamed new output into the remounted pane". That IS the fact `survived`
      // asserts, so poll for it — the remount, the resubscribe and the daemon's replay all take
      // real time on a loaded runner, and a sleep that is a beat short reds `survived` on a loop
      // that never stopped running. 15s ceiling (every poll here must fit this gate's own 70s
      // watchdog), and the assertion is unchanged.
      let capAfter = ''
      let after: number[] = []
      for (let i = 0; i < 60; i++) {
        capAfter = String(await ES('window.__cap'))
        after = marks(capAfter)
        if (after.length > 0 && Math.max(...after) > beforeMax) break
        await delay(250)
      }
      // …then a settle beat, and re-read. `noDuplicate` is a NEGATIVE claim — no second loop
      // restarted at MARK_0 — and a negative needs an OBSERVATION WINDOW, not the first frame
      // that satisfies the positive one next to it. 1200ms is three of the loop's 400ms ticks,
      // so a duplicate prints into this read or it does not exist. (boardfail's settle idiom.)
      await delay(1200)
      capAfter = String(await ES('window.__cap'))
      after = marks(capAfter)
      const afterMax = after.length ? Math.max(...after) : -1
      const afterMin = after.length ? Math.min(...after) : -1
      // The latch assertion — read BEFORE the Ctrl-C below (real typing, rightly clears
      // it). Pre-reload the loop's OSC 9 latched red; the remounted chip may only show
      // that via the stateSync pull, and only keeps it if remount auto-replies were not
      // classified as typing. No fresh OSC has fired since. The direct invoke reads the
      // relay's answer without the pane's paint in between — it splits "backend lost
      // the latch" (isTerminalReply failed) from "the pane painted it wrong" (pull
      // path failed).
      const syncAnswer = String(await ES('window.bridge.invoke("terminal:stateSync",{id:1})'))
      // SHAPE 2 (a consequence of the line above, read with NO budget of its own). The backend's
      // answer and the chip are the SAME latch at two ends, and the chip is strictly the later —
      // the pull has to cross IPC and repaint. Read in the same tick, a loaded runner reds
      // `latchHeld` on a latch the backend just confirmed. Cause first, then its paint, with a
      // budget for the one repaint that separates them.
      let stateAfter = String(await chipState())
      for (let i = 0; i < 20 && stateAfter !== 'attention'; i++) {
        await delay(250)
        stateAfter = String(await chipState())
      }

      await send('\x03') // stop the loop
      await delay(400)

      const remounted = bridge === 'object' && paneExists
      const survived = after.length > 0 && afterMax > beforeMax
      const noDuplicate = afterMin > beforeMax // continues above pre-reload max => no restart-at-0, no 2nd loop
      const latchHeld =
        stateBefore === 'attention' && syncAnswer === 'attention' && stateAfter === 'attention'
      const noErrors = errors.length === 0
      const pass = remounted && survived && noDuplicate && latchHeld && noErrors

      done = true
      write({
        pass,
        remounted,
        survived,
        noDuplicate,
        latchHeld,
        stateBefore,
        stateAfter,
        syncAnswer,
        noErrors,
        beforeMax,
        afterMin,
        afterMax,
        afterCount: after.length,
        bridge,
        paneExists,
        errors,
        note: 'PTY survived in main and continued; the attention latch survived the renderer reload (stateSync pull + auto-reply filter).',
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
      // Launcher-first boot: provision Workspace 1 (pane 1) ourselves. The state chip
      // is gated on a tracked provider session — adopt one so the latch reads are live.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});' +
          'if(m&&m.agents&&m.agents.adopt)m.agents.adopt(1,"claude","");return 1;})()'
      )
      // SHAPE 1 (a fixed sleep standing in for "the thing happened"): 2500ms stood in for pane 1's
      // shell being up. `send(LOOP)` is ONE SHOT and the whole gate — survived, noDuplicate,
      // latchHeld — is downstream of it; "a write raced into a still-spawning PTY is silently
      // dropped by the daemon" (ui/core/terminal/liveness-port.ts), so a slow spawn does not
      // delay the loop, it means there is no loop. Wait for the app's own liveness signal.
      let paneLive = false
      for (let i = 0; i < 40 && !paneLive; i++) {
        paneLive = Boolean(await ES('window.__mogging.agents.paneLive(1) === true'))
        if (!paneLive) await delay(200)
      }
      await ES(HOOK)
      await send(LOOP)
      // WAIT for the latch rather than guessing at a deadline. An OSC 9 is a low-confidence
      // GUESS — every agent CLI rings one on COMPLETION as much as when blocked — so the
      // tracker holds it for BELL_CONFIRM_MS to see whether an explicit done contradicts it
      // (agent-state/activity.ts). Nothing contradicts this one, so it still latches
      // attention, just ~2s later than it used to. A fixed delay was the wrong tool: the
      // ring lands at node-startup + the loop's 5th tick + the bell window, and any estimate
      // of that sits right on the boundary (measured: a 4.4s guess read 'busy', and the latch
      // looked lost when it was merely late). Poll instead.
      for (let i = 0; i < 40; i++) {
        if (String(await chipState()) === 'attention') break
        await delay(250)
      }
      const before = marks(String(await ES('window.__cap')))
      const beforeMax = before.length ? Math.max(...before) : -1
      const stateBefore = String(await chipState())

      // Attach the next-load promise BEFORE reloading so we can't miss it.
      const loaded = new Promise<void>((res) => wc.once('did-finish-load', () => res()))
      wc.reload()
      await loaded
      await phaseB(beforeMax, stateBefore)
    } catch (e) {
      failOut('phaseA exception: ' + String(e))
    }
  }

  wc.once('did-finish-load', () => void phaseA())
  setTimeout(() => failOut('TIMEOUT: reload smoke did not complete'), 70000)
}

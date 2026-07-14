import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { notifyHookInvocation } from './notify-hook'

// Env-gated END-TO-END verdict smoke (MOGGING_VERDICTLIVE=1).
//
// Everything else about the alerts system is gated against a SEAM. ATTENTION unit-asserts the
// tracker in-process and drives the UI through `__mogging.attention.setPaneState`. NOTIFYHOOK
// proves the generated hook script speaks the wire — but to a FAKE daemon socket, with no window.
// So the middle of the chain, which is the part a user actually has, was never exercised by
// anything: a real hook event, over the real authed socket, into the real daemon's real tracker,
// out through the real IPC relay, onto the real dot.
//
// This gate closes that. It types THE LITERAL COMMAND CLAUDE CODE RUNS into a real pane's shell:
//
//     node "<userData>/notify-hook/notify.mjs" --event done
//
// which is exactly what `claudeNotifyHooks` writes into the `--settings` overlay for the Stop
// hook (agents/notify-hook.ts). Nothing is simulated: the script resolves MOGGING_PANE_ID and
// MOGGING_DAEMON_ENDPOINT from the environment the PANE really has, opens the daemon's socket,
// handshakes with the token, and sends the notify. If any link in that chain is wrong, the dot
// does not move and this gate goes red.
//
// The story it drives is the one that matters, and the one that used to be told wrong:
//
//   turn-start        you submit a prompt                  -> busy
//   subagent-start x2 the agent fans work out              -> busy
//   done              THE MAIN ENDS ITS TURN MID-FAN-OUT   -> STILL BUSY. This is the whole
//                     (Claude fires Stop with the work        subagent gate: green requires
//                      still in flight)                       main-done AND zero subagents, so
//                                                             the verdict is DEFERRED, not taken.
//                                                             Get this wrong and a pane pulses
//                                                             green in the middle of a job.
//   subagent-stop     one child lands                      -> still busy
//   subagent-stop     the last child lands                 -> GREEN. The main's own deferred
//                                                             verdict is now due.
//   click             you look at it                       -> acknowledged, back to yellow
//   needs-input       a permission prompt                  -> RED + a red resting outline
//   'x'               a stray keystroke                    -> STILL RED. It answered nothing,
//                                                             and claiming otherwise was a lie
//                                                             with no way back.
//   Enter             you actually answer it               -> busy. The agent said it was
//                                                             blocked on this human; the human
//                                                             answered. Both facts certain.
//
// THE ADOPTED SESSION IS ON A CLOCK. The dot only renders for a pane with an agent session, and
// `agents.adopt` is a shim — no claude is really running in that pane, so the backend's PTY-subtree
// detector emits agentId:null and retires it under us. Every wait therefore RE-ADOPTS on each
// poll. That is not a workaround for a flake: re-adopting forces the pane to PULL state from the
// daemon (terminal:stateSync), so each assert reads the daemon's own truth rather than a UI echo
// of the event we just sent — which makes this a stronger test, not a weaker one.

interface Step {
  want: string
  got: string
  alert: string | null
  ok: boolean
}

const SCRIPT = (hook: string): string => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  if (!m || !m.workspace || !m.agents) return { pass: false, error: 'no dev handles' }
  if (m.workspace.count() === 0) { m.workspace.create({ name: 'Verdict' }); await sleep(1200) }

  const HOOK = ${JSON.stringify(hook)}
  const type = (s) => window.bridge.send('terminal:write', { id: 1, data: s })
  // The pane's shell runs it. This is the hook's real invocation, not a stand-in.
  const fire = (ev) => type(HOOK + ' --event ' + ev + '\\r')
  const adopt = () => { try { m.agents.adopt(1, 'claude', '') } catch (e) {} }

  const slot = () => document.querySelector('.layout-slot[data-pane-id="1"]')
  const dot = () => { const e = slot() && slot().querySelector('.pane-state'); return e ? e.getAttribute('data-state') : null }
  const alert = () => { const s = slot(); return s ? s.getAttribute('data-alert') : null }

  const steps = []
  /** Poll until the dot reaches \`want\`, re-adopting each tick so the shim session cannot be
   *  retired out from under us and each read re-pulls from the daemon. */
  const settle = async (want, ms) => {
    const t0 = Date.now()
    let got = dot()
    while (Date.now() - t0 < (ms || 12000)) {
      adopt()
      await sleep(300)
      got = dot()
      if (got === want) break
    }
    const s = { want, got, alert: alert(), ok: got === want }
    steps.push(s)
    return s
  }
  /** Assert the dot HOLDS a state for a while — the deferred-done case is about what must NOT
   *  happen, and a poll that stops at the first match would never see it. */
  const hold = async (want, ms) => {
    const t0 = Date.now()
    let got = dot()
    while (Date.now() - t0 < ms) {
      adopt()
      await sleep(300)
      got = dot()
      if (got !== want) break // it moved — that IS the failure
    }
    const s = { want, got, alert: alert(), ok: got === want }
    steps.push(s)
    return s
  }

  adopt()
  await sleep(1200)

  // ── a real turn, fanning out to subagents ────────────────────────────────────────────
  fire('turn-start')
  const turnStart = await settle('busy')

  fire('subagent-start')
  await sleep(900)
  fire('subagent-start')
  const fanOut = await settle('busy')

  // THE GATE. The main fires Stop with two children still running. It must NOT go green.
  fire('done')
  const doneDeferred = await hold('busy', 5000)

  fire('subagent-stop')
  const oneLeft = await hold('busy', 3500)

  // ...and the last child landing is what makes the main's own verdict due.
  fire('subagent-stop')
  const redeemed = await settle('finished')

  // A click is the acknowledgement.
  const s = slot()
  if (s) s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  const acked = await settle('idle', 4000)

  // ── a permission prompt ──────────────────────────────────────────────────────────────
  fire('needs-input')
  const blocked = await settle('attention')

  // A stray keystroke answers nothing.
  type('x')
  const strayHolds = await hold('attention', 4000)

  // Enter answers it.
  type('\\r')
  const answered = await settle('busy', 8000)

  const pass = steps.every((s) => s.ok) &&
    doneDeferred.got === 'busy' &&      // never green mid-fan-out
    redeemed.alert === 'finished' &&    // the resting green outline
    blocked.alert === 'input' &&        // the resting red outline
    acked.alert === null                // the click cleared it

  return {
    pass,
    turnStart, fanOut, doneDeferred, oneLeft, redeemed, acked, blocked, strayHolds, answered
  }
})()`

export function runVerdictLiveSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // real subprocess spawns per step — be generous
  const run = async (): Promise<void> => {
    let result: unknown = { pass: false, error: 'never ran' }
    const hook = notifyHookInvocation()
    try {
      if (!hook) throw new Error('no notify-hook invocation (the script could not be written)')
      result = await win.webContents.executeJavaScript(SCRIPT(hook), true)
      ;(result as { hook?: string }).hook = hook
    } catch (e) {
      result = { pass: false, error: String(e), hook }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'verdictlive-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    console.log('VERDICTLIVE_RESULT ' + JSON.stringify(result))
    app.exit((result as { pass?: boolean })?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 3000))
  else setTimeout(run, 3000)
}

import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated `mogging notify` smoke (MOGGING_NOTIFY). End-to-end proof of Phase-2/04:
//  - the daemon spawned pane 1 with MOGGING_PANE_ID + MOGGING_DAEMON_ENDPOINT in its env,
//  - running `mogging notify --event needs-input` INSIDE that pane connects to the daemon over
//    its authed socket and raises the pane's attention,
//  - which flows through the existing state -> attention pipeline as a terminal:state event.
// We hook terminal:state for pane 1, inject the notify command into pane 1's shell, and assert an
// 'attention' state arrives. MUST run against a FRESH daemon (new code) — isolate LOCALAPPDATA.
export function runNotifySmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000) // safety net
  const wc = win.webContents
  const exec = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const binPath = join(process.cwd(), 'bin', 'mogging.mjs')

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // Launcher-first boot: provision Workspace 1 (pane 1) ourselves.
      await exec(
        `(function(){var m=window.__mogging;` +
          `if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()`
      )
      // Observe pane 1's state stream.
      await exec(
        `window.__nstates=window.__nstates||[];if(!window.__nhook){window.__nhook=1;` +
          `window.bridge.on('terminal:state',function(e){if(e&&e.id===1)window.__nstates.push(e.state);});}1`
      )
      await sleep(3500) // let pane 1 spawn + its shell reach a prompt

      // Only count states AFTER we fire the notify (drop the idle replay from attach).
      await exec(`window.__nstates=[]`)
      const cmd = `node "${binPath}" notify --event needs-input\r`
      await exec(`window.bridge.send("terminal:write",{id:1,data:${JSON.stringify(cmd)}})`)

      let sawAttention = false
      for (let i = 0; i < 40; i++) {
        const states = await exec<string[]>(`window.__nstates.slice()`)
        if (Array.isArray(states) && states.includes('attention')) {
          sawAttention = true
          break
        }
        await sleep(500)
      }
      const states = await exec<string[]>(`window.__nstates.slice()`)

      // (0.8.1) `done` is a turn ENDING: it lands as idle — the UI's green finished
      // story — never attention. Red is reserved for needs-input (blocked on you); a
      // done that rang red made finished and blocked indistinguishable. Typing the
      // command clears the needs-input latch above (real input, rightly), so anything
      // red AFTER this reset can only be the done event mismapped.
      await exec(`window.__nstates=[]`)
      const doneCmd = `node "${binPath}" notify --event done\r`
      await exec(`window.bridge.send("terminal:write",{id:1,data:${JSON.stringify(doneCmd)}})`)
      let sawIdle = false
      for (let i = 0; i < 30; i++) {
        const st = await exec<string[]>(`window.__nstates.slice()`)
        if (Array.isArray(st) && st.includes('idle')) {
          sawIdle = true
          break
        }
        await sleep(500)
      }
      const doneStates = await exec<string[]>(`window.__nstates.slice()`)
      const doneNeverRang = !doneStates.includes('attention')

      const paneTail = await exec<string | null>(
        `(()=>{const p=(window.__mogging.panes||[]).find(x=>x.id===1);` +
          `return p?p.text().replace(/\\s+$/,'').slice(-300):null;})()`
      )
      result = {
        pass: sawAttention && sawIdle && doneNeverRang,
        sawAttention, sawIdle, doneNeverRang, states, doneStates, binPath, paneTail
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'notify-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 3000))
  else setTimeout(run, 3000)
}

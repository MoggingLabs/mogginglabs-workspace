import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated agent-CLI smoke (set MOGGING_AGENT=claude). Launches a real coding-agent
// CLI in the pane and verifies full-TUI behaviour: the terminal's ALTERNATE buffer goes
// active (a full-screen app took over), color sequences are emitted, and raw keystrokes
// are accepted. Writes out/agent-smoke-result.json + stdout, then exits (0=pass,1=fail).
// Dev-only (relies on the import.meta.env.DEV window.__mogging handle).

const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI ... final
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL|ST
    .replace(/\x1b[=>]/g, '') // 2-char ESC sequences

export function runAgentSmoke(win: BrowserWindow, command: string): void {
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
    console.log('AGENT_SMOKE_RESULT ' + json)
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'agent-smoke-result.json'), json)
    } catch {
      // best-effort
    }
  }
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const send = (d: string): Promise<unknown> =>
    ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(d) + '});')
  const bufType = async (): Promise<string> =>
    String(
      await ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'return p?p.term.buffer.active.type:"?";})()'
      )
    )

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      await ES(
        "window.__cap='';if(!window.__capHooked){window.__capHooked=true;" +
          "window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});}"
      )
      await delay(500)

      // Launch the agent in the repo dir. Clear nested-Claude env vars so it starts clean
      // (the app was itself launched from a Claude Code session).
      const cwd = app.getAppPath()
      await send('cd /d "' + cwd + '" & set "CLAUDECODE=" & set "CLAUDE_CODE_ENTRYPOINT=" & ' + command + '\r')
      await delay(9000)

      const capA = String(await ES('window.__cap'))
      const typeA = await bufType()
      const lenA = capA.length

      // Raw-mode input: a down-arrow then a character; the TUI should redraw.
      await send('\x1b[B')
      await delay(400)
      await send('h')
      await delay(1500)
      const capB = String(await ES('window.__cap'))
      const typeB = await bufType()

      // Attempt a graceful exit (Ctrl-C twice); app.exit() kills the pty regardless.
      await send('\x03')
      await delay(700)
      await send('\x03')
      await delay(1300)
      const typeC = await bufType()

      const altEnter = /\x1b\[\?(?:1049|1047|47)h/.test(capA)
      const altScreen = typeA === 'alternate' || typeB === 'alternate'
      const anyColor = /\x1b\[[0-9;]*m/.test(capA)
      const truecolor = /\x1b\[(?:38|48);2;/.test(capA)
      const color256 = /\x1b\[(?:38|48);5;/.test(capA)
      const content = /claude/i.test(stripAnsi(capA)) || lenA > 800
      const rawKeyOk = capB.length > lenA
      const altRestored = typeC === 'normal'
      const noErrors = errors.length === 0

      const pass = altScreen && anyColor && content && rawKeyOk && noErrors

      write({
        pass,
        command,
        altScreen,
        altEnter,
        anyColor,
        truecolor,
        color256,
        content,
        rawKeyOk,
        altRestored,
        typeA,
        typeB,
        typeC,
        lenA,
        lenB: capB.length,
        noErrors,
        errors,
        text: stripAnsi(capA)
          .replace(/[ \t]+\n/g, '\n')
          .slice(0, 1400),
        consoleMsgs
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      write({ pass: false, command, errors: [...errors, 'agent smoke exception: ' + String(e)], consoleMsgs })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  setTimeout(() => {
    if (done) return
    done = true
    write({ pass: false, command, errors: [...errors, 'TIMEOUT: agent smoke did not complete'], consoleMsgs })
    app.exit(1)
  }, 90000)
}

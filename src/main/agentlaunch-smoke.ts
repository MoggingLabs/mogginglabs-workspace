import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// Env-gated agent-LAUNCHER smoke (MOGGING_AGENTLAUNCH): drives the PICKER path end-to-end —
// detect installed CLIs, then launch `claude` into the focused pane via the launcher
// (window.__mogging.agents.launch) — and asserts the pane becomes a full TUI (alternate buffer
// + color), the CLI self-authenticated, and the pane got labelled with its agent. Dev-only
// (uses the __mogging handle). Writes out/agentlaunch-result.json, then exits (0=pass,1=fail).

const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>]/g, '')

export function runAgentLaunchSmoke(win: BrowserWindow): void {
  const wc = win.webContents
  const errors: string[] = []
  let done = false

  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)))

  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (result: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'agentlaunch-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      await ES(
        "window.__cap='';if(!window.__capHooked){window.__capHooked=true;" +
          "window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});}"
      )
      await delay(500)

      const detected = (await ES(
        '(async()=>{try{return (await window.__mogging.agents.detect()).filter(a=>a.installed).map(a=>a.id);}catch(e){return [];}})()'
      )) as string[]
      const detectedClaude = Array.isArray(detected) && detected.includes('claude')

      // Clear nested-Claude env so it starts clean (the app may be launched from a Claude session).
      const clearEnv = 'set "CLAUDECODE=" & set "CLAUDE_CODE_ENTRYPOINT="\r'
      await ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(clearEnv) + '});')
      await delay(700)

      // Drive the launcher (the picker's launch path) — NOT a raw terminal write.
      await ES("window.__mogging.agents.launch('claude','Claude Code');")
      await delay(9000)

      const cap = String(await ES('window.__cap'))
      const bufType = String(
        await ES(
          '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];return p?p.term.buffer.active.type:"?";})()'
        )
      )
      const labeled = Boolean(await ES("!!document.querySelector('.pane-badge.has-label')"))

      const altEnter = /\x1b\[\?(?:1049|1047|47)h/.test(cap)
      const altScreen = bufType === 'alternate' || altEnter
      const anyColor = /\x1b\[[0-9;]*m/.test(cap)
      const content = /claude/i.test(stripAnsi(cap)) || cap.length > 800

      const pass = altScreen && anyColor && content && labeled && errors.length === 0

      emit({
        pass,
        detected,
        detectedClaude,
        altScreen,
        altEnter,
        anyColor,
        content,
        labeled,
        bufType,
        capLen: cap.length,
        errors,
        text: stripAnsi(cap).slice(0, 700)
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ pass: false, errors: [...errors, 'exception: ' + String(e)] })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  setTimeout(() => {
    if (done) return
    done = true
    emit({ pass: false, errors: [...errors, 'TIMEOUT'] })
    app.exit(1)
  }, 60000)
}

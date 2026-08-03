import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { ALT_SCREEN_ENTER_RE, SGR_RE } from '@contracts'

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
      // Launcher-first boot: provision Workspace 1 (pane 1) ourselves.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await delay(2500)
      await ES(
        "window.__cap='';if(!window.__capHooked){window.__capHooked=true;" +
          "window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});}1"
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
      await ES("window.__mogging.agents.launch('claude');")
      // Newer Claude Code builds boot slower AND may show first-run onboarding
      // (theme picker / trust dialog) on the NORMAL buffer. POLL for the alternate
      // screen up to 45 s, answering known onboarding prompts with Enter (defaults)
      // — the assertion itself (a real TUI on the alt screen) is unchanged.
      let cap = ''
      let bufType = '?'
      let answeredTheme = false
      let answeredTrust = false
      for (let i = 0; i < 45; i++) {
        await delay(1000)
        cap = String(await ES('window.__cap'))
        bufType = String(
          await ES(
            '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];return p?p.term.buffer.active.type:"?";})()'
          )
        )
        // Wait for exactly the pair the LAUNCH COVER waits for: the alternate screen
        // taken, and a frame painted into it (ui/core/terminal/liveness-port.ts). This
        // loop used to break on whichever protocol marker arrived first, and the earlier
        // ones lose by a wide margin — scripts/measure-agent-readiness.mjs puts the
        // cursor-shape query at 1.4-1.9s and alt-screen at 2.0-2.6s — so it captured a
        // pane that had negotiated but not yet drawn, and then failed its own `anyColor`
        // assertion. Waiting on both makes this gate the standing proof that the signal
        // the product ships on is really emitted by a real CLI.
        if ((bufType === 'alternate' || ALT_SCREEN_ENTER_RE.test(cap)) && SGR_RE.test(cap)) break
        // Cursor-positioning sequences swallow the spaces — match de-spaced text.
        const plain = stripAnsi(cap).replace(/\s+/g, '')
        if (!answeredTheme && /Choosethetextstyle|Let'sgetstarted/i.test(plain)) {
          answeredTheme = true
          await ES('window.bridge.send("terminal:write",{id:1,data:"\\r"});')
        } else if (!answeredTrust && /trustthefiles|trustthisfolder|Yes,proceed/i.test(plain)) {
          answeredTrust = true
          await ES('window.bridge.send("terminal:write",{id:1,data:"\\r"});')
        }
      }
      // SHAPE 2 (a consequence of the event above, read with NO budget of its own). The loop
      // exits the instant the TUI takes the screen and paints; the pane LABEL comes from the
      // daemon's process-table detection, which is a different, strictly later event — it walks
      // the pane's PTY subtree on its own cadence. Read in the same tick as the alt screen, this
      // is a coin flip on a loaded runner, and `labeled` is load-bearing in `pass`. Give the
      // consequence its own poll. 6s at 300ms: bounded so the run still fits inside this gate's
      // 60s net even when the alt-screen loop above spends its full 45s.
      let labeled = false
      for (let i = 0; i < 20 && !labeled; i++) {
        labeled = Boolean(await ES("!!document.querySelector('.pane-label.has-label')"))
        if (!labeled) await delay(300)
      }

      const altEnter = ALT_SCREEN_ENTER_RE.test(cap)
      const altScreen = bufType === 'alternate' || altEnter
      // A real TUI is detected by protocol signals, not screen choice: alt screen, kitty
      // keyboard enable (ESC[>1u), cursor-shape negotiation (ESC[>0q), or synchronized
      // output (ESC[?2026h). Claude Code 2.1.19x could render IN PLACE on the normal
      // buffer, which is why the broader set is still what `pass` rests on; current
      // builds are fullscreen with no opt-out, so the loop above waits for the alt
      // screen and the wider net only matters if that ever changes back.
      const tuiProtocol = altScreen || /\x1b\[>\d*[uq]/.test(cap) || /\x1b\[\?2026h/.test(cap)
      const anyColor = /\x1b\[[0-9;]*m/.test(cap)
      const content = /claude/i.test(stripAnsi(cap)) || cap.length > 800

      const pass = detectedClaude && tuiProtocol && anyColor && content && labeled && errors.length === 0

      emit({
        pass,
        detected,
        detectedClaude,
        altScreen,
        tuiProtocol,
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

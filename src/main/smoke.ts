import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, type BrowserWindow } from 'electron'

// Env-gated runtime smoke test (set MOGGING_SMOKE=1). Launches with the real window +
// backend, captures both consoles, verifies window.bridge + that the app shell rendered,
// then drives the terminal through the Phase-0/02 checklist (env/PATH, echo I/O,
// streaming, window-resize reflow, pty resize, scrollback, WebGL, copy, paste). Writes a
// single SMOKE_RESULT JSON line + out/smoke-result.json, then exits (0 = pass, 1 = fail).
// Inert unless MOGGING_SMOKE is set — safe in prod.
export function runSmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const consoleMsgs: Array<{ level: unknown; message: string }> = []
  const wc = win.webContents
  let done = false

  // Automation robustness: smokes often run with the window unfocused/occluded; a throttled
  // renderer makes the fixed copy/paste waits below flake. Measure our code, not the scheduler.
  wc.setBackgroundThrottling(false)

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
  wc.on('render-process-gone', (_e, details) => errors.push('render-process-gone: ' + JSON.stringify(details)))
  wc.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load: ' + code + ' ' + desc))
  wc.on('preload-error', (_e, p, error) => errors.push('preload-error: ' + p + ' :: ' + String(error)))

  const write = (result: object): void => {
    const json = JSON.stringify(result)
    console.log('SMOKE_RESULT ' + json)
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'smoke-result.json'), json)
    } catch {
      // best-effort
    }
  }

  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const send = (d: string): Promise<unknown> =>
    ES('window.bridge.send("terminal:write",{id:1,data:' + JSON.stringify(d) + '});')
  const grid = (): Promise<{ rows: number; cols: number }> =>
    ES(
      '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
        'return p?{rows:p.rows(),cols:p.cols()}:{rows:-1,cols:-1};})()'
    ) as Promise<{ rows: number; cols: number }>

  async function bridgeCheck(): Promise<Record<string, unknown>> {
    return ES(
      '({' +
        ' bridge: typeof window.bridge,' +
        ' methods: window.bridge ? Object.keys(window.bridge) : [],' +
        ' rootChildren: (document.getElementById("root") || {}).childElementCount ?? -1,' +
        ' titlebar: !!document.getElementById("titlebar"),' +
        ' pane: !!document.querySelector(".pane")' +
        '})'
    ) as Promise<Record<string, unknown>>
  }

  async function terminalCore(): Promise<Record<string, unknown>> {
    // Launcher-first boot: the app opens on Home with no workspace. Create Workspace 1
    // (which reveals its grid + spawns pane 1) and give its shell time to reach a prompt.
    await ES(
      '(function(){var m=window.__mogging;' +
        'if(m&&m.workspace&&m.workspace.count()===0){m.workspace.create({name:"Workspace 1"});}' +
        'else if(m&&m.workspace){m.workspace.switchByIndex(0);}return true;})()'
    )
    await delay(2500)

    await ES(
      "window.__cap='';" +
        "if(!window.__capHooked){window.__capHooked=true;" +
        "window.bridge.on('terminal:data',function(e){if(e&&e.id===1){window.__cap+=e.data;}});}"
    )

    // I/O: echo marker, env/PATH, and 50 streamed lines. Platform-aware: the pane
    // shell is cmd.exe on Windows and the login shell (bash/zsh/sh) elsewhere.
    const isWin = process.platform === 'win32'
    await send('echo MOGGING_ECHO_7788\r')
    await send(isWin ? 'echo PATHSTART[%PATH%]PATHEND\r' : 'echo "PATHSTART[$PATH]PATHEND"\r')
    await send(isWin ? 'for /L %i in (1,1,50) do @echo LN_%i\r' : 'for i in $(seq 1 50); do echo LN_$i; done\r')
    await delay(1800)

    // Window-resize reflow: shrink the OS window and confirm the grid recomputed.
    const before = await grid()
    win.setSize(900, 600)
    await delay(600)
    const after = await grid()
    const reflowOk = after.cols !== before.cols || after.rows !== before.rows

    // PTY resize (SIGWINCH path) must not throw, and the shell keeps working.
    let ptyResizeOk = true
    try {
      await ES('window.bridge.send("terminal:resize",{id:1,cols:100,rows:38});')
    } catch {
      ptyResizeOk = false
    }
    await send('echo AFTER_RESIZE_5150\r')
    await delay(700)

    const cap = String(await ES('window.__cap'))
    const rinfo = (await ES(
      '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
        'return p?{bufferLines:p.bufferLines(),rows:p.rows(),cols:p.cols(),hasCanvas:p.hasCanvas()}' +
        ':{bufferLines:-1,rows:-1,cols:-1,hasCanvas:!!document.querySelector("canvas")};})()'
    )) as { bufferLines: number; rows: number; cols: number; hasCanvas: boolean }

    // Copy: select all -> selection non-empty; write a marker through the clipboard IPC.
    const selLen = Number(
      await ES(
        '(function(){var p=window.__mogging&&window.__mogging.panes&&window.__mogging.panes[0];' +
          'if(!p)return -1;p.term.selectAll();var s=p.term.getSelection();' +
          'window.bridge.invoke("clipboard:write",{text:"COPY_MARK_3312"});return s.length;})()'
      )
    )
    await delay(800)
    const copyClip = clipboard.readText()

    // Paste: main sets the OS clipboard; renderer reads it via IPC and writes to the pty.
    clipboard.writeText('PASTE_MARK_5591')
    await ES('window.bridge.invoke("clipboard:read").then(function(t){window.bridge.send("terminal:write",{id:1,data:t+"\\r"});});')
    await delay(1600)
    const cap2 = String(await ES('window.__cap'))

    const echo = cap.includes('MOGGING_ECHO_7788')
    const pathOk = isWin
      ? /PATHSTART\[[\s\S]*(Windows|System32)[\s\S]*\]PATHEND/i.test(cap)
      : /PATHSTART\[[\s\S]*\/(usr\/)?bin[\s\S]*\]PATHEND/.test(cap)
    const lines = (cap.match(/LN_\d+/g) || []).length
    const afterResize = cap.includes('AFTER_RESIZE_5150')
    const scrollbackOk = rinfo.bufferLines > rinfo.rows && rinfo.rows > 0
    const webglActive = !consoleMsgs.some((m) => String(m.message).includes('WebGL renderer unavailable'))
    const copyOk = copyClip === 'COPY_MARK_3312' && selLen > 0
    const pasteOk = cap2.includes('PASTE_MARK_5591')

    const pass =
      echo &&
      pathOk &&
      lines >= 40 &&
      reflowOk &&
      ptyResizeOk &&
      afterResize &&
      scrollbackOk &&
      webglActive &&
      copyOk &&
      pasteOk

    return {
      pass,
      echo,
      pathOk,
      lines,
      reflowOk,
      ptyResizeOk,
      afterResize,
      scrollbackOk,
      webglActive,
      copyOk,
      pasteOk,
      selLen,
      grid: { before, after, final: { rows: rinfo.rows, cols: rinfo.cols } },
      bufferLines: rinfo.bufferLines,
      hasCanvas: rinfo.hasCanvas,
      capTail: cap2.slice(-260)
    }
  }

  const finish = (extra?: string): void => {
    if (done) return
    done = true
    if (extra) errors.push(extra)
    void (async () => {
      try {
        const info = await bridgeCheck()
        const bridgeOk =
          info?.bridge === 'object' &&
          Array.isArray(info.methods) &&
          (info.methods as unknown[]).length >= 3 &&
          typeof info.rootChildren === 'number' &&
          (info.rootChildren as number) > 0
        const terminal = await terminalCore()
        const pass = errors.length === 0 && bridgeOk && terminal.pass === true
        write({ pass, errors, info, terminal, consoleMsgs })
        app.exit(pass ? 0 : 1)
      } catch (e) {
        write({ pass: false, errors: [...errors, 'smoke exception: ' + String(e)], consoleMsgs })
        app.exit(1)
      }
    })()
  }

  wc.once('did-finish-load', () => setTimeout(() => finish(), 2000))
  // Hard safety timeout only for the case did-finish-load never fires (async work above
  // is guarded by `done`, so it is free to take as long as it needs).
  setTimeout(() => finish('TIMEOUT: did-finish-load never fired within 40s'), 40000)
}

import { app, clipboard, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quotePathForShell, shellFlavor } from '@contracts'
import {
  clipboardAuditState,
  failNextClipboardWrites,
  resetClipboardReadAudit
} from './clipboard-audit-faults'

// Env-gated clipboard smoke (MOGGING_CLIPBOARD). Five things are checked, because five
// things can independently break and each is invisible from the others:
//
//   1. The pure quoting rule — asserted HERE, in main, with no window involved. A dropped
//      path must survive spaces, quotes, `$`, and must never smuggle a newline.
//   2. The history ring over real IPC — write, list, restore, remove, and the rule that
//      deleting the CURRENT entry also clears the system clipboard.
//   3. The drop overlay's lifecycle, driven by synthetic drag events: hidden at rest,
//      raised with the right message while a file hovers, lowered after the drop.
//   4. The paste choke point, against a REAL pty: one paste event echoes exactly once —
//      twice means xterm's own unsanitised paste listener ran alongside ours.
//   5. The AGENT's clipboard (probeAgentClipboard): OSC 52 — the sequence Claude Code,
//      Codex, vim and tmux copy with — must land on the system clipboard; its READ form
//      must be answered with NOTHING (the exfil guard); an image-only paste must forward
//      the bare Ctrl+V byte so the CLI reads the image itself; and a copy the OS refused
//      must come back as a failure the user can see, never a silent success. This is the
//      regression fence around the 2026-07 bug where Claude Code printed "Copied N
//      characters to clipboard" while the clipboard never changed.
//
// What no smoke can drive: a real OS drag, so the webUtils.getPathForFile link (dropped
// File -> absolute path) still needs one human drag. Everything downstream of it is
// covered by 1 and 3; everything upstream is DOM the smoke exercises directly.

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const b = window.bridge
  if (!b) return { pass: false, error: 'no bridge' }

  // A clean slate: the ring may already hold whatever the host clipboard had.
  await b.invoke('clipboard:historySet', { enabled: true })
  await b.invoke('clipboard:clear')

  // Privacy: an explicitly copied secret still reaches the system clipboard, but the
  // history ring must refuse it. Clearing history also clears that live system value.
  const secretText = 'password=' + 'smoke-secret-5591'
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: secretText, source: 'app' })
  await sleep(50)
  let hist = await b.invoke('clipboard:history')
  const sensitiveNotRetained = hist.length === 0
  const sensitiveStillCopied = (await b.invoke('clipboard:read')) === secretText
  await b.invoke('clipboard:clear')
  const privacyClearWorked = (await b.invoke('clipboard:read')) === ''

  // 1. Write two distinct entries; newest must come first. Assertions read PREVIEW:
  //    the wire deliberately carries no full text (see toWire in main/clipboard.ts),
  //    and for short control-free strings preview === payload.
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'FIRST_5591', source: 'terminal' })
  await sleep(50)
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'SECOND_5591', source: 'app' })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const ordered = hist.length === 2 && hist[0].preview === 'SECOND_5591' && hist[1].preview === 'FIRST_5591'
  const sourced = hist[1].source === 'terminal' && hist[0].source === 'app'
  const stamped = hist.every((e) => typeof e.at === 'number' && e.at > 0)
  // The privacy property itself, locked down: full text must never cross the bridge.
  const wireStripped = hist.every((e) => e.text === '')

  // 2. The system clipboard holds the newest write.
  const liveIsSecond = (await b.invoke('clipboard:read')) === 'SECOND_5591'

  // 3. Restoring an older entry floats it to the top AND puts it on the system clipboard
  //    (the read comes back with FULL text — proof main kept the payload it stopped wiring).
  await b.invoke('clipboard:restore', { id: hist[1].id })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const restored = hist[0].preview === 'FIRST_5591' && (await b.invoke('clipboard:read')) === 'FIRST_5591'

  // 4. Deleting the entry that IS the system clipboard must clear the system clipboard —
  //    otherwise "delete" leaves the secret one paste away.
  await b.invoke('clipboard:remove', { id: hist[0].id })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const removedFromRing = hist.length === 1 && hist[0].preview === 'SECOND_5591'
  const systemCleared = (await b.invoke('clipboard:read')) === ''

  // 5. De-dupe: re-copying an existing payload moves it, never doubles it.
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'SECOND_5591', source: 'app' })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const deduped = hist.length === 1

  // 6. Turning history off must EMPTY the ring, not merely hide it.
  await b.invoke('clipboard:historySet', { enabled: false })
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'GHOST_5591', source: 'app' })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const recordingOff = hist.length === 0
  await b.invoke('clipboard:historySet', { enabled: true })

  // 7. A DROP is remembered but must never overwrite the system clipboard.
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'KEEP_ME_5591', source: 'app' })
  await sleep(50)
  await b.invoke('clipboard:recordDrop', { files: ['/tmp/a b.txt'], text: "'/tmp/a b.txt'" })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const dropRecorded = hist[0].kind === 'files' && hist[0].source === 'drop' &&
                       hist[0].files && hist[0].files[0] === '/tmp/a b.txt'
  const dropDidNotClobber = (await b.invoke('clipboard:read')) === 'KEEP_ME_5591'

  // 8. An IMAGE round-trips, and deleting it clears the system clipboard too — the
  //    guarantee the delete button's tooltip makes, which text got but images did not.
  //    The pixel is generated OPAQUE via canvas: a semi-transparent hardcoded PNG could
  //    change under the OS clipboard's DIB alpha round-trip and flake the fingerprint.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 8
  const cx = canvas.getContext('2d')
  cx.fillStyle = '#ff2200'
  cx.fillRect(0, 0, 8, 8)
  const PNG_RED = canvas.toDataURL('image/png')
  await b.invoke('clipboard:writeEntry', { kind: 'image', imageDataUrl: PNG_RED, source: 'app' })
  await sleep(80)
  hist = await b.invoke('clipboard:history')
  const imageRecorded = hist[0].kind === 'image' && !!hist[0].imageDataUrl
  const richIsImage = (await b.invoke('clipboard:readRich')).kind === 'image'
  await b.invoke('clipboard:remove', { id: hist[0].id })
  await sleep(80)
  const imageDeleteCleared = (await b.invoke('clipboard:readRich')).kind === 'text'

  // 9. The environment names a quoting flavor.
  const env = await b.invoke('clipboard:env')
  const hasFlavor = ['posix', 'cmd', 'powershell'].includes(env && env.flavor)

  // 10. Every terminal pane carries a drop overlay, hidden until a drag arrives.
  const m = window.__mogging
  if (m && m.workspace && m.workspace.count() === 0) m.workspace.create({ name: 'Workspace 1' })
  for (let i = 0; i < 50 && !document.querySelector('.pane-drop'); i++) await sleep(200)
  const overlay = document.querySelector('.pane-drop')
  const overlayReady = !!overlay && overlay.hidden === true && !overlay.classList.contains('is-active')

  // 11. The drag animation, driven synthetically: a file-bearing dragenter raises the
  //     card (translucent, correct message), the drop lowers it, and a drop whose File
  //     has no disk backing (getPathForFile throws) must not break anything.
  let overlayShown = false
  let overlayTitled = false, overlayHiddenAfterDrop = false
  const paneBody = overlay ? overlay.parentElement : null
  if (paneBody) {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'dropped.txt', { type: 'text/plain' }))
    const fire = (type) =>
      paneBody.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire('dragenter')
    fire('dragover')
    // POLL for is-active rather than sampling once: the class lands via rAF, and
    // Chromium suspends rAF entirely for an occluded window — which a smoke window
    // running behind a terminal often is. (A real drag's target window is visible by
    // definition, so production never depends on this.)
    for (let i = 0; i < 12 && !overlayShown; i++) {
      await sleep(100)
      overlayShown = overlay.hidden === false && overlay.classList.contains('is-active')
    }
    const titleEl = overlay.querySelector('.pane-drop-title')
    overlayTitled = !!titleEl && titleEl.textContent === 'Drop to insert path'
    fire('drop')
    await sleep(500) // fade (150 ms) + the 220 ms fallback, with slack
    overlayHiddenAfterDrop = overlay.hidden === true && !overlay.classList.contains('is-active')
  }

  // 11b. The path-resolution bridge is ALIVE in the sandboxed preload. A pathless
  //      synthetic File cannot yield a real path — the point is distinguishing
  //      "webUtils answered (empty/threw its own error)" from "webUtils missing",
  //      which would make every real drop a silent no-op.
  let pathApi = 'bridge-fn-missing'
  try {
    if (typeof b.getPathForFile === 'function') {
      const p = b.getPathForFile(new File(['x'], 'probe.txt'))
      pathApi = 'ok:' + JSON.stringify(p)
    }
  } catch (err) {
    const s = String(err)
    pathApi = s.indexOf('undefined') !== -1 ? 'WEBUTILS-MISSING:' + s.slice(0, 60) : 'ok-threw:' + s.slice(0, 60)
  }
  const pathApiLive = pathApi.indexOf('ok') === 0

  // 12. The paste choke point, end to end: a synthetic 'paste' event on xterm's textarea
  //     must reach the REAL pty and echo back EXACTLY ONCE. Twice would mean xterm's own
  //     unsanitised paste listener ran alongside ours — the double-paste regression.
  let pasteOnce = false, pasteCount = -1
  const pane = m && m.panes && m.panes[0]
  if (pane && pane.term && pane.term.textarea) {
    await sleep(1500) // let the shell prompt settle so the echo has somewhere to land
    const dtp = new DataTransfer()
    dtp.setData('text/plain', 'PASTE_E2E_5591')
    pane.term.textarea.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dtp })
    )
    const countMarker = () => {
      const buf = pane.term.buffer.active
      let all = ''
      for (let r = 0; r < buf.length; r++) {
        const line = buf.getLine(r)
        if (line) all += line.translateToString(true) + String.fromCharCode(10)
      }
      return all.split('PASTE_E2E_5591').length - 1
    }
    for (let i = 0; i < 25 && countMarker() === 0; i++) await sleep(200)
    await sleep(600) // grace: a SECOND echo (the double-paste bug) needs time to show up
    pasteCount = countMarker()
    pasteOnce = pasteCount === 1
  }

  return {
    pass: sensitiveNotRetained && sensitiveStillCopied && privacyClearWorked &&
          ordered && sourced && stamped && wireStripped && liveIsSecond && restored &&
          removedFromRing && systemCleared && deduped && recordingOff && dropRecorded &&
          dropDidNotClobber && imageRecorded && richIsImage && imageDeleteCleared &&
          hasFlavor && overlayReady && overlayShown && overlayTitled &&
          overlayHiddenAfterDrop && pasteOnce && pathApiLive,
    sensitiveNotRetained, sensitiveStillCopied, privacyClearWorked,
    ordered, sourced, stamped, wireStripped, liveIsSecond, restored, removedFromRing,
    systemCleared, deduped, recordingOff, dropRecorded, dropDidNotClobber,
    imageRecorded, richIsImage, imageDeleteCleared,
    hasFlavor, overlayReady, overlayShown, overlayTitled, overlayHiddenAfterDrop,
    pasteOnce, pasteCount, pathApi, pathApiLive, flavor: env && env.flavor
  }
})()`

/** The quoting rule, checked in-process. No PTY, no window — it is a pure function, and a
 *  regression here is a shell-injection bug, so it is asserted first and independently. */
function checkQuoting(): { pass: boolean; detail: Record<string, unknown> } {
  const NL = String.fromCharCode(10)
  const detail: Record<string, unknown> = {
    // The product contract: a PLAIN path is quoted too — "the complete path, inside
    // quotes", not "quoted when the characters demand it".
    plainPosix: quotePathForShell('/home/me/file.txt', 'posix'),
    plainCmd: quotePathForShell('C:\\Users\\pedro\\a.txt', 'cmd'),
    posixSpace: quotePathForShell('/a b/c.txt', 'posix'),
    posixQuote: quotePathForShell("/a/it's.txt", 'posix'),
    posixSubshell: quotePathForShell('/a/$(id).txt', 'posix'),
    cmdSpace: quotePathForShell('C:\\a b\\c.txt', 'cmd'),
    psDollar: quotePathForShell('C:\\$Recycle.Bin\\x', 'powershell'),
    psQuote: quotePathForShell("C:\\o'brien\\x", 'powershell'),
    newline: quotePathForShell('/a' + NL + 'rm -rf ~', 'posix'),
    // cmd expands %NAME% even inside double quotes, so a filename is an INJECTION vector:
    // unspliced, `"C:\tmp\100%PATHX%end"` retargets the user's next command at whatever
    // PATHX holds. Each % must ride BETWEEN quoted runs (see cmdQuote) — and a backslash
    // abutting any quote we emit, spliced or final, must be doubled or the argv parser
    // reads it as an escaped quote and swallows the next token.
    cmdPercent: quotePathForShell('C:\\tmp\\100%PATHX%end', 'cmd'),
    cmdPercentTail: quotePathForShell('C:\\dir\\%FOO%', 'cmd'),
    cmdDriveRoot: quotePathForShell('C:\\', 'cmd'),
    flavorWin: shellFlavor('C:\\Windows\\system32\\cmd.exe', 'win32'),
    flavorPwsh: shellFlavor('pwsh.exe', 'win32'),
    flavorMac: shellFlavor('/bin/zsh', 'darwin')
  }
  const pass =
    detail.plainPosix === `'/home/me/file.txt'` &&
    detail.plainCmd === '"C:\\Users\\pedro\\a.txt"' &&
    detail.posixSpace === `'/a b/c.txt'` &&
    detail.posixQuote === `'/a/it'\\''s.txt'` &&
    detail.posixSubshell === `'/a/$(id).txt'` &&
    detail.cmdSpace === '"C:\\a b\\c.txt"' &&
    detail.psDollar === `'C:\\$Recycle.Bin\\x'` &&
    detail.psQuote === `'C:\\o''brien\\x'` &&
    // The newline is stripped, so the quoted word can never become two commands.
    !String(detail.newline).includes(NL) &&
    detail.cmdPercent === '"C:\\tmp\\100"%"PATHX"%"end"' &&
    detail.cmdPercentTail === '"C:\\dir\\\\"%"FOO"%""' &&
    detail.cmdDriveRoot === '"C:\\\\"' &&
    // A %-free path is untouched by the splice — the normal case must not move a byte.
    detail.plainCmd === '"C:\\Users\\pedro\\a.txt"' &&
    detail.flavorWin === 'cmd' &&
    detail.flavorPwsh === 'powershell' &&
    detail.flavorMac === 'posix'
  return { pass, detail }
}

/** The shape asserts above prove we EMIT what we meant to. This proves cmd.exe HONORS it:
 *  type the quoted path at a real prompt (stdin to cmd.exe is the interactive parser — the
 *  same percent expansion a pane gets) and read back the argv the program actually
 *  received. Without this, the rule is only as true as our reading of the docs, and the
 *  docs are exactly what got this wrong before. win32 only; elsewhere there is no cmd. */
function checkCmdRoundTrip(): { pass: boolean; detail: Record<string, unknown> } {
  if (process.platform !== 'win32') return { pass: true, detail: { skipped: 'not win32' } }
  const paths = [
    'C:\\tmp\\100%PATHX%end', // a DEFINED var in the name — the injection
    'C:\\Users\\pedro\\%FOO%\\bin',
    'C:\\dir\\%FOO%', // backslash abuts a spliced quote
    'C:\\a&b%FOO%c', // a cmd metachar rides along, and must stay literal
    'C:\\a%my var%b', // a space inside the spliced pair — still ONE argument
    'C:\\', // drive root: the trailing-backslash escape
    'C:\\Program Files\\My App' // the ordinary case
  ]
  const detail: Record<string, unknown> = {}
  const sink = join(app.getPath('temp'), 'mogging-cmdquote-argv.json')
  let pass = true
  for (const p of paths) {
    // ELECTRON_RUN_AS_NODE turns our own binary into a plain Node — no extra dependency,
    // and its argv goes through the very CommandLineToArgvW rules the quoting targets.
    // The argv goes to a FILE, not stdout: cmd echoes piped input, so stdout carries the
    // command line as well as its output and any parse of it can match the wrong one.
    // `-e` puts NO script path in argv: argv[1] is the first real argument, not argv[2].
    const probe = `require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))`
    const line = `"${process.execPath}" -e "${probe}" "${sink}" ${quotePathForShell(p, 'cmd')}\r\n`
    let got: string[] | null = null
    try {
      unlinkSync(sink)
    } catch {
      /* first run */
    }
    try {
      execFileSync('cmd.exe', [], {
        input: `@echo off\r\nset FOO=BAR\r\nset PATHX=INJECTED\r\n${line}exit\r\n`,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      got = JSON.parse(readFileSync(sink, 'utf8')) as string[]
    } catch {
      got = null
    }
    detail[p] = got
    // ONE argument, and byte-exactly the path we quoted.
    if (!Array.isArray(got) || got.length !== 1 || got[0] !== p) pass = false
  }
  try {
    unlinkSync(sink)
  } catch {
    /* best effort */
  }
  return { pass, detail }
}

/** The one link a synthetic DragEvent cannot carry: a REAL, disk-backed File resolving
 *  to its absolute path through the sandboxed preload's getPathForFile — the exact call
 *  a real drop makes. CDP's DOM.setFileInputFiles plants a real file on an input, which
 *  hands the renderer the same kind of File object an OS drag delivers. The probe file
 *  has a SPACE in its name on purpose: the path that comes back is the path quoting
 *  must survive. */
async function probeRealFileDrop(win: BrowserWindow): Promise<{ realDropPath: string; realDropOk: boolean }> {
  const probePath = join(app.getPath('temp'), 'mogging drop probe.txt')
  const dbg = win.webContents.debugger
  try {
    writeFileSync(probePath, 'probe')
    dbg.attach('1.3')
    await win.webContents.executeJavaScript(
      `(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__dropprobe'; document.body.append(i); return true })()`,
      true
    )
    const { root } = (await dbg.sendCommand('DOM.getDocument')) as { root: { nodeId: number } }
    const { nodeId } = (await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#__dropprobe'
    })) as { nodeId: number }
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [probePath], nodeId })
    const resolved = (await win.webContents.executeJavaScript(
      `(() => {
        const i = document.getElementById('__dropprobe')
        const f = i.files && i.files[0]
        let p = ''
        try { p = f ? window.bridge.getPathForFile(f) : 'NO-FILE' } catch (e) { p = 'THREW:' + String(e).slice(0, 120) }
        i.remove()
        return p
      })()`,
      true
    )) as string
    return {
      realDropPath: resolved,
      // Windows paths compare case-insensitively.
      realDropOk: resolved.toLowerCase() === probePath.toLowerCase()
    }
  } catch (e) {
    return { realDropPath: 'PROBE-FAILED:' + String(e).slice(0, 120), realDropOk: false }
  } finally {
    try {
      dbg.detach()
    } catch {
      /* not attached */
    }
    try {
      unlinkSync(probePath)
    } catch {
      /* already gone */
    }
  }
}

/**
 * The user's reported sequence, replayed verbatim: copy A outside the app, copy B
 * outside the app, click Copy on A's history row, Ctrl+V into a terminal — the paste
 * MUST produce A. The paste is fired with webContents.paste(), which emits the same
 * DOM `paste` event a physical Ctrl+V's default action does — unlike the synthetic
 * ClipboardEvent in the main script, this one carries Chromium's own reading of the
 * system clipboard, so a stale read is CAUGHT here. Also drives select-to-copy and
 * the Ctrl+C-with-selection chord, so every copy path the user can perform by hand
 * is exercised by machine.
 */
async function probeUserSequence(win: BrowserWindow): Promise<Record<string, unknown>> {
  const exec = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    // 1. Two copies "in Windows" — a main-side writeText is indistinguishable from
    //    another app's copy; the watcher must record both.
    clipboard.writeText('WINCOPY_A_5591')
    await sleep(1300) // > one 800 ms poll tick
    clipboard.writeText('WINCOPY_B_5591')
    await sleep(1300)
    const recorded = (await exec(`(async () => {
      const h = await window.bridge.invoke('clipboard:history')
      return h.some(e => e.preview === 'WINCOPY_A_5591') && h.some(e => e.preview === 'WINCOPY_B_5591')
    })()`)) as boolean

    // 2. Copy paths driven from the terminal itself: select-to-copy, then the
    //    Ctrl+C-with-selection chord (synthetic keydown drives our handler directly).
    //    Raw values are returned, not just verdicts — a false here must name itself.
    const termCopies = (await exec(`(async () => {
      const p = window.__mogging.panes[0]
      if (!p || !p.term) return { selectCopyOk: false, ctrlCOk: false, error: 'no pane' }
      // Select the first row that HAS text — row 0 of a restored session can be blank,
      // and a blank selection tests nothing (and must copy nothing; see handleKey).
      let textRow = -1
      const buf = p.term.buffer.active
      for (let r = 0; r < buf.length; r++) {
        const line = buf.getLine(r)
        if (line && line.translateToString(true).trim().length >= 9) { textRow = r; break }
      }
      if (textRow === -1) return { selectCopyOk: false, ctrlCOk: false, error: 'no text row' }
      const row0 = buf.getLine(textRow).translateToString(true)
      p.term.select(0, textRow, 9)
      const expectedSel = p.term.getSelection()
      await new Promise(r => setTimeout(r, 400)) // copy-on-select debounce is 120 ms
      const clip1 = await window.bridge.invoke('clipboard:read')
      p.term.select(0, textRow, 5)
      const expectedChord = p.term.getSelection()
      p.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 300))
      const clip2 = await window.bridge.invoke('clipboard:read')
      return {
        selectCopyOk: !!expectedSel && clip1 === expectedSel,
        ctrlCOk: !!expectedChord && clip2 === expectedChord,
        row0: row0.slice(0, 40),
        expectedSel, clip1: String(clip1).slice(0, 40),
        expectedChord, clip2: String(clip2).slice(0, 40)
      }
    })()`)) as { selectCopyOk: boolean; ctrlCOk: boolean }

    // 3. Restore A's row — the settings tab's Copy button path — and confirm the
    //    SYSTEM clipboard actually changed.
    const restoredRead = (await exec(`(async () => {
      const h = await window.bridge.invoke('clipboard:history')
      const row = h.find(e => e.preview === 'WINCOPY_A_5591')
      if (!row) return 'NO-ROW'
      await window.bridge.invoke('clipboard:restore', { id: row.id })
      return await window.bridge.invoke('clipboard:read')
    })()`)) as string

    // 4. The REAL paste into the terminal. A must land; B must not. A window-capture
    //    spy runs BEFORE the pane's own capture listener (outermost element first), so
    //    it sees the event even though the pane stops propagation — proving whether
    //    webContents.paste() produced an event at all, on what, carrying what.
    await exec(`(() => {
      window.__pasteSpy = []
      window.addEventListener('paste', (e) => {
        const t = e.target
        window.__pasteSpy.push({
          target: (t && t.tagName || '?') + '.' + (t && t.className || ''),
          text: String(e.clipboardData ? e.clipboardData.getData('text/plain') : 'NO-DATA').slice(0, 30)
        })
      }, true)
      const p = window.__mogging.panes[0]
      // Focus the textarea DIRECTLY: term.focus() no-ops when the pane is not laid out
      // (Home view showing, workspace hidden) — the paste event then lands on <body>,
      // outside every pane. The textarea itself is focusable regardless.
      p.term.textarea.focus()
      return true
    })()`)
    await sleep(250)
    const focusInfo = (await exec(
      `(() => { const a = document.activeElement; return (a && a.tagName || '?') + '.' + (a && a.className || '') })()`
    )) as string
    win.webContents.paste()
    await sleep(1500)
    const counts = (await exec(`(() => {
      const buf = window.__mogging.panes[0].term.buffer.active
      let all = ''
      for (let r = 0; r < buf.length; r++) { const l = buf.getLine(r); if (l) all += l.translateToString(true) }
      return { a: all.split('WINCOPY_A_5591').length - 1, b: all.split('WINCOPY_B_5591').length - 1, spy: window.__pasteSpy }
    })()`)) as { a: number; b: number; spy: unknown }

    return {
      seqRecordedExternal: recorded,
      seqTermCopies: termCopies,
      seqSelectCopyOk: termCopies.selectCopyOk,
      seqCtrlCCopyOk: termCopies.ctrlCOk,
      seqRestoreRead: restoredRead,
      seqRestoreOk: restoredRead === 'WINCOPY_A_5591',
      seqFocus: focusInfo,
      seqPasteCounts: counts,
      seqPasteCorrect: counts.a === 1 && counts.b === 0,
      seqPass:
        recorded &&
        termCopies.selectCopyOk &&
        termCopies.ctrlCOk &&
        restoredRead === 'WINCOPY_A_5591' &&
        counts.a === 1 &&
        counts.b === 0
    }
  } catch (e) {
    return { seqPass: false, seqError: String(e).slice(0, 200) }
  }
}

/**
 * The agent's clipboard, end to end — the fence around the OSC 52 fix (2026-07).
 *
 * Every sequence is written with `pane.term.write(...)`, which feeds xterm's parser the
 * same way PTY output does — so these assertions cover the shipped handler registration,
 * not a reimplementation of it. The PTY-write spy (`__mogging.ptyWrites`, a DEV seam in
 * terminalClient.write) observes what a pane TYPED, which the buffer cannot show: the
 * shell decides what echoes, and the two negative cases here are precisely about bytes
 * that must never be sent.
 */
async function probeAgentClipboard(win: BrowserWindow): Promise<Record<string, unknown>> {
  const exec = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true)
  try {
    const inPage = (await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const b = window.bridge
      const p = window.__mogging.panes[0]
      if (!p || !p.term) return { agentPass: false, agentError: 'no pane' }
      await b.invoke('clipboard:historySet', { enabled: true })

      // Base64 an arbitrary UTF-8 string the way an agent CLI does (bytes, not code units).
      const b64utf8 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      const OSC = String.fromCharCode(27) + ']52;c;'
      const BEL = String.fromCharCode(7)
      const readClip = () => b.invoke('clipboard:read')
      const waitClip = async (want) => {
        for (let i = 0; i < 20; i++) { if ((await readClip()) === want) return true; await sleep(100) }
        return false
      }

      // The spy sees every byte a pane sends to its PTY from here on.
      window.__mogging.ptyWrites = []
      const spy = window.__mogging.ptyWrites

      // 1. OSC 52 copy — THE reported bug. An agent emits ESC]52;c;<base64>BEL and the
      //    payload must land on the system clipboard.
      p.term.write(OSC + b64utf8('OSC52_ASCII_5591') + BEL)
      const osc52Ascii = await waitClip('OSC52_ASCII_5591')

      // 2. UTF-8 payload — a naive atob-only decode mangles every non-ASCII character.
      const utf8Payload = 'caf\\u00e9 \\u65e5\\u672c 5591'
      p.term.write(OSC + b64utf8(utf8Payload) + BEL)
      const osc52Utf8 = await waitClip(utf8Payload)

      // 3. Split across chunk boundaries — PTYs chunk anywhere, including inside the
      //    sequence. xterm's parser must reassemble it; this locks the wiring, not xterm.
      const whole = OSC + b64utf8('OSC52_SPLIT_5591') + BEL
      p.term.write(whole.slice(0, 9))
      await sleep(30)
      p.term.write(whole.slice(9))
      const osc52Split = await waitClip('OSC52_SPLIT_5591')

      // 4. History attribution: the newest ring entry is the OSC 52 copy, sourced
      //    'terminal' — an agent's copy is traceable like every other.
      const hist = await b.invoke('clipboard:history')
      const osc52InHistory = hist.length > 0 && hist[0].preview === 'OSC52_SPLIT_5591' && hist[0].source === 'terminal'

      // 5. The READ request must be answered with NOTHING. If anyone ever implements the
      //    read half, the reply rides terminalClient.write and the spy catches it — this
      //    is the guard against a pane (or an ssh host) reading the user's clipboard.
      await b.invoke('clipboard:write', { text: 'OSC52_SECRET_5591', source: 'app' })
      const spyMark = spy.length
      p.term.write(String.fromCharCode(27) + ']52;c;?' + BEL)
      await sleep(600)
      const readAnswered = spy.slice(spyMark).some((w) => String(w.data).includes('OSC52_SECRET_5591'))
      const osc52ReadRefused = !readAnswered

      // 6. An EMPTY payload (spec: "clear the selection") must not wipe the clipboard.
      p.term.write(OSC + BEL)
      await sleep(400)
      const osc52EmptyKept = (await readClip()) === 'OSC52_SECRET_5591'

      // 7. Garbage base64 copies nothing and breaks nothing.
      p.term.write(OSC + '@@@not-base64@@@' + BEL)
      await sleep(400)
      const osc52GarbageKept = (await readClip()) === 'OSC52_SECRET_5591'

      // 8. Image-only paste forwards the bare Ctrl+V byte (0x16) — the CLI reads the
      //    image off the system clipboard itself, but only if it SEES the chord. A real
      //    Chromium image paste carries type 'Files' with an image File; synthesized the
      //    same way here.
      const dtImg = new DataTransfer()
      dtImg.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
      const spyImg = spy.length
      p.term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dtImg }))
      await sleep(300)
      // Tolerate xterm's own device-query auto-replies (CPR/DA — ESC-prefixed, they ride
      // the same write path and can land at any time); the CHORD byte must be there, and
      // no OTHER printable byte may have been typed by the paste.
      const isAutoReply = (w) => w.startsWith(String.fromCharCode(27))
      const imgWrites = spy.slice(spyImg).map((w) => String(w.data))
      const imagePasteChord =
        imgWrites.some((w) => w === String.fromCharCode(22)) &&
        imgWrites.every((w) => w === String.fromCharCode(22) || isAutoReply(w))

      // 9. A text+image paste types the TEXT (never both, never the chord).
      const dtBoth = new DataTransfer()
      dtBoth.setData('text/plain', 'BOTH_5591')
      dtBoth.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
      const spyBoth = spy.length
      p.term.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dtBoth }))
      await sleep(300)
      const bothWrites = spy.slice(spyBoth).map((w) => String(w.data))
      const textWinsPaste =
        bothWrites.some((w) => w.includes('BOTH_5591')) &&
        bothWrites.every((w) => w !== String.fromCharCode(22))

      // 10. A MULTI-LINE write must verify clean. Windows stores clipboard text as CRLF,
      //     so the write-then-read-back check must tolerate \\n -> \\r\\n — a rejection
      //     here would flash "Copy failed" on every copied code block.
      let multilineOk = false
      try {
        await b.invoke('clipboard:write', { text: 'LINE1_5591' + String.fromCharCode(10) + 'LINE2_5591', source: 'app' })
        multilineOk = true
      } catch { multilineOk = false }

      delete window.__mogging.ptyWrites
      return {
        osc52Ascii, osc52Utf8, osc52Split, osc52InHistory, osc52ReadRefused,
        osc52EmptyKept, osc52GarbageKept, imagePasteChord, imgWrites,
        textWinsPaste, bothWrites, multilineOk,
        agentPass: osc52Ascii && osc52Utf8 && osc52Split && osc52InHistory &&
          osc52ReadRefused && osc52EmptyKept && osc52GarbageKept &&
          imagePasteChord && textWinsPaste && multilineOk
      }
    })()`)) as Record<string, unknown> & { agentPass?: boolean }

    // 11. A copy the OS refused must reject the invoke — this is what the renderer turns
    //     into `copyText === false`. Armed via the existing fault seam; the arm counter
    //     is exhausted by the attempt, so nothing leaks into later assertions.
    failNextClipboardWrites(1)
    const failedWriteRejected = (await exec(`(async () => {
      try { await window.bridge.invoke('clipboard:write', { text: 'MUSTFAIL_5591', source: 'app' }); return false }
      catch { return true }
    })()`)) as boolean
    failNextClipboardWrites(0)
    const failedWriteNotOnClipboard = clipboard.readText() !== 'MUSTFAIL_5591'

    // 12. …and the USER must see it. Drive the real chord (select + Ctrl+C) against an
    //     armed failure and require the danger toast. Two arms: copy-on-select's debounced
    //     copy fires first and consumes one; the chord consumes the other. The 3 s toast
    //     throttle collapses them to one visible truth.
    failNextClipboardWrites(2)
    const copyFailToast = (await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const p = window.__mogging.panes[0]
      const buf = p.term.buffer.active
      let textRow = -1
      for (let r = 0; r < buf.length; r++) {
        const line = buf.getLine(r)
        if (line && line.translateToString(true).trim().length >= 5) { textRow = r; break }
      }
      if (textRow === -1) return 'no-text-row'
      p.term.select(0, textRow, 5)
      p.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }))
      for (let i = 0; i < 20; i++) {
        const t = [...document.querySelectorAll('.toast--danger .toast-title')]
        if (t.some((el) => el.textContent === 'Copy failed')) return 'toast-shown'
        await sleep(150)
      }
      return 'no-toast'
    })()`)) as string
    failNextClipboardWrites(0)

    return {
      ...inPage,
      failedWriteRejected,
      failedWriteNotOnClipboard,
      copyFailToast,
      agentPass: !!(
        inPage.agentPass &&
        failedWriteRejected &&
        failedWriteNotOnClipboard &&
        copyFailToast === 'toast-shown'
      )
    }
  } catch (e) {
    failNextClipboardWrites(0) // never leave an armed failure behind
    return { agentPass: false, agentError: String(e).slice(0, 200) }
  }
}

export function runClipboardSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net (user-sequence + agent-clipboard probes add ~20 s)
  const run = async (): Promise<void> => {
    // Foreground the window: the overlay-animation check rides requestAnimationFrame,
    // which Chromium suspends for occluded windows — and a smoke window launched from a
    // terminal usually starts behind it.
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
    const quoting = checkQuoting()
    const cmdTrip = checkCmdRoundTrip()
    const defaultUi = (await win.webContents.executeJavaScript(`(() => {
      const section = document.querySelector('[data-section="clipboard"]')
      const row = [...(section?.querySelectorAll('.toggle-row') || [])]
        .find((el) => el.querySelector('.toggle-row-label')?.textContent?.trim() === 'Keep a history')
      const input = row?.querySelector('input.switch-input')
      const hint = row?.querySelector('.toggle-row-hint')?.textContent || ''
      const empty = section?.querySelector('.clip-empty')?.textContent || ''
      const pref = localStorage.getItem('mogging.clipboard.historyEnabled')
      const pass = input instanceof HTMLInputElement && !input.checked && pref === '0' &&
        hint.includes('Off by default') && hint.includes('800 ms') &&
        hint.includes('other apps') && empty.includes('Clipboard history is off') &&
        empty.includes('not reading')
      return { pass, checked: input instanceof HTMLInputElement ? input.checked : null, pref, hint, empty }
    })()`, true)) as Record<string, unknown> & { pass?: boolean }

    // Direct proof of the negative promise: boot + more than one poll interval + an
    // explicit focus event while opted out must produce no Electron clipboard reads.
    const bootReadAudit = clipboardAuditState()
    const bootReadsNone =
      bootReadAudit.textReads === 0 && bootReadAudit.imageReads === 0 && bootReadAudit.formatReads === 0
    resetClipboardReadAudit()
    app.emit('browser-window-focus', {}, win)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const offReadAudit = clipboardAuditState()
    const offReadsNone =
      offReadAudit.textReads === 0 && offReadAudit.imageReads === 0 && offReadAudit.formatReads === 0
    let ipc: { pass?: boolean } = { pass: false }
    try {
      ipc = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      ipc = { pass: false, ...{ error: String(e) } }
    }
    const realDrop = await probeRealFileDrop(win)
    const seq = await probeUserSequence(win)
    const agent = await probeAgentClipboard(win)
    const finalClipboardAudit = clipboardAuditState()
    const sensitiveFilterObserved = finalClipboardAudit.blockedSensitiveEntries >= 1
    // `pass` LAST: the in-page script returns its own `pass`, and an earlier revision
    // spread `...ipc` after the computed field, letting the script's value overwrite
    // the aggregate — a green light that ignored the main-side probes.
    const result = {
      quoting: quoting.detail,
      quotingPass: quoting.pass,
      cmdRoundTrip: cmdTrip.detail,
      cmdRoundTripPass: cmdTrip.pass,
      defaultUi,
      bootReadAudit,
      bootReadsNone,
      offReadAudit,
      offReadsNone,
      finalClipboardAudit,
      sensitiveFilterObserved,
      ...realDrop,
      ...seq,
      ...agent,
      ...ipc,
      pass: !!(
        quoting.pass &&
        cmdTrip.pass &&
        defaultUi.pass &&
        bootReadsNone &&
        offReadsNone &&
        sensitiveFilterObserved &&
        ipc.pass &&
        realDrop.realDropOk &&
        seq.seqPass &&
        agent.agentPass
      )
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'clipboard-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    // Leave the host clipboard as we found it rather than holding a test marker.
    clipboard.clear()
    app.exit(result.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

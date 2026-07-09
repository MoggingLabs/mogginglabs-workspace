import { app, clipboard, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quotePathForShell, shellFlavor } from '@contracts'

// Env-gated clipboard smoke (MOGGING_CLIPBOARD). Four things are checked, because four
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

  // 1. Write two distinct entries; newest must come first. Assertions read PREVIEW:
  //    the wire deliberately carries no full text (see toWire in main/clipboard.ts),
  //    and for short control-free strings preview === payload.
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'FIRST_5591', source: 'terminal' })
  await sleep(50)
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'SECOND_5591', source: 'app' })
  await sleep(50)
  let hist = await b.invoke('clipboard:history')
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
    pass: ordered && sourced && stamped && wireStripped && liveIsSecond && restored &&
          removedFromRing && systemCleared && deduped && recordingOff && dropRecorded &&
          dropDidNotClobber && imageRecorded && richIsImage && imageDeleteCleared &&
          hasFlavor && overlayReady && overlayShown && overlayTitled &&
          overlayHiddenAfterDrop && pasteOnce && pathApiLive,
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
    posixSpace: quotePathForShell('/a b/c.txt', 'posix'),
    posixQuote: quotePathForShell("/a/it's.txt", 'posix'),
    posixSubshell: quotePathForShell('/a/$(id).txt', 'posix'),
    cmdSpace: quotePathForShell('C:\\a b\\c.txt', 'cmd'),
    psDollar: quotePathForShell('C:\\$Recycle.Bin\\x', 'powershell'),
    psQuote: quotePathForShell("C:\\o'brien\\x", 'powershell'),
    newline: quotePathForShell('/a' + NL + 'rm -rf ~', 'posix'),
    flavorWin: shellFlavor('C:\\Windows\\system32\\cmd.exe', 'win32'),
    flavorPwsh: shellFlavor('pwsh.exe', 'win32'),
    flavorMac: shellFlavor('/bin/zsh', 'darwin')
  }
  const pass =
    detail.posixSpace === `'/a b/c.txt'` &&
    detail.posixQuote === `'/a/it'\\''s.txt'` &&
    detail.posixSubshell === `'/a/$(id).txt'` &&
    detail.cmdSpace === '"C:\\a b\\c.txt"' &&
    detail.psDollar === `'C:\\$Recycle.Bin\\x'` &&
    detail.psQuote === `'C:\\o''brien\\x'` &&
    // The newline is stripped, so the quoted word can never become two commands.
    !String(detail.newline).includes(NL) &&
    detail.flavorWin === 'cmd' &&
    detail.flavorPwsh === 'powershell' &&
    detail.flavorMac === 'posix'
  return { pass, detail }
}

export function runClipboardSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 40000) // safety net
  const run = async (): Promise<void> => {
    // Foreground the window: the overlay-animation check rides requestAnimationFrame,
    // which Chromium suspends for occluded windows — and a smoke window launched from a
    // terminal usually starts behind it.
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
    const quoting = checkQuoting()
    let ipc: { pass?: boolean } = { pass: false }
    try {
      ipc = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      ipc = { pass: false, ...{ error: String(e) } }
    }
    const result = { pass: !!(quoting.pass && ipc.pass), quoting: quoting.detail, quotingPass: quoting.pass, ...ipc }
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

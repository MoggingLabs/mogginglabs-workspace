import { app, clipboard, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quotePathForShell, shellFlavor } from '@contracts'

// Env-gated clipboard smoke (MOGGING_CLIPBOARD). Three things are checked, because three
// things can independently break and each is invisible from the others:
//
//   1. The pure quoting rule — asserted HERE, in main, with no window involved. A dropped
//      path must survive spaces, quotes, `$`, and must never smuggle a newline.
//   2. The history ring over real IPC — write, list, restore, remove, and the rule that
//      deleting the CURRENT entry also clears the system clipboard.
//   3. The pane's drop overlay exists and is hidden until a drag arrives.

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const b = window.bridge
  if (!b) return { pass: false, error: 'no bridge' }

  // A clean slate: the ring may already hold whatever the host clipboard had.
  await b.invoke('clipboard:historySet', { enabled: true })
  await b.invoke('clipboard:clear')

  // 1. Write two distinct entries; newest must come first.
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'FIRST_5591', source: 'terminal' })
  await sleep(50)
  await b.invoke('clipboard:writeEntry', { kind: 'text', text: 'SECOND_5591', source: 'app' })
  await sleep(50)
  let hist = await b.invoke('clipboard:history')
  const ordered = hist.length === 2 && hist[0].text === 'SECOND_5591' && hist[1].text === 'FIRST_5591'
  const sourced = hist[1].source === 'terminal' && hist[0].source === 'app'
  const stamped = hist.every((e) => typeof e.at === 'number' && e.at > 0)

  // 2. The system clipboard holds the newest write.
  const liveIsSecond = (await b.invoke('clipboard:read')) === 'SECOND_5591'

  // 3. Restoring an older entry floats it to the top AND puts it on the system clipboard.
  await b.invoke('clipboard:restore', { id: hist[1].id })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const restored = hist[0].text === 'FIRST_5591' && (await b.invoke('clipboard:read')) === 'FIRST_5591'

  // 4. Deleting the entry that IS the system clipboard must clear the system clipboard —
  //    otherwise "delete" leaves the secret one paste away.
  await b.invoke('clipboard:remove', { id: hist[0].id })
  await sleep(50)
  hist = await b.invoke('clipboard:history')
  const removedFromRing = hist.length === 1 && hist[0].text === 'SECOND_5591'
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
  const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await b.invoke('clipboard:writeEntry', { kind: 'image', imageDataUrl: PNG_1x1, source: 'app' })
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

  return {
    pass: ordered && sourced && stamped && liveIsSecond && restored && removedFromRing &&
          systemCleared && deduped && recordingOff && dropRecorded && dropDidNotClobber &&
          imageRecorded && richIsImage && imageDeleteCleared && hasFlavor && overlayReady,
    ordered, sourced, stamped, liveIsSecond, restored, removedFromRing,
    systemCleared, deduped, recordingOff, dropRecorded, dropDidNotClobber,
    imageRecorded, richIsImage, imageDeleteCleared,
    hasFlavor, overlayReady, flavor: env && env.flavor
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

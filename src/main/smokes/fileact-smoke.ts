import { app, clipboard, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quotePathForShell, type ShellFlavor } from '@contracts'
import { setExplorerShellPortForSmoke, type ExplorerShellPort } from '../explorer'
import { probeContrastAcrossThemes, type AaProbeResult } from './aa-probe'

// Env-gated file-actions smoke (MOGGING_FILEACT, Phase-11/06). Everything a READ-ONLY
// explorer may do with a file — and proof that it does nothing else. The real shell is
// NEVER called: a recording spy is the only witness, because a gate that "tests" open-with-
// the-OS by launching the operator's editor is not a gate, it is a prank. Zero network.
// Asserts:
//   (a) Open/Reveal land the EXACT absolute path in the spy; an outside-root path and a
//       vanished one come back as TYPED refusals — no dialog, no throw, no shell call;
//   (b) copy path / copy relative path reach the system clipboard;
//   (c) send-to-pane: the pane's buffer ends with the quoted path and NO newline — the
//       shell never saw an Enter, so nothing ran;
//   (d) HOSTILE names — `$(rm -rf) .txt`, `; echo pwned;`, spaces, unicode, an HTML tag —
//       arrive as ONE inert quoted argument. `pwned` never appears in the pane, the fixture
//       files are all still on disk, and the name renders as TEXT (no element injected);
//   (e) the menu opens on Shift+F10, walks by keyboard, returns focus to its row on Esc,
//       and every item clears the 28px hitbox floor;
//   (f) the drag payload's `text/plain` equals the quoted insert, behind our private type.
//   Plus AA on the menu's inks, across four themes.
// Verdict: out/fileact-result.json.

interface Fixture {
  root: string
  outside: string
  hostile: string[]
}

/** Names a hostile agent (or a hostile repo) could plant. Each is a legal filename on this
 *  platform; each would be a different kind of disaster if it were ever interpolated. */
function hostileNames(): string[] {
  const names = [
    'a file with spaces.txt',
    'ünïcødé-名前.md',
    "it's-quoted.txt",
    '<img src=x onerror="window.__pwned=1">.md'
  ]
  // POSIX-only names: Windows forbids these characters outright, so a fixture that used
  // them there would fail to build rather than prove anything.
  if (process.platform !== 'win32') {
    names.push('$(rm -rf ~).txt', '; echo pwned; #.txt', '`echo pwned`.txt', 'back\\slash.txt')
  } else {
    // The win32 equivalents that ARE legal: cmd metacharacters that survive a filename.
    names.push('$(rm -rf).txt', '&echo pwned&.txt', '%USERPROFILE%.txt', '^caret^.txt')
  }
  return names
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'mog-fileact-'))
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'main.ts'), 'export {}\n')
  writeFileSync(join(root, 'README.md'), '# project\n')
  writeFileSync(join(root, 'gone.txt'), 'about to vanish\n') // deleted mid-smoke, for the `missing` refusal

  const hostile: string[] = []
  for (const name of hostileNames()) {
    try {
      writeFileSync(join(root, 'src', name), 'inert\n')
      hostile.push(name)
    } catch {
      /* this platform refuses the name — it cannot be an attack surface here */
    }
  }

  // OUTSIDE the explorer's root, on purpose: the guard's whole job.
  const outside = join(base, 'outside-secret.txt')
  writeFileSync(outside, 'must never be opened\n')
  return { root, outside, hostile }
}

/**
 * How many PROMPTS the pane has printed. This is the crispest possible proof that Enter was
 * never pressed: a shell prints a fresh prompt after every command it runs, so no matter how
 * many paths we type into it, the count must stay at ONE. We type; the user executes.
 */
function promptLines(buffer: string): number {
  if (process.platform === 'win32') {
    // xterm WRAPS buffer rows, and cmd's prompt is the full fixture path — long enough on a
    // CI runner (deep temp dirs, narrow pane) that `project>` itself splits across two rows.
    // A per-line test then counts ZERO prompts and the gate fails arithmetic it never meant
    // to test. Count occurrences in the rejoined stream: the marker only ever comes from the
    // prompt (no fixture name contains it), so occurrences == prompts.
    return (buffer.replace(/\n/g, '').match(/project>/g) ?? []).length
  }
  const marker = /[$%#]\s*$|project.*[$%#]/
  const perLine = buffer.split('\n').filter((l) => marker.test(l.trim())).length
  if (perLine > 0) return perLine
  // The POSIX prompt wraps too, on hosts with very long hostnames (the CI mac runner's spans
  // a full row): 'project' and the '$' land on different rows and the per-line test counts
  // ZERO prompts that are plainly on screen. Fall back to counting prompt occurrences in the
  // de-wrapped stream — fallback only, because de-wrapped matching is looser about what sits
  // between the marker and the sigil. (Typed fixture content never contains 'project': the
  // sends are all src/-relative.)
  return (buffer.replace(/\n/g, '').match(/project[^$%#]*[$%#]/g) ?? []).length
}

export function runFileActSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 300000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // THE ONLY WITNESS. The real shell is never reached — nothing on this machine opens.
  const spy: { opened: string[]; revealed: string[] } = { opened: [], revealed: [] }
  const port: ExplorerShellPort = {
    openPath: (p) => {
      spy.opened.push(p)
      return Promise.resolve('') // Electron's "success" is an empty error string
    },
    showItemInFolder: (p) => {
      spy.revealed.push(p)
    }
  }
  setExplorerShellPortForSmoke(port)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      const flavor: ShellFlavor = process.platform === 'win32' ? 'cmd' : 'posix'
      await sleep(1500)

      await ES(`window.__mogging.workspace.create({ name: 'Proj', cwd: ${JSON.stringify(F.root)}, paneCount: 1 })`)
      await sleep(3000) // the pane's shell spawns and prints a prompt
      await ES(`window.__mogging.explorer.toggle(true)`)
      await sleep(1000)
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(join(F.root, 'src'))})`)
      await sleep(1000)

      const mainTs = join(F.root, 'src', 'main.ts')

      // ── (a) Open / Reveal reach the OS with the exact path; refusals are TYPED ────
      await ES(`window.__mogging.explorer.resetActions()`)
      const openRes = await ES<{ ok: boolean }>(`window.__mogging.explorer.osOpen(${JSON.stringify(mainTs)})`)
      const revealRes = await ES<{ ok: boolean }>(`window.__mogging.explorer.osReveal(${JSON.stringify(mainTs)})`)
      await sleep(300)
      const delegateOk =
        openRes.ok === true && revealRes.ok === true &&
        spy.opened.length === 1 && spy.opened[0] === mainTs &&
        spy.revealed.length === 1 && spy.revealed[0] === mainTs

      // OUTSIDE the root: refused, and the shell is NEVER called.
      const outsideRes = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(F.outside)})`
      )
      // A path that VANISHED between listing and clicking.
      rmSync(join(F.root, 'gone.txt'))
      const goneRes = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(join(F.root, 'gone.txt'))})`
      )
      const junkRes = await ES<{ ok: boolean; reason?: string }>(`window.__mogging.explorer.osOpen('not-absolute')`)
      await sleep(300)
      const refusalsOk =
        outsideRes.ok === false && outsideRes.reason === 'outside-root' &&
        goneRes.ok === false && goneRes.reason === 'missing' &&
        junkRes.ok === false && junkRes.reason === 'invalid' &&
        spy.opened.length === 1 // ← the whole point: not ONE refused path reached the shell

      // ── (b) copy path / copy relative path ───────────────────────────────────────
      clipboard.writeText('sentinel-before-copy')
      await ES(`window.__mogging.explorer.menuFor(${JSON.stringify(mainTs)})`)
      await sleep(300)
      await ES(`[...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('Copy path')).click()`)
      await sleep(400)
      const copiedAbs = clipboard.readText()
      clipboard.writeText('sentinel-before-copy')
      await ES(`window.__mogging.explorer.menuFor(${JSON.stringify(mainTs)})`)
      await sleep(300)
      await ES(`[...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('Copy relative path')).click()`)
      await sleep(400)
      const copiedRel = clipboard.readText()
      const relExpected = join('src', 'main.ts')
      const copyOk = copiedAbs === mainTs && copiedRel === relExpected

      // ── (c) send-to-pane: typed, never executed ──────────────────────────────────
      // Focus the pane first — send-to-pane goes to the FOCUSED pane, by design.
      await ES(`document.querySelector('#workspace-host .xterm-helper-textarea').focus()`)
      await sleep(300)
      const quotedRel = quotePathForShell(relExpected, flavor) // the pane's cwd IS the root
      const insertText = await ES<string>(`window.__mogging.explorer.insertTextFor(${JSON.stringify(mainTs)})`)
      await ES(`window.__mogging.explorer.sendToPane(${JSON.stringify(mainTs)})`)
      await sleep(1200)
      const paneAfterSend = await ES<string>(`window.__mogging.panes[0].text()`)
      // xterm WRAPS: a prompt plus the path easily exceeds the dock-narrowed pane's columns,
      // so the logical input line is split across buffer rows. Rejoin them before looking —
      // "the last non-empty line" would otherwise be a fragment of the thing we typed.
      const flatBuffer = paneAfterSend.replace(/\n/g, '')
      const sendOk =
        insertText === quotedRel && // the exact quoted text…
        !/[\r\n]/.test(insertText) && // …carrying NO carriage return: it cannot press Enter
        flatBuffer.includes(quotedRel) && // …and it landed on the pane's input line
        promptLines(paneAfterSend) === 1 // …where nothing ran (a second prompt would mean it did)

      // ── (d) hostile names, end to end ────────────────────────────────────────────
      const hostileRows: Record<string, unknown>[] = []
      for (const name of F.hostile) {
        const p = join(F.root, 'src', name)
        const quoted = quotePathForShell(join('src', name), flavor)
        const got = await ES<string>(`window.__mogging.explorer.insertTextFor(${JSON.stringify(p)})`)
        await ES(`window.__mogging.explorer.sendToPane(${JSON.stringify(p)})`)
        await sleep(500)
        hostileRows.push({ name, quoted, got, matches: got === quoted })
      }
      await sleep(1500)
      const paneAfterHostile = await ES<string>(`window.__mogging.panes[0].text()`)
      // The HTML-tag name only exists where the filesystem allows it — Windows forbids
      // `<`, `>` and `"` in filenames outright, so there it is not an attack surface at all
      // (FILETREE proves the render path against a SYNTHETIC listing for exactly this
      // reason). Assert it where it can exist; say so plainly where it cannot.
      const tagName = F.hostile.find((n) => n.startsWith('<img')) ?? ''
      const domSafe = await ES<{ pwned: boolean; injected: boolean; rendered: boolean | null }>(`(() => {
        const names = window.__mogging.explorer.rowNames()
        const tag = ${JSON.stringify(tagName)}
        return {
          pwned: '__pwned' in window,
          injected: !!document.querySelector('.explorer-dock img'),
          rendered: tag ? names.includes(tag) : null
        }
      })()`)
      // The REAL proof that nothing executed: every fixture file is still on disk. A shell
      // that ran `$(rm -rf …)` or `; echo pwned;` would have left a mark.
      const survivors = readdirSync(join(F.root, 'src')).length
      // "pwned" APPEARS in the buffer — one of the fixture filenames is literally
      // `&echo pwned&.txt`, and the tree shows it. That is the point: it is TEXT. What would
      // prove execution is `pwned` printed as OUTPUT, i.e. alone on its own line, which is
      // exactly what an `echo` produces and what a quoted argument never does.
      const echoed = paneAfterHostile.split('\n').some((l) => l.trim().toLowerCase() === 'pwned')
      const hostileOk =
        hostileRows.length > 0 &&
        hostileRows.every((r) => r.matches === true) && // each is ONE quoted argument
        !echoed && // no shell metacharacter ever fired
        promptLines(paneAfterHostile) === 1 && // ENTER WAS NEVER PRESSED: still one prompt, after 7 sends
        !domSafe.pwned && !domSafe.injected && // no script ran, no element was injected
        domSafe.rendered !== false && // …and where the tag name CAN exist, it rendered as text
        // …and every fixture file is still on disk. A shell that had run `$(rm -rf …)` or
        // `& echo pwned &` would have left a mark on this tree.
        survivors === F.hostile.length + 1 && // + main.ts
        existsSync(join(F.root, 'README.md'))

      // ── (e) the menu: keyboard, focus return, hitbox ─────────────────────────────
      await ES(`window.__mogging.explorer.reveal(${JSON.stringify(mainTs)})`)
      await sleep(400)
      const menuKb = await ES<{
        opened: boolean
        items: number
        heights: number[]
        firstFocused: string
        afterDown: string
        afterEnd: string
        afterEsc: string
        stillOpen: boolean
      }>(`(async () => {
        const row = [...document.querySelectorAll('.explorer-dock .ft-row')].find((r) => r.title === ${JSON.stringify(mainTs)})
        row.focus()
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 200))
        const menu = document.querySelector('.ctx-menu')
        const items = [...document.querySelectorAll('.ctx-item')]
        const label = () => document.activeElement?.querySelector?.('.ctx-label')?.textContent ?? ''
        const firstFocused = label()
        // MEASURE WHILE IT IS UP: after Esc the items are detached and every rect is 0.
        const heights = items.map((b) => Math.round(b.getBoundingClientRect().height))
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        const afterDown = label()
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
        const afterEnd = label()
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 150))
        return {
          opened: !!menu,
          items: items.length,
          heights,
          firstFocused, afterDown, afterEnd,
          afterEsc: document.activeElement?.title ?? '',   // focus back on the ROW
          stillOpen: !!document.querySelector('.ctx-menu')
        }
      })()`)
      const menuOk =
        menuKb.opened && menuKb.items === 5 &&
        menuKb.heights.every((h) => h >= 28) &&
        menuKb.firstFocused === 'Open' &&
        menuKb.afterDown !== 'Open' &&
        menuKb.afterEnd === 'Send to pane' &&
        !menuKb.stillOpen &&
        menuKb.afterEsc === mainTs // Esc gave the keyboard back to the row that opened it

      // ── (f) the drag payload ─────────────────────────────────────────────────────
      const drag = await ES<Record<string, string>>(`window.__mogging.explorer.dragPayload(${JSON.stringify(mainTs)})`)
      const dragOk =
        drag['text/plain'] === quotedRel &&
        drag['application/x-mogging-path'] === '1' && // our private marker gates the pane's drop
        (drag['text/uri-list'] ?? '').startsWith('file://')

      // ── AA on the menu's inks ────────────────────────────────────────────────────
      await ES(`window.__mogging.explorer.menuFor(${JSON.stringify(mainTs)})`)
      await sleep(400)
      // A pane IS focused here, so "Send to pane" is enabled and the disabled ink would have
      // nothing to measure. Disable one item so the real CSS rule is measured rather than
      // reported as a rotted hook — the disabled state is a state a user reads.
      await ES(`(() => { const b = document.querySelector('.ctx-item'); if (b) b.disabled = true })()`)
      const aa: AaProbeResult = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.ctx-item:not(:disabled) .ctx-label', '.ctx-item .ctx-hint', '.ctx-item:disabled .ctx-label'],
        settleMs: 220
      })
      await ES(`document.querySelector('.ctx-menu')?.remove()`)
      // `missing` matters as much as `failures`: a selector that matched nothing in EVERY
      // theme is a hook that rotted, and a green gate over nothing measured is a lie.
      const aaOk = aa.failures.length === 0 && aa.missing.length === 0

      const pass = delegateOk && refusalsOk && copyOk && sendOk && hostileOk && menuOk && dragOk && aaOk
      result = {
        pass,
        delegateOk, spy, openRes, revealRes,
        refusalsOk, outsideRes, goneRes, junkRes,
        copyOk, copiedAbs, copiedRel, relExpected,
        sendOk, insertText, quotedRel, paneTail: flatBuffer.slice(-120),
        hostileOk, hostileRows, survivors, domSafe, echoed,
        promptsAfterSend: promptLines(paneAfterSend), promptsAfterHostile: promptLines(paneAfterHostile),
        menuOk, menuKb,
        dragOk, drag,
        aaOk, aaFailures: aa.failures, aaWorst: aa.worst, aaMissing: aa.missing,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    setExplorerShellPortForSmoke(null) // give the real shell back
    try {
      if (fx) rmSync(join(fx.root, '..'), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'fileact-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

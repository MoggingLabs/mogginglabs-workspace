import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated folder-browser smoke (MOGGING_FOLDERPICK, Phase-8.5/03). Builds a real
// fixture tree, then drives BOTH seams: the `fs:listDir` channel directly, and the
// wizard's Where card through the DOM. Zero network. Asserts:
//   (a) directories only, sorted case-insensitively, dotfolders hidden, 500-cap +
//       `truncated`;
//   (b) the repo pill renders for the folder holding `.git`;
//   (c) click-to-pick and breadcrumb-ascend move the wizard's cwd AND the path bar;
//   (d) typing an absolute path in the bar re-roots the browser;
//   (e) arrows + Enter descend without a mouse;
//   (f) an unreadable folder renders the refusal state and does not crash;
//   (g) the hidden toggle reveals the dotfolder — without stealing the selection;
//   (h) per-OS roots: the win32 drive list is reachable above `C:\`, POSIX stops at `/`;
//   (i) THE INVARIANT (8.5/03, after review): with no refusal and no remote host, the
//       controller's cwd, the path bar, and the browser's selection are ONE value.
//       Re-checked after every interaction — a ping-pong shows up here first;
//   (j) looking is not choosing: a fresh wizard opens the browser at $HOME with
//       NOTHING selected, so `$HOME` never silently becomes the workspace root;
//   (k) typing a path that does not exist leaves the browser exactly where it was
//       (a half-typed path used to replace the listing with a refusal), and Launch
//       declines a path the filesystem refused instead of stranding every pane in it.

const CAP = 500

interface Fixture {
  root: string
  locked: string
  deniedCreated: boolean
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mog-fpick-'))
  for (const d of ['alpha', 'Beta', 'Zeta']) mkdirSync(join(root, d))
  mkdirSync(join(root, 'alpha', 'sub'))
  mkdirSync(join(root, 'Beta', '.git')) // -> the repo pill
  mkdirSync(join(root, '.hidden')) // -> filtered unless "show hidden"
  writeFileSync(join(root, 'notes.txt'), 'a file, never listed\n')

  const many = join(root, 'many')
  mkdirSync(many)
  for (let i = 0; i < CAP + 100; i++) mkdirSync(join(many, 'd' + String(i).padStart(3, '0')))

  // A really unreadable folder. icacls on win32 yields EPERM; chmod 000 on POSIX
  // yields EACCES — but not for root, who bypasses the bit (some CI containers).
  const locked = join(root, 'locked')
  mkdirSync(locked)
  let deniedCreated = false
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [locked, '/deny', `${process.env.USERNAME}:(RX)`], { stdio: 'ignore', windowsHide: true })
      deniedCreated = true
    } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(locked, 0o000)
      deniedCreated = true
    }
  } catch {
    /* couldn't create the condition — the smoke says so rather than pretending */
  }
  // VERIFY the deny actually binds. A windows-latest CI runner account holds a privilege
  // that bypasses a /deny ACE on a folder IT owns, so icacls "succeeds" but the directory is
  // still readable (denied.ok:true, no refusal — a deterministic FOLDERPICK fail on CI Windows
  // both dispatches, 8.5/09). If the read goes through, the denied CONDITION could not be
  // built on this host; fall back to the same graceful path as POSIX-root (skip the
  // denied-refusal assertion) rather than fail on a fixture the OS would not let us create.
  if (deniedCreated) {
    try {
      readdirSync(locked)
      deniedCreated = false
    } catch {
      /* good — the deny binds, the folder is genuinely unreadable */
    }
  }
  return { root, locked, deniedCreated }
}

function cleanup(f: Fixture): void {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [f.locked, '/remove:d', String(process.env.USERNAME)], { stdio: 'ignore', windowsHide: true })
    else chmodSync(f.locked, 0o700)
  } catch {
    /* best effort */
  }
  try {
    rmSync(f.root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

export function runFolderPickSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net (600 mkdirs + a full wizard boot)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Renderer-side helpers, injected once per call site.
  const H = `
    const rows = () => [...document.querySelectorAll('#view-wizard .fb-row')]
    const rowNames = () => rows().map((r) => r.querySelector('.fb-row-name').textContent)
    const rowBy = (n) => rows().find((r) => r.querySelector('.fb-row-name').textContent === n)
    const crumbs = () => [...document.querySelectorAll('#view-wizard .fb-crumb')].map((c) => c.textContent)
    const bar = () => document.querySelector('#view-wizard .path-input-field').value
    const key = (node, k) => node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    const sot = () => window.__mogging.wizardPath()
  `

  /**
   * The single-source-of-truth invariant. With no refusal and no remote host, the
   * controller's cwd, the path bar's text, and the browser's selection are ONE value.
   * Checked after every interaction below — a ping-pong would show up here first.
   */
  const agrees = (): Promise<{ agree: boolean; cwd: string | null; bar: string | null; browserSelected: string | null }> =>
    ES(`window.__mogging.wizardPath()`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const fx = makeFixture()
    try {
      const R = JSON.stringify(fx.root)
      await sleep(1200)

      // ── (a) the channel itself: dirs only, sorted, hidden filtered ────────────
      const listed = await ES<{ entries: { name: string; isRepo: boolean }[]; truncated: boolean; parent: string | null }>(
        `window.bridge.invoke('fs:listDir', { path: ${R} })`
      )
      const names = listed.entries.map((e) => e.name)
      const dirsOnly = !names.includes('notes.txt')
      const hiddenFiltered = !names.includes('.hidden')
      const sorted = names.indexOf('alpha') < names.indexOf('Beta') && names.indexOf('Beta') < names.indexOf('Zeta')
      const repoFlagged = listed.entries.find((e) => e.name === 'Beta')?.isRepo === true

      const big = await ES<{ entries: unknown[]; truncated: boolean }>(
        `window.bridge.invoke('fs:listDir', { path: ${JSON.stringify(join(fx.root, 'many'))} })`
      )
      const capped = big.entries.length === CAP && big.truncated === true
      const listingOk = dirsOnly && hiddenFiltered && sorted && repoFlagged && capped

      // ── (f) refusals, straight from the channel ───────────────────────────────
      const denied = await ES<{ ok: boolean; reason?: string }>(`window.bridge.invoke('fs:listDir', { path: ${JSON.stringify(fx.locked)} })`)
      const missing = await ES<{ ok: boolean; reason?: string }>(`window.bridge.invoke('fs:listDir', { path: ${JSON.stringify(join(fx.root, 'nope'))} })`)
      const notDir = await ES<{ ok: boolean; reason?: string }>(`window.bridge.invoke('fs:listDir', { path: ${JSON.stringify(join(fx.root, 'notes.txt'))} })`)
      const deniedOk = fx.deniedCreated ? denied.ok === false && denied.reason === 'denied' : true
      const refusalsOk = deniedOk && missing.reason === 'missing' && notDir.reason === 'not-a-directory'

      // ── (h) per-OS roots ──────────────────────────────────────────────────────
      const rootProbe = await ES<{ ok: boolean; entries?: { name: string }[]; parent?: string | null; reason?: string }>(
        process.platform === 'win32'
          ? `window.bridge.invoke('fs:listDir', { path: '' })`
          : `window.bridge.invoke('fs:listDir', { path: '/' })`
      )
      const rootsOk =
        process.platform === 'win32'
          ? rootProbe.ok === true && (rootProbe.entries ?? []).some((e) => e.name === 'C:') && rootProbe.parent === null
          : rootProbe.ok === true && rootProbe.parent === null

      // ── looking is not choosing: a fresh wizard must not adopt $HOME ──────────
      await ES(`window.__mogging.templates.openWizard()`)
      await sleep(1200) // home listing lands
      const fresh = await ES<{ cwd: string; bar: string; browserSelected: string; browserPath: string; rows: number }>(`(() => {${H}
        const s = sot()
        return { cwd: s.cwd, bar: s.bar, browserSelected: s.browserSelected, browserPath: s.browserPath, rows: rows().length }
      })()`)
      // The browser is showing somewhere real, and nothing is chosen.
      const lookingNotChoosingOk = fresh.cwd === '' && fresh.bar === '' && fresh.browserSelected === '' && fresh.rows > 0

      // ── the UI. Open the wizard rooted at the fixture. ────────────────────────
      await ES(`window.__mogging.templates.openWizard({ cwd: ${R} })`)
      await sleep(900)
      const sotPrefill = await agrees()

      // (b) the repo pill is in the DOM, on Beta's row and nowhere else
      const pills = await ES<{ betaHasPill: boolean; zetaHasPill: boolean; visible: string[] }>(`(() => {${H}
        return {
          betaHasPill: !!rowBy('Beta')?.querySelector('.pill'),
          zetaHasPill: !!rowBy('Zeta')?.querySelector('.pill'),
          visible: rowNames()
        }
      })()`)
      const repoPillOk = pills.betaHasPill && !pills.zetaHasPill && !pills.visible.includes('.hidden')

      // (c) one click PICKS a child: cwd and the bar both move, without descending
      const picked = await ES<{ bar: string; crumbsAfter: string[]; selected: boolean }>(`(() => {${H}
        rowBy('alpha').click()
        return { bar: bar(), crumbsAfter: crumbs(), selected: rowBy('alpha').classList.contains('is-selected') }
      })()`)
      await sleep(300)
      const sotPick = await agrees()
      const clickPickOk = picked.bar === join(fx.root, 'alpha') && picked.selected && sotPick.agree

      // ...and Enter DESCENDS into it, making it current
      const descended = await ES<{ bar: string; last: string }>(`(() => {${H}
        const r = rowBy('alpha'); r.focus(); key(r, 'Enter')
        return { bar: bar(), last: '' }
      })()`)
      await sleep(500)
      const afterDescend = await ES<{ bar: string; last: string; names: string[] }>(`(() => {${H}
        const c = crumbs()
        return { bar: bar(), last: c[c.length - 1], names: rowNames() }
      })()`)
      const descendOk = afterDescend.last === 'alpha' && afterDescend.bar === join(fx.root, 'alpha') && afterDescend.names.includes('sub')

      // breadcrumb-ascend returns to the fixture root, bar follows
      await ES(`(() => {${H}
        const cs = [...document.querySelectorAll('#view-wizard .fb-crumb')]
        cs[cs.length - 2].click()
      })()`)
      await sleep(500)
      const ascended = await ES<{ bar: string; last: string }>(`(() => {${H}
        const c = crumbs()
        return { bar: bar(), last: c[c.length - 1] }
      })()`)
      const sotAscend = await agrees()
      const ascendOk = ascended.bar === fx.root && afterDescend.last === 'alpha' && sotAscend.agree
      const clickWalkOk = clickPickOk && descendOk && ascendOk && descended.bar === join(fx.root, 'alpha')

      // ── (d) typing an absolute path re-roots the browser ──────────────────────
      await ES(`(() => {
        const i = document.querySelector('#view-wizard .path-input-field')
        i.value = ${JSON.stringify(join(fx.root, 'Beta'))}
        i.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(900) // the bar debounces at 350ms, then one IPC round trip
      const typed = await ES<{ last: string }>(`(() => {${H} const c = crumbs(); return { last: c[c.length - 1] } })()`)
      const sotTyped = await agrees()
      const typeRerootOk = typed.last === 'Beta' && sotTyped.agree

      // ...and a path that does NOT exist must leave the browser exactly where it is.
      // (The old code re-rooted on every debounce, so typing on the way to a folder
      // replaced the listing with a refusal and threw away where you were.)
      await ES(`(() => {
        const i = document.querySelector('#view-wizard .path-input-field')
        i.value = ${JSON.stringify(join(fx.root, 'Beta', 'no-such-child'))}
        i.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(900)
      const afterGarbage = await ES<{ last: string; hasRefusal: boolean; rows: number; barStatus: string }>(`(() => {${H}
        const c = crumbs()
        return {
          last: c[c.length - 1],
          hasRefusal: !!document.querySelector('#view-wizard .fb-refusal'),
          rows: rows().length,
          barStatus: document.querySelector('#view-wizard .path-input-status')?.textContent ?? ''
        }
      })()`)
      const partialTypeKeepsBrowserOk =
        afterGarbage.last === 'Beta' && !afterGarbage.hasRefusal && afterGarbage.rows > 0 && /no folder there/i.test(afterGarbage.barStatus)

      // ── (e) keyboard: arrows + Enter, no mouse ────────────────────────────────
      await ES(`window.__mogging.templates.openWizard({ cwd: ${R} })`)
      await sleep(900)
      const kb = await ES<{ before: string; focusName: string }>(`(() => {${H}
        const first = rows()[0]           // the ".." row
        first.focus()
        key(first, 'ArrowDown')           // -> alpha
        const f = document.activeElement
        return { before: crumbs().slice(-1)[0], focusName: f.querySelector?.('.fb-row-name')?.textContent ?? '' }
      })()`)
      await ES(`(() => {${H} key(document.activeElement, 'Enter') })()`)
      await sleep(600)
      const kbAfter = await ES<{ last: string; bar: string }>(`(() => {${H} const c = crumbs(); return { last: c[c.length - 1], bar: bar() } })()`)
      const sotKb = await agrees()
      const keyboardOk = kb.focusName === 'alpha' && kbAfter.last === 'alpha' && kbAfter.bar === join(fx.root, 'alpha') && sotKb.agree

      // ── (f) the refusal STATE renders, and the page survives it ───────────────
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(fx.locked)} })`)
      await sleep(900)
      const refusalUi = await ES<{ hasRefusal: boolean; title: string; pageAlive: boolean; rows: number }>(`(() => {
        const r = document.querySelector('#view-wizard .fb-refusal')
        return {
          hasRefusal: !!r,
          title: document.querySelector('#view-wizard .fb-refusal-title')?.textContent ?? '',
          pageAlive: !!document.querySelector('#view-wizard .wizard-footer .btn--primary'),
          rows: document.querySelectorAll('#view-wizard .fb-row').length
        }
      })()`)
      // On a host where the denial could not be created, the folder simply lists empty.
      const refusalUiOk = fx.deniedCreated ? refusalUi.hasRefusal && refusalUi.rows === 0 && refusalUi.pageAlive : refusalUi.pageAlive

      // ── (g) the hidden toggle reveals the dotfolder ───────────────────────────
      await ES(`window.__mogging.templates.openWizard({ cwd: ${R} })`)
      await sleep(900)
      const beforeHidden = await ES<string[]>(`(() => {${H} return rowNames() })()`)
      await ES(`document.querySelector('#view-wizard .fb-foot .checkbox input').click()`)
      await sleep(600)
      const afterHidden = await ES<string[]>(`(() => {${H} return rowNames() })()`)
      const sotHidden = await agrees()
      const hiddenToggleOk = !beforeHidden.includes('.hidden') && afterHidden.includes('.hidden') && sotHidden.agree

      // A refused path is not a workspace root: Launch must decline it, in place.
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(join(fx.root, 'nowhere'))} })`)
      await sleep(900)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      await sleep(600)
      const badLaunch = await ES<{ stillWizard: boolean; status: string; workspaces: number }>(`(() => ({
        stillWizard: !!document.querySelector('#content.view-wizard'),
        status: document.querySelector('#view-wizard .path-input-status')?.textContent ?? '',
        workspaces: (window.__mogging.workspace.count?.() ?? 0)
      }))()`)
      const refuseLaunchOk = badLaunch.stillWizard && /no folder there/i.test(badLaunch.status) && badLaunch.workspaces === 0

      // Scope honesty (step 4) is stated where the user reads it.
      const noteOk = await ES<boolean>(
        `/nothing is indexed, watched, or sent anywhere/i.test(document.querySelector('#view-wizard .fb-note')?.textContent ?? '')`
      )

      const pass =
        listingOk &&
        refusalsOk &&
        rootsOk &&
        repoPillOk &&
        clickWalkOk &&
        typeRerootOk &&
        keyboardOk &&
        refusalUiOk &&
        hiddenToggleOk &&
        noteOk &&
        lookingNotChoosingOk &&
        partialTypeKeepsBrowserOk &&
        refuseLaunchOk &&
        sotPrefill.agree
      result = {
        pass,
        lookingNotChoosingOk,
        fresh,
        partialTypeKeepsBrowserOk,
        afterGarbage,
        refuseLaunchOk,
        badLaunch,
        sotPrefill,
        sotPick,
        sotAscend,
        sotTyped,
        sotKb,
        sotHidden,
        listingOk,
        dirsOnly,
        hiddenFiltered,
        sorted,
        repoFlagged,
        capped,
        entryCount: listed.entries.length,
        bigCount: big.entries.length,
        refusalsOk,
        deniedCreated: fx.deniedCreated,
        denied,
        missing: missing.reason,
        notDir: notDir.reason,
        rootsOk,
        rootProbeParent: rootProbe.parent ?? null,
        repoPillOk,
        clickWalkOk,
        clickPickOk,
        descendOk,
        ascendOk,
        afterDescend,
        ascended,
        typeRerootOk,
        typed,
        keyboardOk,
        kb,
        kbAfter,
        refusalUiOk,
        refusalUi,
        hiddenToggleOk,
        beforeHidden,
        afterHidden,
        noteOk,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    cleanup(fx)
    try {
      writeFileSync(join(process.cwd(), 'out', 'folderpick-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

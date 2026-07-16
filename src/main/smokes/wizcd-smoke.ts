import { app, type BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated cd-line + home-default smoke (MOGGING_WIZCD — wizard revamp 2026-07-16).
// Drives the REAL wizard page: the real input, the real completion menu, the real
// selection controller. Asserts:
//   (a) THE DEFAULT: a fresh wizard chooses the user's home folder — the bar holds
//       the real path (fs:home's answer, not placeholder fiction) and the three
//       views agree;
//   (b) cd-ONLY: `ls`, `git status`, and a BARE PATH are refused in place with a
//       hint — the selection does not move, the line keeps what was typed;
//   (c) navigation: absolute (quoted), relative, `..`, the cmd no-space `cd..`,
//       `chdir`, `~`, and `cd -` all land where a shell would — input cleared,
//       bar/browser/controller one value after every hop;
//   (d) Tab completion: a unique prefix completes AND descends; an ambiguous one
//       extends to the shared prefix then cycles; ↓/↑ walk the menu; Escape
//       restores the typed stem, closes the menu, and never leaves the page;
//       a quoted-space folder completes quoted; a dot prefix reveals dotfolders;
//   (e) the pure table: resolver + completion edge cases on BOTH path dialects
//       (drive-only `cd C:`, `/abs` against a Windows base, UNC `..`, `/d` flag,
//       `-` with and without a previous folder, quote stripping) — the exact
//       functions the UI calls, driven with fixture strings;
//   (f) THE AUTOMATIC NAME follows the folder: it holds the basename through
//       every hop, a TYPED name survives folder changes untouched, and clearing
//       the box hands the name back to the folder.
// Zero network.

export function runWizCdSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(process.cwd(), 'out', 'wizcd-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const waitFor = async (probe: () => Promise<boolean>, tries = 24, gapMs = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const root = mkdtempSync(join(tmpdir(), 'mog-wizcd-'))
    try {
      for (const d of ['alpha', 'Beta', 'gamma one', '.hid']) mkdirSync(join(root, d))
      for (const d of ['subone', 'subtwo', 'deep']) mkdirSync(join(root, 'alpha', d))
      await sleep(1500)

      const CD = `window.__mogging.wizardCd`
      const cwdNow = (): Promise<string> => ES<string>(`window.__mogging.wizardPath().cwd`)
      const agreeNow = (): Promise<boolean> => ES<boolean>(`window.__mogging.wizardPath().agree`)
      const valueNow = (): Promise<string> => ES<string>(`${CD}.value()`)
      const hintNow = (): Promise<string> => ES<string>(`${CD}.hint()`)
      const type = (v: string): Promise<unknown> => ES(`${CD}.type(${JSON.stringify(v)})`)
      const key = (k: string, init = ''): Promise<unknown> => ES(`${CD}.key('${k}'${init ? `, ${init}` : ''})`)
      const settle = (): Promise<unknown> => ES(`${CD}.settle()`)
      const suggestions = (): Promise<string[]> => ES<string[]>(`${CD}.suggestions()`)

      /** Type a line, press Enter, wait for the selection AND the views to land on
       *  `want` — agreement arrives with the listing, one IPC after the move. */
      const cdTo = async (line: string, want: string): Promise<{ ok: boolean; cwd: string; cleared: boolean; agree: boolean }> => {
        await type(line)
        await key('Enter')
        const ok = await waitFor(async () => (await cwdNow()) === want && (await agreeNow()))
        return { ok, cwd: await cwdNow(), cleared: (await valueNow()) === '', agree: await agreeNow() }
      }

      // ── (a) the home default is REAL ─────────────────────────────────────────
      const home = await ES<string>(`window.bridge.invoke('fs:home')`)
      await ES(`window.__mogging.templates.openWizard()`)
      const homeLanded = await waitFor(async () => (await cwdNow()) === home && (await agreeNow()))
      const barShowsHome = await ES<string>(`document.querySelector('#view-wizard .path-input-field')?.value ?? ''`)
      const homeDefaultOk = !!home && homeLanded && barShowsHome === home

      // ── (b) cd-only: everything else is refused in place ────────────────────
      const refusals: Record<string, unknown> = {}
      let refusalsOk = true
      for (const line of ['ls', 'git status', root]) {
        const before = await cwdNow()
        await type(line)
        await key('Enter')
        await sleep(350)
        const r = { hint: await hintNow(), cwd: await cwdNow(), kept: await valueNow() }
        refusals[line] = r
        refusalsOk &&= /only cd/i.test(r.hint) && r.cwd === before && r.kept === line
      }

      // ── (c) navigation, hop by hop ───────────────────────────────────────────
      const sep = process.platform === 'win32' ? '\\' : '/'
      const A = join(root, 'alpha')
      const hops = {
        absQuoted: await cdTo(`cd "${root}"`, root),
        relative: await cdTo('cd alpha', A),
        deeper: await cdTo('cd subone', join(A, 'subone')),
        dotdot: await cdTo('cd ..', A),
        noSpace: await cdTo('cd..', root),
        chdir: await cdTo('chdir alpha', A),
        tilde: await cdTo('cd ~', home),
        dash: await cdTo('cd -', A) // the folder the ~ hop left
      }
      const hopsOk = Object.values(hops).every((h) => h.ok && h.cleared && h.agree)

      // ── (d) Tab completion on the real menu ──────────────────────────────────
      await ES(`${CD}.type(${JSON.stringify(`cd "${root}"`)})`)
      await key('Enter')
      await waitFor(async () => (await cwdNow()) === root)

      // unique prefix: completes AND descends, then offers the children
      await type('cd al')
      await settle()
      const uniqueBefore = await suggestions()
      await key('Tab')
      await settle()
      const afterUnique = { value: await valueNow(), menu: await suggestions() }
      const uniqueTabOk =
        uniqueBefore.length === 1 &&
        uniqueBefore[0] === 'alpha' &&
        afterUnique.value === `cd alpha${sep}` &&
        afterUnique.menu.length === 3 // subone · subtwo · deep

      // ambiguous prefix: first Tab extends to the shared prefix, then cycles, wraps
      await type(`cd alpha${sep}su`)
      await settle()
      await key('Tab')
      await settle()
      const extended = await valueNow() // su -> sub (shared), menu still open
      await key('Tab')
      const first = { value: await valueNow(), sel: await ES<number>(`${CD}.selectedIndex()`) }
      await key('Tab')
      const second = await valueNow()
      await key('Tab')
      const wrapped = await valueNow()
      const cycleOk =
        extended === `cd alpha${sep}sub` &&
        first.value === `cd alpha${sep}subone` &&
        first.sel === 0 &&
        second === `cd alpha${sep}subtwo` &&
        wrapped === `cd alpha${sep}subone`
      const enterAfterCycle = await (async () => {
        await key('Enter')
        return waitFor(async () => (await cwdNow()) === join(A, 'subone'))
      })()

      // arrows walk, Escape restores the stem and stays on the page
      await cdTo(`cd "${root}"`, root)
      await type('cd ')
      await settle()
      const menuAll = await suggestions()
      await key('ArrowDown')
      const down1 = await valueNow()
      await key('ArrowDown')
      const down2 = await valueNow()
      await key('Escape')
      const afterEsc = {
        value: await valueNow(),
        menu: await suggestions(),
        open: await ES<boolean>(`!document.querySelector('#view-wizard .wizard-cd-suggest')?.hidden`),
        stillWizard: await ES<boolean>(`document.getElementById('app').classList.contains('view-wizard')`)
      }
      const arrowsOk =
        menuAll.length === 3 && // alpha · Beta · gamma one (dotfolder hidden)
        down1 === 'cd alpha' &&
        down2 === 'cd Beta' &&
        afterEsc.value === 'cd ' &&
        !afterEsc.open &&
        afterEsc.stillWizard

      // a space in the name completes QUOTED, and executes
      await type('cd gam')
      await settle()
      await key('Tab')
      await settle()
      const quotedValue = await valueNow()
      await key('Enter')
      const quotedLanded = await waitFor(async () => (await cwdNow()) === join(root, 'gamma one'))
      const quotedOk = quotedValue === `cd "gamma one${sep}"` && quotedLanded

      // a dot prefix asks for the hidden world
      await cdTo(`cd "${root}"`, root)
      await type('cd .hi')
      await settle()
      const dotMenu = await suggestions()
      const hiddenOk = dotMenu.length === 1 && dotMenu[0] === '.hid'

      // ── (f) the automatic name follows the folder ────────────────────────────
      const nameOf = (): Promise<string> => ES<string>(`document.querySelector('#view-wizard .wizard-name-input')?.value ?? ''`)
      const nameAtRoot = await (async () => {
        await cdTo(`cd "${root}"`, root)
        return nameOf()
      })()
      const nameAtAlpha = await (async () => {
        await cdTo('cd alpha', A)
        return nameOf()
      })()
      // A typed name is MANUAL: folder moves must not touch it.
      await ES(`(() => {
        const n = document.querySelector('#view-wizard .wizard-name-input')
        n.value = 'Hand Picked'
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await cdTo('cd subone', join(A, 'subone'))
      const nameManual = await nameOf()
      // Clearing hands the name back to the folder: the next move refills it.
      await ES(`(() => {
        const n = document.querySelector('#view-wizard .wizard-name-input')
        n.value = ''
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await cdTo('cd ..', A)
      const nameRearmed = await nameOf()
      const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''
      const nameFollowOk =
        nameAtRoot === base(root) && nameAtAlpha === 'alpha' && nameManual === 'Hand Picked' && nameRearmed === 'alpha'

      // ── (e) the pure table, both dialects ────────────────────────────────────
      const table = await ES<{ name: string; pass: boolean; got: unknown }[]>(`(() => {
        const p = ${CD}.pure
        const t = []
        const eq = (name, got, want) => t.push({ name, got, pass: JSON.stringify(got) === JSON.stringify(want) })
        eq('drive-only', p.resolveCdTarget('cd C:', 'C:\\\\x\\\\y', ''), { ok: true, target: 'C:\\\\' })
        eq('posix-abs-on-win', p.resolveCdTarget('cd /repos', 'C:\\\\x\\\\y', ''), { ok: true, target: 'C:\\\\repos' })
        eq('posix-abs', p.resolveCdTarget('cd /srv/app', '/home/u', ''), { ok: true, target: '/srv/app' })
        eq('unc-dotdot', p.resolveCdTarget('cd ..', '\\\\\\\\srv\\\\share\\\\dir', ''), { ok: true, target: '\\\\\\\\srv\\\\share' })
        eq('slash-d-flag', p.resolveCdTarget('cd /d D:\\\\w', 'C:\\\\x', ''), { ok: true, target: 'D:\\\\w' })
        eq('slash-dev-not-flag', p.resolveCdTarget('cd /dev', '/home/u', ''), { ok: true, target: '/dev' })
        eq('bare-path-refused', p.resolveCdTarget('D:\\\\w', 'C:\\\\x', ''), { ok: false, reason: 'not-cd' })
        eq('ls-refused', p.resolveCdTarget('ls -la', '/home/u', ''), { ok: false, reason: 'not-cd' })
        eq('dash', p.resolveCdTarget('cd -', '/a', '/h', '/prev'), { ok: true, target: '/prev' })
        eq('dash-empty', p.resolveCdTarget('cd -', '/a', '/h', ''), { ok: false, reason: 'no-previous' })
        eq('bare-cd-home', p.resolveCdTarget('cd', '/a', '/h'), { ok: true, target: '/h' })
        eq('bare-cd-no-home', p.resolveCdTarget('cd', '/a', ''), { ok: false, reason: 'no-home' })
        eq('tilde-glued', p.resolveCdTarget('cd~', 'C:\\\\x', 'C:\\\\Users\\\\p'), { ok: true, target: 'C:\\\\Users\\\\p' })
        eq('dot-normalize', p.resolveCdTarget('cd a\\\\..\\\\b', 'C:\\\\r', ''), { ok: true, target: 'C:\\\\r\\\\b' })
        eq('root-dotdot-floor', p.resolveCdTarget('cd ..', 'C:\\\\', ''), { ok: true, target: 'C:\\\\' })
        eq('not-cd-word', p.parseCdLine('cdd x').kind, 'not-cd')
        eq('cd-dotdot-parse', p.parseCdLine('cd..'), { kind: 'cd', arg: '..', argStart: 2 })
        const winCtx = p.completionContext('cd al', 'C:\\\\r', '')
        eq('ctx-win', { dir: winCtx.dir, prefix: winCtx.prefix, head: winCtx.head, sep: winCtx.sep }, { dir: 'C:\\\\r', prefix: 'al', head: 'cd ', sep: '\\\\' })
        eq('ctx-win-apply', p.applyCompletion(winCtx, 'alpha', true), 'cd alpha\\\\')
        const posixCtx = p.completionContext('cd alpha/su', '/r', '')
        eq('ctx-posix', { dir: posixCtx.dir, prefix: posixCtx.prefix, sep: posixCtx.sep }, { dir: '/r/alpha', prefix: 'su', sep: '/' })
        const stepCtx = p.completionContext('cd ..', '/r/a', '')
        eq('ctx-step', { dir: stepCtx.dir, prefix: stepCtx.prefix, argDir: stepCtx.argDir }, { dir: '/r', prefix: '', argDir: '../' })
        const quoteCtx = p.completionContext('cd "gam', '/r', '')
        eq('ctx-quote', { prefix: quoteCtx.prefix, quote: quoteCtx.quote }, { prefix: 'gam', quote: true })
        eq('ctx-quote-apply', p.applyCompletion(quoteCtx, 'gamma one', true), 'cd "gamma one/"')
        eq('common-prefix', p.commonPrefix(['subone', 'subtwo']), 'sub')
        eq('filter-ci', p.filterCompletions(['Documents', 'downloads', 'src'], 'd'), ['Documents', 'downloads'])
        eq('not-cd-null-ctx', p.completionContext('ls al', '/r', ''), null)
        return t
      })()`)
      const tableOk = table.every((row) => row.pass)

      const pass =
        homeDefaultOk && refusalsOk && hopsOk && uniqueTabOk && cycleOk && enterAfterCycle && arrowsOk && quotedOk && hiddenOk && nameFollowOk && tableOk
      result = {
        pass,
        nameFollowOk,
        nameAtRoot,
        nameAtAlpha,
        nameManual,
        nameRearmed,
        homeDefaultOk,
        home,
        barShowsHome,
        refusalsOk,
        refusals,
        hopsOk,
        hops,
        uniqueTabOk,
        uniqueBefore,
        afterUnique,
        cycleOk,
        extended,
        first,
        second,
        wrapped,
        enterAfterCycle,
        arrowsOk,
        menuAll,
        down1,
        down2,
        afterEsc,
        quotedOk,
        quotedValue,
        hiddenOk,
        dotMenu,
        tableFailures: table.filter((row) => !row.pass),
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

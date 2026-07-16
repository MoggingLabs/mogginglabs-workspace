import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Layout probe run alongside the grid shot: real geometry of pane 1's slot / header /
// terminal, so "doesn't fill the width"-class reports are diagnosed with numbers.
const PROBE = `(() => {
  const slot = document.querySelector('.layout-slot[data-pane-id="1"]')
  if (!slot) return { error: 'no slot' }
  const r = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }
  const header = slot.querySelector('.pane-header')
  const cs = header ? getComputedStyle(header) : null
  return {
    slot: r(slot),
    header: r(header),
    headerDisplay: cs ? cs.display : null,
    headerCols: cs ? cs.gridTemplateColumns : null,
    left: r(slot.querySelector('.pane-head-left')),
    git: r(slot.querySelector('.pane-git')),
    actions: r(slot.querySelector('.pane-actions')),
    body: r(slot.querySelector('.pane-body')),
    screen: r(slot.querySelector('.xterm-screen')),
    viewport: r(slot.querySelector('.xterm-viewport')),
    canvas: r(slot.querySelector('canvas')),
    term: (() => {
      const p = (window.__mogging && window.__mogging.panes || []).find((x) => x.id === 1)
      if (!p) return null
      const core = p.term._core
      const dims = core && core._renderService ? core._renderService.dimensions : null
      return {
        cols: p.term.cols,
        rows: p.term.rows,
        cellW: dims && dims.css ? dims.css.cell.width : null,
        cellH: dims && dims.css ? dims.css.cell.height : null,
        fontFamily: p.term.options.fontFamily,
        computedFont: getComputedStyle(slot.querySelector('.xterm')).fontFamily,
        jbmLoaded: document.fonts.check('13px "JetBrains Mono Variable"'),
        fontsStatus: document.fonts.status,
        // FitAddon 0.11 (xterm 6) no longer exposes viewport.scrollBarWidth.
        // Mirror its public-option formula so the fill gate measures the reserve
        // the addon actually subtracted instead of falling back to a stale 10px.
        scrollBarWidth: p.term.options.scrollback === 0
          ? 0
          : (p.term.options.overviewRuler?.width || 14),
        // ConPTY compatibility, seeded from the pty's OWN answer (SpawnResult.pty, daemon
        // protocol v4 -> core/terminal/pty-emulation.ts). On Windows this MUST be
        // { backend: 'conpty', buildNumber: <os build> }: without it xterm grows rows the
        // unix way while ConPTY grows them its own, the viewports drift, and ConPTY's
        // repaint-on-resize smears stale shell rows into a live agent frame.
        windowsPty: p.term.options.windowsPty || null
      }
    })()
  }
})()`

/**
 * Env-gated visual smoke (MOGGING_SHOT): once the UI has loaded, capture the window to
 * out/shot.png and exit. Handy for eyeballing branding / layout changes (e.g. the logo).
 * MOGGING_SHOT=grid first opens a 4-pane workspace (launcher-first boot shows Home
 * otherwise), waits for prompts, then captures.
 */
import { runGallery } from './gallery'
import { mkdirSync } from 'node:fs'

/** Settings sweep (MOGGING_SHOT=settings): every settings tab in both principal
 *  themes → out/gallery/settings/. The fast iteration loop for tab-page design
 *  work — no staged workspaces, no CLI verbs, ~20s instead of the full gallery. */
function runSettingsShot(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const dir = join(process.cwd(), 'out', 'gallery', 'settings')
  const TABS = ['appearance', 'terminal', 'clipboard', 'providers', 'profiles', 'integrations', 'usage', 'webhooks', 'privacy', 'browser', 'activity', 'account', 'shortcuts', 'about']
  const run = async (): Promise<void> => {
    try {
      mkdirSync(dir, { recursive: true })
      win.setSize(1600, 950)
      await sleep(800)
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click()`)
      await sleep(600)
      for (const theme of ['midnight', 'light']) {
        await ES(`window.__mogging.setTheme(${JSON.stringify(theme)})`)
        await sleep(300)
        for (const tab of TABS) {
          await ES(`window.__mogging.settingsTab(${JSON.stringify(tab)})`)
          await sleep(350)
          const img = await wc.capturePage()
          writeFileSync(join(dir, `${theme}-${tab}.png`), img.toPNG())
        }
      }
      app.exit(0)
    } catch (e) {
      try {
        writeFileSync(join(dir, 'error.txt'), String(e))
      } catch {
        /* ignore */
      }
      app.exit(1)
    }
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 1500))
  else setTimeout(() => void run(), 1500)
}

/** 5/06 type matrix: the same busy specimen at every candidate size × line-height,
 *  at 4-pane and 16-pane densities — the empirical basis for the default. */
function runTypeMatrix(win: BrowserWindow): void {
  const wc = win.webContents
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const dir = join(process.cwd(), 'out', 'gallery', 'typematrix')
  const SPECIMEN = `(() => {
    const E = String.fromCharCode(27) + '['
    const lines = [
      E+'1;38;5;208m` + '\\u25b6' + ` claude'+E+'0m '+E+'2mrefactoring the reflow path` + '\\u2026' + `'+E+'0m',
      E+'38;5;114m` + '\\u2713' + `'+E+'0m read '+E+'38;5;75msrc/ui/layout/grid.ts'+E+'0m '+E+'2m(412 lines)'+E+'0m',
      E+'38;5;114m` + '\\u2713' + `'+E+'0m edit '+E+'38;5;75msrc/ui/features/terminal/terminal-pane.ts'+E+'0m',
      '` + '\\u250c\\u2500' + ` Test run ` + '\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2510' + `',
      '` + '\\u2502' + ` '+E+'38;5;114m42 passed'+E+'0m, '+E+'38;5;203m1 failed'+E+'0m, 3 skipped  ` + '\\u2502' + `',
      '` + '\\u2514\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2518' + `',
      E+'38;5;203m- if (cols === before.cols) return'+E+'0m',
      E+'38;5;114m+ if (d.cols === this.term.cols && d.rows === this.term.rows) return'+E+'0m',
      'ilmnop O0 1lI| ` + '\\u2500\\u2502\\u250c\\u2510' + ` the quick brown fox 0123456789',
      E+'1;38;5;75m` + '\\u276f' + `'+E+'0m npm run typecheck'
    ]
    for (const p of (window.__mogging.panes || [])) { p.term.write(lines.join(String.fromCharCode(13,10)) + String.fromCharCode(13,10)) }
    return 1
  })()`
  const paneRect = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    const r = (await ES(
      `(() => { const b = document.querySelector('.layout-slot[data-pane-id="1"]').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`
    )) as { x: number; y: number; width: number; height: number }
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const spec = (size: number, lh: number): Promise<unknown> =>
    ES(`((window.__mogging.panes || []).forEach((p) => p.typeSpec(${size}, ${lh})), 1)`)
  const snap = async (name: string, rect?: Electron.Rectangle): Promise<void> => {
    await sleep(150)
    const img = rect ? await wc.capturePage(rect) : await wc.capturePage()
    writeFileSync(join(dir, `${name}.png`), img.toPNG())
  }
  const run = async (): Promise<void> => {
    try {
      mkdirSync(dir, { recursive: true })
      win.setSize(1600, 950)
      await ES(`(window.__mogging.workspace.count() === 0 && window.__mogging.workspace.create({ name: 'Type' }), 1)`)
      await sleep(1500)
      await ES(`(window.__mogging.layout.apply(4), 1)`)
      await sleep(4000)
      // 4-pane: the full size × line-height matrix, cropped to pane 1.
      for (const lh of [1.2, 1.3, 1.35]) {
        for (const size of [13, 13.5, 14, 15]) {
          await spec(size, lh)
          await sleep(400)
          await ES(SPECIMEN)
          await sleep(300)
          await snap(`4p-${String(size).replace('.', '_')}-lh${String(lh).replace('.', '')}`, await paneRect())
        }
      }
      // 16-pane: candidate sizes at the fixed line-height, full window.
      await ES(`(window.__mogging.layout.apply(16), 1)`)
      await sleep(6000)
      for (const size of [13, 14, 15]) {
        await spec(size, 1.3)
        await sleep(500)
        await ES(SPECIMEN)
        await sleep(400)
        await snap(`16p-${size}`)
      }
      app.exit(0)
    } catch (e) {
      try {
        writeFileSync(join(dir, 'error.txt'), String(e))
      } catch {
        /* ignore */
      }
      app.exit(1)
    }
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 1800))
  else setTimeout(() => void run(), 1800)
}

/** Wizard sweep (MOGGING_SHOT=wizard): the redesigned page in both themes, plus the
 *  painter's merged state and the LAUNCHED merged geometry → out/gallery/wizard/.
 *  The fast iteration loop for the wizard redesign — ~20s, no staged world. */
function runWizardShot(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const dir = join(process.cwd(), 'out', 'gallery', 'wizard')
  const run = async (): Promise<void> => {
    try {
      mkdirSync(dir, { recursive: true })
      win.setSize(1600, 950)
      const fixture = join(tmpdir(), 'mog-wizard-shot')
      mkdirSync(join(fixture, 'apps', 'web'), { recursive: true })
      mkdirSync(join(fixture, 'packages', 'core'), { recursive: true })
      await sleep(800)
      const snap = async (label: string): Promise<void> => {
        const img = await wc.capturePage()
        writeFileSync(join(dir, `${label}.png`), img.toPNG())
      }
      for (const theme of ['midnight', 'light']) {
        await ES(`window.__mogging.setTheme(${JSON.stringify(theme)})`)
        await sleep(300)
        await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(fixture)} })`)
        await sleep(900)
        await snap(`${theme}-wizard-page`)
        await ES(`(window.__mogging.wizardLayout.setGrid(2, 2), window.__mogging.wizardLayout.merge(0, 0, 0, 1), 1)`)
        await sleep(350)
        await snap(`${theme}-wizard-merged`)
        await ES(`document.querySelector('#view-wizard .wizard')?.scrollTo({ top: 99999 })`)
        await sleep(350)
        await snap(`${theme}-wizard-foot`)
      }
      // One real launch of the merged layout — the geometry photo.
      await ES(`window.__mogging.setTheme('midnight')`)
      await ES(`window.__mogging.templates.openWizard({ cwd: ${JSON.stringify(fixture)} })`)
      await sleep(900)
      await ES(`(window.__mogging.wizardLayout.setGrid(2, 2), window.__mogging.wizardLayout.merge(0, 0, 0, 1), 1)`)
      await sleep(250)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary')?.click()`)
      await sleep(2500)
      await snap('midnight-merged-workspace')
      app.exit(0)
    } catch (e) {
      try {
        writeFileSync(join(dir, 'error.txt'), String(e))
      } catch {
        /* ignore */
      }
      app.exit(1)
    }
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 1500))
  else setTimeout(() => void run(), 1500)
}

export function runShot(win: BrowserWindow): void {
  if (process.env.MOGGING_SHOT === 'all') {
    runGallery(win) // Phase-5/01: every surface, both themes -> out/gallery/
    return
  }
  if (process.env.MOGGING_SHOT === 'typematrix') {
    runTypeMatrix(win) // Phase-5/06: the empirical terminal-type matrix
    return
  }
  if (process.env.MOGGING_SHOT === 'settings') {
    runSettingsShot(win) // every settings tab × both themes -> out/gallery/settings/
    return
  }
  if (process.env.MOGGING_SHOT === 'wizard') {
    runWizardShot(win) // the redesigned wizard + merged layout -> out/gallery/wizard/
    return
  }
  const grid = process.env.MOGGING_SHOT === 'grid'
  const reveal = process.env.MOGGING_SHOT === 'reveal'
  const capture = async (): Promise<void> => {
    try {
      if (reveal) {
        // The field-reported artifact: resize the WINDOW while the workspace is hidden
        // behind Home, then reveal — panes must immediately occupy the new space.
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        const ES = (js: string): Promise<unknown> => win.webContents.executeJavaScript(js, true)
        await ES(
          '(function(){var m=window.__mogging;' +
            'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});' +
            'if(m&&m.layout)m.layout.apply(4);return 1;})()'
        )
        await sleep(3500) // panes fit at the ORIGINAL window size
        await ES(
          '(function(){var b=document.querySelector(".titlebar-right .icon-btn[aria-label=\\"Board\\"]");b&&b.click();return 1;})()'
        ) // go to Board -> panes hidden (5/05: Board is a full-app view). Was Home, which
        // a workspace now makes unreachable; any full-app view stages the same artifact.
        await sleep(600)
        win.setSize(1880, 1000) // resize WHILE hidden — the artifact's trigger
        await sleep(900)
        await ES('window.__mogging.workspace.switchByIndex(0)') // reveal
        await sleep(1200)
        const probe = (await win.webContents.executeJavaScript(PROBE, true)) as Record<string, never>
        // 5/06 standing gate: the fill math must hold at EVERY user-selectable size.
        // A live size change goes remeasure→refit; afterwards the rendered screen
        // must fill the body minus at most one partial column + the scrollbar
        // reserve, and the header (chrome) must not move with the buffer type.
        type P = {
          body?: { w: number }
          screen?: { w: number }
          header?: { h: number }
          term?: { cellW: number | null; scrollBarWidth: number | null; cols: number }
        }
        const fillOk = (p: P, headerH: number): boolean =>
          !!(
            p.body &&
            p.screen &&
            p.term &&
            p.term.cellW &&
            p.body.w - p.screen.w <= Math.ceil(p.term.cellW) + (p.term.scrollBarWidth ?? 10) + 2 &&
            p.header &&
            p.header.h === headerH
          )
        const baseHeaderH = (probe as P).header?.h ?? -1
        const sizes: Record<string, unknown> = {}
        let sizesPass = true
        for (const s of [12, 14, 16]) {
          await ES(`window.__mogging.setTerminalFontSize(${s})`)
          await sleep(800)
          const p = (await win.webContents.executeJavaScript(PROBE, true)) as P
          sizes[String(s)] = p
          if (!fillOk(p, baseHeaderH)) sizesPass = false
        }
        await ES('window.__mogging.setTerminalFontSize(14)') // back to the default
        writeFileSync(
          join(process.cwd(), 'out', 'shot-probe.json'),
          JSON.stringify({ sizesPass, base: probe, sizes }, null, 2)
        )
      }
      if (grid) {
        win.setSize(1880, 1000) // probe at a maximized-class width
        const cwd = JSON.stringify(process.cwd()) // a real repo -> the branch chip renders
        await win.webContents.executeJavaScript(
          '(function(){var m=window.__mogging;' +
            `if(m&&m.workspace&&m.workspace.count()===0){m.workspace.create({name:"Workspace 1",cwd:${cwd}});}` +
            'if(m&&m.layout)m.layout.apply(4);return 1;})()',
          true
        )
        await new Promise((r) => setTimeout(r, 5000)) // panes spawn + shells prompt + git resolves
        try {
          const probe = await win.webContents.executeJavaScript(PROBE, true)
          writeFileSync(join(process.cwd(), 'out', 'shot-probe.json'), JSON.stringify(probe, null, 2))
        } catch {
          /* best effort */
        }
      }
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), 'out', 'shot.png'), img.toPNG())
    } catch {
      /* best effort */
    }
    app.exit(0)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(capture, 1500))
  } else {
    setTimeout(capture, 1500)
  }
}

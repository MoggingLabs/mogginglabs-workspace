import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
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
        scrollBarWidth: core && core.viewport ? core.viewport.scrollBarWidth : null
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

export function runShot(win: BrowserWindow): void {
  if (process.env.MOGGING_SHOT === 'all') {
    runGallery(win) // Phase-5/01: every surface, both themes -> out/gallery/
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
        await ES('window.__mogging.home && 1') // no-op; keep parity
        await ES('(function(){var h=document.querySelector("#content");return 1;})()')
        await win.webContents.executeJavaScript(
          '(function(){var b=document.querySelector(".rail-footer .rail-btn");b&&b.click();return 1;})()',
          true
        ) // go Home -> panes hidden
        await sleep(600)
        win.setSize(1880, 1000) // resize WHILE hidden — the artifact's trigger
        await sleep(900)
        await ES('window.__mogging.workspace.switchByIndex(0)') // reveal
        await sleep(1200)
        const probe = await win.webContents.executeJavaScript(PROBE, true)
        writeFileSync(join(process.cwd(), 'out', 'shot-probe.json'), JSON.stringify(probe, null, 2))
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

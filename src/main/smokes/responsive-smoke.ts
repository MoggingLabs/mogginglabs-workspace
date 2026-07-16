import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

interface SizeProbe {
  innerWidth: number
  railAutoCollapsed: boolean
  browserOverlay: boolean
  explorerOverlay: boolean
  rail: Rect
  content: Rect
  browser: Rect
  explorer: Rect
  scrollWidth: number
  browserHandle: Handle
  explorerHandle: Handle
}

interface Handle {
  min: number
  max: number
  now: number
  role: string | null
  orientation: string | null
  /** A focusable, keyboard-operable separator that is ALSO aria-hidden is announced to nobody
   *  while still taking a tab stop — a screen-reader user tabs onto a control that does not
   *  exist. The explorer handle shipped exactly that (it kept an aria-hidden from before it was
   *  made operable), and this gate — which owns the fixture and already drives both handles from
   *  the keyboard — never looked. Now it does. */
  hidden: boolean
}

// Audit regression for the single rail/content/dock budget. It runs the actual
// minimum BrowserWindow width and two larger breakpoints with every horizontal
// consumer visible, then drives both separators from the keyboard.
export function runResponsiveSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  let fixture = ''

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // Force the reveal BEFORE any resize. The window shows on `ready-to-show` (else a
      // 4000ms fallback); the heavier the app boots, the later that fires — and a
      // `win.setSize` issued while the window is still hidden is silently dropped, leaving
      // it at its created 1200 width (the probe then measures innerWidth 1200 for every
      // breakpoint and the geometry fails). Showing it here removes that startup race so
      // the gate measures the LAYOUT, never the reveal timing. Real users never hit it —
      // nobody programmatically resizes a window in the frames after it appears.
      if (!win.isDestroyed() && !win.isVisible()) win.show()
      fixture = mkdtempSync(join(tmpdir(), 'mogging-responsive-'))
      writeFileSync(join(fixture, 'README.md'), 'responsive fixture\n')
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Responsive', cwd: ${JSON.stringify(fixture)} })`)
      await sleep(700)
      await ES(`window.__mogging.browser.toggle(true)`)
      await ES(`window.__mogging.explorer.toggle(true)`)
      await sleep(800)

      const measure = (): Promise<SizeProbe> => ES<SizeProbe>(`(() => {
        const rect = (selector) => {
          const r = document.querySelector(selector)?.getBoundingClientRect()
          return r ? { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } :
            { left:0, right:0, top:0, bottom:0, width:0, height:0 }
        }
        const handle = (selector) => {
          const el = document.querySelector(selector)
          return {
            min: Number(el?.getAttribute('aria-valuemin')),
            max: Number(el?.getAttribute('aria-valuemax')),
            now: Number(el?.getAttribute('aria-valuenow')),
            role: el?.getAttribute('role') ?? null,
            orientation: el?.getAttribute('aria-orientation') ?? null,
            hidden: !!el?.hasAttribute('aria-hidden')
          }
        }
        const app = document.getElementById('app')
        return {
          innerWidth,
          railAutoCollapsed: !!app?.classList.contains('rail-auto-collapsed'),
          browserOverlay: !!app?.classList.contains('browser-budget-overlay'),
          explorerOverlay: !!app?.classList.contains('explorer-budget-overlay'),
          rail: rect('#rail'),
          content: rect('#content'),
          browser: rect('.browser-dock:not([hidden])'),
          explorer: rect('.explorer-dock:not([hidden])'),
          scrollWidth: document.documentElement.scrollWidth,
          browserHandle: handle('.browser-dock-handle'),
          explorerHandle: handle('.explorer-dock-handle')
        }
      })()`)
      const key = async (selector: string, value: string): Promise<void> => {
        await ES(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!(el instanceof HTMLElement)) return false
          el.focus()
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true, cancelable: true }))
          return true
        })()`)
        await sleep(100)
      }

      const probes: Array<{
        requested: number
        initial: SizeProbe
        home: SizeProbe
        end: SizeProbe
        step: SizeProbe
        geometryOk: boolean
        keyboardOk: boolean
      }> = []
      for (const requested of [600, 800, 1200]) {
        win.setSize(requested, 720)
        // WAIT for the renderer to actually observe the new width, don't assume a fixed
        // settle: the OS resize + relayout takes variably longer under a heavy app, and a
        // 550ms guess measured a stale innerWidth (a resize still in flight), failing the
        // geometry on timing rather than layout. Poll to the real state, floor 400ms.
        await sleep(400)
        for (let i = 0; i < 24; i++) {
          const w = await ES<number>('innerWidth')
          if (Math.abs(w - requested) <= 2) break
          await sleep(80)
        }
        const initial = await measure()

        await key('.explorer-dock-handle', 'Home')
        await key('.browser-dock-handle', 'Home')
        const home = await measure()
        await key('.explorer-dock-handle', 'End')
        await key('.browser-dock-handle', 'End')
        const end = await measure()
        await key('.explorer-dock-handle', 'ArrowRight')
        await key('.browser-dock-handle', 'ArrowRight')
        const step = await measure()

        const compact = initial.innerWidth < 800
        const contentFloor = compact ? 280 : 480
        const expectedExplorerOverlay = false
        const expectedBrowserOverlay = requested <= 800
        const inViewport = (rect: Rect): boolean =>
          rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= initial.innerWidth + 1
        const geometryOk =
          Math.abs(initial.innerWidth - requested) <= 2 &&
          initial.railAutoCollapsed && initial.rail.width > 40 && initial.rail.width < 100 &&
          initial.browserOverlay === expectedBrowserOverlay &&
          initial.explorerOverlay === expectedExplorerOverlay &&
          initial.content.width >= contentFloor - 2 &&
          inViewport(initial.browser) && inViewport(initial.explorer) &&
          initial.browser.right <= initial.explorer.left + 2 &&
          initial.scrollWidth <= initial.innerWidth + 1

        const truthful = (probe: SizeProbe): boolean =>
          Math.abs(probe.browser.width - probe.browserHandle.now) <= 2 &&
          Math.abs(probe.explorer.width - probe.explorerHandle.now) <= 2
        const semanticHandles =
          home.browserHandle.role === 'separator' && home.browserHandle.orientation === 'vertical' &&
          home.explorerHandle.role === 'separator' && home.explorerHandle.orientation === 'vertical' &&
          !home.browserHandle.hidden && !home.explorerHandle.hidden // operable ⇒ announced (see Handle.hidden)
        const atHome =
          Math.abs(home.browserHandle.now - home.browserHandle.min) <= 1 &&
          Math.abs(home.explorerHandle.now - home.explorerHandle.min) <= 1
        const atEnd =
          Math.abs(end.browserHandle.now - end.browserHandle.max) <= 1 &&
          Math.abs(end.explorerHandle.now - end.explorerHandle.max) <= 1
        const browserHasRange = end.browserHandle.max > end.browserHandle.min
        const explorerHasRange = end.explorerHandle.max > end.explorerHandle.min
        const stepped =
          (!browserHasRange || step.browser.width < end.browser.width) &&
          (!explorerHasRange || step.explorer.width < end.explorer.width)
        const keyboardOk = semanticHandles && atHome && atEnd && stepped &&
          truthful(home) && truthful(end) && truthful(step)
        probes.push({ requested, initial, home, end, step, geometryOk, keyboardOk })
      }

      const pass = probes.every((probe) => probe.geometryOk && probe.keyboardOk)
      result = { pass, probes }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    if (fixture) {
      try {
        rmSync(fixture, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'responsive-result.json'), JSON.stringify(result, null, 2))
    } catch {
      // best effort
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

import { app, type BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated explorer-dock smoke (MOGGING_EXPLORER, Phase-11/03). The 02 tree given a
// home: a right-side dock rooted at the ACTIVE workspace's folder, toggled from the FAR
// RIGHT of the app bar. Zero network. Asserts:
//   (a) all three doors toggle it — the titlebar button, Ctrl+Shift+E, and the palette
//       command — and `is-active` tracks the dock every time;
//   (b) the toggle is the RIGHTMOST interactive control in #titlebar (right of Settings)
//       and is hit-testable at its own centre (nothing overlaps it);
//   (c) the width handle drags, CLAMPS (a greedy drag can never squeeze the grid below
//       its floor), persists, and the KV reads back;
//   (d) switching workspaces re-roots the tree — right folder, remembered expansion —
//       inside the 100ms perception budget;
//   (e) a workspace with NO folder shows an EmptyState and issues ZERO listings (spy);
//   (f) toggling never moves focus out of the pane the user was typing in;
//   (g) a CLOSED explorer costs nothing: no listing traffic, even across a switch.
// Verdict: out/explorer-result.json.

interface Fixture {
  alpha: string
  beta: string
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mog-explorer-'))
  // Alpha: a small tree with one nested dir to expand (the memory assertion).
  const alpha = join(root, 'alpha-project')
  mkdirSync(join(alpha, 'src', 'deep'), { recursive: true })
  mkdirSync(join(alpha, 'docs'))
  writeFileSync(join(alpha, 'src', 'deep', 'leaf.ts'), 'export {}\n')
  writeFileSync(join(alpha, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(alpha, 'README.md'), '# alpha\n')
  writeFileSync(join(alpha, '.hushfile'), 'hidden\n')
  // Beta: a DIFFERENT tree, so a re-root is unmistakable.
  const beta = join(root, 'beta-project')
  mkdirSync(join(beta, 'lib'), { recursive: true })
  writeFileSync(join(beta, 'BETA.txt'), 'beta\n')
  return { alpha, beta }
}

export function runExplorerSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // safety net (a full app boot + two workspaces)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const H = `
    const X = window.__mogging.explorer
    const dock = () => document.querySelector('.explorer-dock')
    const btn = () => document.querySelector('#titlebar .explorer-toggle')
    const shown = () => { const d = dock(); return !!d && !d.hidden }
    const active = () => !!btn()?.classList.contains('is-active')
    const names = () => X.rowNames()
  `
  const key = (code: string): Promise<unknown> =>
    ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${code}', code: 'Key${code.toUpperCase()}', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const fx = makeFixture()
    try {
      await sleep(1500)

      // ── Two workspaces: Alpha has a folder, Beta has NONE. ────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'Alpha', cwd: ${JSON.stringify(fx.alpha)}, paneCount: 1 })`)
      await sleep(2500) // the pane spawns; the dock must not care
      await ES(`window.__mogging.workspace.create({ name: 'Gamma', cwd: ${JSON.stringify(fx.beta)}, paneCount: 1 })`)
      await sleep(2500)
      await ES(`window.__mogging.workspace.create({ name: 'Beta' })`) // no cwd, on purpose
      await sleep(1500)
      await ES(`window.__mogging.workspace.switchByIndex(0)`) // back to Alpha
      await sleep(800)

      // ── (g) CLOSED costs zero: no listing traffic, even across a switch ───────
      await ES(`window.__mogging.explorer.resetCalls()`)
      await ES(`window.__mogging.workspace.switchByIndex(1)`)
      await sleep(600)
      await ES(`window.__mogging.workspace.switchByIndex(0)`)
      await sleep(600)
      const closedCalls = await ES<string[]>(`window.__mogging.explorer.listCalls()`)
      const closedIsFree = closedCalls.length === 0 && (await ES<boolean>(`(() => {${H} return !shown() })()`))

      // ── (b) the toggle is the RIGHTMOST control in the bar, and hit-testable ──
      const place = await ES<{ rightmost: boolean; rightOfSettings: boolean; hits: boolean; label: string; w: number; h: number }>(`(() => {${H}
        const all = [...document.querySelectorAll('#titlebar button')]
        const b = btn()
        const r = b.getBoundingClientRect()
        const settings = all.find((x) => (x.getAttribute('aria-label') || '') === 'Settings')
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const hit = document.elementFromPoint(cx, cy)
        return {
          rightmost: all.every((x) => x === b || x.getBoundingClientRect().right <= r.right),
          rightOfSettings: !!settings && r.left >= settings.getBoundingClientRect().right,
          hits: b.contains(hit),
          label: b.getAttribute('aria-label') || '',
          w: Math.round(r.width), h: Math.round(r.height)
        }
      })()`)
      // Same hitbox as every other bar control (the CHROMEUX contract, 29px).
      const placeOk = place.rightmost && place.rightOfSettings && place.hits && place.label === 'File explorer' && place.w >= 27 && place.w <= 31

      // ── (a) door 1: the button ────────────────────────────────────────────────
      await ES(`(() => {${H} btn().click() })()`)
      await sleep(700)
      const byButton = await ES<{ shown: boolean; active: boolean; names: string[]; root: string }>(`(() => {${H}
        return { shown: shown(), active: active(), names: names(), root: X.rootPath() }
      })()`)
      // Rooted at Alpha: dirs first, hidden filtered, and the folder is really Alpha's.
      const rootedOk =
        byButton.shown && byButton.active && byButton.root === fx.alpha &&
        byButton.names.join(',') === ['docs', 'src', 'README.md'].join(',')

      // ── (f) focus stays in the pane across a toggle ───────────────────────────
      const focusKept = await ES<{ before: string; after: string; kept: boolean }>(`(async () => {${H}
        const ta = document.querySelector('#workspace-host .xterm-helper-textarea')
        ta.focus()
        const before = document.activeElement?.className ?? ''
        btn().click()                                  // close
        await new Promise((r) => setTimeout(r, 300))
        btn().click()                                  // open again
        await new Promise((r) => setTimeout(r, 500))
        const after = document.activeElement?.className ?? ''
        return { before, after, kept: before === after && after.includes('xterm-helper-textarea') }
      })()`)
      const focusOk = focusKept.kept

      // ── (a) door 2: Ctrl+Shift+E ─────────────────────────────────────────────
      await key('e')
      await sleep(500)
      const afterKbClose = await ES<{ shown: boolean; active: boolean }>(`(() => {${H} return { shown: shown(), active: active() } })()`)
      await key('e')
      await sleep(600)
      const afterKbOpen = await ES<{ shown: boolean; active: boolean }>(`(() => {${H} return { shown: shown(), active: active() } })()`)
      const keyboardOk = !afterKbClose.shown && !afterKbClose.active && afterKbOpen.shown && afterKbOpen.active

      // ── (a) door 3: the palette command ──────────────────────────────────────
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))`)
      await sleep(400)
      await ES(`(() => {
        const i = document.querySelector('.palette-input')
        i.value = 'file explorer'
        i.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(400)
      const paletteRow = await ES<string>(`document.querySelector('.palette-item .palette-item-title')?.textContent ?? ''`)
      await ES(`document.querySelector('.palette-item')?.click()`)
      await sleep(600)
      const afterPalette = await ES<{ shown: boolean; active: boolean }>(`(() => {${H} return { shown: shown(), active: active() } })()`)
      const paletteOk = /toggle file explorer/i.test(paletteRow) && !afterPalette.shown && !afterPalette.active
      await key('e') // back open for the rest
      await sleep(700)

      // ── (c) width: drag, clamp, persist, read back ───────────────────────────
      const drag = await ES<{ start: number; wide: number; cap: number; narrow: number; min: number }>(`(async () => {${H}
        const h = document.querySelector('.explorer-dock-handle')
        const pull = (dx) => {
          const r = h.getBoundingClientRect()
          const x0 = Math.round(r.left + r.width / 2)
          h.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x0, bubbles: true, cancelable: true }))
          h.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x0 - dx, bubbles: true }))
          h.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
        }
        const start = X.width()
        pull(120)                            // widen by 120
        await new Promise((r) => setTimeout(r, 100))
        const wide = X.width()
        pull(5000)                           // greedy: must clamp, never eat the grid
        await new Promise((r) => setTimeout(r, 100))
        const cap = X.width()
        pull(-5000)                          // and the floor holds too
        await new Promise((r) => setTimeout(r, 100))
        const narrow = X.width()
        pull(120)                            // settle at 360 — NOT the 300 default, so the
        await new Promise((r) => setTimeout(r, 100)) // KV read-back proves a real write
        return { start, wide, cap, narrow, min: 240 }
      })()`)
      const vw = await ES<number>(`window.innerWidth`)
      const contentW = await ES<number>(`document.getElementById('content').getBoundingClientRect().width`)
      const dragOk =
        drag.wide > drag.start &&
        drag.cap <= Math.round(vw * 0.4) && drag.cap < 5000 &&
        drag.narrow === 240 &&
        contentW >= 480 // the grid's floor survived a greedy drag
      await sleep(600) // the 400ms width debounce lands
      const kv = await ES<{ open: boolean; width: number; showHidden: boolean }>(`window.bridge.invoke('explorer:init')`)
      const live = await ES<number>(`window.__mogging.explorer.width()`)
      // 300 is the DEFAULT — a read-back that merely equals it proves nothing. The drag
      // settled at 360, so the KV must carry that, and `open` must have been persisted too.
      const persistOk = kv.open === true && kv.width === live && kv.width === 360

      // ── (d) switch → re-rooted, remembered expansion, within the budget ──────
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(join(fx.alpha, 'src'))})`)
      await sleep(600)
      const expandedAlpha = await ES<{ names: string[]; dirs: string[] }>(`(() => {${H}
        return { names: names(), dirs: X.expandedDirs() }
      })()`)
      const expandOk = expandedAlpha.names.includes('deep') && expandedAlpha.names.includes('index.ts')

      const switchTiming = await ES<{ ms: number; root: string; names: string[] }>(`(async () => {${H}
        const t0 = performance.now()
        window.__mogging.workspace.switchByIndex(1)          // -> Gamma (beta-project)
        // Wait for the tree to actually SHOW the new root — re-rooting is not done
        // until the rows on screen are the new folder's.
        for (let i = 0; i < 240; i++) {
          if (X.rootPath() === ${JSON.stringify(fx.beta)} && names().includes('BETA.txt')) break
          await new Promise((r) => requestAnimationFrame(r))
        }
        const ms = Math.round(performance.now() - t0)
        return { ms, root: X.rootPath(), names: names() }
      })()`)
      const reRootOk =
        switchTiming.root === fx.beta &&
        switchTiming.names.join(',') === ['lib', 'BETA.txt'].join(',') &&
        switchTiming.ms <= 100

      // ...and coming BACK restores Alpha's expansion from memory.
      await ES(`window.__mogging.workspace.switchByIndex(0)`)
      await sleep(900)
      const back = await ES<{ root: string; names: string[]; dirs: string[] }>(`(() => {${H}
        return { root: X.rootPath(), names: names(), dirs: X.expandedDirs() }
      })()`)
      const memoryOk =
        back.root === fx.alpha &&
        back.dirs.includes(join(fx.alpha, 'src')) &&
        back.names.includes('deep') // src is still open — we returned, we did not arrive

      // ── (e) a workspace with NO folder: EmptyState, zero listings ────────────
      await ES(`window.__mogging.explorer.resetCalls()`)
      await ES(`window.__mogging.workspace.switchByIndex(2)`) // Beta — no cwd
      await sleep(900)
      const noCwd = await ES<{ empty: boolean; title: string; rows: number; calls: number; root: string }>(`(() => {${H}
        return {
          empty: !!document.querySelector('.explorer-dock .empty-state'),
          title: document.querySelector('.explorer-dock .empty-title')?.textContent ?? '',
          rows: document.querySelectorAll('.explorer-dock .ft-row').length,
          calls: X.listCalls().length,
          root: X.rootPath()
        }
      })()`)
      const noCwdOk = noCwd.empty && noCwd.rows === 0 && noCwd.calls === 0 && noCwd.root === '' && /no folder/i.test(noCwd.title)

      const pass =
        placeOk && rootedOk && keyboardOk && paletteOk && focusOk && dragOk && persistOk && expandOk && reRootOk && memoryOk && noCwdOk && closedIsFree
      result = {
        pass,
        placeOk, place,
        rootedOk, byButton,
        keyboardOk, afterKbClose, afterKbOpen,
        paletteOk, paletteRow, afterPalette,
        focusOk, focusKept,
        dragOk, drag, vw, contentW,
        persistOk, kv, live,
        expandOk, expandedAlpha,
        reRootOk, switchTiming,
        memoryOk, back,
        noCwdOk, noCwd,
        closedIsFree, closedCalls,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      rmSync(join(fx.alpha, '..'), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'explorer-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

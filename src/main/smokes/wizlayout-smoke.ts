import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated wizard-layout smoke (MOGGING_WIZLAYOUT — wizard revamp 2026-07-16).
// The layout section's whole promise, end to end: what the lattice offers is what
// the screen honestly holds, what you paint is what OPENS, and what opens keeps
// every pane at its physical minimums. Asserts:
//   (a) CAPACITY WIRING: the painter's budget equals the pane-capacity model run
//       against THIS screen minus THIS app's chrome AND this machine's own
//       budget (recomputed live from window.screen + the content region + the
//       system:machine measurements, with every constant pinned: 132×110 minima,
//       4px seam, 512 MiB/pane, 4 GiB reserve, 2 panes/core, ABS cap 32) — and
//       every lattice cell is blocked exactly when its grid would exceed it.
//       The section's hint quotes the same number and, when the machine is the
//       binding term, says so. Panes ALREADY RUNNING are charged: after the
//       first launch the reopened wizard's budget is smaller by exactly that
//       many panes;
//   (b) the lattice commits on DRAG-RELEASE, not only on click: press (0,0),
//       sweep to (0,N-1), release — the readout and the spec say 1×N. (The old
//       per-cell click listener committed NOTHING for this gesture — "I selected
//       the eight terminals horizontally and it didn't produce them");
//   (c) a plain lattice CLICK still commits exactly once (the drag path swallows
//       only its own synthesized click);
//   (d) the painted row LAUNCHES as painted: the workspace opens with N panes in
//       ONE horizontal line — pane count, persisted split tree (one 'h' root, N
//       leaves), and on-screen geometry (one shared top edge) all agree;
//   (e) MORE THAN 16, honored: a painted 8×3 (24 panes) opens with 24 panes, 24
//       'shell' assignments, and a persisted tree of 8 rows × 3 columns — the
//       old 16-cap template dialect must never re-enter this path;
//   (f) the pane minima are PHYSICAL: in the 8-row workspace every pane stays
//       >= the 110px height floor — the grid grows past the viewport and the
//       host SCROLLS (overflow-y auto, scrollHeight past clientHeight) instead
//       of crushing terminals.
// Zero network.

export function runWizLayoutSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net (two real launches, 32 PTYs)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(process.cwd(), 'out', 'wizlayout-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const waitFor = async (probe: () => Promise<boolean>, tries = 40, gapMs = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const root = mkdtempSync(join(tmpdir(), 'mog-wizlay-'))
    try {
      await sleep(1500)
      const cwdJs = JSON.stringify(root)
      await ES(`window.__mogging.templates.openWizard({ cwd: ${cwdJs} })`)
      await sleep(800)

      // THE DEFAULT: a fresh wizard proposes ONE terminal — you grow from there.
      // (It proposed four, a fleet nobody had asked for yet — 2026-07-16.)
      const freshReadout = await ES<string>(
        `document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? ''`
      )
      const defaultOneOk = /^1 terminal · 1×1/.test(freshReadout)

      // ── (a) capacity: geometry minus chrome, ∧ the machine, minus running ────
      const capacity = await ES<{
        cap: { maxCols: number; maxRows: number; maxPanes: number; screenMaxPanes: number; machineMaxPanes: number | null; panesElsewhere: number }
        expected: { maxCols: number; maxRows: number; maxPanes: number; screenMaxPanes: number; machineMaxPanes: number }
        latticeHonest: boolean
        latticeCols: number
        hint: string
        hintOk: boolean
      }>(`(async () => {
        const cap = window.__mogging.wizardLayout.capacity()
        // The whole budget, recomputed here with its constants PINNED (132/110 minima,
        // 4px seam, 512 MiB/pane, 4096 MiB reserve, 2 panes/core, ABS cap 32): if any
        // policy number moves, this gate must be edited deliberately.
        const fit = (span, min) => Math.max(1, Math.floor((Math.max(0, span) + 4) / (min + 4)))
        const content = document.getElementById('content').getBoundingClientRect()
        const availW = Math.max(1, screen.availWidth - Math.max(0, innerWidth - content.width))
        const availH = Math.max(1, screen.availHeight - Math.max(0, innerHeight - content.height))
        const cols = fit(availW, 132)
        const rows = fit(availH, 110)
        const screenMax = Math.min(cols * rows, 32)
        const m = await window.bridge.invoke('system:machine')
        const machineMax = Math.max(1, Math.min(Math.floor((m.totalMemMb - 4096) / 512), m.cpuCount * 2, 32))
        const expected = { maxCols: cols, maxRows: rows, maxPanes: Math.min(screenMax, machineMax), screenMaxPanes: screenMax, machineMaxPanes: machineMax }
        const cells = [...document.querySelectorAll('#view-wizard .gp-cell')]
        const latticeHonest = cells.length > 0 && cells.every((c) => {
          const panes = (Number(c.dataset.r) + 1) * (Number(c.dataset.c) + 1)
          const blocked = c.classList.contains('is-blocked')
          return (panes > cap.maxPanes) === blocked && c.disabled === blocked
        })
        const latticeCols = 1 + Math.max(...cells.map((c) => Number(c.dataset.c)))
        const hint = [...document.querySelectorAll('#view-wizard .wizard-hint')]
          .map((n) => n.textContent).find((t) => /up to \\d+ terminals/i.test(t)) ?? ''
        // The hint quotes THE number, and names the machine when the machine binds.
        const hintOk = new RegExp('up to ' + cap.maxPanes + ' terminals', 'i').test(hint) &&
          (cap.maxPanes >= cap.screenMaxPanes || /sized to this machine/.test(hint))
        return { cap, expected, latticeHonest, latticeCols, hint, hintOk }
      })()`)
      const capacityOk =
        capacity.cap.maxPanes === capacity.expected.maxPanes &&
        capacity.cap.maxCols === capacity.expected.maxCols &&
        capacity.cap.maxRows === capacity.expected.maxRows &&
        capacity.cap.screenMaxPanes === capacity.expected.screenMaxPanes &&
        capacity.cap.machineMaxPanes === capacity.expected.machineMaxPanes &&
        capacity.cap.panesElsewhere === 0 &&
        capacity.latticeHonest &&
        capacity.hintOk

      // ── (b) drag-release commits — the eight-across gesture ──────────────────
      const N = Math.min(8, capacity.cap.maxCols, capacity.latticeCols, capacity.cap.maxPanes)
      const drag = await ES<{ readout: string; rows: number; cols: number; regions: number }>(`(() => {
        const lattice = document.querySelector('#view-wizard .gp-lattice')
        const r = lattice.getBoundingClientRect()
        const cols = ${capacity.latticeCols}
        const rowsInLattice = [...lattice.querySelectorAll('.gp-cell')].length / cols
        const at = (row, col) => ({
          x: r.x + ((col + 0.5) / cols) * r.width,
          y: r.y + ((row + 0.5) / rowsInLattice) * r.height
        })
        const fire = (type, p) => lattice.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 11
        }))
        const a = at(0, 0)
        const b = at(0, ${N} - 1)
        fire('pointerdown', a)
        fire('pointermove', { x: (a.x + b.x) / 2, y: a.y })
        fire('pointermove', b)
        fire('pointerup', b)
        const spec = window.__mogging.wizardLayout.spec()
        return {
          readout: document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? '',
          rows: spec.rows, cols: spec.cols, regions: spec.regions.length
        }
      })()`)
      const dragCommitsOk =
        N >= 4 && drag.rows === 1 && drag.cols === N && drag.regions === N && drag.readout.startsWith(`${N} terminals · 1×${N}`)

      // ── (c) a plain click still commits exactly once ──────────────────────────
      await ES(`[...document.querySelectorAll('#view-wizard .gp-cell')]
        .find((c) => c.dataset.r === '1' && c.dataset.c === '1')?.click()`)
      await sleep(200)
      const clicked = await ES<{ rows: number; cols: number; regions: number }>(`(() => {
        const spec = window.__mogging.wizardLayout.spec()
        return { rows: spec.rows, cols: spec.cols, regions: spec.regions.length }
      })()`)
      const clickCommitsOk = clicked.rows === 2 && clicked.cols === 2 && clicked.regions === 4

      // ── (d) the painted 1×N row launches AS PAINTED ───────────────────────────
      await ES(`(() => {
        const lattice = document.querySelector('#view-wizard .gp-lattice')
        const r = lattice.getBoundingClientRect()
        const cols = ${capacity.latticeCols}
        const rowsInLattice = [...lattice.querySelectorAll('.gp-cell')].length / cols
        const p = { x: r.x + ((${N} - 0.5) / cols) * r.width, y: r.y + (0.5 / rowsInLattice) * r.height }
        const fire = (type) => lattice.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerId: 12
        }))
        fire('pointerdown')
        fire('pointerup')
      })()`)
      await sleep(200)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      const rowLaunched = await waitFor(async () =>
        ES<boolean>(`!!document.querySelector('#content.view-grid') && (window.__mogging.layout.paneCount?.() ?? 0) === ${N}`)
      )
      await sleep(500)
      const rowWorkspace = await ES<{
        panes: number
        tree: { dir?: string; children?: unknown[]; id?: number } | null
        tops: number[]
        heights: number[]
      }>(`(() => {
        const meta = window.__mogging.workspace.active()
        let tree = null
        try { tree = JSON.parse(meta.layout).root } catch { /* unparsed */ }
        const grid = document.querySelector('.workspace-view.active .layout-grid')
        const slots = [...grid.querySelectorAll('.layout-slot')].map((s) => s.getBoundingClientRect())
        return {
          panes: meta.paneCount,
          tree,
          tops: slots.map((s) => Math.round(s.y)),
          heights: slots.map((s) => Math.round(s.height))
        }
      })()`)
      const oneRowOk =
        rowLaunched &&
        rowWorkspace.panes === N &&
        rowWorkspace.tree?.dir === 'h' &&
        (rowWorkspace.tree?.children?.length ?? 0) === N &&
        rowWorkspace.tops.length === N &&
        rowWorkspace.tops.every((t) => Math.abs(t - rowWorkspace.tops[0]!) <= 2)

      // ── (e) + (f) more than 16, honored — at physical minimums ───────────────
      await ES(`window.__mogging.templates.openWizard({ cwd: ${cwdJs} })`)
      await sleep(800)
      // Running panes are CHARGED: the reopened wizard has N fewer to offer.
      const capacity2 = await ES<{ maxPanes: number; screenMaxPanes: number; machineMaxPanes: number | null; panesElsewhere: number }>(
        `(() => { const c = window.__mogging.wizardLayout.capacity(); return { maxPanes: c.maxPanes, screenMaxPanes: c.screenMaxPanes, machineMaxPanes: c.machineMaxPanes, panesElsewhere: c.panesElsewhere } })()`
      )
      const chargedOk =
        capacity2.panesElsewhere === N &&
        capacity2.machineMaxPanes === capacity.cap.machineMaxPanes &&
        capacity2.maxPanes === Math.min(capacity2.screenMaxPanes, Math.max(1, (capacity2.machineMaxPanes ?? Infinity) - N))
      const painted24 = await ES<{ panes: number; readout: string }>(`(() => ({
        panes: window.__mogging.wizardLayout.setGrid(8, 3),
        readout: document.querySelector('#view-wizard .wizard-layout-readout')?.textContent ?? ''
      }))()`)
      await ES(`document.querySelector('#view-wizard .wizard-footer .btn--primary').click()`)
      const bigLaunched = await waitFor(async () =>
        ES<boolean>(`!!document.querySelector('#content.view-grid') && (window.__mogging.layout.paneCount?.() ?? 0) === 24`)
      )
      await sleep(700)
      const bigWorkspace = await ES<{
        panes: number
        assignments: string[]
        treeRows: number
        rowWidths: number[]
        heights: number[]
        overflowY: string
        scrollHeight: number
        clientHeight: number
      }>(`(() => {
        const meta = window.__mogging.workspace.active()
        let treeRows = 0
        let rowWidths = []
        try {
          const rootNode = JSON.parse(meta.layout).root
          treeRows = rootNode.dir === 'v' ? rootNode.children.length : 0
          rowWidths = rootNode.dir === 'v' ? rootNode.children.map((c) => c.children?.length ?? 1) : []
        } catch { /* unparsed */ }
        const host = document.querySelector('.workspace-view.active')
        const slots = [...host.querySelectorAll('.layout-slot')].map((s) => s.getBoundingClientRect())
        return {
          panes: meta.paneCount,
          assignments: meta.assignments ?? [],
          treeRows,
          rowWidths,
          heights: slots.map((s) => Math.round(s.height)),
          overflowY: getComputedStyle(host).overflowY,
          scrollHeight: host.scrollHeight,
          clientHeight: host.clientHeight
        }
      })()`)
      const over16Ok =
        painted24.panes === 24 &&
        /^24 terminals · 8×3/.test(painted24.readout) &&
        bigLaunched &&
        bigWorkspace.panes === 24 &&
        bigWorkspace.assignments.length === 24 &&
        bigWorkspace.assignments.every((a) => a === 'shell') &&
        bigWorkspace.treeRows === 8 &&
        bigWorkspace.rowWidths.every((w) => w === 3)
      // 8 rows at the 110px floor need ~894px; the smoke window's grid is ~700. The floor
      // must WIN — panes hold >= 109 (rounding) and the HOST scrolls the difference (its
      // scrollable content reaches the tree's requirement even when the viewport cannot).
      const minimaOk =
        bigWorkspace.heights.length === 24 &&
        bigWorkspace.heights.every((h) => h >= 109) &&
        bigWorkspace.overflowY === 'auto' &&
        bigWorkspace.scrollHeight >= 890

      const pass = defaultOneOk && capacityOk && chargedOk && dragCommitsOk && clickCommitsOk && oneRowOk && over16Ok && minimaOk
      result = {
        pass,
        defaultOneOk,
        freshReadout,
        capacityOk,
        capacity,
        chargedOk,
        capacity2,
        dragCommitsOk,
        N,
        drag,
        clickCommitsOk,
        clicked,
        oneRowOk,
        rowLaunched,
        rowWorkspace,
        over16Ok,
        painted24,
        bigLaunched,
        bigWorkspace: { ...bigWorkspace, heights: bigWorkspace.heights.slice(0, 6) },
        minimaOk,
        minHeightSeen: Math.min(...bigWorkspace.heights),
        scroll: { overflowY: bigWorkspace.overflowY, scrollHeight: bigWorkspace.scrollHeight, clientHeight: bigWorkspace.clientHeight }
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

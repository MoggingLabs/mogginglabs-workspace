import { app, type BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WATCH_POOL_CAP } from '@backend/features/explorer'
import { explorerWatchStats } from './explorer'

// Env-gated liveness smoke (MOGGING_TREELIVE, Phase-11/04). The law: WATCH WHAT'S
// VISIBLE, NOTHING ELSE. Every write below is a REAL fs write from the main process —
// this is the agent, simulated honestly. Zero network. Asserts:
//   (a) create / delete / rename in an EXPANDED dir lands within 1s, and the selection
//       and scroll position survive the update;
//   (b) writes into a COLLAPSED dir produce ZERO batches — not one wasted wake-up —
//       until it is expanded, and expanding then shows them;
//   (c) a torrent (500 files across 5 expanded dirs) coalesces into ≤ 10 batches and
//       costs 0 frames > 100ms while the tree applies it;
//   (d) 100 expanded dirs cap the pool at 64 handles — and a dir EVICTED to the poll
//       tier still comes alive when touched;
//   (e) a HIDDEN window watches nothing (0 batches while blind) and re-shows with ONE
//       reconcile pass that catches everything it missed;
//   (f) a CLOSED explorer reports 0 handles and 0 polls.
// Verdict: out/treelive-result.json.

const TORRENT_DIRS = 5
const TORRENT_PER_DIR = 100
const MANY = 100 // expanded dirs for the pool-cap arm

interface Fixture {
  root: string
  live: string
  collapsed: string
  torrent: string[]
  many: string
  manyDirs: string[]
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mog-treelive-'))

  // `live`: the dir we watch. Enough files that the tree scrolls, so (a) can prove the
  // scroll position is not thrown away by an update.
  const live = join(root, 'live')
  mkdirSync(live)
  for (let i = 0; i < 60; i++) writeFileSync(join(live, `f${String(i).padStart(3, '0')}.txt`), '')

  // `collapsed`: never expanded. Writes in here must be silent (b).
  const collapsed = join(root, 'collapsed')
  mkdirSync(collapsed)
  writeFileSync(join(collapsed, 'seed.txt'), '')

  // `torrent/t0..t4`: the burst (c).
  const torrentRoot = join(root, 'torrent')
  mkdirSync(torrentRoot)
  const torrent: string[] = []
  for (let i = 0; i < TORRENT_DIRS; i++) {
    const d = join(torrentRoot, 't' + i)
    mkdirSync(d)
    torrent.push(d)
  }

  // `many/d000..d099`: the pool cap + eviction arm (d).
  const many = join(root, 'many')
  mkdirSync(many)
  const manyDirs: string[] = []
  for (let i = 0; i < MANY; i++) {
    const d = join(many, 'd' + String(i).padStart(3, '0'))
    mkdirSync(d)
    manyDirs.push(d)
  }

  return { root, live, collapsed, torrent, many, manyDirs }
}

export function runTreeLiveSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const H = `
    const X = window.__mogging.explorer
    const names = () => X.rowNames()
  `
  /** Wait (in the RENDERER) until a row with this name exists — the honest latency. */
  const awaitRow = (name: string, capMs = 5000): Promise<number> =>
    ES<number>(`(async () => {${H}
      const t0 = performance.now()
      while (performance.now() - t0 < ${capMs}) {
        if (names().includes(${JSON.stringify(name)})) return Math.round(performance.now() - t0)
        await new Promise((r) => setTimeout(r, 16))
      }
      return -1
    })()`)
  const awaitGone = (name: string, capMs = 5000): Promise<number> =>
    ES<number>(`(async () => {${H}
      const t0 = performance.now()
      while (performance.now() - t0 < ${capMs}) {
        if (!names().includes(${JSON.stringify(name)})) return Math.round(performance.now() - t0)
        await new Promise((r) => setTimeout(r, 16))
      }
      return -1
    })()`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const fx = makeFixture()
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Live', cwd: ${JSON.stringify(fx.root)}, paneCount: 1 })`)
      await sleep(2500)

      // ── (f) closed costs zero — BEFORE we ever open it ────────────────────────
      const closedStats = explorerWatchStats()
      const closedZero = closedStats.handles === 0 && closedStats.polls === 0

      await ES(`window.__mogging.explorer.toggle(true)`)
      await sleep(800)
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(fx.live)})`)
      await sleep(600)
      const openStats = explorerWatchStats()
      // root + live = 2 handles. `collapsed` is NOT watched — that is the whole law.
      const watchingOk = openStats.handles === 2 && openStats.polls === 0 && !openStats.suspended

      // ── (a) create / delete / rename land ≤ 1s, selection + scroll survive ────
      await ES(`(async () => {${H}
        await X.reveal(${JSON.stringify(join(fx.live, 'f030.txt'))})   // select something mid-list
        X.setScrollTop(120)
      })()`)
      await sleep(300)
      const before = await ES<{ selection: string; scrollTop: number }>(
        `(() => ({ selection: window.__mogging.explorer.selection(), scrollTop: window.__mogging.explorer.scrollTop() }))()`
      )
      await ES(`window.__mogging.explorer.resetBatches()`)

      writeFileSync(join(fx.live, 'AGENT-NEW.txt'), 'written by an agent\n')
      const createMs = await awaitRow('AGENT-NEW.txt')
      const afterCreate = await ES<{ selection: string; scrollTop: number }>(
        `(() => ({ selection: window.__mogging.explorer.selection(), scrollTop: window.__mogging.explorer.scrollTop() }))()`
      )

      unlinkSync(join(fx.live, 'f000.txt'))
      const deleteMs = await awaitGone('f000.txt')

      // The new name sorts FIRST on purpose. Rows are virtualized (11/02), so only the
      // scrolled-to window is in the DOM — a name that sorts after 58 siblings would be
      // a real row the tree holds and never renders, and this probe would be measuring
      // the virtualizer, not the watcher.
      renameSync(join(fx.live, 'f001.txt'), join(fx.live, 'AAA-RENAMED.txt'))
      const renameMs = await awaitRow('AAA-RENAMED.txt')

      const liveOk =
        createMs >= 0 && createMs <= 1000 &&
        deleteMs >= 0 && deleteMs <= 1000 &&
        renameMs >= 0 && renameMs <= 1000 &&
        afterCreate.selection === before.selection && // the update did not steal the selection…
        afterCreate.scrollTop === before.scrollTop // …nor throw away where we were looking

      // ── (b) a COLLAPSED dir is silent ────────────────────────────────────────
      // NOTE the Windows trap this proves absent: writing inside `collapsed/` bumps that
      // directory's last-write time, which FIRES the root's non-recursive watcher. The
      // pool re-reads the root, sees its listing did not move, and drops it — so the
      // renderer is never woken. Without that check this assertion would fail here.
      await ES(`window.__mogging.explorer.resetBatches()`)
      for (let i = 0; i < 20; i++) writeFileSync(join(fx.collapsed, `hidden-${i}.txt`), 'x')
      await sleep(1600) // well past the coalesce window + a poll tick
      const silentBatches = await ES<string[][]>(`window.__mogging.explorer.batches()`)
      // …and expanding it NOW shows the writes (they were never lost, just never watched).
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(fx.collapsed)})`)
      await sleep(700)
      const collapsedNames = await ES<string[]>(`window.__mogging.explorer.rowNames()`)
      const collapsedOk = silentBatches.length === 0 && collapsedNames.includes('hidden-19.txt')

      // ── (c) the torrent: 500 files, 5 dirs, one burst ────────────────────────
      await ES(`window.__mogging.explorer.setExpanded(${JSON.stringify([fx.live, fx.collapsed, ...fx.torrent])})`)
      await sleep(800)
      await ES(`window.__mogging.explorer.resetBatches()`)
      // Sample frames in the renderer WHILE main writes — the tree must stay smooth.
      const framesPromise = ES<{ frames: number; over100: number; maxGap: number }>(`(async () => {
        const gaps = []
        let last = performance.now()
        const t0 = last
        await new Promise((res) => {
          const step = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            if (now - t0 >= 3000) return res()
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
        const warm = gaps.slice(2)
        return { frames: gaps.length, over100: warm.filter((g) => g > 100).length, maxGap: Math.round(Math.max(...warm)) }
      })()`)
      await sleep(250) // let the sampler get going, then let the agent loose
      for (const dir of fx.torrent) {
        for (let i = 0; i < TORRENT_PER_DIR; i++) writeFileSync(join(dir, `burst-${String(i).padStart(3, '0')}.txt`), 'x')
      }
      const frames = await framesPromise
      const torrentBatches = await ES<string[][]>(`window.__mogging.explorer.batches()`)
      // ~580 rows now exist; only the scrolled window is in the DOM. Scroll to the file
      // to prove the tree really HOLDS it — `reveal` walks the model, so a row it can
      // reach is a row the batch actually spliced in.
      await ES(`window.__mogging.explorer.reveal(${JSON.stringify(join(fx.torrent[0], 'burst-099.txt'))})`)
      await sleep(400)
      const torrentLanded = await ES<boolean>(`window.__mogging.explorer.rowNames().includes('burst-099.txt')`)
      const gpuSoft = process.env.MOGGING_CI_GPU === 'soft'
      const torrentOk =
        torrentBatches.length > 0 && torrentBatches.length <= 10 &&
        torrentLanded &&
        (gpuSoft ? frames.over100 <= 2 : frames.over100 === 0)

      // ── (d) 100 expanded dirs: the pool caps, the evicted still live ─────────
      // The renderer sends [root, many, d000…d099] — 102 dirs, priority-ordered. The
      // pool keeps 64 handles; the rest drop to the poll tier.
      await ES(`window.__mogging.explorer.setExpanded(${JSON.stringify([fx.many, ...fx.manyDirs])})`)
      await sleep(1500)
      const poolStats = explorerWatchStats()
      const evicted = fx.manyDirs[MANY - 1] // the coldest — certain to be on the poll tier
      await ES(`window.__mogging.explorer.resetBatches()`)
      writeFileSync(join(evicted, 'POKED.txt'), 'x')
      // The poll tier is jittered around 2s — give it room, then prove it delivered.
      const pokedMs = await ES<number>(`(async () => {
        const t0 = performance.now()
        while (performance.now() - t0 < 8000) {
          const hit = window.__mogging.explorer.batches().some((b) => b.includes(${JSON.stringify(evicted)}))
          if (hit) return Math.round(performance.now() - t0)
          await new Promise((r) => setTimeout(r, 50))
        }
        return -1
      })()`)
      await ES(`window.__mogging.explorer.reveal(${JSON.stringify(join(evicted, 'POKED.txt'))})`)
      await sleep(400)
      const pokedRow = await ES<boolean>(`window.__mogging.explorer.rowNames().includes('POKED.txt')`)
      const poolOk =
        poolStats.handles === WATCH_POOL_CAP &&
        poolStats.polls === 102 - WATCH_POOL_CAP &&
        pokedMs >= 0 && pokedMs <= 8000 &&
        pokedRow // the evicted dir's write reached the SCREEN, not just the batch log

      // ── (e) hidden window: blind, then ONE reconcile pass on the way back ────
      await ES(`window.__mogging.explorer.setExpanded(${JSON.stringify([fx.live])})`)
      await sleep(800)
      await ES(`window.__mogging.explorer.resetBatches()`)
      win.hide()
      await sleep(500)
      const hiddenStats = explorerWatchStats()
      writeFileSync(join(fx.live, 'WHILE-BLIND.txt'), 'written while nobody was looking\n')
      await sleep(1800) // longer than any coalesce window or poll tick
      const blindBatches = await ES<string[][]>(`window.__mogging.explorer.batches()`)
      win.show()
      const blindMs = await awaitRow('WHILE-BLIND.txt', 6000)
      await sleep(400)
      const resumeBatches = await ES<string[][]>(`window.__mogging.explorer.batches()`)
      const shownStats = explorerWatchStats()
      const hiddenOk =
        hiddenStats.handles === 0 && hiddenStats.polls === 0 && hiddenStats.suspended === true &&
        blindBatches.length === 0 && // blind means blind: not one event while hidden
        blindMs >= 0 &&
        resumeBatches.length === 1 && // ONE reconcile pass, not a replay of the burst
        resumeBatches[0].includes(fx.live) &&
        shownStats.suspended === false && shownStats.handles > 0

      // ── (f) close it: the pool goes to nothing ───────────────────────────────
      await ES(`window.__mogging.explorer.toggle(false)`)
      await sleep(600)
      const shutStats = explorerWatchStats()
      const shutOk = shutStats.handles === 0 && shutStats.polls === 0

      const pass = closedZero && watchingOk && liveOk && collapsedOk && torrentOk && poolOk && hiddenOk && shutOk
      result = {
        pass,
        closedZero, closedStats,
        watchingOk, openStats,
        liveOk, createMs, deleteMs, renameMs, before, afterCreate,
        collapsedOk, silentBatchCount: silentBatches.length,
        torrentOk, torrentBatchCount: torrentBatches.length, torrentLanded, frames, gpuSoft,
        poolOk, poolStats, cap: WATCH_POOL_CAP, pokedMs, pokedRow,
        hiddenOk, hiddenStats, blindBatchCount: blindBatches.length, blindMs,
        resumeBatchCount: resumeBatches.length, shownStats,
        shutOk, shutStats,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      rmSync(fx.root, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'treelive-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

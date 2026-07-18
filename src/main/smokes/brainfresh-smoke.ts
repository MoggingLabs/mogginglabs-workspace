import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BRAIN_DRAIN_QUIET_MS, headDiffSpawnsForSmoke } from '@backend/features/brain'
import { brainDebug, disposeBrain, handleBrainRebuild, handleBrainStatus } from '../brain'
import type { BrainStatus } from '@contracts'

// Env-gated brain-freshness smoke (MOGGING_BRAINFRESH, ADR 0018 step 04) — the freshness
// LAW, live: the index follows the repo by riding the existing 2.5s git tick, and nothing
// else. A REAL shell pane (the FILESMILESTONE precedent) does the headline write — the
// index is proving it follows an AGENT's footprint, not this smoke reaching around one.
//   (a) a real pane appends a function to a tracked file → within ≤ 2 ticks the node
//       exists and the generation moved by exactly one;
//       coalescing: 20 rapid writes → 1–2 drains, counted, one gen bump per drain;
//   (b) a real pane deletes a file → its rows gone, the tombstone counted;
//   (c) head moves are DELTA-ONLY: a commit (no worktree change) drains nothing; a
//       branch round-trip reparses exactly the two changed files — cache-hit, never the
//       tree — and the dump returns byte-identical to the pre-branch snapshot;
//   (d) dirty is nonzero DURING the debounce window and zero after — polled, never slept;
//   (e) a NON-repo root picks up an mtime change via the capped sweep on the same cadence;
//   (f) killed mid-work: the brain subsystem is torn down COLD (dispose — freshness state,
//       handles, timers all gone), files change while nothing watches, and the FIRST
//       status after reopen heals by reconcile — incremental counts, not a full reparse;
//   (g) determinism: after all of it, rebuild == incremental result, byte-identical dump
//       (both roots) — the incremental path may not drift. And the meters: one
//       brain:changed per landed drain; one head-diff spawn per observed head move.
// Verdict: out/brainfresh-result.json.

const TICK_MS = 2500

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface Fixture {
  base: string
  repo: string
  folder: string
}

const REPO_FILES: Record<string, string> = {
  'tracked.ts': 'export function alpha(): number {\n  return 1\n}\n',
  'storm.ts': 'export function storm(): number {\n  return 1\n}\n',
  'doomed.ts': 'export function doomed(): number {\n  return 1\n}\n',
  'cee.ts': 'export function cee(): number {\n  return 1\n}\n',
  'dee.ts': 'export function dee(): number {\n  return 1\n}\n',
  'winfile.ts': 'export function winfn(): number {\n  return 1\n}\n'
}

function makeFixture(): Fixture {
  // realpathSync.native: CI temp dirs are aliases (8.3 short names, /var symlinks) and the
  // probe stack canonicalizes — the FILESMILESTONE lesson, inherited verbatim.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainfresh-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  for (const [rel, src] of Object.entries(REPO_FILES)) writeFileSync(join(repo, rel), src)
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  // autocrlf OFF: byte identity across checkouts is half this smoke's spine.
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])

  const folder = join(base, 'plain') // no git — the sweep's world
  mkdirSync(folder)
  writeFileSync(join(folder, 'a.py'), 'def solo():\n    return 1\n')

  // The REAL pane's tool, OUTSIDE the repo (.mjs would otherwise become a row): the shell
  // runs `node ../ops.mjs <verb>` — a real child of a real shell doing the write.
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync, rmSync } from 'node:fs'\n` +
      `const repo = ${JSON.stringify(repo)}\n` +
      `const op = process.argv[2]\n` +
      `if (op === 'append') appendFileSync(repo + '/tracked.ts', '\\nexport function freshface(): number {\\n  return 2\\n}\\n')\n` +
      `if (op === 'delete') rmSync(repo + '/doomed.ts')\n`
  )
  return { base, repo, folder }
}

export function runBrainFreshSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainfresh-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (existsSync(resultFile)) {
    app.exit(0)
    return
  }
  const write = (o: object): void => {
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: brainfresh smoke did not complete' })
    app.exit(1)
  }, 280000)

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** The retry-loop rule: every wait is a poll on observable state with an honest cap. */
  const until = async (pred: () => boolean, capMs: number, stepMs = 50): Promise<{ ok: boolean; ms: number }> => {
    const t0 = Date.now()
    for (;;) {
      if (pred()) return { ok: true, ms: Date.now() - t0 }
      if (Date.now() - t0 > capMs) return { ok: false, ms: Date.now() - t0 }
      await sleep(stepMs)
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      const statusOf = (root: string): BrainStatus | null => {
        const a = handleBrainStatus({ root })
        return a.ok ? a : null
      }
      const fresh = (root: string): ReturnType<ReturnType<typeof brainDebug>['freshness']> =>
        brainDebug().freshness(root)
      const dump = (root: string): string => brainDebug().dump(root) ?? ''
      await sleep(1500)

      // ── The world: a workspace whose ONE pane is a real shell in the repo ──────────
      await ES(`window.__mogging.workspace.create({ name: 'Fresh', cwd: ${JSON.stringify(F.repo)}, paneCount: 1 })`)
      await sleep(4000) // the shell spawns and prints a prompt

      const b0 = await handleBrainRebuild({ root: F.repo })
      const bf0 = await handleBrainRebuild({ root: F.folder })
      const baseOk =
        b0.ok && b0.files === 6 && !b0.dirty && bf0.ok && bf0.files === 1 &&
        fresh(F.repo) !== null && fresh(F.folder) !== null && fresh(F.folder)?.isRepo === false
      if (!b0.ok || !bf0.ok) throw new Error('baseline build refused: ' + JSON.stringify({ b0, bf0 }))
      let gen = b0.generation
      let fGen = bf0.generation

      // ── (a) a REAL pane appends a function to a tracked file ───────────────────────
      const writeCmd = 'node ../ops.mjs append\r'
      await ES(`window.__mogging.panes[0].write(${JSON.stringify(writeCmd)})`)
      const appeared = await until(() => (statusOf(F.repo)?.generation ?? 0) >= gen + 1, 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 2500)
      const sA = statusOf(F.repo)
      const freshOk =
        appeared.ok &&
        appeared.ms <= 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS && // ≤ 2 ticks + the quiet window
        sA?.generation === gen + 1 && // ONE drain, ONE bump
        dump(F.repo).includes('"freshface"') &&
        sA?.dirty === false &&
        (fresh(F.repo)?.drains ?? 0) >= 1
      gen += 1

      // ── coalescing: 20 rapid writes → 1–2 drains, counted ──────────────────────────
      const drains0 = fresh(F.repo)?.drains ?? 0
      for (let i = 0; i < 20; i++) {
        appendFileSync(join(F.repo, 'storm.ts'), `\nexport function s${i}(): number {\n  return ${i}\n}\n`)
      }
      const stormSettled = await until(() => {
        const s = statusOf(F.repo)
        const f = fresh(F.repo)
        return !!s && !!f && f.drains > drains0 && !s.dirty && !s.indexing && dump(F.repo).includes('"s19"')
      }, 4 * TICK_MS + 5000)
      const stormDrains = (fresh(F.repo)?.drains ?? 0) - drains0
      const sStorm = statusOf(F.repo)
      const stormOk =
        stormSettled.ok && stormDrains >= 1 && stormDrains <= 2 &&
        sStorm?.generation === gen + stormDrains // one bump per drain, nothing hidden
      gen += stormDrains

      // ── (b) a REAL pane deletes a file → rows gone, tombstone counted ──────────────
      await ES(`window.__mogging.panes[0].write(${JSON.stringify('node ../ops.mjs delete\r')})`)
      const deleted = await until(() => {
        const s = statusOf(F.repo)
        return !!s && s.generation >= gen + 1 && !s.dirty && !s.indexing
      }, 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 5000)
      const sB = statusOf(F.repo)
      const deleteOk =
        deleted.ok &&
        sB?.generation === gen + 1 &&
        sB?.files === 5 &&
        !dump(F.repo).includes('doomed') &&
        (fresh(F.repo)?.lastRemoved ?? 0) === 1
      gen += 1

      // ── (c) head moves: commit drains NOTHING; a branch round-trip is delta-only ───
      // Settle the working tree on main first, so the side branch's delta is EXACTLY two
      // files. The settle commit itself IS the first head-move probe: HEAD moves, no
      // worktree byte does — the diff fires once and the drain counter must not.
      const drainsC = fresh(F.repo)?.drains ?? 0
      git(F.repo, ['add', '-A'])
      git(F.repo, ['commit', '-m', 'settle'])
      const hmSettle = await until(() => (fresh(F.repo)?.headMoves ?? 0) >= 1, 3 * TICK_MS + 3000)
      const ticksAtSettle = fresh(F.repo)?.ticks ?? 0
      await until(() => (fresh(F.repo)?.ticks ?? 0) >= ticksAtSettle + 2, 3 * TICK_MS + 3000)
      const sSettle = statusOf(F.repo)
      const commitQuietOk =
        hmSettle.ok && sSettle?.generation === gen && !sSettle?.dirty &&
        (fresh(F.repo)?.drains ?? 0) === drainsC // HEAD moved, nothing reparsed
      const dumpMain = dump(F.repo) // the snapshot the round-trip must return to, byte-for-byte

      git(F.repo, ['checkout', '-b', 'side']) // same oid — not a head move
      writeFileSync(join(F.repo, 'cee.ts'), 'export function cee2(): number {\n  return 2\n}\n')
      writeFileSync(join(F.repo, 'dee.ts'), 'export function dee2(): number {\n  return 2\n}\n')
      const sideDrained = await until(() => {
        const s = statusOf(F.repo)
        return !!s && s.generation > gen && !s.dirty && !s.indexing && dump(F.repo).includes('"cee2"') && dump(F.repo).includes('"dee2"')
      }, 4 * TICK_MS + 5000)
      const sideGenDelta = (statusOf(F.repo)?.generation ?? 0) - gen
      const sideOk = sideDrained.ok && sideGenDelta >= 1 && sideGenDelta <= 2
      gen += sideGenDelta

      git(F.repo, ['add', '-A'])
      git(F.repo, ['commit', '-m', 'side'])
      // The monitor must OBSERVE the side commit before the switch back — two moves that
      // cancel inside one tick are invisible to any poll-based observer, honestly so.
      const hmSide = await until(() => (fresh(F.repo)?.headMoves ?? 0) >= 2, 3 * TICK_MS + 3000)
      git(F.repo, ['checkout', 'main'])
      const backDrained = await until(() => {
        const s = statusOf(F.repo)
        return !!s && s.generation >= gen + 1 && !s.dirty && !s.indexing
      }, 3 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 5000)
      const fBack = fresh(F.repo)
      const dumpBack = dump(F.repo)
      const switchOk =
        hmSide.ok && backDrained.ok &&
        (statusOf(F.repo)?.generation ?? 0) === gen + 1 &&
        fBack?.lastProcessed === 2 && // THE delta, not the tree
        fBack?.lastCacheHits === 2 && fBack?.lastCacheMisses === 0 && // old bytes, still paid for
        fBack?.headMoves === 3 &&
        dumpBack === dumpMain // the round trip left no residue
      gen += 1

      // ── (d) dirty nonzero DURING the debounce window, zero after — polled ──────────
      writeFileSync(join(F.repo, 'winfile.ts'), 'export function winfn2(): number {\n  return 2\n}\n')
      const sawDirty = await until(() => statusOf(F.repo)?.dirty === true, 2 * TICK_MS + 2000, 25)
      const dirtySettled = await until(() => {
        const s = statusOf(F.repo)
        return !!s && !s.dirty && !s.indexing && s.generation === gen + 1
      }, 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 5000, 25)
      const dirtyOk = sawDirty.ok && dirtySettled.ok && dump(F.repo).includes('"winfn2"')
      gen += 1

      // ── (e) a non-repo root picks up an mtime change via the sweep ─────────────────
      writeFileSync(join(F.folder, 'a.py'), 'def solo2():\n    return 2\n')
      const sweepHealed = await until(() => {
        const s = statusOf(F.folder)
        return !!s && s.generation >= fGen + 1 && !s.dirty && dump(F.folder).includes('"solo2"')
      }, 3 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 5000)
      const sweepOk =
        sweepHealed.ok &&
        (statusOf(F.folder)?.generation ?? 0) === fGen + 1 &&
        (fresh(F.folder)?.sweeps ?? 0) >= 1 &&
        fresh(F.folder)?.isRepo === false
      fGen += 1

      // ── the changed-event law, before the teardown resets the meters ───────────────
      const emitsPreCold = brainDebug().drainEmits()
      const drainsPreCold = (fresh(F.repo)?.drains ?? 0) + (fresh(F.folder)?.drains ?? 0)
      const emitsOkPre = emitsPreCold === drainsPreCold // ONE brain:changed per landed drain

      // ── (f) cold start: torn down mid-work, changes land unobserved, first status
      //        heals by reconcile — incremental counts, never a full reparse ──────────
      disposeBrain() // freshness state, timers, subscriptions, handles: all gone
      writeFileSync(join(F.repo, 'coldnew.ts'), 'export function coldnew(): number {\n  return 7\n}\n')
      appendFileSync(join(F.repo, 'tracked.ts'), '\nexport function alphaTwo(): number {\n  return 3\n}\n')
      rmSync(join(F.repo, 'storm.ts'))
      const first = handleBrainStatus({ root: F.repo }) // THE first status after reopen
      const firstDirtyOk = first.ok && first.dirty === true && first.generation === gen // staleness visible, instantly
      const healed = await until(() => {
        const s = statusOf(F.repo)
        return !!s && s.generation === gen + 1 && !s.dirty && !s.indexing
      }, 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 10000)
      const fHeal = fresh(F.repo)
      const dumpHealed = dump(F.repo)
      const healOk =
        firstDirtyOk && healed.ok &&
        (statusOf(F.repo)?.files ?? 0) === 5 && // tracked, cee, dee, winfile, coldnew
        fHeal?.reconciles === 1 &&
        fHeal?.lastProcessed === 2 && // coldnew + tracked — the prefilter spared the rest
        fHeal?.lastRemoved === 1 && // storm.ts
        dumpHealed.includes('"coldnew"') && dumpHealed.includes('"alphaTwo"') &&
        !dumpHealed.includes('storm.ts')
      gen += 1

      // ── (g) determinism: the incremental path may not drift ────────────────────────
      const dumpIncRepo = dump(F.repo)
      const rb = await handleBrainRebuild({ root: F.repo })
      const dumpFullRepo = dump(F.repo)
      const dumpIncFolder = dump(F.folder)
      const rbF = await handleBrainRebuild({ root: F.folder })
      const dumpFullFolder = dump(F.folder)
      const determinismOk =
        rb.ok && dumpFullRepo === dumpIncRepo && rb.generation === gen + 1 &&
        rb.cacheHits === rb.files && rb.cacheMisses === 0 && // every byte was already known
        rbF.ok && dumpFullFolder === dumpIncFolder

      // ── the meters: spawns follow moves; emissions follow drains ───────────────────
      const emitsPost = brainDebug().drainEmits()
      const drainsPost = (fresh(F.repo)?.drains ?? 0) + (fresh(F.folder)?.drains ?? 0)
      const metersOk = emitsOkPre && emitsPost === drainsPost && headDiffSpawnsForSmoke() === 3

      const pass =
        baseOk && freshOk && stormOk && deleteOk && commitQuietOk && sideOk && switchOk &&
        dirtyOk && sweepOk && healOk && determinismOk && metersOk
      result = {
        pass,
        baseOk,
        freshOk, freshMs: appeared.ms, budgetMs: 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS,
        stormOk, stormDrains,
        deleteOk,
        commitQuietOk, sideOk, sideGenDelta, switchOk,
        headStats: { headMoves: fresh(F.repo)?.headMoves ?? -1, diffSpawns: headDiffSpawnsForSmoke(), lastProcessed: fBack?.lastProcessed, lastCacheHits: fBack?.lastCacheHits },
        dirtyOk, sawDirtyMs: sawDirty.ms,
        sweepOk, sweeps: fresh(F.folder)?.sweeps ?? -1,
        healOk, heal: { reconciles: fHeal?.reconciles, lastProcessed: fHeal?.lastProcessed, lastRemoved: fHeal?.lastRemoved },
        determinismOk,
        metersOk, emitsPreCold, drainsPreCold, emitsPost, drainsPost,
        generations: { repo: statusOf(F.repo)?.generation, folder: statusOf(F.folder)?.generation },
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* a live shell may hold the cwd — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BRAIN_DRAIN_QUIET_MS } from '@backend/features/brain'
import { brainDebug, handleBrainEnsureBuilt, handleBrainStatus } from '../brain'
import type { BrainStatus } from '@contracts'

// Env-gated build-on-open smoke (MOGGING_BRAINOPEN, ADR 0018 — self-build) — the bug
// this pack exists to kill: a project must index ITSELF when a door opens it, never
// only on a Rebuild click. WINDOWED (the tick source is bound only after boot, and the
// attach bite reads it) but paneless — the doors are exercised through the exact
// `brain:ensureBuilt` seam, and the freshness the empty-partition bite observes rides
// the same git tick the app already pays for (subscribeTick keeps the poll alive, so a
// subscribed empty repo genuinely ticks). Asserts:
//   (1) neverBuilt — a fresh repo reports `built:false`, zero files, generation 1 (the
//       seed): `built` tells "never indexed" from "indexed, genuinely empty", which
//       `generation` cannot (it seeds at 1);
//   (2) buildOnOpen — ONE ensureBuilt on a never-built repo builds it: `built:true`,
//       nodes > 0, generation moved to 2 — the door does what the click used to;
//   (3) idempotent — a second ensureBuilt is a NO-OP: generation stays 2 (open must not
//       mean rebuild-every-time);
//   (4) builtEmpty — a repo with NO indexable source builds to `built:true` with zero
//       files (the marker is the build, not the row count);
//   (5) emptyFollowed — that built-but-empty repo is FOLLOWED by freshness (a non-null
//       stats handle): the attachRoot fix — an empty partition used to be dropped, so
//       its first file stayed invisible forever;
//   (6) emptyPicksUpFirstFile (the gold bite) — a source file added to that empty repo
//       becomes queryable within ≤ 2 ticks and the generation moves by one: the empty
//       root really absorbs its first file, the exact "silent forever" bug, reproduced
//       and guarded.
// Verdict: out/brainopen-result.json.

const TICK_MS = 2500

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface Fixture {
  base: string
  /** A git repo with ONE indexable source file — the never-built → built path. */
  repoSrc: string
  /** A git repo with NO indexable source (a readme only) — the empty-partition path. */
  repoEmpty: string
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  // autocrlf OFF: byte identity across a checkout is load-bearing on Windows.
  git(dir, ['config', 'core.autocrlf', 'false'])
  git(dir, ['config', 'user.email', 'smoke@mogging.test'])
  git(dir, ['config', 'user.name', 'Mogging Smoke'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
}

function makeFixture(): Fixture {
  // realpathSync.native: CI temp dirs are aliases (8.3 short names, /var symlinks) and
  // the resolver keys off git's own canonical answer — the boardv2/FILESMILESTONE lesson.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainopen-')))

  const repoSrc = join(base, 'src')
  initRepo(repoSrc)
  writeFileSync(join(repoSrc, 'alpha.ts'), 'export function alpha(): number {\n  return 1\n}\n')
  git(repoSrc, ['add', '-A'])
  git(repoSrc, ['commit', '-m', 'fixture'])

  const repoEmpty = join(base, 'empty')
  initRepo(repoEmpty)
  // readme.txt has no routable extension (the grammar roster has no .txt) — the repo is a
  // real, committed, git-tracked project that simply holds nothing the brain can index.
  writeFileSync(join(repoEmpty, 'readme.txt'), 'nothing to index here\n')
  git(repoEmpty, ['add', '-A'])
  git(repoEmpty, ['commit', '-m', 'fixture'])

  return { base, repoSrc, repoEmpty }
}

export function runBrainOpenSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainopen-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainopen smoke did not complete' })
    app.exit(1)
  }, 120000)

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** Every wait is a poll on observable state with an honest cap (the retry-loop rule). */
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
      const dump = (root: string): string => brainDebug().dump(root) ?? ''
      const followed = (root: string): boolean => brainDebug().freshness(root) !== null
      await sleep(1500) // let boot settle (registerBrain has bound the git tick by now)

      // ── (1) never built: `built` is false where `generation` cannot say so ─────────
      const s0 = statusOf(F.repoSrc)
      const neverBuiltOk = !!s0 && s0.built === false && s0.files === 0 && s0.generation === 1

      // ── (2) build-on-open: ONE door call builds a never-built project ──────────────
      const b1 = await handleBrainEnsureBuilt({ root: F.repoSrc })
      const buildOnOpenOk =
        b1.ok && b1.built === true && b1.nodes > 0 && b1.files >= 1 && b1.generation === 2 &&
        dump(F.repoSrc).includes('"alpha"')

      // ── (3) idempotent: a second call is a no-op — open never means rebuild ────────
      const b2 = await handleBrainEnsureBuilt({ root: F.repoSrc })
      const idempotentOk = b2.ok && b2.built === true && b2.generation === 2

      // ── (4) built-but-empty: a source-less repo still becomes `built:true` ─────────
      const e0 = statusOf(F.repoEmpty)
      const e1 = await handleBrainEnsureBuilt({ root: F.repoEmpty })
      const builtEmptyOk =
        !!e0 && e0.built === false &&
        e1.ok && e1.built === true && e1.files === 0 && e1.nodes === 0 && e1.generation === 2

      // ── (5) the attach fix: the empty partition is FOLLOWED, not dropped ───────────
      const emptyFollowedOk = followed(F.repoEmpty)

      // ── (6) gold: the empty repo absorbs its FIRST file within ≤ 2 ticks ───────────
      // An UNTRACKED source file is exactly what an agent writes. The porcelain tick lists
      // it (`--untracked-files=normal`), consider() routes it by extension, and the drain
      // lands it — the plain worktree-change path (no commit, so no head-move sequencing to
      // race). The follow the attach fix earned is what lets this land at all — an
      // unfollowed empty root would never see the file (the exact "silent forever" bug).
      writeFileSync(join(F.repoEmpty, 'first.ts'), 'export function firstfn(): number {\n  return 7\n}\n')
      const appeared = await until(
        () => {
          const s = statusOf(F.repoEmpty)
          return !!s && s.generation >= 3 && !s.dirty && !s.indexing && dump(F.repoEmpty).includes('"firstfn"')
        },
        3 * TICK_MS + BRAIN_DRAIN_QUIET_MS + 6000
      )
      const g6 = statusOf(F.repoEmpty)
      const firstFileOk =
        appeared.ok && g6?.generation === 3 && g6?.files === 1 && (g6?.nodes ?? 0) >= 1 &&
        dump(F.repoEmpty).includes('"firstfn"')

      const pass =
        neverBuiltOk && buildOnOpenOk && idempotentOk && builtEmptyOk && emptyFollowedOk && firstFileOk
      result = {
        pass,
        neverBuiltOk, buildOnOpenOk, idempotentOk, builtEmptyOk, emptyFollowedOk, firstFileOk,
        firstFileMs: appeared.ms, firstFileBudgetMs: 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS,
        src: s0 ? { built: s0.built, generation: s0.generation, files: s0.files } : null,
        afterBuild: b1.ok ? { built: b1.built, generation: b1.generation, nodes: b1.nodes } : { reason: b1.reason },
        empty: e1.ok ? { built: e1.built, generation: e1.generation, files: e1.files } : { reason: e1.reason },
        emptyFinal: g6 ? { generation: g6.generation, files: g6.files, nodes: g6.nodes } : null,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  const wc = win.webContents
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2000))
  else setTimeout(() => void run(), 2000)
}

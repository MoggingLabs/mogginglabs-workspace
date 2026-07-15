import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeGitFull } from '@backend/features/git'
import { gitCheckIgnoreSpawnsForSmoke } from '../git'
import { probeContrastAcrossThemes, type AaProbeResult } from './aa-probe'

// Env-gated git-decoration smoke (MOGGING_TREEGIT, Phase-11/05). The explorer answers "what
// did my agents touch" — and it must do so on the tick `git/probe.ts` ALREADY pays for.
// Zero network. Asserts:
//   (a) every state wears the right letter and ink (M/A/U/D/C), AA-measured across four
//       themes on plain, hover, AND selected fills (the real token fills, via aa-probe);
//   (b) folder colour PROPAGATES to visible ancestors — colour only, never a letter;
//   (c) touching a file flips its badge on the next tick; an UNTOUCHED repo emits ZERO
//       `git:filesChange` messages (change-only, so a wall of idle agents is silent);
//   (d) the Changes lens shows exactly the status list — count matches porcelain — and
//       leaving it restores the prior expansion exactly;
//   (e) ignore dimming costs ≤ 1 `check-ignore` spawn per dir, cached until invalidated;
//   (f) a NON-REPO folder produces zero git traffic and no lens chip;
//   (g) (the GIT gate, run separately) the per-pane chip is untouched.
// Verdict: out/treegit-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface Fixture {
  repo: string
  plain: string // a non-repo folder, for the dormancy arm
}

/** A repo wearing one of every state at once — the gallery's `makeRepo` recipe, dirtied. */
function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'mog-treegit-'))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'treegit@mogging.test'])
  git(repo, ['config', 'user.name', 'TreeGit'])
  git(repo, ['config', 'commit.gpgsign', 'false'])

  // Committed baseline: src/ holds the files we will then disturb.
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'src', 'deep'))
  writeFileSync(join(repo, 'src', 'edited.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'src', 'removed.ts'), 'export const b = 2\n')
  writeFileSync(join(repo, 'src', 'deep', 'nested-edit.ts'), 'export const c = 3\n')
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  writeFileSync(join(repo, '.gitignore'), 'build/\n*.log\n')
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'out.js'), 'ignored\n')
  writeFileSync(join(repo, 'noisy.log'), 'ignored\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'baseline'])

  // CONFLICTED FIRST, on a clean tree: a real merge conflict, made the honest way. It has to
  // come first because git refuses almost everything mid-merge — `stash pop` included ("Merging
  // is not possible because you have unmerged files"). Working-tree edits, however, are fine
  // DURING an unresolved merge, so every other state layers on top of it.
  git(repo, ['checkout', '-b', 'side'])
  writeFileSync(join(repo, 'src', 'clash.ts'), 'side\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'side'])
  git(repo, ['checkout', 'main'])
  writeFileSync(join(repo, 'src', 'clash.ts'), 'main\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'main'])
  try {
    git(repo, ['merge', 'side'])
  } catch {
    /* the conflict IS the point — merge exits non-zero, and that is the fixture working */
  }

  // …then one of every other state, on top of the unresolved merge.
  writeFileSync(join(repo, 'src', 'edited.ts'), 'export const a = 99\n') // MODIFIED
  writeFileSync(join(repo, 'src', 'deep', 'nested-edit.ts'), 'export const c = 99\n') // MODIFIED (deep — propagation)
  writeFileSync(join(repo, 'src', 'staged.ts'), 'export const s = 1\n')
  git(repo, ['add', join('src', 'staged.ts')]) // ADDED (adding a NEW file resolves nothing)
  unlinkSync(join(repo, 'src', 'removed.ts')) // DELETED
  writeFileSync(join(repo, 'src', 'brand-new.ts'), 'export const n = 1\n') // UNTRACKED

  const plain = join(base, 'plain') // no .git anywhere above it
  mkdirSync(plain)
  writeFileSync(join(plain, 'lonely.txt'), 'not a repo\n')
  return { repo, plain }
}

export function runTreeGitSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 300000) // safety net (a repo + four themes × three fills)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      // INSIDE the try: a fixture that cannot be built must report itself, not vanish into a
      // MISSING verdict that sends the next reader hunting a product bug.
      fx = makeFixture()
      await sleep(1500)
      // Ground truth, straight from the same porcelain the app reads.
      const truth = await probeGitFull(fx.repo, true)
      const truthFiles = truth.files ?? []

      await ES(`window.__mogging.workspace.create({ name: 'Repo', cwd: ${JSON.stringify(fx.repo)}, paneCount: 1 })`)
      await sleep(2500)
      await ES(`window.__mogging.workspace.create({ name: 'Plain', cwd: ${JSON.stringify(fx.plain)}, paneCount: 1 })`)
      await sleep(2500)
      await ES(`window.__mogging.workspace.switchByIndex(0)`)
      await sleep(800)

      await ES(`window.__mogging.explorer.toggle(true)`)
      await sleep(1200)
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(join(fx.repo, 'src'))})`)
      await sleep(1200)
      await ES(`window.__mogging.explorer.expand(${JSON.stringify(join(fx.repo, 'src', 'deep'))})`)
      await sleep(1500) // the first git tick + the check-ignore batches

      const seen = await ES<{ root: string; files: { path: string; state: string }[] }>(
        `(() => ({ root: window.__mogging.explorer.gitRoot(), files: window.__mogging.explorer.gitFiles() }))()`
      )
      // The renderer's list IS the porcelain list — same paths, same states, no invention.
      const filesMatch =
        seen.root === fx.repo &&
        JSON.stringify(seen.files.map((f) => `${f.state}:${f.path}`).sort()) ===
          JSON.stringify(truthFiles.map((f) => `${f.state}:${f.path}`).sort())

      // ── (a) letters + tones, per state ───────────────────────────────────────
      const D = (p: string): Promise<{ tone: string | null; letter: string | null; ignored: boolean; name: string } | null> =>
        ES(`window.__mogging.explorer.decorationOf(${JSON.stringify(p)})`)
      const modified = await D(join(fx.repo, 'src', 'edited.ts'))
      const added = await D(join(fx.repo, 'src', 'staged.ts'))
      const untracked = await D(join(fx.repo, 'src', 'brand-new.ts'))
      const conflicted = await D(join(fx.repo, 'src', 'clash.ts'))
      const clean = await D(join(fx.repo, 'README.md'))
      const lettersOk =
        modified?.letter === 'M' && modified.tone === 'modified' &&
        added?.letter === 'A' && added.tone === 'added' &&
        untracked?.letter === 'U' && untracked.tone === 'untracked' &&
        conflicted?.letter === 'C' && conflicted.tone === 'conflicted' &&
        clean?.letter === null && clean.tone === null // an untouched file wears NOTHING

      // Deleted: git reports it, and the row is gone from disk — so it decorates only if the
      // listing still carries it. Assert on the STATUS list instead of a row that cannot exist.
      const deletedKnown = seen.files.some((f) => f.state === 'deleted' && f.path === 'src/removed.ts')

      // ── (b) folder propagation: colour, never a letter ───────────────────────
      const srcDir = await D(join(fx.repo, 'src'))
      const deepDir = await D(join(fx.repo, 'src', 'deep'))
      const propagationOk =
        !!srcDir?.tone && srcDir.letter === null && // a folder takes the colour and NO letter
        deepDir?.tone === 'modified' && deepDir.letter === null && // …up from the nested edit
        srcDir.tone === 'conflicted' // …and the LOUDEST thing under src wins

      // ── (e) ignore dimming, and its spawn budget ─────────────────────────────
      const ignoredLog = await D(join(fx.repo, 'noisy.log'))
      const ignoredDir = await D(join(fx.repo, 'build'))
      const spawnsAfterFirst = gitCheckIgnoreSpawnsForSmoke()
      // Re-render + re-expand the SAME dirs: the cache must answer, not git.
      await ES(`window.__mogging.explorer.setExpanded(${JSON.stringify([join(fx.repo, 'src'), join(fx.repo, 'src', 'deep')])})`)
      await sleep(900)
      const spawnsAfterCached = gitCheckIgnoreSpawnsForSmoke()
      // 3 dirs are visible (root, src, src/deep) -> at most one spawn each, and ZERO on a re-ask.
      const ignoreOk =
        ignoredLog?.ignored === true &&
        ignoredDir?.ignored === true &&
        spawnsAfterFirst <= 3 &&
        spawnsAfterCached === spawnsAfterFirst

      // ── AA: every badge ink, four themes, three fills ────────────────────────
      // Tag one row per state, then measure the REAL token fills: plain, the hover fill
      // (--bg-elevated), and the selected wash (--accent-weak, an rgba the probe composites).
      await ES(`(() => {
        const tag = (path, cls) => {
          const row = [...document.querySelectorAll('.explorer-dock .ft-row')].find((r) => r.title === path)
          if (row) row.classList.add(cls)
        }
        tag(${JSON.stringify(join(fx.repo, 'src', 'edited.ts'))}, 'aa-m')
        tag(${JSON.stringify(join(fx.repo, 'src', 'staged.ts'))}, 'aa-a')
        tag(${JSON.stringify(join(fx.repo, 'src', 'brand-new.ts'))}, 'aa-u')
        tag(${JSON.stringify(join(fx.repo, 'src', 'clash.ts'))}, 'aa-c')
        tag(${JSON.stringify(join(fx.repo, 'noisy.log'))}, 'aa-i')
      })()`)
      const SELECTORS = [
        '.aa-m .ft-badge', '.aa-m .ft-name',
        '.aa-a .ft-badge', '.aa-a .ft-name',
        '.aa-u .ft-badge', '.aa-u .ft-name',
        '.aa-c .ft-badge', '.aa-c .ft-name',
        '.aa-i .ft-name'
      ]
      const aa: Record<string, AaProbeResult> = {}
      for (const fill of ['plain', 'hover', 'selected'] as const) {
        await ES(`(() => {
          for (const r of document.querySelectorAll('.explorer-dock .ft-row')) {
            r.classList.remove('is-selected')
            r.style.background = ''
          }
          if (${JSON.stringify(fill)} === 'hover') {
            for (const r of document.querySelectorAll('.aa-m, .aa-a, .aa-u, .aa-c, .aa-i')) r.style.background = 'var(--bg-elevated)'
          } else if (${JSON.stringify(fill)} === 'selected') {
            for (const r of document.querySelectorAll('.aa-m, .aa-a, .aa-u, .aa-c, .aa-i')) r.classList.add('is-selected')
          }
        })()`)
        aa[fill] = await probeContrastAcrossThemes({ es: ES, sleep, selectors: SELECTORS, settleMs: 220 })
      }
      await ES(`(() => {
        for (const r of document.querySelectorAll('.explorer-dock .ft-row')) { r.classList.remove('is-selected'); r.style.background = '' }
      })()`)
      const aaFailures = Object.entries(aa).flatMap(([fill, r]) => r.failures.map((f) => `${fill}: ${f}`))
      const aaMissing = Object.entries(aa).flatMap(([fill, r]) => r.missing.map((m) => `${fill}: ${m}`))
      const aaOk = aaFailures.length === 0 && aaMissing.length === 0

      // ── (d) the Changes lens ─────────────────────────────────────────────────
      const beforeLens = await ES<string[]>(`window.__mogging.explorer.expandedDirs()`)
      const chipCount = await ES<number>(`window.__mogging.explorer.lensCount()`)
      await ES(`window.__mogging.explorer.setLens(true)`)
      await sleep(1000)
      const lensRows = await ES<string[]>(`window.__mogging.explorer.rowNames()`)
      // Exactly the changed files (that live under the root) plus their ancestor dirs — no
      // clean file survives the lens.
      const lensFileRows = lensRows.filter((n) => /\.(ts|md|log|js)$/.test(n))
      const expectedFiles = truthFiles
        .filter((f) => f.state !== 'deleted') // a deleted file has no row to show
        .map((f) => f.path.split('/').pop() ?? '')
      const lensShowsChanged =
        expectedFiles.every((n) => lensFileRows.includes(n)) &&
        lensFileRows.every((n) => expectedFiles.includes(n)) &&
        !lensRows.includes('README.md') // the clean file is gone
      await ES(`window.__mogging.explorer.setLens(false)`)
      await sleep(900)
      const afterLens = await ES<string[]>(`window.__mogging.explorer.expandedDirs()`)
      const lensOk =
        chipCount === truthFiles.length &&
        lensShowsChanged &&
        JSON.stringify(afterLens.slice().sort()) === JSON.stringify(beforeLens.slice().sort()) // restored EXACTLY

      // ── (c) an idle repo is silent; a touched file flips on the next tick ────
      await ES(`window.__mogging.explorer.resetGitEvents()`)
      await sleep(6000) // >2 full 2.5s ticks with NOTHING changing
      const idleEvents = await ES<number>(`window.__mogging.explorer.gitEvents()`)

      writeFileSync(join(fx.repo, 'README.md'), '# repo, touched by an agent\n')
      let flippedMs = -1
      const t0 = Date.now()
      for (let i = 0; i < 40; i++) {
        await sleep(300)
        const d = await D(join(fx.repo, 'README.md'))
        if (d?.letter === 'M') {
          flippedMs = Date.now() - t0
          break
        }
      }
      const liveOk = idleEvents === 0 && flippedMs >= 0 && flippedMs <= 6000

      // ── (f) a NON-REPO folder: no chip, no traffic ───────────────────────────
      const spawnsBeforePlain = gitCheckIgnoreSpawnsForSmoke()
      await ES(`window.__mogging.explorer.resetGitEvents()`)
      await ES(`window.__mogging.workspace.switchByIndex(1)`) // the plain folder
      await sleep(4000) // more than a tick
      const plainState = await ES<{ root: string; chip: boolean; events: number }>(
        `(() => ({ root: window.__mogging.explorer.gitRoot(), chip: window.__mogging.explorer.lensVisible(), events: window.__mogging.explorer.gitEvents() }))()`
      )
      const dormantOk =
        plainState.root === '' && !plainState.chip && plainState.events === 0 &&
        gitCheckIgnoreSpawnsForSmoke() === spawnsBeforePlain // not one check-ignore either

      const pass = filesMatch && lettersOk && deletedKnown && propagationOk && ignoreOk && aaOk && lensOk && liveOk && dormantOk
      result = {
        pass,
        filesMatch, truthCount: truthFiles.length, seenCount: seen.files.length,
        lettersOk, modified, added, untracked, conflicted, clean, deletedKnown,
        propagationOk, srcDir, deepDir,
        ignoreOk, ignoredLog, ignoredDir, spawnsAfterFirst, spawnsAfterCached,
        aaOk, aaFailures, aaMissing, aaWorst: Object.fromEntries(Object.entries(aa).map(([k, v]) => [k, v.worst])),
        lensOk, chipCount, lensRows, lensShowsChanged, beforeLens, afterLens,
        liveOk, idleEvents, flippedMs,
        dormantOk, plainState,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    try {
      if (fx) rmSync(join(fx.repo, '..'), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'treegit-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brainDbPath, BRAIN_OPEN_DB_CAP } from '@backend/features/brain'
import { foldProjectKey } from '@backend/features/workspace'
import { canonical, isUnder } from '@backend/platform/fs-paths'
import { brainBaseDir, brainDebug, handleBrainRebuild, handleBrainStatus } from '../brain'

// Env-gated brain-core smoke (MOGGING_BRAINCORE, ADR 0018 step 02) — WINDOWLESS,
// zero UI, zero network, no daemon, no parsing. Proves the lifecycle LAWS every
// later brain step consumes, through the exact validation seam `brain:status` /
// `brain:rebuild` bind. Fixture: a real git repo + a real linked worktree under
// `.mogging/worktrees/` + a plain folder. Asserts:
//   (a) identity — repo and worktree resolve to the SAME projectKey (the board-v2
//       rule, the extracted resolver); the folder gets its own; roots name both
//       checkouts of the repo project;
//   (b) status — zeroed counts (files/nodes/edges/languages), indexing false,
//       dirty false, and a REAL generation;
//   (c) custody — the db exists under userData, NOT under either root;
//   (d) refusals — missing path -> 'missing'; junk shapes, relative paths, and a
//       file root -> 'invalid'; never a throw;
//   (e) lifecycle — rebuild bumps the generation (visible from the WORKTREE root:
//       one project, one brain); dispose closes handles (the db file deletes
//       cleanly on win32 — an open handle would refuse); generation survives a
//       dispose/reopen; a DELETED db rebuilds from scratch (derived state);
//       the LRU caps open handles at BRAIN_OPEN_DB_CAP.
// (f) of the goal — BOARDV2 still green — is the sweep's job, not this file's.
// Verdict: out/braincore-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const reason = (r: unknown): string | null =>
  typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === false
    ? String((r as { reason?: unknown }).reason)
    : null

export async function runBrainCoreSmoke(): Promise<void> {
  const resultFile = join(app.getAppPath(), 'out', 'braincore-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit): a previous
  // pass already wrote its verdict — leave it alone. qa-smokes.sh removes the file
  // before each run; do the same for a manual run.
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
    write({ pass: false, error: 'TIMEOUT: braincore smoke did not complete' })
    app.exit(1)
  }, 60000)

  const scratch: string[] = []
  const tmp = (prefix: string): string => {
    // Canonical roots (realpathSync.native): the resolver keys projects off git's own
    // long-path answer — the boardv2 alias lesson (8.3 temp cwds on CI runners).
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    scratch.push(dir)
    return dir
  }
  const cleanup = (): void => {
    for (const dir of scratch) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  try {
    // The world: repoA (+ a real linked worktree under .mogging/worktrees/), folderB.
    const repoA = tmp('mog-brain-a-')
    git(repoA, ['init'])
    git(repoA, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(repoA, ['config', 'user.email', 'smoke@mogging.test'])
    git(repoA, ['config', 'user.name', 'Mogging Smoke'])
    git(repoA, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repoA, 'readme.txt'), 'a\n')
    git(repoA, ['add', '-A'])
    git(repoA, ['commit', '-m', 'init'])
    mkdirSync(join(repoA, '.mogging'), { recursive: true })
    writeFileSync(join(repoA, '.mogging', '.gitignore'), '*\n')
    const wtPath = join(repoA, '.mogging', 'worktrees', 'wt1')
    git(repoA, ['worktree', 'add', wtPath, '-b', 'mogging/wt1'])
    const folderB = tmp('mog-brain-b-')

    // ── (a) identity: repo == worktree, folder its own; roots name both checkouts ──
    const sRepo = handleBrainStatus({ root: repoA })
    const sWt = handleBrainStatus({ root: wtPath })
    const sB = handleBrainStatus({ root: folderB })
    const fold = foldProjectKey
    const identityOk =
      sRepo.ok && sWt.ok && sB.ok &&
      fold(sRepo.projectKey) === fold(repoA) &&
      fold(sWt.projectKey) === fold(sRepo.projectKey) &&
      fold(sB.projectKey) === fold(folderB) &&
      sRepo.roots.some((r) => fold(r) === fold(repoA)) &&
      sRepo.roots.some((r) => fold(r) === fold(wtPath)) &&
      sWt.roots.length === sRepo.roots.length &&
      sB.roots.length === 1

    // ── (b) zeroed counts + a real generation ─────────────────────────────────────
    const zeroedOk =
      sRepo.ok &&
      sRepo.files === 0 && sRepo.nodes === 0 && sRepo.edges === 0 &&
      sRepo.languages.length === 0 && sRepo.indexing === false && sRepo.dirty === false &&
      Number.isInteger(sRepo.generation) && sRepo.generation >= 1

    // ── (c) the db lives under userData, never under a root ───────────────────────
    const dbPath = sRepo.ok ? brainDbPath(brainBaseDir(), sRepo.projectKey) : ''
    // canonical() both sides: MOGGING_USERDATA arrives from the sweep's bash with
    // mixed separators, and getPath returns it RAW — join() already normalized dbPath.
    const custodyOk =
      !!dbPath &&
      existsSync(dbPath) &&
      isUnder(canonical(dbPath), canonical(app.getPath('userData'))) &&
      !isUnder(canonical(dbPath), repoA) &&
      !isUnder(canonical(dbPath), folderB)

    // ── (d) typed refusals — junk never throws ────────────────────────────────────
    const missing = handleBrainStatus({ root: join(folderB, 'nope') })
    const fileRoot = handleBrainStatus({ root: join(repoA, 'readme.txt') })
    const relative = handleBrainStatus({ root: join('not', 'absolute') })
    const junk = [null, undefined, {}, { root: 42 }, { root: '' }, 'junk', 7].map((j) =>
      handleBrainStatus(j)
    )
    const refusalsOk =
      reason(missing) === 'missing' &&
      reason(fileRoot) === 'invalid' &&
      reason(relative) === 'invalid' &&
      junk.every((r) => reason(r) === 'invalid')

    // ── (e) lifecycle: rebuild bumps; dispose closes; delete rebuilds; LRU caps ───
    const g1 = sRepo.ok ? sRepo.generation : -1
    const afterRebuild = await handleBrainRebuild({ root: repoA })
    const viaWorktree = handleBrainStatus({ root: wtPath })
    const rebuildOk =
      afterRebuild.ok && afterRebuild.generation === g1 + 1 &&
      viaWorktree.ok && viaWorktree.generation === g1 + 1 // one project, ONE brain

    brainDebug().dispose()
    const reopened = handleBrainStatus({ root: repoA })
    const persistOk = reopened.ok && reopened.generation === g1 + 1 // survived the close

    brainDebug().dispose()
    let deletableOk = false
    try {
      rmSync(dbPath) // an open handle refuses this on win32 — THE dispose proof
      deletableOk = !existsSync(dbPath)
    } catch {
      deletableOk = false
    }
    const reborn = handleBrainStatus({ root: repoA })
    const rebuildableOk = reborn.ok && reborn.generation === 1 // derived state, from nothing

    const extras = Array.from({ length: BRAIN_OPEN_DB_CAP + 1 }, (_v, i) => tmp(`mog-brain-l${i}-`))
    const lruAnswers = extras.map((dir) => handleBrainStatus({ root: dir }))
    const lruOk = lruAnswers.every((r) => r.ok) && brainDebug().openCount() === BRAIN_OPEN_DB_CAP

    const pass =
      identityOk && zeroedOk && custodyOk && refusalsOk &&
      rebuildOk && persistOk && deletableOk && rebuildableOk && lruOk
    write({
      pass,
      identityOk, zeroedOk, custodyOk, refusalsOk,
      rebuildOk, persistOk, deletableOk, rebuildableOk, lruOk,
      openCount: brainDebug().openCount(),
      projectKeyRepo: sRepo.ok ? sRepo.projectKey : reason(sRepo),
      projectKeyWt: sWt.ok ? sWt.projectKey : reason(sWt),
      projectKeyB: sB.ok ? sB.projectKey : reason(sB),
      roots: sRepo.ok ? sRepo.roots : [],
      dbPath,
      refusals: { missing: reason(missing), fileRoot: reason(fileRoot), relative: reason(relative), junk: junk.map(reason) },
      platform: process.platform
    })
    brainDebug().dispose()
    cleanup()
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    brainDebug().dispose()
    cleanup()
    app.exit(1)
  }
}

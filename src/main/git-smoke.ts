import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GitStatus } from '@contracts'

// Env-gated per-pane Git smoke (MOGGING_GIT). Gates the whole status contract end to end:
// mixed staged/unstaged/untracked counts, rendered dirty/clean labels, exact commit divergence
// against main, sub-poll metadata refresh latency, same-cwd branch switching, linked/unborn/
// detached/non-repo states, read-only queries, and canonical cwd retargeting. The pre-existing
// PTY OSC relay remains diagnostic for older surviving daemons. Repositories are real throwaways;
// renderer assertions read the public dev port and actual pane-header DOM.

const CLEAN_TIMEOUT = 20000
const DIRTY_TIMEOUT = 20000
const OSC_TIMEOUT = 2000
const STEP_MS = 100
const IMMEDIATE_MAX_MS = 2000

type SmokeGit = GitStatus

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  }).trim()
}

function changeDirectoryCommand(cwd: string): string {
  if (process.platform === 'win32') return `cd /d "${cwd.replace(/"/g, '""')}"`
  return `cd '${cwd.replace(/'/g, "'\\''")}'`
}

/** Create a deterministic repo with a real `main` base and a clean feature branch. */
function makeRepo(branch: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-git-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  if (branch !== 'main') git(repo, ['switch', '-c', branch])
  return repo
}

export function runGitSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net

  const writeResult = (value: Record<string, unknown>): void => {
    for (const path of [join(process.cwd(), 'out', 'git-result.json'), join(app.getPath('userData'), 'git-result.json')]) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(value, null, 2))
      } catch {
        /* try the other diagnostic location */
      }
    }
  }
  writeResult({ pass: false, phase: 'scheduled', cwd: process.cwd() })
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) writeResult({ pass: false, phase: 'did-fail-load', code, description, url })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    writeResult({ pass: false, phase: 'render-process-gone', ...details })
  })

  const exec = <T = unknown>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const readStatus = (paneId: number): Promise<SmokeGit | null> =>
    exec<SmokeGit | null>(`window.__mogging.git.status(${paneId})`)

  const pollStatus = async (
    paneId: number,
    pred: (s: SmokeGit | null) => boolean,
    timeoutMs: number
  ): Promise<SmokeGit | null> => {
    const start = Date.now()
    let last: SmokeGit | null = null
    while (Date.now() - start < timeoutMs) {
      last = await readStatus(paneId)
      if (pred(last)) return last
      await sleep(STEP_MS)
    }
    return last
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo('mogging-test')
      const repo2 = makeRepo('osc-branch') // OSC 7 will retarget the pane's chip to this repo
      const nonRepo = mkdtempSync(join(tmpdir(), 'mogging-nogit-'))
      const linkedParent = mkdtempSync(join(tmpdir(), 'mogging-linked-parent-'))
      const linkedRepo = join(linkedParent, 'linked-status')
      git(repo, ['worktree', 'add', '-b', 'linked-status', linkedRepo, 'main'])
      const linkedGitDir = git(linkedRepo, ['rev-parse', '--absolute-git-dir'])
      writeFileSync(join(linkedGitDir, 'mogging-base'), 'deleted-base\n')
      const unbornRepo = mkdtempSync(join(tmpdir(), 'mogging-unborn-'))
      git(unbornRepo, ['init'])
      git(unbornRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

      // Open a workspace pointed at the repo; derive its first pane id from the ordinal.
      const opened = await exec<{ ordinal: number; cwd: string }>(
        `(() => { const ws = window.__mogging.workspace.openForCwd(${JSON.stringify(repo)}); ` +
          `return { ordinal: ws.ordinal, cwd: ws.cwd }; })()`
      )
      const paneId = opened.ordinal * 100 + 1

      // 1) Repo resolves to the right branch, initially clean.
      const clean = await pollStatus(
        paneId,
        (s) =>
          !!s &&
          s.available &&
          !s.dirty &&
          s.branch === 'mogging-test' &&
          s.baseBranch === 'main' &&
          s.baseAhead === 0 &&
          s.baseBehind === 0,
        CLEAN_TIMEOUT
      )

      // 2) Mixed working state: one tracked edit, one staged+then-edited file, one untracked.
      appendFileSync(join(repo, 'README.md'), 'a local uncommitted edit\n')
      writeFileSync(join(repo, 'staged.txt'), 'staged version\n')
      git(repo, ['add', 'staged.txt'])
      appendFileSync(join(repo, 'staged.txt'), 'working version\n')
      writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
      const dirty = await pollStatus(
        paneId,
        (s) =>
          !!s &&
          s.dirty &&
          s.changed === 3 &&
          s.staged === 1 &&
          s.unstaged === 2 &&
          s.untracked === 1 &&
          s.conflicted === 0,
        DIRTY_TIMEOUT
      )

      // 2b) The user-facing DoD: the pane's .pane-git CHIP (not just the port) renders the branch
      //     and the dirty dot. Read the actual DOM in the pane's slot.
      const dirtyChip = await exec<{ text: string; title: string; hasGit: boolean; dirty: boolean } | null>(
        `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-git');` +
          `return el?{text:(el.textContent||''),title:(el.getAttribute('title')||''),hasGit:el.classList.contains('has-git'),` +
          `dirty:el.classList.contains('dirty')}:null;})()`
      )

      // 3) A non-repo cwd -> null (nothing shown, no error).
      // Commit twice. Metadata watches must beat the 2.5s fallback and report the exact
      // number of commits made against main, even though this branch has no upstream.
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-m', 'agent commit one'])
      const firstCommitAt = Date.now()
      const committedOne = await pollStatus(
        paneId,
        (s) => !!s && !s.dirty && s.baseBranch === 'main' && s.baseAhead === 1,
        CLEAN_TIMEOUT
      )
      const firstCommitLatencyMs = Date.now() - firstCommitAt

      writeFileSync(join(repo, 'second.txt'), 'second commit\n')
      git(repo, ['add', 'second.txt'])
      git(repo, ['commit', '-m', 'agent commit two'])
      const secondCommitAt = Date.now()
      const committedTwo = await pollStatus(
        paneId,
        (s) => !!s && !s.dirty && s.baseAhead === 2,
        CLEAN_TIMEOUT
      )
      const secondCommitLatencyMs = Date.now() - secondCommitAt

      // Advance main independently so ahead and behind are both meaningful.
      const mainHead = git(repo, ['rev-parse', 'main'])
      const mainTree = git(repo, ['rev-parse', 'main^{tree}'])
      const advancedMain = git(repo, ['commit-tree', mainTree, '-p', mainHead, '-m', 'main advanced'])
      git(repo, ['update-ref', 'refs/heads/main', advancedMain, mainHead])
      const baseMoveAt = Date.now()
      const diverged = await pollStatus(
        paneId,
        (s) => !!s && s.baseAhead === 2 && s.baseBehind === 1,
        CLEAN_TIMEOUT
      )
      const baseMoveLatencyMs = Date.now() - baseMoveAt

      // Same-directory branch switch: no cwd event and no provider hook is involved.
      git(repo, ['switch', '-c', 'instant-branch'])
      const branchSwitchAt = Date.now()
      const switched = await pollStatus(paneId, (s) => !!s && s.branch === 'instant-branch', CLEAN_TIMEOUT)
      const branchSwitchLatencyMs = Date.now() - branchSwitchAt
      const cleanChip = await exec<{ text: string; title: string } | null>(
        `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-git');` +
          `return el?{text:(el.textContent||''),title:(el.getAttribute('title')||'')}:null;})()`
      )

      // Linked, unborn, detached, and non-repository states stay explicit.
      const linked = await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(linkedRepo)})`)
      const unborn = await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(unbornRepo)})`)
      git(linkedRepo, ['switch', '--detach'])
      const detached = await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(linkedRepo)})`)
      git(linkedRepo, ['switch', 'linked-status'])
      const none = await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(nonRepo)})`)

      // Read-only observation: explicit status queries do not move HEAD.
      const headBeforeQuery = git(repo, ['rev-parse', 'HEAD'])
      await exec<SmokeGit | null>(`window.__mogging.git.query(${JSON.stringify(repo)})`)
      const headAfterQuery = git(repo, ['rev-parse', 'HEAD'])
      const branchAfter = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])

      // Cwd refinement is gated too: the pane must retire instant-branch and retarget to repo2.
      const repo2uri = 'file://host/' + repo2.replace(/\\/g, '/') // OSC 7 wants forward slashes
      const oscEmit =
        `node -e "process.stdout.write(String.fromCharCode(27)+']7;${repo2uri}'+String.fromCharCode(7))"\r`
      const oscAt = Date.now()
      await exec(
        `(()=>{window.bridge.send("terminal:write",{id:${paneId},data:${JSON.stringify(oscEmit)}});return true})()`
      )
      const retarget = await pollStatus(paneId, (s) => !!s && s.branch === 'osc-branch', OSC_TIMEOUT)
      const oscRetargeted = !!retarget && retarget.branch === 'osc-branch'
      const oscLatencyMs = Date.now() - oscAt

      // The canonical cwd path used by every standard and custom CLI: launch a harmless custom
      // command through the shared launcher and prove the old branch retires synchronously before
      // the replacement probe lands. OSC remains a separate daemon diagnostic.
      const directRetargetAt = Date.now()
      const staleRetiredImmediately = await exec<boolean>(
        `(async()=>{await window.__mogging.agents.launchIn(${paneId},${JSON.stringify(`custom:${changeDirectoryCommand(linkedRepo)}`)},${JSON.stringify(linkedRepo)});` +
          `return window.__mogging.git.status(${paneId})===null})()`
      )
      const directRetarget = await pollStatus(
        paneId,
        (s) => !!s && s.branch === 'linked-status' && s.linkedWorktree,
        CLEAN_TIMEOUT
      )
      const directRetargetLatencyMs = Date.now() - directRetargetAt
      const directChip = await exec<{ text: string; title: string } | null>(
        `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-git');` +
          `return el?{text:(el.textContent||''),title:(el.getAttribute('title')||'')}:null;})()`
      )

      const pass =
        !!clean &&
        clean.available === true &&
        clean.branch === 'mogging-test' &&
        clean.detached === false &&
        clean.dirty === false &&
        clean.changed === 0 &&
        clean.baseBranch === 'main' &&
        !!dirty &&
        dirty.dirty === true &&
        dirty.branch === 'mogging-test' &&
        dirty.changed === 3 &&
        dirty.staged === 1 &&
        dirty.unstaged === 2 &&
        dirty.untracked === 1 &&
        !!dirtyChip &&
        dirtyChip.hasGit === true &&
        dirtyChip.text.includes('mogging-test') &&
        dirtyChip.text.includes('3 uncommitted') &&
        dirtyChip.text.includes('1 staged') &&
        dirtyChip.title.includes('Working tree: dirty') &&
        dirtyChip.dirty === true &&
        !!committedOne &&
        committedOne.baseAhead === 1 &&
        firstCommitLatencyMs < IMMEDIATE_MAX_MS &&
        !!committedTwo &&
        committedTwo.baseAhead === 2 &&
        secondCommitLatencyMs < IMMEDIATE_MAX_MS &&
        !!diverged &&
        diverged.baseAhead === 2 &&
        diverged.baseBehind === 1 &&
        baseMoveLatencyMs < IMMEDIATE_MAX_MS &&
        !!switched &&
        switched.branch === 'instant-branch' &&
        branchSwitchLatencyMs < IMMEDIATE_MAX_MS &&
        !!cleanChip &&
        cleanChip.text.includes('instant-branch') &&
        cleanChip.text.includes('clean') &&
        cleanChip.text.includes('↑2') &&
        cleanChip.text.includes('↓1') &&
        cleanChip.text.includes('main') &&
        !!linked &&
        linked.linkedWorktree === true &&
        linked.branch === 'linked-status' &&
        linked.baseBranch === 'main' &&
        !!unborn &&
        unborn.available === true &&
        unborn.head === null &&
        unborn.branch === 'main' &&
        !!detached &&
        detached.linkedWorktree === true &&
        detached.detached === true &&
        detached.head !== null &&
        none === null &&
        headBeforeQuery === headAfterQuery &&
        branchAfter === 'instant-branch' &&
        !!directRetarget &&
        staleRetiredImmediately &&
        directRetarget.branch === 'linked-status' &&
        directRetarget.linkedWorktree === true &&
        directRetargetLatencyMs < IMMEDIATE_MAX_MS &&
        !!directChip &&
        directChip.text.includes('linked-status') &&
        directChip.title.includes('(linked)')

      await exec(`(()=>{window.bridge.send("git:unwatch",{paneId:${paneId}});return true})()`)
      await sleep(100)
      result = {
        pass,
        paneId,
        clean,
        dirty,
        dirtyChip,
        committedOne,
        committedTwo,
        diverged,
        switched,
        cleanChip,
        linked,
        unborn,
        detached,
        none,
        firstCommitLatencyMs,
        secondCommitLatencyMs,
        baseMoveLatencyMs,
        branchSwitchLatencyMs,
        headBeforeQuery,
        headAfterQuery,
        branchAfter,
        oscRetargeted,
        oscLatencyMs,
        retarget,
        directRetarget,
        staleRetiredImmediately,
        directRetargetLatencyMs,
        directChip
      }
      for (const d of [
        linkedParent,
        repo,
        repo2,
        nonRepo,
        unbornRepo
      ]) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    writeResult(result)
    app.exit(result.pass ? 0 : 1)
  }

  let started = false
  const start = (): void => {
    if (started) return
    started = true
    setTimeout(run, 3000)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', start)
    setTimeout(start, 15000) // diagnostic fallback: run records executeJavaScript/load failures
  } else {
    start()
  }
}

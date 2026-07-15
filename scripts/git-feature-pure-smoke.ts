import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitStatus } from '@contracts'
import { GitContextObserver, PaneCwdState, fileUriToPath, normalizePaneCwd } from '@backend/features/agent-state'
import { GitMonitor, probeGitFull, type GitProbeResult } from '@backend/features/git'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  }).trim()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pred()) return true
    await delay(25)
  }
  return pred()
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

function makeRepo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mogging-git-pure-'))
  git(root, ['init', '-q'])
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(root, ['config', 'user.email', 'pure-smoke@mogging.test'])
  git(root, ['config', 'user.name', 'Git Pure Smoke'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-q', '-m', 'base'])
  if (branch !== 'main') git(root, ['switch', '-q', '-c', branch])
  return root
}

async function main(): Promise<void> {
  const cleanup: string[] = []
  const monitors: GitMonitor[] = []
  const contextObservers: GitContextObserver[] = []
  const result: Record<string, unknown> = { pass: false }
  try {
    process.stderr.write('git-pure: base cache\n')
    const baseRepo = makeRepo('main')
    const linkedParent = mkdtempSync(join(tmpdir(), 'mogging-git-pure-linked-'))
    const repo = join(linkedParent, 'agent-work')
    cleanup.push(linkedParent, baseRepo)
    git(baseRepo, ['branch', 'feature/nested-base', 'main'])
    git(baseRepo, ['worktree', 'add', '-q', '-b', 'agent/nested-work', repo, 'main'])
    const gitDir = git(repo, ['rev-parse', '--absolute-git-dir'])
    writeFileSync(join(gitDir, 'mogging-base'), 'feature/nested-base\n')
    writeFileSync(join(repo, 'agent.txt'), 'agent work\n')
    git(repo, ['add', 'agent.txt'])
    git(repo, ['commit', '-q', '-m', 'agent work'])

    // Boxed rather than a bare `let`: TS never sees a closure assignment (#9998), so a
    // bare binding stays narrowed to its `null` initializer at every read below.
    const seen: { status: GitStatus | null } = { status: null }
    const watched = (): GitStatus | null => seen.status
    const monitor = new GitMonitor({ change: (_id, status) => (seen.status = status) }, 60_000)
    monitors.push(monitor)
    await monitor.setCwd(101, repo)
    await waitUntil(() => watched() != null)
    assert(
      watched()?.baseBranch === 'feature/nested-base',
      `managed nested base was not selected: ${JSON.stringify(watched())}`
    )
    assert(watched()?.baseAhead === 1 && watched()?.baseBehind === 0, 'initial managed-base divergence is wrong')

    const baseHead = git(repo, ['rev-parse', 'refs/heads/feature/nested-base'])
    const baseTree = git(repo, ['rev-parse', 'refs/heads/feature/nested-base^{tree}'])
    const advanced = git(repo, ['commit-tree', baseTree, '-p', baseHead, '-m', 'advance nested base'])
    git(repo, ['update-ref', 'refs/heads/feature/nested-base', advanced, baseHead])

    const freshAfterRefMove = (await probeGitFull(repo)).status
    assert(
      freshAfterRefMove?.baseAhead === 1 && freshAfterRefMove.baseBehind === 1,
      'one-shot probe served stale divergence after a nested base ref moved'
    )
    assert(
      await waitUntil(() => watched()?.baseBranch === 'feature/nested-base' && watched()?.baseBehind === 1),
      'nested base ref watcher did not invalidate cached divergence'
    )

    writeFileSync(join(gitDir, 'mogging-base'), 'main\n')
    const freshAfterManagedChange = (await probeGitFull(repo)).status
    assert(
      freshAfterManagedChange?.baseBranch === 'main' && freshAfterManagedChange.baseBehind === 0,
      'one-shot probe served the previous mogging-base value'
    )
    assert(
      await waitUntil(() => watched()?.baseBranch === 'main' && watched()?.baseBehind === 0),
      'mogging-base watcher did not clear both divergence caches'
    )
    monitor.dispose()

    process.stderr.write('git-pure: paths and invalid layouts\n')
    const whitespaceRepo = makeRepo('main')
    cleanup.push(whitespaceRepo)
    writeFileSync(join(whitespaceRepo, ' leading-space.txt'), 'legal path\n')
    const whitespace = await probeGitFull(whitespaceRepo, true)
    assert(
      whitespace.files?.some((file) => file.path === ' leading-space.txt' && file.state === 'untracked'),
      'Git pathname whitespace was trimmed'
    )

    const invalid = mkdtempSync(join(tmpdir(), 'mogging-invalid-git-'))
    cleanup.push(invalid)
    mkdirSync(join(invalid, '.git'))
    const stale = mkdtempSync(join(tmpdir(), 'mogging-stale-git-'))
    cleanup.push(stale)
    writeFileSync(join(stale, '.git'), 'gitdir: missing-admin-dir\n')
    assert((await probeGitFull(invalid)).status === null, 'invalid .git directory produced a chip')
    assert((await probeGitFull(stale)).status === null, 'stale .git pointer produced a chip')
    const nestedInvalid = join(whitespaceRepo, 'fixture-with-dummy-git')
    mkdirSync(join(nestedInvalid, '.git'), { recursive: true })
    assert(
      (await probeGitFull(nestedInvalid)).status?.root === whitespaceRepo,
      'invalid nested .git entry hid the valid parent repository'
    )

    const physicalChild = join(whitespaceRepo, 'physical-child', 'deep')
    mkdirSync(physicalChild, { recursive: true })
    const linkParent = mkdtempSync(join(tmpdir(), 'mogging-git-link-'))
    cleanup.push(linkParent)
    const linkedChild = join(linkParent, 'linked-child')
    let directoryLinkSupported = true
    try {
      symlinkSync(
        join(whitespaceRepo, 'physical-child'),
        linkedChild,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') directoryLinkSupported = false
      else throw error
    }
    if (directoryLinkSupported) {
      assert(
        (await probeGitFull(join(linkedChild, 'deep'))).status?.root === whitespaceRepo,
        'repo discovery followed a directory link lexically instead of physically'
      )
    }

    process.stderr.write('git-pure: OSC cwd locality\n')
    const localHost = hostname()
    const uriPath = process.platform === 'win32' ? '/C:/Users/mogging' : '/tmp/mogging'
    const expectedPath = process.platform === 'win32' ? 'C:/Users/mogging' : '/tmp/mogging'
    assert(fileUriToPath(`file://${localHost}${uriPath}`) === expectedPath, 'local OSC 7 host was rejected')
    assert(fileUriToPath(`file://localhost${uriPath}`) === expectedPath, 'localhost OSC 7 was rejected')
    assert(fileUriToPath(`file://${uriPath}`) === expectedPath, 'authority-free OSC 7 was rejected')
    assert(
      fileUriToPath(`file://foreign-${localHost}${uriPath}`) === null,
      'foreign OSC 7 authority was accepted as a local cwd'
    )
    assert(fileUriToPath('file://unc-server/share/path') === null, 'UNC authority was accepted as local')
    assert(
      fileUriToPath(`file://localhost${uriPath}%20space`) === `${expectedPath} space`,
      'OSC 7 path was not decoded'
    )
    assert(fileUriToPath(`file://localhost${uriPath}%ZZ`) === null, 'malformed OSC 7 encoding was accepted')
    if (process.platform === 'win32') {
      const bareUnc = '\\\\server\\share\\path'
      assert(fileUriToPath(bareUnc) === bareUnc, 'bare OSC 9;9 UNC path was not preserved')
    }

    process.stderr.write('git-pure: provider-neutral Git context\n')
    const traceRoot = mkdtempSync(join(tmpdir(), 'mogging-git-context-'))
    cleanup.push(traceRoot)
    const traceFile = join(traceRoot, 'setup.trace')
    writeFileSync(traceFile, '', { mode: 0o600 })
    const contextState = new PaneCwdState(baseRepo, 'local')
    contextState.acceptShell(baseRepo, false)
    contextState.acceptCommandStart()
    const tracedWorktrees: string[] = []
    const contextObserver = new GitContextObserver(traceFile, (raw) => {
      const normalized = normalizePaneCwd(raw, { mustExist: true })
      if (!normalized) return
      tracedWorktrees.push(normalized)
      contextState.acceptWorktree(normalized)
    })
    contextObservers.push(contextObserver)
    execFileSync('git', ['-C', repo, 'status', '--short'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TRACE_SETUP: traceFile, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    contextObserver.drain()
    assert(await waitUntil(() => tracedWorktrees.length >= 1), 'GIT_TRACE_SETUP worktree was not observed')
    assert(contextState.current().cwd === normalizePaneCwd(repo, { mustExist: true }), 'Git worktree did not become active context')
    assert(contextState.current().source === 'process', 'Git worktree did not use the passive process lane')
    assert(!readFileSync(traceFile, 'utf8').includes('status --short'), 'Git setup trace retained argv')
    contextObserver.resetAtPrompt()
    const promptContext = contextState.acceptPrompt()
    assert(promptContext?.cwd === baseRepo && promptContext.source === 'shell', 'prompt did not retire Git worktree context')

    contextState.acceptCommandStart()
    execFileSync('git', ['-C', repo, 'status', '--short'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TRACE_SETUP: traceFile, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    contextObserver.drain()
    assert(await waitUntil(() => tracedWorktrees.length >= 2), 'same worktree was suppressed in a later command')
    assert(contextState.current().cwd === normalizePaneCwd(repo, { mustExist: true }), 'repeated Git worktree did not reactivate context')
    contextObserver.resetAtPrompt()
    contextState.acceptPrompt()
    assert(contextState.acceptWorktree(repo) === null, 'background Git worktree context was accepted without a command')

    const realStatus = (await probeGitFull(repo)).status
    assert(realStatus, 'fixture unexpectedly has no Git status')
    process.stderr.write('git-pure: pane generation\n')
    let oldResolve!: (value: GitProbeResult) => void
    let newResolve!: (value: GitProbeResult) => void
    let calls = 0
    const events: Array<GitStatus | null> = []
    const aba = new GitMonitor(
      { change: (_id, status) => events.push(status) },
      60_000,
      () =>
        new Promise<GitProbeResult>((resolve) => {
          if (calls++ === 0) oldResolve = resolve
          else newResolve = resolve
        })
    )
    monitors.push(aba)
    const predecessor = aba.setCwd(202, repo)
    assert(await waitUntil(() => calls === 1, 500), 'predecessor probe did not start')
    aba.remove(202)
    const successor = aba.setCwd(202, repo)
    assert(await waitUntil(() => calls === 2, 500), 'successor probe did not start')
    newResolve({ status: { ...realStatus, branch: 'successor' }, files: null, truncated: false })
    await successor
    oldResolve({ status: { ...realStatus, branch: 'predecessor' }, files: null, truncated: false })
    await predecessor
    const statuses = events.filter((status): status is GitStatus => status != null)
    assert(statuses[statuses.length - 1]?.branch === 'successor', 'late predecessor crossed pane-id reuse')
    aba.dispose()

    process.stderr.write('git-pure: concurrency\n')
    let active = 0
    let maxActive = 0
    const limited = new GitMonitor(
      { change: () => undefined },
      60_000,
      async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(40)
        active--
        return { status: realStatus, files: null, truncated: false }
      }
    )
    monitors.push(limited)
    await Promise.all(Array.from({ length: 8 }, (_, index) => limited.setCwd(300 + index, repo)))
    limited.dispose()
    assert(maxActive === 4, `probe concurrency was ${maxActive}, expected 4`)

    Object.assign(result, {
      pass: true,
      nestedBase: true,
      managedBaseInvalidation: true,
      whitespace: true,
      invalidGitHidden: true,
      physicalRepoDiscovery: directoryLinkSupported ? true : 'unsupported',
      oscCwdLocality: true,
      providerNeutralGitContext: true,
      paneAbaGuarded: true,
      maxActive
    })
  } finally {
    for (const monitor of monitors) monitor.dispose()
    for (const observer of contextObservers) observer.dispose()
    for (const root of cleanup) rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})

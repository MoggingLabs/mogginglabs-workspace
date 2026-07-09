import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated worktree-isolation smoke (MOGGING_WORKTREE, Phase-3/03):
//  1. throwaway repo -> open a workspace with TWO isolated agent slots (dev handle;
//     a `custom:` provider whose command writes the shell's LIVE branch into a file
//     at the shell's own cwd — no TUI launches, and the file is the testimony).
//  2. assert: two worktrees under <repo>/.mogging/worktrees, `git worktree list`
//     agrees, each pane's branch chip shows its own mogging/<slug> branch — AND each
//     pane's SHELL really runs inside its worktree. The chip reads the published
//     pane-cwd port, so it stays green even when the shell spawned somewhere else
//     entirely; only the shell can say where it is. (Regression 2026-07-09: the
//     GridLayout constructor applies a 1-pane grid, which spawned pane 1's PTY before
//     the controller published its cwd seed — slot 1's shell opened in $HOME while
//     its chip claimed mogging/<slug>. `custom:` providers launch verbatim, no
//     `cd` prefix, so they surface the true spawn cwd.)
//  3. removal is dirty-SAFE: a dirty worktree is refused, force removes it, a clean
//     one removes first try. Repo HEAD is byte-identical before/after everything.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-wt-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runWorktreeSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      await sleep(1500) // launcher-first boot settles

      // Open 2 isolated agent slots (1x2 grid) via the wizard's isolation path. The
      // custom command is each pane's testimony: it runs at the shell's real cwd.
      const provider = 'custom:git branch --show-current > branch.txt'
      const opened = (await ES(
        `window.__mogging.templates.openIsolated(${JSON.stringify(repo)}, [{provider:${JSON.stringify(provider)},count:2}])`
      )) as { paneCount: number; assignments: string[]; paneCwds: (string | null)[] }
      const paneCwds = (opened?.paneCwds ?? []).filter((p): p is string => !!p)
      const openedOk = opened?.paneCount === 2 && paneCwds.length === 2

      // Filesystem + git agree: two managed worktrees on mogging/ branches.
      const wtRoot = join(repo, '.mogging', 'worktrees')
      const dirs = existsSync(wtRoot) ? readdirSync(wtRoot) : []
      const porcelain = git(repo, ['worktree', 'list', '--porcelain'])
      // The CLAIM is "git lists a worktree at each pane's cwd"; the PROBE must
      // compare CANONICAL paths. windows-latest hands out TEMP in 8.3 short
      // form (C:\Users\RUNNER~1\...) so the pane cwd and git's long-form
      // porcelain paths never match textually (found by the 6/03 sweep, run
      // 28669886364). realpath expands the alias; slashes + case normalize for
      // NTFS's case-insensitivity (win32 only — POSIX compares exact).
      const norm = (s: string): string => {
        const t = s.replaceAll('\\', '/')
        return process.platform === 'win32' ? t.toLowerCase() : t
      }
      const canon = (p: string): string => {
        try {
          return norm(realpathSync.native(p))
        } catch {
          return norm(p)
        }
      }
      const porcelainNorm = norm(porcelain)
      // Either form may be the one git recorded (macOS: /var/... symlinks to
      // /private/var/... and realpath crosses that boundary) — accept both.
      const gitAgrees =
        dirs.length === 2 &&
        paneCwds.every((p) => porcelainNorm.includes(canon(p)) || porcelainNorm.includes(norm(p)))
      const branches = git(repo, ['branch', '--list', 'mogging/*'])
      const branchesOk = branches.split('\n').filter((b) => b.trim()).length === 2

      // Each pane's chip resolves ITS OWN mogging/<slug> branch (git port, polled).
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const chipBranch = async (id: number): Promise<string> =>
        String(
          await ES(
            `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${id}"] .pane-branch');return el?el.textContent:'';})()`
          )
        )
      let chip1 = ''
      let chip2 = ''
      for (let i = 0; i < 30; i++) {
        chip1 = await chipBranch(base + 1)
        chip2 = await chipBranch(base + 2)
        if (chip1.includes('mogging/') && chip2.includes('mogging/') && chip1 !== chip2) break
        await sleep(500)
      }
      const chipsOk = chip1.includes('mogging/') && chip2.includes('mogging/') && chip1 !== chip2

      // Each pane's shell wrote its live branch AT ITS OWN CWD (lineup launch). Both
      // files must land inside the worktrees and name two distinct mogging/ branches.
      // (PowerShell's `>` writes UTF-16LE — strip NULs before comparing.)
      let shellFiles: Record<string, string> = {}
      let shellsOk = false
      for (let i = 0; i < 60 && !shellsOk; i++) {
        await sleep(500)
        shellFiles = {}
        for (const p of paneCwds) {
          const f = join(p, 'branch.txt')
          if (existsSync(f)) shellFiles[p] = readFileSync(f, 'utf8').replace(/[\u0000\uFEFF]/g, '').trim()
        }
        const vals = Object.values(shellFiles)
        shellsOk = vals.length === 2 && vals.every((b) => b.startsWith('mogging/')) && new Set(vals).size === 2
      }
      // The testimony must not contaminate the dirty-safety phase below — an untracked
      // file reads as dirty, and worktree #2 is asserted clean-removable.
      for (const p of paneCwds) rmSync(join(p, 'branch.txt'), { force: true })

      // Removal safety — drive the real IPC from the renderer, like the pane menu does.
      const removeVia = (path: string, force: boolean): Promise<{ ok: boolean; reason?: string }> =>
        ES(
          `window.bridge.invoke('worktrees:remove', ${JSON.stringify({ repo, path, force })})`
        ) as Promise<{ ok: boolean; reason?: string }>
      writeFileSync(join(paneCwds[0], 'dirty.txt'), 'uncommitted\n')
      // The dirty REFUSAL is a git-level check (before any delete), so it holds
      // whether or not the pane is open.
      const dirtyRefused = await removeVia(paneCwds[0], false)
      // Windows refuses to delete a directory that is a live process's CWD — each
      // pane's own shell keeps ITS worktree open, so ANY delete (clean or forced)
      // hits "Permission denied" on windows-latest (never on POSIX, which unlinks
      // a busy dir). The real "remove worktree" UX closes the pane first; close
      // BOTH, then retry each delete while the OS releases the handles.
      await ES(`window.__mogging.layout.close(${base + 1})`)
      await ES(`window.__mogging.layout.close(${base + 2})`)
      const removeRetry = async (path: string, force: boolean): Promise<{ ok: boolean; reason?: string }> => {
        let r: { ok: boolean; reason?: string } = { ok: false, reason: 'not attempted' }
        for (let i = 0; i < 14; i++) {
          await sleep(500)
          r = await removeVia(path, force)
          if (r.ok) break
        }
        return r
      }
      const cleanRemoved = await removeRetry(paneCwds[1], false) // clean -> no force needed
      const forcedRemoved = await removeRetry(paneCwds[0], true)
      const removalOk =
        dirtyRefused.ok === false &&
        dirtyRefused.reason === 'dirty' &&
        cleanRemoved.ok === true &&
        forcedRemoved.ok === true

      // Read-only guarantee: the repo's HEAD/branch never moved.
      const headAfter = git(repo, ['rev-parse', 'HEAD'])
      const branchAfter = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const repoIntact = headBefore === headAfter && branchAfter === 'main'

      const pass = openedOk && gitAgrees && branchesOk && chipsOk && shellsOk && removalOk && repoIntact
      result = {
        pass,
        openedOk,
        gitAgrees,
        branchesOk,
        chipsOk,
        chip1,
        chip2,
        shellsOk,
        shellFiles,
        removalOk,
        dirtyRefused,
        cleanRemoved,
        forcedRemoved,
        repoIntact,
        dirs
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'worktree-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

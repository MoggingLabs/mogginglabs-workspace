import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'

// Env-gated reviewer-gate smoke (MOGGING_GATE, Phase-4/03). The DoD, asserted:
// an unapproved branch cannot merge through the app — not by click, not by CLI —
// except via the verbatim typed human override; role checks live at the daemon.
//   ungated refusal -> approve from a NON-reviewer pane (exit 6) -> role reviewer ->
//   approve (exit 0) -> merge lands -> approvals list it -> worktree removal clears
//   the sign-off -> second branch: wrong override word stays ungated, verbatim
//   'override' lands.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-gate-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'gated repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runGateSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) =>
          resolveCli({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      await sleep(1500)
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
      await sleep(3000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const asPane = (n: number): Record<string, string> => ({ MOGGING_PANE_ID: String(base + n) })

      // Branch 1: committed work in a worktree.
      const wt = await createWorktree(repo)
      if (!wt.ok || !wt.path || !wt.branch) throw new Error('worktree create failed')
      writeFileSync(join(wt.path, 'README.md'), 'gated repo\nagent line\n')
      git(wt.path, ['add', '-A'])
      git(wt.path, ['commit', '-m', 'gated work'])

      const mergeVia = (branch: string, override?: string): Promise<{ ok: boolean; state: string }> =>
        ES(
          `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, branch, override })})`
        ) as Promise<{ ok: boolean; state: string }>

      // 1) no sign-off, no override -> ungated (the lock works)
      const ungated = await mergeVia(wt.branch)

      // 2) a non-reviewer pane cannot approve (role-checked at the daemon)
      const notReviewer = await cli(['approve', wt.branch], asPane(1))

      // 3) the reviewer pane approves; the same merge now lands
      await cli(['role', String(base + 2), 'reviewer'])
      const approved = await cli(['approve', wt.branch], asPane(2))
      const approvalsList = JSON.parse((await cli(['approvals', '--json'])).stdout) as { branch: string }[]
      const merged = await mergeVia(wt.branch)

      // 4) removing the worktree clears its sign-off (approvals are for live work)
      await ES(`window.bridge.invoke('worktrees:remove', ${JSON.stringify({ repo, path: wt.path, force: true })})`)
      await sleep(800)
      const afterRemove = JSON.parse((await cli(['approvals', '--json'])).stdout) as { branch: string }[]
      const clearedOk = afterRemove.every((a) => a.branch !== wt.branch)

      // 5) branch 2, human path: the override word must be VERBATIM
      const wt2 = await createWorktree(repo)
      if (!wt2.ok || !wt2.path || !wt2.branch) throw new Error('worktree2 create failed')
      writeFileSync(join(wt2.path, 'human.txt'), 'human-landed\n')
      git(wt2.path, ['add', '-A'])
      git(wt2.path, ['commit', '-m', 'human work'])
      const wrongWord = await mergeVia(wt2.branch, 'Override')
      const overridden = await mergeVia(wt2.branch, 'override')

      const pass =
        ungated.ok === false &&
        ungated.state === 'ungated' &&
        notReviewer.code === 6 &&
        approved.code === 0 &&
        approvalsList.some((a) => a.branch === wt.branch) &&
        merged.ok === true &&
        merged.state === 'merged' &&
        clearedOk &&
        wrongWord.ok === false &&
        wrongWord.state === 'ungated' &&
        overridden.ok === true &&
        overridden.state === 'merged' &&
        git(repo, ['log', '--oneline', '-4']).includes('human work')
      result = {
        pass,
        ungated,
        notReviewerExit: notReviewer.code,
        approvedExit: approved.code,
        approvalsList,
        merged,
        clearedOk,
        wrongWord,
        overridden
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'gate-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

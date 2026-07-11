import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { INHERITED_PANE_ENV, scrubInheritedPaneEnv } from './pane-env'

// Env-gated reviewer-gate smoke (MOGGING_GATE, Phase-4/03). The DoD, asserted:
// an unapproved branch cannot merge through the app — not by click, not by CLI —
// except via the verbatim typed human override.
//   ungated refusal -> approve from a NON-reviewer pane (exit 6) -> the USER names a
//   reviewer -> approve (exit 0) -> merge lands -> approvals list it -> worktree removal
//   clears the sign-off -> second branch: wrong override word stays ungated, verbatim
//   'override' lands.
//
// WHO may sign off is the app's answer, not the daemon's. This smoke used to make its
// reviewer with `mogging role <pane> reviewer` and merge on the strength of it — which is
// precisely the forgery: `set-role` is open to every pane, so a worker agent could promote
// ITSELF and land its own unreviewed branch with two CLI calls. The role now comes from the
// workspace manifest (the user's UI), and step 2b asserts the attack is inert: a pane that
// self-promotes through the CLI still cannot open the gate.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/**
 * The CLI calls below are only worth anything if they reach THIS app's daemon. They did not:
 * an app launched from inside a MoggingLabs pane inherited that pane's MOGGING_PANE_ID and
 * MOGGING_DAEMON_ENDPOINT and passed both to every `mogging` it spawned, and `mogging` prefers
 * that endpoint over the runtime dir — so every call here went to the USER'S LIVE DAEMON, past
 * MOGGING_USERDATA and LOCALAPPDATA isolation, and answered `nopane` about someone else's
 * panes. A colliding pane id would have had `role`/`approve`/`kill` mutating a real session.
 * main scrubs it now (pane-env.ts); this asserts BOTH halves, because the live half is silent
 * on a machine that never leaks (CI) and the pure half is silent about the wiring.
 */
function checkPaneEnvIsolation(): { pass: boolean; detail: Record<string, unknown> } {
  // Pure: the rule drops exactly the pane identity, and nothing else. MOGGING_GATE and
  // MOGGING_USERDATA are OURS — the app's own launch flags — and must survive.
  const fake: Record<string, string | undefined> = {
    MOGGING_PANE_ID: '3',
    MOGGING_DAEMON_ENDPOINT: 'C:/host/endpoint.json',
    MOGGING_BROWSER_ENDPOINT: 'C:/host/browser.json',
    MOGGING_GATE: '1',
    MOGGING_USERDATA: 'C:/iso/userdata',
    PATH: 'keep me'
  }
  const dropped = scrubInheritedPaneEnv(fake)
  const pureOk =
    dropped.length === 3 &&
    INHERITED_PANE_ENV.every((n) => fake[n] === undefined) &&
    fake.MOGGING_GATE === '1' &&
    fake.MOGGING_USERDATA === 'C:/iso/userdata' &&
    fake.PATH === 'keep me'
  // Live: whatever this app was launched from, it is not wearing a pane's name NOW — so the
  // CLI children it spawns discover the daemon through the isolated runtime dir, like they must.
  const liveOk = INHERITED_PANE_ENV.every((n) => process.env[n] === undefined)
  return { pass: pureOk && liveOk, detail: { pureOk, liveOk, dropped } }
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
      await ES(`window.__mogging.templates.open([{provider:'shell',count:3}])`)
      await sleep(3000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const asPane = (n: number): Record<string, string> => ({ MOGGING_PANE_ID: String(base + n) })

      // The USER names the reviewer. This is the ONE channel that confers sign-off authority:
      // setPaneRole -> the terminal:setRole ipcMain message, sent by the renderer. A pane is a
      // PTY child that speaks the daemon protocol and nothing else — it has no IPC, so it can
      // never send this. (`mogging role`, which any pane CAN send, writes only the daemon's
      // coordination map. Step 2b proves that map no longer opens anything.)
      await ES(`window.__mogging.workspace.setRole(${base + 2}, 'reviewer')`)
      await sleep(800) // the role reaches main (appRoles) and the daemon

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

      // 2) a non-reviewer pane cannot approve — the daemon refuses it outright (exit 6)
      const notReviewer = await cli(['approve', wt.branch], asPane(1))

      // 2b) THE ATTACK. Pane 3 (a worker) promotes ITSELF through the open `set-role` verb
      // and signs off on the branch. The daemon, whose role map it just rewrote, accepts the
      // approve — so `mogging approvals` may even list it. The APP must not care: it never
      // made pane 3 a reviewer, so the merge stays shut. This is the whole fix, asserted.
      const selfPromote = await cli(['role', String(base + 3), 'reviewer'])
      const selfApprove = await cli(['approve', wt.branch], asPane(3))
      const mergeAfterForgery = await mergeVia(wt.branch)
      // ...and the board's ✓ must not appear either: main filters the sign-off at the
      // boundary, so the renderer is never told a forged approval exists.
      const forgedDiff = (await ES(
        `window.bridge.invoke('review:diff', ${JSON.stringify({ repo, worktree: wt.path })})`
      )) as { approved?: boolean }

      // 3) the pane the USER made a reviewer approves; the same merge now lands
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

      const paneEnv = checkPaneEnvIsolation()

      const pass =
        paneEnv.pass &&
        ungated.ok === false &&
        ungated.state === 'ungated' &&
        notReviewer.code === 6 &&
        // The forgery is INERT: whatever the daemon was told, the gate stayed shut and the
        // renderer was never handed an approval to paint. (We do not assert the CLI's own
        // exit codes here — the daemon may well have accepted both calls. That is the point:
        // the app's answer no longer depends on the daemon's.)
        mergeAfterForgery.ok === false &&
        mergeAfterForgery.state === 'ungated' &&
        forgedDiff.approved !== true &&
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
        paneEnvIsolation: paneEnv.detail,
        ungated,
        notReviewerExit: notReviewer.code,
        selfPromoteExit: selfPromote.code,
        selfApproveExit: selfApprove.code,
        mergeAfterForgery,
        forgedDiffApproved: forgedDiff.approved,
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

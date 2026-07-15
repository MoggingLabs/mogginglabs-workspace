import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import type { DaemonEndpoint } from '@contracts'
import { runtimeDir } from '../daemon-client'
import { INHERITED_PANE_ENV, scrubInheritedPaneEnv } from '../pane-env'
import { approvalListed, sendApprovalFromPane } from './reviewer-smoke-helper'
import { capturePaneTokenForSmoke } from './smoke-shell'

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
  const inheritedCli = join(
    tmpdir(),
    'MoggingLabs',
    'run',
    'v123',
    'bin',
    process.platform === 'win32' ? 'mogging.cmd' : 'mogging'
  )
  const arbitraryCli = join(tmpdir(), 'host-runtime', 'bin', process.platform === 'win32' ? 'mogging.cmd' : 'mogging')
  // A managed per-pane git trace the daemon's shell integration wrote for the HOST pane — the
  // app must not inherit it (nested panes would append to it and never get their own cwd lane).
  const managedTrace = join(tmpdir(), 'MoggingLabs', 'run', 'v123', 'bin', '.shell-integration', '4321', 'git-4321-3-0.trace')
  // ...but a GIT_TRACE_SETUP the USER set for their own git debugging is not ours to touch.
  const userTrace = join(tmpdir(), 'my-own-git-debug.trace')
  // Pure: the rule drops exactly the pane identity, and nothing else. MOGGING_GATE and
  // MOGGING_USERDATA are OURS — the app's own launch flags — and must survive.
  const fake: Record<string, string | undefined> = {
    MOGGING_PANE_ID: '3',
    MOGGING_PANE_TOKEN: 'parent-pane-secret',
    MOGGING_DAEMON_ENDPOINT: 'C:/host/endpoint.json',
    MOGGING_BROWSER_ENDPOINT: 'C:/host/browser.json',
    MOGGING_PTY: '1',
    MOGGING_CLI: inheritedCli,
    GIT_TRACE_SETUP: managedTrace,
    MOGGING_GATE: '1',
    MOGGING_USERDATA: 'C:/iso/userdata',
    PATH: [dirname(inheritedCli), dirname(arbitraryCli), 'keep me'].join(delimiter)
  }
  const dropped = scrubInheritedPaneEnv(fake)
  const hostile: Record<string, string | undefined> = {
    MOGGING_CLI: arbitraryCli,
    GIT_TRACE_SETUP: userTrace,
    PATH: [dirname(arbitraryCli), 'keep me'].join(delimiter)
  }
  scrubInheritedPaneEnv(hostile)
  // Assert each pane var is gone by LITERAL name — independent of INHERITED_PANE_ENV. The
  // `.every(INHERITED_PANE_ENV)` check below derives its expectation from the very const under
  // test, so dropping an entry from the const (e.g. MOGGING_PANE_TOKEN -> the parent pane's secret
  // leaks into every nested launch, audit finding 7 reborn) would shift both the length and the
  // every() with it and the gate would stay green. These literals red the gate on exactly that.
  const scrubbedByName =
    fake.MOGGING_PANE_ID === undefined &&
    fake.MOGGING_PANE_TOKEN === undefined &&
    fake.MOGGING_DAEMON_ENDPOINT === undefined &&
    fake.MOGGING_BROWSER_ENDPOINT === undefined &&
    fake.MOGGING_PTY === undefined &&
    fake.MOGGING_CLI === undefined
  const pureOk =
    scrubbedByName &&
    // The 6 pane vars + the managed git trace all leave; INHERITED_PANE_ENV.length + 1.
    dropped.length === INHERITED_PANE_ENV.length + 1 &&
    INHERITED_PANE_ENV.every((n) => fake[n] === undefined) &&
    // The managed git trace is scrubbed; a user's own trace is left alone.
    fake.GIT_TRACE_SETUP === undefined &&
    dropped.includes('GIT_TRACE_SETUP') &&
    hostile.GIT_TRACE_SETUP === userTrace &&
    fake.MOGGING_GATE === '1' &&
    fake.MOGGING_USERDATA === 'C:/iso/userdata' &&
    fake.PATH === [dirname(arbitraryCli), 'keep me'].join(delimiter) &&
    hostile.PATH === [dirname(arbitraryCli), 'keep me'].join(delimiter)
  // Live: inherited pane identity is absent. Main then installs its OWN MOGGING_CLI, which must
  // be present so children resolve this app's private runtime rather than their parent pane's.
  const liveOk =
    INHERITED_PANE_ENV.filter((n) => n !== 'MOGGING_CLI').every((n) => process.env[n] === undefined) &&
    !!process.env.MOGGING_CLI &&
    existsSync(process.env.MOGGING_CLI) &&
    process.env.PATH?.split(delimiter)[0] === dirname(process.env.MOGGING_CLI)
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

/** An old or hostile client can still omit fields at runtime despite the TypeScript contract.
 * Send that exact frame so the gate proves transport enforcement, not only CLI enforcement. */
function unboundApprovalVerdict(from: string, branch: string): Promise<string> {
  const endpoint = JSON.parse(readFileSync(join(runtimeDir(), 'endpoint.json'), 'utf8')) as DaemonEndpoint
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.address)
    socket.setEncoding('utf8')
    let buffer = ''
    let welcomed = false
    let settled = false
    const finish = (verdict?: string, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(verdict ?? 'closed')
    }
    const timer = setTimeout(() => finish(undefined, new Error('unbound approval probe timed out')), 5000)
    socket.on('connect', () => {
      socket.write(JSON.stringify({ t: 'hello', v: endpoint.version, token: endpoint.token }) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line) as { t?: string; reason?: string }
        if (!welcomed && message.t === 'welcome') {
          welcomed = true
          socket.write(JSON.stringify({ t: 'approve', branch, from }) + '\n')
        } else if (welcomed && message.t === 'error') finish(message.reason ?? 'error')
        else if (welcomed && message.t === 'approved') finish('approved')
      }
    })
    socket.on('error', (error) => finish(undefined, error))
    socket.on('close', () => finish())
  })
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
      const paneTokens: Record<number, string> = {}
      for (const n of [1, 2, 3]) {
        paneTokens[n] = await capturePaneTokenForSmoke({
          write: async (command) => {
            const sent = await cli(['send', String(base + n), command])
            if (sent.code !== 0) throw new Error(`could not probe pane ${base + n}`)
          },
          sleep
        })
      }
      const asPane = (n: number): Record<string, string> => ({
        MOGGING_PANE_ID: String(base + n),
        MOGGING_PANE_TOKEN: paneTokens[n]
      })

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

      const mergeVia = (worktree: string, override?: string): Promise<{ ok: boolean; state: string }> =>
        ES(
          `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, worktree, override })})`
        ) as Promise<{ ok: boolean; state: string }>

      // 1) no sign-off, no override -> ungated (the lock works)
      const ungated = await mergeVia(wt.path)

      // 2) a non-reviewer pane cannot approve — the daemon refuses it outright (exit 6)
      // A public pane id is not a capability. Three refusals, from three different places:
      //   - the id ALONE, with no pane credential: the CLI never even reaches the daemon
      //     (it fails closed on the missing MOGGING_PANE_TOKEN);
      //   - the id with ANOTHER pane's credential, sent by a client that bypasses the CLI:
      //     the daemon itself refuses the frame (`notreviewer`), so the enforcement is in the
      //     transport and not merely in our own CLI's argument checking;
      //   - an HONESTLY bound pane whose role is not reviewer: refused by role (exit 6).
      // The external CLI calls carry --repo/--base because approve records the exact object
      // graph it signs off on; without them it would fail on the snapshot, not on the identity
      // we are actually testing here.
      const approveArgs = (branch: string): string[] => ['approve', branch, '--repo', repo, '--base', 'main']
      const unboundReviewer = await cli(approveArgs(wt.branch), { MOGGING_PANE_ID: String(base + 2) })
      const unboundWireVerdict = await unboundApprovalVerdict(String(base + 2), `gate-probe-${Date.now()}`)
      const impersonatedReviewer = await cli(approveArgs(wt.branch), {
        MOGGING_PANE_ID: String(base + 2),
        MOGGING_PANE_TOKEN: paneTokens[1]
      })
      // Then the stronger case: a real worker pane, with its own valid credential, signing
      // from inside itself — still cannot sign, and no approval is ever recorded for it.
      const notReviewer = await cli(approveArgs(wt.branch), asPane(1))
      const boundNonReviewerSent = await sendApprovalFromPane(cli, cliPath, base + 1, wt.branch, { repo, base: 'main' })
      const boundNonReviewerListed =
        boundNonReviewerSent &&
        (await approvalListed(cli, wt.branch, { attempts: 6, sleepMs: 200, byPaneId: base + 1 }))

      // 2b) THE ATTACK. Pane 3 (a worker) promotes ITSELF through the open `set-role` verb
      // and signs off on the branch. The daemon, whose role map it just rewrote, accepts the
      // approve — so `mogging approvals` may even list it. The APP must not care: it never
      // made pane 3 a reviewer, so the merge stays shut. This is the whole fix, asserted.
      const selfPromote = await cli(['role', String(base + 3), 'reviewer'])
      const selfApprovalSent = await sendApprovalFromPane(cli, cliPath, base + 3, wt.branch, { repo, base: 'main' })
      const selfApprovalListed =
        selfApprovalSent && (await approvalListed(cli, wt.branch, { byPaneId: base + 3 }))
      const selfApprove = { code: selfApprovalListed ? 0 : 1 }
      const mergeAfterForgery = await mergeVia(wt.path)
      // ...and the board's ✓ must not appear either: main filters the sign-off at the
      // boundary, so the renderer is never told a forged approval exists.
      const forgedDiff = (await ES(
        `window.bridge.invoke('review:diff', ${JSON.stringify({ repo, worktree: wt.path })})`
      )) as { approved?: boolean }

      // 3) the pane the USER made a reviewer approves; the same merge now lands
      const approvedSent = await sendApprovalFromPane(cli, cliPath, base + 2, wt.branch, { repo, base: 'main' })
      const approvedListed = approvedSent && (await approvalListed(cli, wt.branch, { byPaneId: base + 2 }))
      const approved = { code: approvedListed ? 0 : 1 }
      const approvalsList = JSON.parse((await cli(['approvals', '--json'])).stdout) as { branch: string }[]
      const merged = await mergeVia(wt.path)

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
      const wrongWord = await mergeVia(wt2.path, 'Override')
      const overridden = await mergeVia(wt2.path, 'override')

      const paneEnv = checkPaneEnvIsolation()

      const pass =
        paneEnv.pass &&
        ungated.ok === false &&
        ungated.state === 'ungated' &&
        // The CLI's own exit code for a MISSING pane credential is the one place the two
        // lineages disagree (2 = 'bad usage/environment' vs 6 = 'notreviewer'); the merge of
        // bin/mogging.mjs settles it. What is NOT in doubt — and is what this gate is for — is
        // that the call is refused and no approval is recorded, which the wire verdict below
        // and the approvals list assert directly.
        unboundReviewer.code !== 0 &&
        unboundWireVerdict === 'notreviewer' &&
        impersonatedReviewer.code === 6 &&
        notReviewer.code === 6 &&
        boundNonReviewerSent &&
        !boundNonReviewerListed &&
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
        unboundReviewerExit: unboundReviewer.code,
        unboundWireVerdict,
        impersonatedReviewerExit: impersonatedReviewer.code,
        notReviewerExit: notReviewer.code,
        boundNonReviewerSent,
        boundNonReviewerListed,
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

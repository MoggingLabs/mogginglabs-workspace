import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { sh, softFps, softGapMs } from './smoke-shell'
import { approvalListed, sendApprovalFromPane } from './reviewer-smoke-helper'

// Env-gated Phase-4 SWARM MILESTONE (MOGGING_SWARMMILESTONE), two-phase like 2/05+3/06:
//
//  Phase A — the swarm. Temp repo -> 2 workers + 1 reviewer (shell provider,
//  deterministic), workers in their own worktrees, roles set -> the LEDGER referees
//  (overlap denied, disjoint granted) -> workers handshake through the MAILBOX
//  (PING/ACK) -> each commits in ITS territory via the real `mogging send` -> the
//  GATE holds (ungated -> reviewer approves -> lands; the other branch lands via the
//  typed human override) -> repo has both changes, HEAD clean, approvals die with
//  their worktree.
//
//  Phase B — perf with the swarm up. Board visited, 11+ live panes, 3 s ANSI torrent
//  + 4 workspace switches against the UNCHANGED machine budget.
const BUDGET = { maxFrameGapMs: softGapMs(150), minAvgFps: softFps(30), maxHeapMB: 300 }
const PING = 'SWARM_PING_4242'
const ACK = 'SWARM_ACK_4242'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-swarmms-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'swarm repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runSwarmMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 260000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 20000, windowsHide: true },
        (err, stdout, stderr) =>
          resolveCli({
            code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr)
          })
      )
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      await sleep(1500)

      // ── A1. The swarm: 2 workers (own worktrees) + 1 reviewer, roles set ─────
      const wt1 = await createWorktree(repo)
      const wt2 = await createWorktree(repo)
      if (!wt1.ok || !wt1.path || !wt1.branch || !wt2.ok || !wt2.path || !wt2.branch) {
        throw new Error('worktree create failed')
      }
      await ES(
        `window.__mogging.workspace.create({ name: 'Swarm', cwd: ${JSON.stringify(repo)}, paneCount: 3, ` +
          `paneCwds: ${JSON.stringify([wt1.path, wt2.path, null])}, roles: ['worker','worker','reviewer'] })`
      )
      await sleep(4000) // panes spawn + roles reach the daemon
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const asPane = (n: number): Record<string, string> => ({ MOGGING_PANE_ID: String(base + n) })

      // ── A2. The ledger referees ──────────────────────────────────────────────
      const claim1 = await cli(['claim', 'src/a/**'], asPane(1))
      const denied = await cli(['claim', 'src/a/x.ts'], asPane(2))
      const claim2 = await cli(['claim', 'src/b/**'], asPane(2))
      const ledgerOk =
        claim1.code === 0 && denied.code === 5 && denied.stderr.includes(String(base + 1)) && claim2.code === 0

      // ── A3. Mailbox handshake between the workers ────────────────────────────
      await cli(['mail', 'send', '--to', String(base + 2), PING], asPane(1))
      const read2 = await cli(['mail', 'read', '--json'], asPane(2))
      await cli(['mail', 'send', '--to', String(base + 1), ACK], asPane(2))
      const read1 = await cli(['mail', 'read', '--json'], asPane(1))
      type Mail = { from: string; body: string; role?: string }
      const inbox2 = JSON.parse(read2.stdout) as Mail[]
      const inbox1 = JSON.parse(read1.stdout) as Mail[]
      const mailOk =
        inbox2.some((m) => m.body === PING && m.from === String(base + 1) && m.role === 'worker') &&
        inbox1.some((m) => m.body === ACK && m.from === String(base + 2) && m.role === 'worker')

      // ── A4. Each worker commits in ITS territory (real `mogging send`) ───────
      const work = (wt: string, dir: string, file: string, mark: string, msg: string): string =>
        sh.chain(
          sh.cd(wt),
          sh.mkdirWrite(`src/${dir}`, `src/${dir}/${file}`, mark),
          'git add -A',
          `git commit -m ${msg}`
        )
      await cli(['send', String(base + 1), work(wt1.path, 'a', 'one.txt', 'W1_4242', 'worker1')])
      await cli(['send', String(base + 2), work(wt2.path, 'b', 'two.txt', 'W2_4242', 'worker2')])
      let workOk = false
      for (let i = 0; i < 40 && !workOk; i++) {
        try {
          workOk =
            git(wt1.path, ['log', '--oneline', '-1']).includes('worker1') &&
            git(wt2.path, ['log', '--oneline', '-1']).includes('worker2')
        } catch {
          /* not yet */
        }
        if (!workOk) await sleep(500)
      }

      // ── A5. The gate holds: ungated -> reviewer approves -> lands ────────────
      const mergeVia = (worktree: string, override?: string): Promise<{ ok: boolean; state: string }> =>
        ES(
          `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, worktree, override })})`
        ) as Promise<{ ok: boolean; state: string }>
      const ungated = await mergeVia(wt1.path)
      const approvalSent = await sendApprovalFromPane(cli, cliPath, base + 3, wt1.branch, { repo, base: 'main' })
      const approvalSeen = approvalSent && (await approvalListed(cli, wt1.branch))
      const approve = { code: approvalSeen ? 0 : 1 }
      const merged1 = await mergeVia(wt1.path)
      // Worker 2's branch: the HUMAN path (typed override, verbatim).
      const merged2 = await mergeVia(wt2.path, 'override')
      const gateOk =
        ungated.state === 'ungated' && approve.code === 0 && merged1.state === 'merged' && merged2.state === 'merged'

      // ── A6. The repo holds both changes; approvals die with their worktree ───
      const bothLanded =
        existsSync(join(repo, 'src', 'a', 'one.txt')) && existsSync(join(repo, 'src', 'b', 'two.txt'))
      const headClean = git(repo, ['status', '--porcelain']) === ''
      const headMoved = git(repo, ['rev-parse', 'HEAD']) !== headBefore
      // Step the worker's shell OUT of its worktree first — Windows refuses to
      // remove a directory that is some process's cwd.
      await cli(['send', String(base + 1), sh.cd(repo)])
      await sleep(1200)
      const removed = (await ES(
        `window.bridge.invoke('worktrees:remove', ${JSON.stringify({ repo, path: wt1.path, force: true })})`
      )) as { ok: boolean }
      await sleep(800)
      const approvalsAfter = JSON.parse((await cli(['approvals', '--json'])).stdout) as { branch: string }[]
      const clearedOk = approvalsAfter.every((a) => a.branch !== wt1.branch)
      const repoOk = bothLanded && headClean && headMoved && clearedOk

      // ── B. Perf with the swarm up: board visited, 11+ panes, torrent + churn ─
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyG', bubbles: true }))`)
      await sleep(700)
      await ES(`window.__mogging.workspace.create({ name: 'Torrent' })`)
      await sleep(500)
      await ES(`window.__mogging.layout.apply(8)`)
      for (let i = 0; i < 40; i++) {
        if (Number(await ES(`window.__mogging.layout.paneCount()`)) === 8) break
        await sleep(400)
      }
      await sleep(2500)
      const torrentIdx = Number(await ES(`window.__mogging.workspace.count()`)) - 1
      const swarmIdx = torrentIdx - 1

      const phaseB = (await ES(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const ESCC = String.fromCharCode(27)
        const m = window.__mogging
        const act = m.workspace.active()
        const b = act.ordinal * 100
        const panes = (m.panes || []).filter((p) => p.id > b && p.id <= b + 8)
        const chunk = (id, t) => {
          let s = ''
          for (let l = 0; l < 6; l++) s += ESCC + '[3' + ((l % 7) + 1) + 'm p' + id + ' t' + t + ' ' + 'x'.repeat(90) + ESCC + '[0m\\r\\n'
          return s
        }
        let ticks = 0
        const writer = setInterval(() => { ticks++; for (const p of panes) p.term.write(chunk(p.id, ticks)) }, 50)
        const gaps = []
        let last = performance.now()
        let on = true
        const tick = (now) => { gaps.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        const seq = [${swarmIdx}, ${torrentIdx}, ${swarmIdx}, ${torrentIdx}]
        for (let i = 0; i < seq.length; i++) { await sleep(650); m.workspace.switchByIndex(seq[i]) }
        await sleep(400)
        on = false
        clearInterval(writer)
        const total = gaps.reduce((a, c) => a + c, 0)
        return {
          frames: gaps.length,
          avgFps: Math.round((gaps.length / (total / 1000)) * 10) / 10,
          maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
          heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
          livePanes: (m.panes || []).length
        }
      })()`)) as { frames: number; avgFps: number; maxGapMs: number; heapMB: number; livePanes: number }
      const phaseBOk =
        phaseB.maxGapMs <= BUDGET.maxFrameGapMs &&
        phaseB.avgFps >= BUDGET.minAvgFps &&
        phaseB.heapMB <= BUDGET.maxHeapMB &&
        phaseB.livePanes >= 11

      const pass = ledgerOk && mailOk && workOk && gateOk && repoOk && phaseBOk
      result = { pass, ledgerOk, mailOk, workOk, gateOk, ungated, mergedStates: [merged1.state, merged2.state], repoOk, bothLanded, headClean, removed, clearedOk, phaseB, phaseBOk, budget: BUDGET }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'swarmmilestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { dockDebug } from './browser-dock'
import { sh, softFps, softGapMs } from './smoke-shell'

// Env-gated PRODUCT MILESTONE (MOGGING_PRODUCT, Phase-6/07) — the freeze proof.
// ONE asserted flow: an installer-fresh machine reaches a working swarm + browser,
// then budgets hold with the whole surface on.
//
//  Phase A — the five-minute path, asserted:
//   fresh boot -> first-run checklist present (6/06) -> a Swarm-preset workspace
//   (2 workers in worktrees + 1 reviewer, shell provider for determinism) with a
//   PER-SLOT PROFILE chosen (6/04, carried in the manifest) -> roles chipped,
//   worktrees agree -> checklist reflects real state (rows 2+3 done; collapse iff
//   a CLI is installed — detection-honest, the 6/01 lesson) -> a browser DOCK
//   opens beside the panes on a smoke-served localhost page (6/05) -> the swarm
//   substrate is reachable from the panes (ledger claim, mailbox handshake, real
//   commits) -> the review GATE lands both branches.
//
//  Phase B — budgets with EVERYTHING on: board visited, browser dock open,
//   checklist rendered, 12+ live panes, 3 s torrent + 4 switches, machine budget
//   UNCHANGED (<=150 ms / >=30 fps / <=300 MB).
const BUDGET = { maxFrameGapMs: softGapMs(150), minAvgFps: softFps(30), maxHeapMB: 300 }
const PING = 'PROD_PING_4242'
const ACK = 'PROD_ACK_4242'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mog.prod.'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'product repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runProductSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 280000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  let server: Server | null = null

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 20000, windowsHide: true },
        (err, stdout, stderr) =>
          resolveCli({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    })

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>PROD_PREVIEW_4242</title><h1>preview</h1>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const a = server?.address()
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const repo = makeRepo()
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const port = await serve()
      await sleep(1500)

      // ── A0. Fresh boot: the first-run checklist is present ───────────────────
      await ES(`try{localStorage.removeItem('mogging.firstrun.dismissed')}catch{}`)
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(600)
      const checklistShown = await ES<boolean>(`!document.querySelector('.firstrun-card').hidden`)
      const anyCliInstalled = await ES<boolean>(
        `window.bridge.invoke('agents:detect').then(a => (a||[]).some(x => x.installed))`
      )

      // ── A1. Per-slot profile pointers for the Swarm (6/04). These two once ALSO
      // masked first-run bug #1 by satisfying the "power-up" checklist row; 06's
      // REMOVE #21 deleted that row, so the checklist below dismisses on cliDone &&
      // wsDone alone — honestly, not because a fixture pre-satisfied a dead row. ──
      const save = (p: unknown): Promise<boolean> => ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedA = await save({ id: 'p-work', name: 'Work', provider: 'gemini', env: { FAKE_MARK: 'PROD_A' }, order: 0 })
      const savedB = await save({ id: 'p-personal', name: 'Personal', provider: 'gemini', env: { FAKE_MARK: 'PROD_B' }, order: 1 })

      // ── A2. The Swarm workspace: 2 workers (worktrees) + reviewer, roles, and a
      // per-slot profile CHOSEN on worker 1 (6/04 — carried in the manifest) ────
      const wt1 = await createWorktree(repo)
      const wt2 = await createWorktree(repo)
      if (!wt1.ok || !wt1.path || !wt1.branch || !wt2.ok || !wt2.path || !wt2.branch) throw new Error('worktree create failed')
      await ES(
        `window.__mogging.workspace.create({ name: 'Swarm', cwd: ${JSON.stringify(repo)}, paneCount: 3, ` +
          `paneCwds: ${JSON.stringify([wt1.path, wt2.path, null])}, roles: ['worker','worker','reviewer'], ` +
          `profileIds: ['p-personal', null, null] })`
      )
      await sleep(4000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const asPane = (n: number): Record<string, string> => ({ MOGGING_PANE_ID: String(base + n) })

      // Manifest carries the choice (roles + the per-slot profile).
      const swarmMeta = (await ES(
        `(() => { const w = window.__mogging.workspace.list().find(m => m.name === 'Swarm'); return w ? { roles: w.roles, profileIds: w.profileIds } : null })()`
      )) as { roles?: (string | null)[]; profileIds?: (string | null)[] } | null
      const rolesOk = JSON.stringify(swarmMeta?.roles) === JSON.stringify(['worker', 'worker', 'reviewer'])
      const profileChosenOk = swarmMeta?.profileIds?.[0] === 'p-personal'

      // ── A3. Checklist is detection-honest: rows 2+3 done; collapse IFF a CLI is
      // installed (dev: collapses; CI: honestly stays with row 1 incomplete) ────
      await ES(`window.__mogging.firstrun.refresh()`)
      await sleep(700)
      const collapsed = await ES<boolean>(`document.querySelector('.firstrun-card').hidden`)
      const checklistHonest = collapsed === anyCliInstalled

      // ── A4. The browser dock opens beside the panes on a localhost page ──────
      await ES(`window.__mogging.browser.toggle(true)`)
      await sleep(500)
      await ES(`window.__mogging.browser.navigate('127.0.0.1:${port}')`)
      let dockOk = false
      for (let i = 0; i < 30 && !dockOk; i++) {
        await sleep(400)
        const st = (await ES(`window.__mogging.browser.state()`)) as { title: string }
        // 8/07: the guest is an in-DOM <webview>; "shown" = dock open + a page loaded.
        if (st.title === 'PROD_PREVIEW_4242') dockOk = dockDebug().open && dockDebug().url.includes(`127.0.0.1:${port}`)
      }

      // ── A5. Swarm substrate reachable from the panes: ledger + mailbox ──────
      const claim1 = await cli(['claim', 'src/a/**'], asPane(1))
      const denied = await cli(['claim', 'src/a/x.ts'], asPane(2))
      const claim2 = await cli(['claim', 'src/b/**'], asPane(2))
      const ledgerOk = claim1.code === 0 && denied.code === 5 && denied.stderr.includes(String(base + 1)) && claim2.code === 0
      await cli(['mail', 'send', '--to', String(base + 2), PING], asPane(1))
      const read2 = await cli(['mail', 'read', '--json'], asPane(2))
      await cli(['mail', 'send', '--to', String(base + 1), ACK], asPane(2))
      const read1 = await cli(['mail', 'read', '--json'], asPane(1))
      type Mail = { from: string; body: string; role?: string }
      const mailOk =
        (JSON.parse(read2.stdout) as Mail[]).some((m) => m.body === PING && m.from === String(base + 1) && m.role === 'worker') &&
        (JSON.parse(read1.stdout) as Mail[]).some((m) => m.body === ACK && m.from === String(base + 2) && m.role === 'worker')

      // ── A6. Each worker commits in ITS territory (real `mogging send`) ──────
      const work = (wt: string, dir: string, file: string, mark: string, msg: string): string =>
        sh.chain(sh.cd(wt), sh.mkdirWrite(`src/${dir}`, `src/${dir}/${file}`, mark), 'git add -A', `git commit -m ${msg}`)
      await cli(['send', String(base + 1), work(wt1.path, 'a', 'one.txt', 'W1_4242', 'worker1')])
      await cli(['send', String(base + 2), work(wt2.path, 'b', 'two.txt', 'W2_4242', 'worker2')])
      let workOk = false
      for (let i = 0; i < 40 && !workOk; i++) {
        try {
          workOk = git(wt1.path, ['log', '--oneline', '-1']).includes('worker1') && git(wt2.path, ['log', '--oneline', '-1']).includes('worker2')
        } catch {
          /* not yet */
        }
        if (!workOk) await sleep(500)
      }

      // ── A7. The review GATE: ungated -> reviewer approves -> lands; the human
      // override lands the second branch. Both changes in the repo, HEAD clean. ─
      const mergeVia = (branch: string, override?: string): Promise<{ ok: boolean; state: string }> =>
        ES(`window.bridge.invoke('review:merge', ${JSON.stringify({ repo, branch, override })})`) as Promise<{ ok: boolean; state: string }>
      const ungated = await mergeVia(wt1.branch)
      const approve = await cli(['approve', wt1.branch], asPane(3))
      const merged1 = await mergeVia(wt1.branch)
      const merged2 = await mergeVia(wt2.branch, 'override')
      const gateOk = ungated.state === 'ungated' && approve.code === 0 && merged1.state === 'merged' && merged2.state === 'merged'
      const bothLanded = existsSync(join(repo, 'src', 'a', 'one.txt')) && existsSync(join(repo, 'src', 'b', 'two.txt'))
      const headClean = git(repo, ['status', '--porcelain']) === ''
      const headMoved = git(repo, ['rev-parse', 'HEAD']) !== headBefore
      const repoOk = bothLanded && headClean && headMoved

      const phaseAOk =
        checklistShown && savedA && savedB && rolesOk && profileChosenOk && checklistHonest && dockOk && ledgerOk && mailOk && workOk && gateOk && repoOk

      // ── B. Budgets with EVERYTHING on: board visited, dock still open, 12+
      // panes, torrent + switches — the machine budget must not move. ──────────
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyG', bubbles: true }))`)
      await sleep(700)
      await ES(`window.__mogging.workspace.create({ name: 'Torrent' })`)
      await sleep(500)
      await ES(`window.__mogging.layout.apply(16)`)
      for (let i = 0; i < 40; i++) {
        if (Number(await ES(`window.__mogging.layout.paneCount()`)) === 16) break
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
        const panes = (m.panes || []).filter((p) => p.id > b && p.id <= b + 16)
        const chunk = (id, t) => { let s = ''; for (let l = 0; l < 6; l++) s += ESCC + '[3' + ((l % 7) + 1) + 'm p' + id + ' t' + t + ' ' + 'x'.repeat(90) + ESCC + '[0m\\r\\n'; return s }
        let ticks = 0
        const writer = setInterval(() => { ticks++; for (const p of panes) p.term.write(chunk(p.id, ticks)) }, 50)
        const gaps = []; let last = performance.now(); let on = true
        const tick = (now) => { gaps.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        const seq = [${swarmIdx}, ${torrentIdx}, ${swarmIdx}, ${torrentIdx}]
        for (let i = 0; i < seq.length; i++) { await sleep(650); m.workspace.switchByIndex(seq[i]) }
        await sleep(400); on = false; clearInterval(writer)
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
        phaseB.maxGapMs <= BUDGET.maxFrameGapMs && phaseB.avgFps >= BUDGET.minAvgFps && phaseB.heapMB <= BUDGET.maxHeapMB && phaseB.livePanes >= 12

      const pass = phaseAOk && phaseBOk
      result = {
        pass, phaseAOk, phaseBOk, anyCliInstalled,
        checklistShown, rolesOk, profileChosenOk, checklistHonest, dockOk,
        ledgerOk, mailOk, workOk, gateOk, repoOk,
        phaseB, budget: BUDGET
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    server?.close()
    try {
      writeFileSync(join(process.cwd(), 'out', 'product-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

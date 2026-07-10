import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh, softFps, softGapMs } from './smoke-shell'

// Env-gated ORCHESTRATION milestone smoke (MOGGING_ORCHESTRATION, Phase-3/06).
// The whole Phase-3 promise as ONE asserted flow, two-phase like the perf milestone:
//
//  Phase A — the loop. Temp repo -> board card -> start-on-card (shell provider,
//  deterministic) -> worktree exists + task marker arrives as the first prompt ->
//  the "agent" (scripted via the REAL `mogging send` CLI) edits a file AND plants a
//  fake secret, commits -> `mogging notify --event needs-input` inside the pane flags
//  the CARD and the RAIL end-to-end -> review:diff shows the change with the secret
//  REDACTED -> review:merge lands the branch -> the card moves to done.
//
//  Phase B — perf under orchestration. Board visited (cards bound), 11+ live panes
//  (3 worktree-isolated), 3 s of ANSI torrent + 4 workspace switches sampled with the
//  UNCHANGED Phase-2 budget: worst gap ≤ 150 ms, avg fps ≥ 30, heap ≤ 300 MB.
const BUDGET = { maxFrameGapMs: softGapMs(150), minAvgFps: softFps(30), maxHeapMB: 300 }
const TASK = 'ORCH_TASK_4242 improve the readme'
const CHANGE = 'AGENT_CHANGE_LINE_4242'
const SECRET = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-orch-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'orchestrated repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runOrchestrationSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 220000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 20000, windowsHide: true },
        (err, stdout) =>
          resolveCli({
            code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout)
          })
      )
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      type Card = { id: string; title: string; lane: string; paneId?: number | null; workspaceId?: string | null; notes: string; createdAt: number; updatedAt: number }
      const repo = makeRepo()
      await sleep(1500)

      // ── A1. Card -> isolated start (shell provider) ─────────────────────────
      const cardId = String(await ES(`window.__mogging.board.createCard(${JSON.stringify(TASK)}, 'Append the change line, then commit.')`))
      await ES(`window.__mogging.workspace.create({ name: 'Repo', cwd: ${JSON.stringify(repo)} })`)
      await sleep(2000)
      const started = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(cardId)}, 'shell')`)) as boolean
      await sleep(1500)
      const cards = (await ES(`window.__mogging.board.list()`)) as Card[]
      const card = cards.find((c) => c.id === cardId)
      const paneId = card?.paneId ?? 0
      const bindOk = started && !!paneId && card?.lane === 'doing'

      const wtRoot = join(repo, '.mogging', 'worktrees')
      const wtDirs = existsSync(wtRoot) ? readdirSync(wtRoot) : []
      const worktree = wtDirs.length === 1 ? join(wtRoot, wtDirs[0]) : ''
      const worktreeOk =
        !!worktree && git(repo, ['worktree', 'list', '--porcelain']).includes(wtDirs[0])

      // ── A2. Task marker = the pane's first prompt ───────────────────────────
      const bufferText = (): Promise<string> =>
        ES<string>(
          `(() => {
            const p = (window.__mogging.panes || []).find((x) => x.id === ${paneId})
            if (!p) return ''
            const b = p.term.buffer.active
            let s = ''
            for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
            return s
          })()`
        )
      let promptOk = false
      for (let i = 0; i < 30 && !promptOk; i++) {
        promptOk = (await bufferText()).includes('ORCH_TASK_4242')
        if (!promptOk) await sleep(500)
      }

      // ── A3. The "agent" works — scripted through the REAL control CLI ───────
      const work = sh.chain(
        sh.cd(worktree),
        sh.appendLine(CHANGE, 'README.md'),
        sh.writeLine(SECRET, 'stolen.txt'),
        'git add -A',
        'git commit -m agent-work'
      )
      const sendRes = await cli(['send', String(paneId), work])
      let workOk = false
      for (let i = 0; i < 40 && !workOk; i++) {
        try {
          workOk = git(worktree, ['log', '--oneline', '-1']).includes('agent-work')
        } catch {
          /* not yet */
        }
        if (!workOk) await sleep(500)
      }

      // ── A4. needs-input INSIDE the pane -> card + rail flag, end to end ─────
      // The pane-state dot (and the card/rail aggregation behind it) is gated on a
      // tracked provider session; the real flow launches the agent through the app,
      // which registers one. This smoke scripts the agent via the control CLI, so
      // adopt the session the launch path would have created.
      await ES(`window.__mogging.agents.adopt(${paneId},"claude","");1`)
      await sleep(400)
      await ES(`window.__mogging.workspace.switchByIndex(0)`) // background the card's workspace
      await sleep(600)
      await cli(['send', String(paneId), `node "${cliPath}" notify --event needs-input`])
      let attnOk = false
      let attnDom: unknown = null
      for (let i = 0; i < 40 && !attnOk; i++) {
        attnDom = await ES(
          `(() => {
            const card = document.querySelector('.board-card[data-card-id="${cardId}"]')
            const rail = document.querySelector('.workspace-tab[data-attention]')
            return {
              cardFlag: card ? card.getAttribute('data-attention') === 'true' : false,
              chip: card ? !!card.querySelector('.board-chip-attention') : false,
              rail: !!rail
            }
          })()`
        )
        const a = attnDom as { cardFlag: boolean; chip: boolean; rail: boolean }
        attnOk = a.cardFlag && a.chip && a.rail
        if (!attnOk) await sleep(500)
      }

      // ── A5. Review: the change arrives, the secret does NOT ──────────────────
      const diff = (await ES(
        `window.bridge.invoke('review:diff', ${JSON.stringify({ repo, worktree })})`
      )) as { branch: string; files: { path: string; hunks: string[] }[]; redactions: number }
      const diffText = JSON.stringify(diff)
      const diffOk =
        diff.files.some((f) => f.path === 'README.md' && f.hunks.join('\n').includes(CHANGE)) &&
        diff.files.some((f) => f.path === 'stolen.txt')
      const redactOk = diff.redactions >= 1 && !diffText.includes(SECRET) && diffText.includes('redacted')

      // ── A6. The reviewer gate (4/03), then the guarded merge lands the branch ──
      // The loop now includes sign-off: an ungated merge is REFUSED; the pane becomes
      // the reviewer and approves; then the same merge succeeds.
      const ungated = (await ES(
        `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, branch: diff.branch })})`
      )) as { ok: boolean; state: string }
      await cli(['role', String(paneId), 'reviewer'])
      const approveRes = await cli(['approve', diff.branch], { MOGGING_PANE_ID: String(paneId) })
      const merge = (await ES(
        `window.bridge.invoke('review:merge', ${JSON.stringify({ repo, branch: diff.branch })})`
      )) as { ok: boolean; state: string }
      const mergeOk =
        ungated.ok === false &&
        ungated.state === 'ungated' &&
        approveRes.code === 0 &&
        merge.ok === true &&
        merge.state === 'merged' &&
        readFileSync(join(repo, 'README.md'), 'utf8').includes(CHANGE)

      // ── A7. The human closes the loop: card -> done ───────────────────────────
      if (card) {
        await ES(`window.bridge.invoke('board:save', ${JSON.stringify({ ...card, lane: 'done' })})`)
        await ES(`window.__mogging.board.refresh()`)
        await sleep(400)
      }
      const doneCards = (await ES(`window.__mogging.board.list()`)) as Card[]
      const doneOk = doneCards.find((c) => c.id === cardId)?.lane === 'done'

      // ── B. Perf under orchestration (Phase-2 budget, UNCHANGED) ─────────────
      await ES(
        `window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyG', bubbles: true }))`
      ) // board OPEN (renders bound cards)…
      await sleep(700)
      await ES(`window.__mogging.templates.openIsolated(${JSON.stringify(repo)}, [{provider:'gemini',count:2}])`)
      await sleep(2000)
      await ES(`window.__mogging.workspace.create({ name: 'Torrent' })`)
      await sleep(500)
      await ES(`window.__mogging.layout.apply(8)`)
      for (let i = 0; i < 40; i++) {
        const n = Number(await ES(`window.__mogging.layout.paneCount()`))
        if (n === 8) break
        await sleep(400)
      }
      await sleep(2500)
      const torrentIdx = Number(await ES(`window.__mogging.workspace.count()`)) - 1
      const isoIdx = torrentIdx - 1

      const phaseB = (await ES(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const ESCC = String.fromCharCode(27)
        const m = window.__mogging
        const act = m.workspace.active()
        const base = act.ordinal * 100
        const panes = (m.panes || []).filter((p) => p.id > base && p.id <= base + 8)
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
        const switches = [${torrentIdx}, ${isoIdx}, ${torrentIdx}, ${isoIdx}]
        for (let i = 0; i < switches.length; i++) { await sleep(650); m.workspace.switchByIndex(switches[i]) }
        await sleep(3000 - 650 * switches.length > 0 ? 3000 - 650 * switches.length : 400)
        on = false
        clearInterval(writer)
        const total = gaps.reduce((a, b) => a + b, 0)
        const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0
        return {
          frames: gaps.length,
          avgFps: Math.round((gaps.length / (total / 1000)) * 10) / 10,
          maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
          heapMB,
          livePanes: (m.panes || []).length
        }
      })()`)) as { frames: number; avgFps: number; maxGapMs: number; heapMB: number; livePanes: number }

      const phaseBOk =
        phaseB.maxGapMs <= BUDGET.maxFrameGapMs &&
        phaseB.avgFps >= BUDGET.minAvgFps &&
        phaseB.heapMB <= BUDGET.maxHeapMB &&
        phaseB.livePanes >= 8

      const pass =
        bindOk && worktreeOk && promptOk && workOk && attnOk && diffOk && redactOk && mergeOk && doneOk && phaseBOk
      result = {
        pass,
        bindOk,
        worktreeOk,
        promptOk,
        sendExit: sendRes.code,
        workOk,
        attnOk,
        attnDom,
        diffOk,
        redactOk,
        redactions: diff.redactions,
        mergeOk,
        ungated,
        approveExit: approveRes.code,
        doneOk,
        phaseB,
        phaseBOk,
        budget: BUDGET
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'orchestration-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

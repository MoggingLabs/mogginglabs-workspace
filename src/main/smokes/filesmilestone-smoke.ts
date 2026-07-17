import { app, clipboard, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeGitFull } from '@backend/features/git'
import { WATCH_POOL_CAP } from '@backend/features/explorer'
import { explorerWatchStats, setExplorerShellPortForSmoke, type ExplorerShellPort } from '../explorer'

// ── THE PHASE-11 MILESTONE (MOGGING_FILESMILESTONE) ──────────────────────────
// The pack's ONLY authority on "Phase 11 done". Everything the six steps promised, in ONE
// composed run, on ONE fixture world: a real git workspace, a real shell pane, real writes.
// Zero network, zero vendor CLIs, and the OS shell is never actually called (a spy stands
// in — the FAKE-parts rule).
//
// THE PROMISE, END TO END:
//   1. The FAR-RIGHT toggle opens a tree on the workspace's folder.
//   2. A SCRIPTED PANE — a real shell process, not this smoke reaching around it — writes,
//      modifies, and deletes files. The tree shows each within a second, as ONE coalesced
//      batch, without losing selection or scroll.
//   3. git decorations flip on the next tick; the Changes count equals porcelain's.
//   4. The lens filters to what changed, and leaving it restores expansion exactly.
//   5. The verbs work: open reaches the OS (spy), copy reaches the clipboard, send-to-pane
//      types a quoted path — and NEVER presses Enter.
//   6. Switching workspaces re-roots inside the perception budget, remembering expansion.
//   7. A workspace with no folder shows the EmptyState and costs zero.
//   8. Closing the explorer costs ZERO: no watchers, no polls, no git traffic.
//   9. ATTENTION IS SACRED: a pane that needed input at the start still needs it at the end.
//  10. The BUDGETS hold on the composed surface: 16 panes + the explorer open + a write
//      torrent (docs/05: worst gap ≤ 150ms, avg fps ≥ 30, heap ≤ 300MB).
// Verdict: out/filesmilestone-result.json.

const BUDGET = { maxFrameGapMs: 150, minAvgFps: 30, maxHeapMB: 300, switchMs: 100 }

interface Fixture {
  repo: string
  outside: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeFixture(): Fixture {
  // realpathSync.native: the CANONICAL spelling of the fresh dir. CI temp dirs are
  // aliases — 8.3 short names on Windows runners (C:\Users\RUNNER~1\…), the /var →
  // /private/var symlink on macOS — and the watcher stack canonicalizes real paths,
  // so an alias-rooted fixture reads as OUTSIDE its own root (win+mac sweep reds,
  // run 29547052949; local and linux temp paths are already canonical, which is why
  // only runners bit). `.native` matters: the JS realpath resolves symlinks but not
  // Windows short names.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-filesms-')))
  const repo = join(base, 'workspace')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'docs'))
  mkdirSync(join(repo, 'lib'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'milestone@mogging.test'])
  git(repo, ['config', 'user.name', 'Milestone'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  writeFileSync(join(repo, 'README.md'), '# workspace\n')
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const v = 1\n')
  writeFileSync(join(repo, 'src', 'doomed.ts'), 'export const gone = true\n')
  writeFileSync(join(repo, 'docs', 'guide.md'), '# guide\n')
  writeFileSync(join(repo, 'lib', 'util.ts'), 'export const u = 1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'baseline'])

  const outside = join(base, 'not-a-workspace') // a folder with no git and no workspace
  mkdirSync(outside)
  return { repo, outside }
}

export function runFilesMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 420000) // safety net (a full compose + a 16-pane budget arm)
  const wc = win.webContents
  wc.setBackgroundThrottling(false) // the budget arm must measure real frames, not a throttled tab
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // The OS is never really called: a spy is the only witness (ADR 0010's delegation, tested
  // without launching the operator's editor).
  const spy: { opened: string[]; revealed: string[] } = { opened: [], revealed: [] }
  setExplorerShellPortForSmoke({
    openPath: (p) => {
      spy.opened.push(p)
      return Promise.resolve('')
    },
    showItemInFolder: (p) => {
      spy.revealed.push(p)
    }
  } satisfies ExplorerShellPort)

  /** Wait, in the RENDERER, for a row to appear (or vanish). Returns the honest latency. */
  const awaitRow = (name: string, want: boolean, capMs = 5000): Promise<number> =>
    ES<number>(`(async () => {
      const t0 = performance.now()
      while (performance.now() - t0 < ${capMs}) {
        const has = window.__mogging.explorer.rowNames().includes(${JSON.stringify(name)})
        if (has === ${String(want)}) return Math.round(performance.now() - t0)
        await new Promise((r) => setTimeout(r, 16))
      }
      return -1
    })()`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The world: a git workspace (a shell pane in it), and a folderless one ─────
      await ES(`window.__mogging.workspace.create({ name: 'Work', cwd: ${JSON.stringify(F.repo)}, paneCount: 1 })`)
      await sleep(3000) // the shell spawns and prints a prompt
      await ES(`window.__mogging.workspace.create({ name: 'Bare' })`) // no cwd, on purpose
      await sleep(1500)
      await ES(`window.__mogging.workspace.switchByIndex(0)`)
      await sleep(1000)

      // (9) ATTENTION IS SACRED. Seed it NOW and check it at the very end: nothing the
      // explorer does — not a batch, not a re-root, not a close — may clear it.
      const paneId = await ES<number>(`window.__mogging.panes[0].id`)
      await ES(`window.__mogging.attention.setPaneState(${paneId}, 'needs-input')`)
      await sleep(400)
      const attentionAtStart = await ES<string>(
        `document.querySelector('#workspace-host .pane-state')?.dataset.state ?? ''`
      )

      // ── (8) CLOSED COSTS ZERO — measured BEFORE it is ever opened ─────────────────
      const closedStatsBefore = explorerWatchStats()

      // ── (1) The far-right toggle opens a tree on the workspace's folder ───────────
      await ES(`(() => {
        const btn = document.querySelector('#titlebar .explorer-toggle')
        btn.click()
      })()`)
      await sleep(1200)
      const opened = await ES<{ shown: boolean; active: boolean; root: string; names: string[] }>(`(() => ({
        shown: !document.querySelector('.explorer-dock').hidden,
        active: document.querySelector('#titlebar .explorer-toggle').classList.contains('is-active'),
        root: window.__mogging.explorer.rootPath(),
        names: window.__mogging.explorer.rowNames()
      }))()`)
      const openOk =
        opened.shown && opened.active && opened.root === F.repo &&
        opened.names.includes('src') && opened.names.includes('README.md')

      // Three dirs expanded — the visible set the liveness law will watch.
      for (const d of ['src', 'docs', 'lib']) {
        await ES(`window.__mogging.explorer.expand(${JSON.stringify(join(F.repo, d))})`)
        await sleep(400)
      }
      await sleep(1200) // the first git tick + the check-ignore batches
      const liveStats = explorerWatchStats()
      // root + 3 expanded = 4 handles. Nothing else — not one watcher on a collapsed dir.
      const watchOk = liveStats.handles === 4 && liveStats.polls === 0 && !liveStats.suspended

      // ── (2) A SCRIPTED PANE writes. A real shell process — not this smoke reaching
      //        around it — so the tree is proving it sees an AGENT's footprint. ───────
      await ES(`window.__mogging.explorer.resetBatches()`)
      const win32 = process.platform === 'win32'
      const shellWrite = win32 ? 'echo agent> src\\agent-made.ts\r' : "echo agent > src/agent-made.ts\r"
      const shellDelete = win32 ? 'del src\\doomed.ts\r' : 'rm src/doomed.ts\r'
      const shellModify = win32 ? 'echo changed> src\\index.ts\r' : "echo changed > src/index.ts\r"

      await ES(`window.__mogging.panes[0].write(${JSON.stringify(shellWrite)})`)
      const createdMs = await awaitRow('agent-made.ts', true)
      await ES(`window.__mogging.panes[0].write(${JSON.stringify(shellDelete)})`)
      const deletedMs = await awaitRow('doomed.ts', false)
      await ES(`window.__mogging.panes[0].write(${JSON.stringify(shellModify)})`)
      await sleep(1200)
      const batches = await ES<string[][]>(`window.__mogging.explorer.batches()`)
      const liveTreeOk =
        createdMs >= 0 && createdMs <= 1000 && // an agent's write shows up within a second…
        deletedMs >= 0 && deletedMs <= 1000 && // …and so does its deletion
        batches.length > 0 && batches.length <= 6 && // …coalesced, never a stream
        batches.every((b) => b.every((d) => d.startsWith(F.repo))) // …and only about what is visible

      // ── (3) The decorations flip on the SHARED git tick; the count is porcelain's ──
      await sleep(3500) // > one 2.5s tick
      const truth = await probeGitFull(F.repo, true)
      const truthFiles = truth.files ?? []
      const decor = await ES<{
        added: { letter: string | null; tone: string | null } | null
        modified: { letter: string | null; tone: string | null } | null
        srcDir: { letter: string | null; tone: string | null } | null
        count: number
        files: { path: string; state: string }[]
      }>(`(() => {
        const X = window.__mogging.explorer
        return {
          added: X.decorationOf(${JSON.stringify(join(F.repo, 'src', 'agent-made.ts'))}),
          modified: X.decorationOf(${JSON.stringify(join(F.repo, 'src', 'index.ts'))}),
          srcDir: X.decorationOf(${JSON.stringify(join(F.repo, 'src'))}),
          count: X.lensCount(),
          files: X.gitFiles()
        }
      })()`)
      const decorOk =
        decor.added?.letter === 'U' && // the agent's new file is untracked
        decor.modified?.letter === 'M' &&
        decor.srcDir?.tone !== null && decor.srcDir?.letter === null && // folders take COLOUR, no letter
        decor.count === truthFiles.length && // the Changes count IS porcelain's
        decor.files.length === truthFiles.length

      // ── (4) The lens: filter to what changed, restore expansion exactly ───────────
      const beforeLens = await ES<string[]>(`window.__mogging.explorer.expandedDirs()`)
      await ES(`window.__mogging.explorer.setLens(true)`)
      await sleep(900)
      const lensNames = await ES<string[]>(`window.__mogging.explorer.rowNames()`)
      await ES(`window.__mogging.explorer.setLens(false)`)
      await sleep(900)
      const afterLens = await ES<string[]>(`window.__mogging.explorer.expandedDirs()`)
      const lensOk =
        lensNames.includes('agent-made.ts') && lensNames.includes('index.ts') &&
        !lensNames.includes('README.md') && // a clean file does not survive the lens
        JSON.stringify(afterLens.slice().sort()) === JSON.stringify(beforeLens.slice().sort())

      // ── (5) The verbs: delegate, copy, type — and NEVER execute ───────────────────
      const target = join(F.repo, 'src', 'index.ts')
      const openRes = await ES<{ ok: boolean }>(`window.__mogging.explorer.osOpen(${JSON.stringify(target)})`)
      const outsideRes = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(join(F.outside, 'nope.txt'))})`
      )
      clipboard.writeText('sentinel')
      await ES(`window.__mogging.explorer.menuFor(${JSON.stringify(target)})`)
      await sleep(300)
      await ES(`[...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('Copy path')).click()`)
      await sleep(400)
      const copied = clipboard.readText()
      const promptsBefore = (await ES<string>(`window.__mogging.panes[0].text()`)).split('\n').filter((l) => /[>$#]/.test(l.trim())).length
      await ES(`document.querySelector('#workspace-host .xterm-helper-textarea').focus()`)
      await sleep(200)
      const insertText = await ES<string>(`window.__mogging.explorer.insertTextFor(${JSON.stringify(target)})`)
      await ES(`window.__mogging.explorer.sendToPane(${JSON.stringify(target)})`)
      await sleep(1000)
      const paneText = await ES<string>(`window.__mogging.panes[0].text()`)
      const promptsAfter = paneText.split('\n').filter((l) => /[>$#]/.test(l.trim())).length
      const verbsOk =
        openRes.ok === true && spy.opened.includes(target) && // it reached the OS…
        outsideRes.ok === false && outsideRes.reason === 'outside-root' && // …and a path outside the tree did NOT
        copied === target && // the clipboard has the path
        !/[\r\n]/.test(insertText) && // the insert carries no carriage return…
        paneText.replace(/\n/g, '').includes(insertText) && // …it landed on the input line…
        promptsAfter === promptsBefore // …and NOTHING RAN (no new prompt: Enter was never pressed)

      // ── (6) Switch: re-root inside the perception budget, expansion remembered ─────
      const switchAway = await ES<{ ms: number; root: string; empty: boolean; calls: number }>(`(async () => {
        const X = window.__mogging.explorer
        X.resetCalls()
        const t0 = performance.now()
        window.__mogging.workspace.switchByIndex(1)          // -> the folderless workspace
        for (let i = 0; i < 240; i++) {
          if (X.rootPath() === '' && document.querySelector('.explorer-dock .empty-state')) break
          await new Promise((r) => requestAnimationFrame(r))
        }
        return {
          ms: Math.round(performance.now() - t0),
          root: X.rootPath(),
          empty: !!document.querySelector('.explorer-dock .empty-state'),
          calls: X.listCalls().length
        }
      })()`)
      // (7) A workspace with no folder: an EmptyState, and ZERO listings.
      const emptyOk = switchAway.root === '' && switchAway.empty && switchAway.calls === 0

      const switchBack = await ES<{ ms: number; root: string; dirs: string[]; names: string[] }>(`(async () => {
        const X = window.__mogging.explorer
        const t0 = performance.now()
        window.__mogging.workspace.switchByIndex(0)
        for (let i = 0; i < 240; i++) {
          if (X.rootPath() === ${JSON.stringify(F.repo)} && X.rowNames().includes('index.ts')) break
          await new Promise((r) => requestAnimationFrame(r))
        }
        return { ms: Math.round(performance.now() - t0), root: X.rootPath(), dirs: X.expandedDirs(), names: X.rowNames() }
      })()`)
      const switchOk =
        switchBack.root === F.repo &&
        switchBack.ms <= BUDGET.switchMs && // the perception budget, WITH the explorer open
        switchBack.dirs.length === 3 && // …and we RETURNED: the three dirs are still open
        switchBack.names.includes('agent-made.ts')

      // ── (10) The BUDGETS, on the composed surface: 16 panes + explorer + torrent ───
      await ES(`window.__mogging.layout.apply(16)`)
      await sleep(9000) // sixteen shells spawn
      // Count the ACTIVE workspace's panes, the MILESTONE way: pane ids are
      // `ordinal*100 + slot`, and `__mogging.panes` accumulates across every workspace —
      // the folderless one has a pane too, and it is not part of this measurement.
      const mounted = await ES<number>(`(() => {
        const base = (window.__mogging.workspace.active()?.ordinal ?? 0) * 100
        return window.__mogging.panes.filter((p) => p.id > base && p.id <= base + 16).length
      })()`)
      const framesPromise = ES<{ frames: number; avgFps: number; maxGapMs: number; over100: number }>(`(async () => {
        const gaps = []
        let last = performance.now()
        const t0 = last
        await new Promise((res) => {
          const step = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            if (now - t0 >= 6000) return res()
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
        const warm = gaps.slice(3)
        const total = warm.reduce((a, b) => a + b, 0)
        return {
          frames: gaps.length,
          avgFps: Math.round((warm.length / (total / 1000)) * 10) / 10,
          maxGapMs: Math.round(Math.max(...warm) * 10) / 10,
          over100: warm.filter((g) => g > 100).length
        }
      })()`)
      await sleep(400)
      // The torrent: an agent fleet writing hard into the folders the tree is showing.
      for (let round = 0; round < 5; round++) {
        for (const d of ['src', 'docs', 'lib']) {
          for (let i = 0; i < 40; i++) writeFileSync(join(F.repo, d, `torrent-${round}-${i}.txt`), 'x')
        }
        await sleep(120)
      }
      const frames = await framesPromise
      const heapMB = await ES<number>(`Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)`)
      const gpuSoft = process.env.MOGGING_CI_GPU === 'soft'
      const budgetOk =
        mounted === 16 &&
        frames.avgFps >= BUDGET.minAvgFps &&
        heapMB > 0 && heapMB <= BUDGET.maxHeapMB &&
        (gpuSoft ? frames.over100 <= 5 : frames.maxGapMs <= BUDGET.maxFrameGapMs)

      // ── (8) CLOSE IT: zero handles, zero polls, zero git traffic ───────────────────
      await ES(`window.__mogging.explorer.resetGitEvents()`)
      await ES(`window.__mogging.explorer.toggle(false)`)
      await sleep(4000) // more than a git tick: a closed explorer must hear nothing
      const shutStats = explorerWatchStats()
      const gitAfterClose = await ES<number>(`window.__mogging.explorer.gitEvents()`)
      const closedOk =
        closedStatsBefore.handles === 0 && closedStatsBefore.polls === 0 && // …before it ever opened
        shutStats.handles === 0 && shutStats.polls === 0 && // …and after it closed
        gitAfterClose === 0 // …with not one git:files* message in between

      // ── (9) ATTENTION SURVIVED the entire run ─────────────────────────────────────
      const attentionAtEnd = await ES<string>(
        `document.querySelector('#workspace-host .pane-state')?.dataset.state ?? ''`
      )
      const attentionOk = attentionAtStart === 'needs-input' && attentionAtEnd === 'needs-input'

      const pass =
        openOk && watchOk && liveTreeOk && decorOk && lensOk && verbsOk && switchOk && emptyOk && budgetOk && closedOk && attentionOk
      result = {
        pass,
        openOk, opened,
        watchOk, liveStats, cap: WATCH_POOL_CAP,
        liveTreeOk, createdMs, deletedMs, batchCount: batches.length,
        decorOk, decor, truthCount: truthFiles.length,
        lensOk, lensNames, beforeLens, afterLens,
        verbsOk, openRes, outsideRes, copied, insertText, promptsBefore, promptsAfter, spy,
        switchOk, switchBack, emptyOk, switchAway,
        budgetOk, budget: BUDGET, mounted, frames, heapMB, gpuSoft,
        closedOk, closedStatsBefore, shutStats, gitAfterClose,
        attentionOk, attentionAtStart, attentionAtEnd,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    setExplorerShellPortForSmoke(null)
    try {
      if (fx) rmSync(join(fx.repo, '..'), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'filesmilestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

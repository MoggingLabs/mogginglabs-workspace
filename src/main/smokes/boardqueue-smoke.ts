import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsStore } from '../app-settings'
import { boardDebug } from '../board'

// Env-gated QUEUE gate (MOGGING_BOARDQUEUE) — the board PULLS, with every
// safety the feature was specified around, each driven through the REAL
// engine and the REAL enable flow:
//   (a) DEFAULT OFF — a fresh board's queue is disabled, and ticking it does
//       nothing
//   (b) the enable flow is a RISK CONFIRM (quota copy on screen): the toggle
//       alone enables nothing; Cancel keeps it off; confirming enables and
//       stamps the acknowledgment
//   (c) the pull: one tick launches exactly the TOP To-do card (position
//       order), binds it, moves it to Doing — and respects maxConcurrent
//       while that agent lives
//   (d) the BUDGET is a hard ceiling: launches/hour spent → no further launch
//       even with free slots; raising the budget resumes
//   (e) two consecutive FAILED launches (fail-closed handoffs) PAUSE the
//       queue: enabled flips off with the reason stored and worn in the head
// The "agent" is the deterministic shell provider + the daemon's own
// typed-launch verdict replayed (the ORCHESTRATION/BOARDFAIL shim) — no
// vendor CLI, no network, no real quota.
export function runBoardQueueSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 220000) // safety net (two fail-closed 9s windows ride this)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (probe: () => Promise<boolean> | boolean, tries = 40, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gap)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1800)
      // Witness every typed-launch verdict the backend publishes — the queue's
      // handoffs must be attributable to THESE events, nothing else.
      await ES(`(() => {
        window.__bqDetections = []
        window.bridge.on('terminal:agent', (p) => { window.__bqDetections.push(p) })
        return 1
      })()`)
      const dir = mkdtempSync(join(tmpdir(), 'mogging-bq-'))
      writeFileSync(join(dir, 'notes.txt'), 'queue world\n')
      await ES(`window.__mogging.workspace.create({ name: 'Queue', cwd: ${JSON.stringify(dir)} })`)
      await sleep(1500)
      const store = getSettingsStore()
      if (!store) throw new Error('no settings store')
      const board = boardDebug().ensureForCwd(dir)
      const boardCfg = (): ReturnType<typeof store.getBoard> => store.getBoard(board.id)

      // (a) default OFF, and an OFF queue pulls nothing.
      const defaultOff = boardCfg()?.config.queue.enabled === false
      const q1 = String(await ES(`window.__mogging.board.createCard('Q first', 'task one')`))
      const q2 = String(await ES(`window.__mogging.board.createCard('Q second', 'task two')`))
      const q3 = String(await ES(`window.__mogging.board.createCard('Q third', 'task three')`))
      await sleep(400)
      await ES(`window.__mogging.board.queueTick()`)
      await sleep(800)
      const noneLaunched = store.listCards(board.id).every((c) => c.paneId == null && c.lane === 'todo')

      // (b) the risk confirm, through the REAL settings sheet. The provider
      // select may be empty on a CLI-less runner — the stored provider is the
      // seam ('shell' is not a CLI), so seed it first, exactly as a machine
      // with a detected CLI would hold one.
      await ES(
        `window.bridge.invoke('board:boardPatch', { id: ${JSON.stringify(board.id)}, patch: { config: { queue: { ...${JSON.stringify(
          board.config.queue
        )}, provider: 'shell', maxConcurrent: 1, launchesPerHour: 1 } } } })`
      )
      await sleep(300)
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('#content.view-board')`))
      await ES(`document.querySelector('.board-head-menu')?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('.ctx-menu .ctx-item')`))
      await ES(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => /Board settings/.test(x.textContent || ''))?.click()`)
      await waitTrue(() => ES<boolean>(`!!document.querySelector('#board-queue-enabled')`))
      const topOverlay = `[...document.querySelectorAll('.modal-overlay:not(.is-closing)')].pop()`
      await ES(`document.querySelector('#board-queue-enabled')?.click()`)
      const confirmUp = await waitTrue(
        () => ES<boolean>(`/quota|credits/i.test((${topOverlay})?.textContent || '') && !!(${topOverlay})?.textContent.includes('UNATTENDED')`),
        20
      )
      const stillUnchecked = await ES<boolean>(`document.querySelector('#board-queue-enabled')?.checked === false`)
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /^Cancel$/.test((b.textContent || '').trim()))?.click()`)
      await sleep(400)
      const offAfterCancel = boardCfg()?.config.queue.enabled === false
      await ES(`document.querySelector('#board-queue-enabled')?.click()`)
      await waitTrue(() => ES<boolean>(`!![...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /enable the queue/i.test(b.textContent || ''))`), 20)
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /enable the queue/i.test(b.textContent || ''))?.click()`)
      const onNow = await waitTrue(() => boardCfg()?.config.queue.enabled === true, 25)
      const ackStamped = (boardCfg()?.config.queue.ackAt ?? null) !== null
      await ES(`[...(${topOverlay})?.querySelectorAll('button') ?? []].find((b) => /^Cancel$/.test((b.textContent || '').trim()))?.click()`)
      await sleep(300)
      const confirmFlowOk = confirmUp && stillUnchecked && offAfterCancel && onNow && ackStamped

      // (c) the pull: the TOP To-do card, and only it (maxConcurrent 1).
      await ES(`window.__mogging.board.queueTick()`)
      const pulled = await waitTrue(() => {
        const c = store.getCard(q1)
        return !!c && c.lane === 'doing' && c.paneId != null
      }, 40)
      const q1Pane = store.getCard(q1)?.paneId ?? 0
      // Replay the daemon's typed-launch verdict so the handoff SUCCEEDS (the
      // same shim ORCHESTRATION rides — a shell launch registers no session).
      await ES(`window.__mogging.agents.detected({ id: ${q1Pane}, agentId: 'claude', cwd: ${JSON.stringify(dir)}, sinceMs: Date.now() })`)
      // The success must REGISTER — a handed outcome is what resets the
      // consecutive-failure counter, so it gets its own bite.
      const handedRegistered = await waitTrue(
        () => ES<boolean>(`window.__mogging.board.queueDebug().outcomes.some((o) => o.startsWith('handed'))`),
        40,
        300
      )
      await ES(`window.__mogging.board.queueTick()`)
      await sleep(800)
      const onlyOne = store.getCard(q2)?.paneId == null && store.getCard(q3)?.paneId == null
      const pullOk = pulled && q1Pane > 0 && onlyOne && handedRegistered
      const launchesAfterFirst = boardCfg()?.config.queue.launches.length ?? 0

      // (d) budget ceiling: slot freed but the hour's budget (1) is spent.
      boardDebug().patchDirect(q1, { lane: 'done' }, 'sync')
      await sleep(400)
      await ES(`window.__mogging.board.queueTick()`)
      await sleep(1000)
      const heldByBudget = store.getCard(q2)?.paneId == null
      await ES(
        `window.bridge.invoke('board:boardPatch', { id: ${JSON.stringify(board.id)}, patch: { config: { queue: { ...${JSON.stringify(
          boardCfg()?.config.queue ?? {}
        )}, enabled: true, launchesPerHour: 10 } } } })`
      )
      await sleep(300)
      await ES(`window.__mogging.board.queueTick()`)
      const q2Pulled = await waitTrue(() => (store.getCard(q2)?.paneId ?? null) != null, 40)
      const q2Pane = store.getCard(q2)?.paneId ?? 0
      await ES(`window.__mogging.agents.detected({ id: ${q2Pane}, agentId: 'claude', cwd: ${JSON.stringify(dir)}, sinceMs: Date.now() })`)
      const budgetOk = launchesAfterFirst === 1 && heldByBudget && q2Pulled

      // (e) two consecutive FAILED launches PAUSE the queue. The failure is
      // INTRINSIC: the provider is an unknown id, and the handoff hands an
      // unknown provider to nothing, ever — whatever a busy machine's process
      // table claims (stray agents get misattributed to fresh subtrees; found
      // live here), the 9s fail-closed window elapses and the outcome is
      // 'failed'. The card unbinds when its failed pane is left behind, so the
      // engine's own poke relaunches it for the second failure; the budget
      // (launchesPerHour = spent + 2) fences exactly the two launches under test.
      boardDebug().patchDirect(q2, { lane: 'review' }, 'sync')
      await sleep(400)
      const spent = boardCfg()?.config.queue.launches.length ?? 0
      await ES(
        `window.bridge.invoke('board:boardPatch', { id: ${JSON.stringify(board.id)}, patch: { config: { queue: { ...${JSON.stringify(
          boardCfg()?.config.queue ?? {}
        )}, enabled: true, provider: 'missing-audit-agent', launchesPerHour: ${spent + 2} } } } })`
      )
      await sleep(300)
      const catchBind = async (not = 0): Promise<number> => {
        await waitTrue(() => {
          const pane = store.getCard(q3)?.paneId ?? null
          return pane != null && pane !== not
        }, 60, 200)
        return store.getCard(q3)?.paneId ?? 0
      }
      await ES(`window.__mogging.board.queueTick()`)
      const q3PaneA = await catchBind()
      const q3Launched = q3PaneA > 0
      const firstFail = await waitTrue(
        () => ES<boolean>(`window.__mogging.board.queueDebug().outcomes.filter((o) => !o.startsWith('handed')).length >= 1`),
        60,
        400
      )
      // Free the card for round two (its failed pane is left for diagnosis —
      // the product behavior) and let the engine's own poke relaunch it.
      boardDebug().patchDirect(q3, { lane: 'todo', paneId: null, workspaceId: null }, 'sync')
      const q3PaneB = await catchBind(q3PaneA)
      const relaunched = q3PaneB > 0 && q3PaneB !== q3PaneA
      const secondFail = await waitTrue(
        () => ES<boolean>(`window.__mogging.board.queueDebug().outcomes.filter((o) => !o.startsWith('handed')).length >= 2`),
        60,
        400
      )
      const paused = await waitTrue(() => {
        const q = boardCfg()?.config.queue
        return q?.enabled === false && !!q?.pausedReason
      }, 30, 400)
      const engineDebug = (await ES(`window.__mogging.board.queueDebug()`)) as Record<string, unknown>
      const detections = (await ES(`(window.__bqDetections || []).slice()`)) as Record<string, unknown>[]
      // The head wears it (the view is open on this board).
      const pausedChip = await waitTrue(
        () => ES<boolean>(`!!document.querySelector('.board-queue-chip.is-paused')`),
        30,
        300
      )
      const pauseOk = q3Launched && firstFail && relaunched && secondFail && paused && pausedChip

      const pass = defaultOff && noneLaunched && confirmFlowOk && pullOk && budgetOk && pauseOk
      result = {
        pass,
        defaultOff,
        noneLaunched,
        confirmFlowOk,
        confirmUp,
        stillUnchecked,
        offAfterCancel,
        onNow,
        ackStamped,
        pullOk,
        handedRegistered,
        q1Pane,
        onlyOne,
        budgetOk,
        launchesAfterFirst,
        heldByBudget,
        q2Pulled,
        pauseOk,
        q3Launched,
        q3PaneA,
        q3PaneB,
        q2Pane,
        firstFail,
        relaunched,
        secondFail,
        paused,
        pausedChip,
        engineDebug,
        detections,
        workspaces: await ES(`window.__mogging.workspace.list().map((w) => ({ name: w.name, ordinal: w.ordinal, cwd: w.cwd }))`),
        cardBindings: store.listCards(board.id).map((c) => ({ id: c.id.slice(0, 6), lane: c.lane, paneId: c.paneId, ws: c.workspaceId })),
        pausedReason: boardCfg()?.config.queue.pausedReason ?? null
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardqueue-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

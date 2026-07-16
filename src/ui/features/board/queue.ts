import { BoardChannels, type Board, type BoardCard, type BoardListing, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { paneInstance } from '../../core/terminal/pane-instance-port'
import { showToast } from '../../components'
import { startOnCard, type CardPort } from './launch'

/**
 * Queue mode — the board PULLS (Phase-9′'s vibe-kanban organ): when a board's
 * queue is enabled, the top To-do card auto-launches an agent in its own
 * worktree whenever a slot frees. The engine is deliberately paranoid, because
 * every launch spends the user's real quota unattended (which is why enabling
 * it demands a risk confirm, and why it is OFF by default):
 *   - a hard per-hour launch budget, engine-enforced (never advisory)
 *   - bounded concurrency (live queue-launched panes count against slots)
 *   - self-pause after two consecutive FAILED launches, with the reason shown
 *   - one kill switch (the settings toggle), effective immediately
 * Cross-iteration state lives in the board's stored config (ADR 0009's law:
 * budgets belong to the ENGINE, not the prompt).
 */

const HOUR_MS = 3_600_000
const TICK_MS = 15_000

interface QueueEngine {
  start(): void
  stop(): void
  /** Deterministic tick for gates + a poke for board:changed bursts. */
  tick(): Promise<void>
  /** Gate visibility: consecutive-failure counters + launch/outcome tallies. */
  debug(): { fails: Record<string, number>; launches: number; outcomes: string[] }
}

export function createQueueEngine(): QueueEngine {
  const bridge = getBridge()
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = false
  const consecutiveFails = new Map<string, number>()
  let launchCount = 0
  /** Launch/outcome tally for the gate + the curious — bounded, app-lifetime. */
  const outcomes: string[] = []
  const noteOutcome = (entry: string): void => {
    outcomes.push(entry)
    if (outcomes.length > 50) outcomes.shift()
  }

  const liveBusy = (cards: BoardCard[]): number =>
    cards.filter((c) => c.lane === 'doing' && c.paneId != null && paneInstance(c.paneId as PaneId) !== undefined).length

  const recentLaunches = (board: Board, now: number): number[] =>
    board.config.queue.launches.filter((t) => Number.isFinite(t) && now - t < HOUR_MS)

  const pause = async (board: Board, reason: string): Promise<void> => {
    // Re-read before writing: the budget recorder patched this board's config
    // since the tick captured it, and a pause must not roll that back.
    const listings = ((await bridge.invoke(BoardChannels.boards)) as BoardListing[]) ?? []
    const fresh = listings.find((b) => b.board.id === board.id)?.board ?? board
    await bridge.invoke(BoardChannels.boardPatch, {
      id: board.id,
      patch: { config: { queue: { ...fresh.config.queue, enabled: false, pausedReason: reason } } }
    })
    showToast({
      tone: 'danger',
      title: `Queue paused — ${board.name}`,
      body: `${reason} Re-enable it in Board settings once the cause is fixed.`,
      timeout: 0
    })
  }

  const pullOne = async (staleBoard: Board): Promise<void> => {
    // Re-read at entry: the tick's listing is already a beat old (poke
    // coalescing), and every gate below — enabled, paused, budget — must hold
    // against what is STORED NOW, or a just-flipped switch launches anyway and
    // the spend record clobbers a concurrent config edit with tick-time state.
    const listings = ((await bridge.invoke(BoardChannels.boards)) as BoardListing[]) ?? []
    const board = listings.find((b) => b.board.id === staleBoard.id)?.board ?? staleBoard
    const queue = board.config.queue
    if (!queue.enabled || queue.pausedReason) return
    if (!queue.provider || board.projectKey.startsWith('::')) return // no provider / no real folder: nothing to launch into
    const cards = ((await bridge.invoke(BoardChannels.list, board.id)) as BoardCard[]) ?? []
    if (liveBusy(cards) >= queue.maxConcurrent) return
    const now = Date.now()
    const launches = recentLaunches(board, now)
    if (launches.length >= queue.launchesPerHour) return // budget spent; the chip says so
    const next = cards
      .filter((c) => c.lane === 'todo' && !c.blocked && c.paneId == null)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)[0]
    if (!next) return
    // Record the spend BEFORE the launch: a crash mid-launch must never
    // under-count the budget (the safe direction is over-counting).
    await bridge.invoke(BoardChannels.boardPatch, {
      id: board.id,
      patch: { config: { queue: { ...queue, launches: [...launches, now] } } }
    })
    // The port must stay LIVE for the whole handoff: stillBound() consults it
    // right up to the moment the task is typed, and a card unbound or moved by
    // ANYONE mid-launch (the human, an agent, a rule) must fail the handoff
    // closed — a tick-time snapshot would type the task anyway. Every accepted
    // write broadcasts board:changed, so the refresh is push-fed, not polled.
    const liveCards = [...cards]
    const port: CardPort = {
      findCard: (id) => liveCards.find((c) => c.id === id),
      patchCard: (card, patch) => {
        Object.assign(card, patch)
        void bridge.invoke(BoardChannels.patch, { id: card.id, patch, actor: 'queue' })
      }
    }
    let refreshing = false
    const offLive = bridge.on(BoardChannels.changed, (payload) => {
      if ((payload as { boardId?: string })?.boardId !== board.id || refreshing) return
      refreshing = true
      void (bridge.invoke(BoardChannels.list, board.id) as Promise<BoardCard[]>)
        .then((fresh) => {
          liveCards.length = 0
          liveCards.push(...(fresh ?? []))
        })
        .finally(() => {
          refreshing = false
        })
    })
    launchCount++
    const launchedCardId = next.id
    const launched = await startOnCard(port, next.id, queue.provider, { cwd: board.projectKey, actor: 'queue' })
    if (!launched.opened || !launched.outcome) {
      offLive()
      noteOutcome(`no-open:${launchedCardId.slice(0, 6)}`)
      await registerFailure(board)
      return
    }
    void launched.outcome.then(async (outcome) => {
      offLive()
      noteOutcome(`${outcome}:${launchedCardId.slice(0, 6)}`)
      if (outcome === 'handed') {
        consecutiveFails.set(board.id, 0)
        return
      }
      await registerFailure(board)
    })
  }

  const registerFailure = async (board: Board): Promise<void> => {
    const fails = (consecutiveFails.get(board.id) ?? 0) + 1
    consecutiveFails.set(board.id, fails)
    if (fails >= 2) {
      consecutiveFails.set(board.id, 0)
      await pause(board, 'Two queue launches in a row failed to hand their task to an agent.')
    }
  }

  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const listings = ((await bridge.invoke(BoardChannels.boards)) as BoardListing[]) ?? []
      for (const { board } of listings) {
        if (!board.config.queue.enabled) continue
        try {
          await pullOne(board)
        } catch {
          /* one board's trouble must not stall the others */
        }
      }
    } catch {
      /* boards unreadable this beat; the next tick retries */
    } finally {
      inFlight = false
    }
  }

  // board:changed lands on every accepted write — a card leaving Doing frees a
  // slot NOW, not at the next interval. Debounced: a burst is one look.
  let pokeTimer: ReturnType<typeof setTimeout> | null = null
  const poke = (): void => {
    if (pokeTimer) return
    pokeTimer = setTimeout(() => {
      pokeTimer = null
      void tick()
    }, 400)
  }

  return {
    start: () => {
      if (timer) return
      timer = setInterval(() => void tick(), TICK_MS)
      bridge.on(BoardChannels.changed, poke)
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    debug: () => ({ fails: Object.fromEntries(consecutiveFails), launches: launchCount, outcomes: [...outcomes] })
  }
}

/** Render-time queue summary for the board head chip — pure, no engine state. */
export function queueChipState(
  board: Board,
  cards: BoardCard[]
): { enabled: boolean; paused: string | null; busy: number; max: number; exhausted: boolean } {
  const queue = board.config.queue
  const now = Date.now()
  return {
    enabled: queue.enabled,
    paused: queue.pausedReason ?? null,
    busy: cards.filter((c) => c.lane === 'doing' && c.paneId != null && paneInstance(c.paneId as PaneId) !== undefined).length,
    max: queue.maxConcurrent,
    exhausted: queue.launches.filter((t) => now - t < HOUR_MS).length >= queue.launchesPerHour
  }
}

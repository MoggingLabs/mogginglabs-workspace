import {
  BoardChannels,
  type Board,
  type BoardCard,
  type BoardCardPatch,
  type BoardLane,
  type BoardListing,
  type BoardPatchResult
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { createAsyncGuard } from '../../core/async/async-state'
import { showToast } from '../../components'
import { getWorkspaces, onWorkspacesChange } from '../../core/workspace/workspace-info-port'

/**
 * The board's renderer-side state + persistence client. Main is the ONE writer
 * (revision CAS): every mutation here is optimistic — apply locally, send the
 * field patch WITH the expected revision, and on any disagreement re-read what
 * is actually stored (the finding-39 discipline: a board that silently
 * disagrees with the database is worse than a repaint). `board:changed` pushes
 * keep the open board live whatever wrote it — an agent, a rule, the queue.
 */

export interface BoardState {
  boards: BoardListing[]
  board: Board | null
  cards: BoardCard[]
}

export interface BoardModel {
  state: BoardState
  onChange(cb: () => void): () => void
  /** Resolve + load the ACTIVE workspace's board (find-or-create, main-side). */
  openForActiveWorkspace(): Promise<void>
  switchTo(boardId: string): Promise<void>
  reload(): Promise<void>
  createCard(input: { title: string; notes?: string; lane?: BoardLane }): Promise<BoardCard | null>
  patchCard(card: BoardCard, patch: BoardCardPatch, opts?: { action?: string }): void
  moveCard(card: BoardCard, lane: BoardLane): void
  reorderCard(card: BoardCard, lane: BoardLane, beforeId: string | null): void
  removeCard(id: string): void
  cardsInLane(lane: BoardLane): BoardCard[]
  findCard(id: string): BoardCard | undefined
  dispose(): void
}

const laneSort = (a: BoardCard, b: BoardCard): number => a.position - b.position || a.createdAt - b.createdAt

export function createBoardModel(): BoardModel {
  const bridge = getBridge()
  const state: BoardState = { boards: [], board: null, cards: [] }
  const subs = new Set<() => void>()
  const emit = (): void => {
    for (const cb of subs) cb()
  }

  /** A board the user picked by hand sticks until the next workspace switch. */
  let pinnedBoardId: string | null = null
  let lastActiveWs: string | null = null
  let loadSeq = 0

  const loadBoards = async (): Promise<void> => {
    state.boards = ((await bridge.invoke(BoardChannels.boards)) as BoardListing[]) ?? []
  }

  const loadCards = async (): Promise<void> => {
    const board = state.board
    if (!board) {
      state.cards = []
      return
    }
    const seq = ++loadSeq
    const cards = ((await bridge.invoke(BoardChannels.list, board.id)) as BoardCard[]) ?? []
    // A stale read must not overwrite a newer one (the ASYNCSTATE law).
    if (seq === loadSeq && state.board?.id === board.id) state.cards = cards
  }

  const reload = async (): Promise<void> => {
    await Promise.all([loadBoards(), loadCards()])
    // The switcher's meta may be fresher than the loaded board (rename/config).
    const mine = state.boards.find((b) => b.board.id === state.board?.id)
    if (mine) state.board = mine.board
    emit()
  }

  const openBoard = async (board: Board | null): Promise<void> => {
    state.board = board
    await reload()
  }

  const openForActiveWorkspace = async (): Promise<void> => {
    const snap = getWorkspaces()
    const activeWs = snap.workspaces.find((w) => w.id === snap.activeId) ?? snap.workspaces[0]
    if (pinnedBoardId) {
      const pinned = state.boards.find((b) => b.board.id === pinnedBoardId)?.board
      if (pinned) {
        await openBoard(pinned)
        return
      }
      pinnedBoardId = null
    }
    // The LIVE cwd rides along: a just-created workspace resolves its board
    // before the debounced state save lands. No workspace yet → Unfiled, so
    // the board is usable before any project is open.
    const board = (await bridge.invoke(BoardChannels.forWorkspace, {
      workspaceId: activeWs?.id ?? '',
      cwd: activeWs?.cwd ?? ''
    })) as Board | null
    await openBoard(board)
  }

  const switchTo = async (boardId: string): Promise<void> => {
    pinnedBoardId = boardId
    const board = state.boards.find((b) => b.board.id === boardId)?.board ?? null
    if (board) await openBoard(board)
  }

  // The loaded board FOLLOWS the active workspace — also while the view is
  // hidden, so card verbs (launch, dev handles, chips) always act on the board
  // of the project actually in front of the user. A manual pick sticks only
  // until the next workspace switch (predictable, both ways).
  const offWs = onWorkspacesChange((snap) => {
    const active = snap.activeId ?? null
    if (active === lastActiveWs) return
    if (lastActiveWs !== null) pinnedBoardId = null
    lastActiveWs = active
    void openForActiveWorkspace()
  })

  // ── writes: optimistic, guarded, reconciled ───────────────────────────────
  const saveGuard = createAsyncGuard<void>()
  const removeGuard = createAsyncGuard<void>()

  const patchCard = (card: BoardCard, patch: BoardCardPatch, opts?: { action?: string }): void => {
    const expectedRevision = card.revision
    // Optimistic: the card moves on screen before the write lands. `beforeId`
    // is an instruction, not a field — it must not land on the card object.
    const { beforeId: _beforeId, ...fields } = patch
    Object.assign(card, fields, { updatedAt: Date.now(), revision: card.revision + 1 })
    emit()
    // …and the write's outcome decides whether the screen was telling the truth.
    void saveGuard.run(
      async () => {
        const result = (await bridge.invoke(BoardChannels.patch, {
          id: card.id,
          expectedRevision,
          patch,
          actor: 'human'
        })) as BoardPatchResult
        if (result.ok) {
          // Adopt the server's truth (position policy + revision live there).
          const mine = state.cards.find((c) => c.id === card.id)
          if (mine) Object.assign(mine, result.card)
          emit()
          return
        }
        if (result.reason === 'conflict') {
          showToast({ tone: 'attention', title: 'Card changed elsewhere', body: 'The board was refreshed with the stored version.' })
        } else {
          showToast({ tone: 'danger', title: 'That change was not saved', body: `The write was refused (${result.reason}).` })
        }
        await reload() // put the board back to what is actually stored
      },
      {
        action: opts?.action ?? 'save the card',
        onError: (message) => {
          showToast({ tone: 'danger', title: 'That change was not saved', body: message })
          void reload()
        }
      }
    )
  }

  const moveCard = (card: BoardCard, lane: BoardLane): void => {
    if (card.lane === lane) return
    patchCard(card, { lane }, { action: 'move the card' })
  }

  const reorderCard = (card: BoardCard, lane: BoardLane, beforeId: string | null): void => {
    if (beforeId === card.id) return
    if (!beforeId && card.lane === lane) return // dropped on its own lane tail: nothing to say
    // Provisional position so the drop paints where it landed; the server's
    // answer (its position policy owns rebalancing) replaces it a beat later.
    const siblings = state.cards.filter((c) => c.lane === lane && c.id !== card.id).sort(laneSort)
    if (beforeId) {
      const at = siblings.findIndex((c) => c.id === beforeId)
      if (at >= 0) card.position = (at > 0 ? (siblings[at - 1].position + siblings[at].position) / 2 : siblings[at].position - 1)
    } else if (siblings.length) {
      card.position = siblings[siblings.length - 1].position + 1
    }
    patchCard(card, beforeId ? { lane, beforeId } : { lane }, { action: 'reorder the card' })
  }

  const createCard = async (input: { title: string; notes?: string; lane?: BoardLane }): Promise<BoardCard | null> => {
    const board = state.board
    if (!board) return null
    try {
      const card = (await bridge.invoke(BoardChannels.create, {
        boardId: board.id,
        title: input.title,
        notes: input.notes ?? '',
        lane: input.lane ?? 'todo',
        actor: 'human'
      })) as BoardCard | null
      if (card) {
        state.cards.push(card)
        emit()
      }
      return card
    } catch (e) {
      showToast({ tone: 'danger', title: 'The card was not created', body: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  const removeCard = (id: string): void => {
    state.cards = state.cards.filter((c) => c.id !== id)
    emit()
    void removeGuard.run(() => bridge.invoke(BoardChannels.remove, id) as Promise<void>, {
      action: 'delete the card',
      onError: (message) => {
        showToast({ tone: 'danger', title: 'The card was not deleted', body: message })
        void reload() // the card is still there — show that, rather than pretending
      }
    })
  }

  // ── live: any accepted write, any writer, repaints the open board ─────────
  let reloadQueued = false
  bridge.on(BoardChannels.changed, (payload) => {
    const boardId = (payload as { boardId?: string })?.boardId
    if (!state.board || (boardId && boardId !== state.board.id)) return
    if (reloadQueued) return // coalesce a burst into one read
    reloadQueued = true
    setTimeout(() => {
      reloadQueued = false
      void reload()
    }, 80)
  })

  return {
    state,
    onChange: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    openForActiveWorkspace,
    switchTo,
    reload,
    createCard,
    patchCard,
    moveCard,
    reorderCard,
    removeCard,
    cardsInLane: (lane) => state.cards.filter((c) => c.lane === lane).sort(laneSort),
    findCard: (id) => state.cards.find((c) => c.id === id),
    dispose: () => {
      subs.clear()
      offWs()
    }
  }
}

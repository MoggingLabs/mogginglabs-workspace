import type { UiFeature } from '../../core/registry/feature-registry'
import { BoardChannels, IntegrationsChannels, type AgentInfo, type BoardCard, type BoardLane, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { activeView, onViewChange, setActiveView } from '../../core/shell/view-port'
import { requestWorkspaceSwitch } from '../../core/workspace/workspace-info-port'
import { onAttentionChange } from '../../core/attention/attention-port'
import { getPaneCwd, onPaneCwd } from '../../core/layout/pane-cwd'
import { setCommands } from '../../core/commands/command-port'
import { shortcutsBlocked } from '../../core/commands/context'
import { isModKey } from '../../core/commands/shortcuts'
import { onAgentRegistryChange } from '../../core/agents/registry'
import { Button, confirmDialog, createModal, el, icon, openContextMenu, showToast } from '../../components'
import { initApprovals, isBranchApproved, onApprovalsChange } from './approvals-store'
import { createBoardModel } from './model'
import { createBoardView, type BoardFilter } from './view'
import { openCardDetail } from './detail'
import { openBoardSettings } from './board-settings'
import { startOnCard } from './launch'
import { initLinks, linkCardModal, linkFor, loadLinks, onLinksChange, serviceLinkChip, snapshotHasUnknownLink } from './links'
import { createQueueEngine, queueChipState } from './queue'
import type { CardContext, CardVerbs } from './card'

/**
 * The Board (Phase-3/05, rebuilt as Board v2): per-PROJECT kanban whose cards
 * LAUNCH agents. One board per repo/folder — every workspace (and every agent
 * worktree) of a project shares it; a switcher reaches the rest. Main owns all
 * writes (revision CAS), `board:changed` keeps this view live whoever wrote,
 * and the queue can pull the top To-do card into a fresh agent when a slot
 * frees (default OFF, risk-confirmed). The board remains a VIEW: it launches
 * through the open/wizard/launch seams and never spawns PTYs itself. Card text
 * is USER CONTENT — it round-trips the local db and nothing else (ADR 0005).
 */

export const boardFeature: UiFeature = {
  name: 'board',
  mount(ctx) {
    const bridge = getBridge()
    const model = createBoardModel()
    const filter: BoardFilter = { text: '', priority: null }
    let roster: AgentInfo[] = []

    // ── verbs (one implementation; menu + detail + drop all call these) ──────
    const verbs: CardVerbs = {
      edit: (card) => openCardDetail(model, card, card.lane),
      confirmDelete: (card) => {
        void confirmDialog({
          title: `Delete “${card.title || 'card'}”?`,
          message: 'This removes the card and its activity for good — archiving keeps them. A bound pane, if any, keeps running.',
          confirmLabel: 'Delete card',
          danger: true
        }).then((ok) => {
          if (ok) model.removeCard(card.id)
        })
      },
      archive: (card) => model.patchCard(card, { archivedAt: Date.now() }, { action: 'archive the card' }),
      restore: (card) => model.patchCard(card, { archivedAt: null }, { action: 'restore the card' }),
      startOn: (card, providerId) => void startOnCard(model, card.id, providerId),
      goToPane: (card) => {
        if (card.workspaceId) requestWorkspaceSwitch(card.workspaceId)
        setActiveView('grid')
      },
      releaseClaim: (card) => model.patchCard(card, { paneId: null, workspaceId: null }, { action: 'release the claim' }),
      linkGitHub: (card) => linkCardModal(card, () => void refreshLinks(true)),
      refreshLink: (card) => {
        const link = linkFor(card.id)
        if (link) void bridge.invoke(IntegrationsChannels.linkRefresh, link.id)
      },
      unlink: (card) => {
        const link = linkFor(card.id)
        if (link) void bridge.invoke(IntegrationsChannels.linkRemove, link.id).then(() => refreshLinks(true))
      },
      findPr: async (card) => {
        const r = (await bridge.invoke(BoardChannels.ghFindPr, card.id)) as { ok: boolean; ref?: string; reason?: string }
        if (r.ok) {
          showToast({ tone: 'info', title: `Linked ${r.ref}` })
          await refreshLinks(true)
        } else {
          showToast({ tone: 'danger', title: 'No PR linked', body: r.reason })
        }
      },
      pushToGitHub: (card) => {
        // Write-back is board-gated app-side; the confirm here is the ACT's own
        // "this leaves the machine" moment (the grant was the standing consent).
        void confirmDialog({
          title: 'Create a GitHub issue from this card?',
          message: `“${card.title.slice(0, 80)}” — its title and notes are sent to the bound repository via your own gh. Needs write-back enabled in Board settings.`,
          confirmLabel: 'Create issue',
          danger: true
        }).then(async (ok) => {
          if (!ok) return
          const r = (await bridge.invoke(BoardChannels.ghPush, card.id)) as { ok: boolean; ref?: string; reason?: string }
          if (r.ok) {
            showToast({ tone: 'info', title: `Created ${r.ref}` })
            await refreshLinks(true)
          } else {
            showToast({ tone: 'danger', title: 'Issue not created', body: r.reason })
          }
        })
      },
      closeIssue: (card) => {
        void confirmDialog({
          title: 'Close the linked GitHub issue?',
          message: 'The linked issue is closed on GitHub via your own gh. Needs write-back enabled in Board settings.',
          confirmLabel: 'Close issue',
          danger: true
        }).then(async (ok) => {
          if (!ok) return
          const r = (await bridge.invoke(BoardChannels.ghClose, card.id)) as { ok: boolean; ref?: string; reason?: string }
          if (r.ok) showToast({ tone: 'info', title: `Closed ${r.ref}` })
          else showToast({ tone: 'danger', title: 'Issue not closed', body: r.reason })
        })
      }
    }

    const cardContext = (): CardContext => ({
      model,
      board: model.state.board,
      roster,
      linked: (card) => !!linkFor(card.id),
      serviceLinkChip,
      verbs,
      onMenuClick: () => {} // the view substitutes its own (menu bookkeeping lives there)
    })

    // ── archived viewer ───────────────────────────────────────────────────────
    const showArchived = async (): Promise<void> => {
      const board = model.state.board
      if (!board) return
      const cards = ((await bridge.invoke(BoardChannels.archived, board.id)) as BoardCard[]) ?? []
      const modal = createModal({ title: `Archived — ${board.name}`, width: 560 })
      const list = el('div', { class: 'board-archived-list' })
      if (!cards.length) list.append(el('div', { class: 'board-activity-empty', text: 'Nothing archived.' }))
      for (const card of cards) {
        const row = el('div', { class: 'board-archived-row' }, [
          el('div', { class: 'board-archived-text' }, [
            el('span', { class: 'board-archived-title', text: card.title }),
            el('span', {
              class: 'board-archived-when',
              text: card.archivedAt ? new Date(card.archivedAt).toLocaleDateString() : ''
            })
          ]),
          Button({
            label: 'Restore',
            onClick: async () => {
              await bridge.invoke(BoardChannels.patch, { id: card.id, patch: { archivedAt: null }, actor: 'human' })
              row.remove()
              await model.reload()
            }
          })
        ])
        list.append(row)
      }
      modal.setBody(list)
      modal.setFooter(el('div', { class: 'board-edit-footer' }, [Button({ label: 'Close', onClick: () => modal.close() })]))
      modal.open()
    }

    const openBoardMenu = (trigger: HTMLElement): void => {
      const r = trigger.getBoundingClientRect()
      openContextMenu({
        items: [
          { label: 'Board settings…', icon: 'sliders', onSelect: () => openBoardSettings(model, roster) },
          { label: 'Show archived…', icon: 'bookmark', onSelect: () => void showArchived() }
        ],
        x: r.right - 200,
        y: r.bottom + 4,
        returnFocus: trigger,
        ariaLabel: 'Board menu'
      })
    }

    // ── head extras: queue chip (state is stored config + live panes) ─────────
    const headExtras = (): (HTMLElement | null)[] => {
      const board = model.state.board
      const extras: (HTMLElement | null)[] = []
      if (board?.repoRef) {
        extras.push(
          el('span', { class: 'board-repo-chip', attrs: { title: 'Bound GitHub repository' } }, [
            icon('git-branch', 12),
            el('span', { text: board.repoRef })
          ])
        )
      }
      if (board && (board.config.queue.enabled || board.config.queue.pausedReason)) {
        const q = queueChipState(board, model.state.cards)
        const label = q.paused ? 'Queue paused' : q.exhausted ? 'Queue: budget spent' : `Queue on · ${q.busy}/${q.max}`
        const chip = el(
          'button',
          {
            class: `board-queue-chip${q.paused ? ' is-paused' : q.exhausted ? ' is-exhausted' : ''}`,
            attrs: { type: 'button', title: q.paused ?? 'Queue mode — open Board settings' },
            onClick: () => openBoardSettings(model, roster)
          },
          [icon('activity', 12), el('span', { text: label })]
        )
        extras.push(chip)
      }
      return extras
    }

    const view = createBoardView({
      model,
      cardContext,
      filter,
      onFilterChange: () => view.render(),
      addCard: (lane: BoardLane) => openCardDetail(model, null, lane),
      openBoardMenu,
      headExtras
    })
    ctx.content.append(view.root)

    // ── links: card ↔ PR/issue chips (loads follow the card set) ─────────────
    initLinks()
    let linkSig = ''
    const refreshLinks = async (force = false): Promise<void> => {
      const sig = model.state.cards.map((c) => c.id).sort().join(',')
      if (!force && sig === linkSig) return
      linkSig = sig
      await loadLinks(model.state.cards)
      view.render()
    }
    onLinksChange(() => {
      // A pushed status naming a link we never loaded = a link was minted
      // without the card set changing (IPC link:set, the PR auto-link rule) —
      // re-load the map so its chip paints now, not at the next reload.
      if (snapshotHasUnknownLink()) void refreshLinks(true)
      else view.render()
    })

    // ── live re-renders: the SAME ports the rail glanceability uses ──────────
    model.onChange(() => {
      view.render()
      void refreshLinks()
    })
    onAttentionChange(() => {
      if (model.state.cards.some((c) => c.paneId)) view.render()
    })
    initApprovals()
    onApprovalsChange(() => {
      if (model.state.cards.some((c) => c.paneId || c.branch)) view.render()
    })
    onPaneCwd((paneId, cwd) => {
      const card = model.state.cards.find((c) => c.paneId === paneId)
      if (!card) return
      if (!cwd) {
        // The pane died: unbind (persisted). The branch stays — approvals and
        // PR lookups outlive the pane on purpose.
        model.patchCard(card, { paneId: null, workspaceId: null }, { action: 'unbind the card' })
        return
      }
      // The ✓-chip keys on cwd/branch state that just moved — repaint.
      view.render()
    })
    onAgentRegistryChange((agents) => {
      roster = [...agents]
      if (activeView() === 'board') view.render()
    })

    // ── queue engine (app-wide; per-board config gates it) ───────────────────
    const queue = createQueueEngine()
    queue.start()

    // ── entry points: titlebar button (shell), palette, keyboard ─────────────
    onViewChange((v) => {
      if (v === 'board') void model.openForActiveWorkspace()
    })
    setCommands('board', [
      {
        id: 'board:open',
        title: 'Toggle Board',
        hint: 'Board',
        kbd: 'Ctrl+Shift+G',
        run: () => setActiveView(activeView() === 'board' ? 'grid' : 'board')
      }
    ])
    window.addEventListener('keydown', (e) => {
      // A global shortcut must not fire from a modal or a text field (finding
      // 29), and must use the platform modifier, not bare ctrlKey (finding 28).
      if (shortcutsBlocked(e.target)) return
      if (isModKey(e) && e.shiftKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        setActiveView(activeView() === 'board' ? 'grid' : 'board')
      }
    })
    void model.openForActiveWorkspace()

    // Dev/smoke handle — same pattern as the other features.
    if (import.meta.env.DEV) {
      const g = globalThis as Record<string, unknown>
      const dev = (g.__mogging ?? (g.__mogging = {})) as Record<string, unknown>
      dev.board = {
        list: () => model.state.cards.map((c) => ({ ...c })),
        boards: () => model.state.boards.map((b) => ({ board: { ...b.board }, cards: b.cards })),
        activeBoard: () => (model.state.board ? { ...model.state.board } : null),
        switchTo: (boardId: string) => model.switchTo(boardId),
        createCard: (title: string, notes = ''): Promise<string> =>
          model.createCard({ title, notes }).then((c) => c?.id ?? ''),
        // Fail-closed by design for unknown/unlaunchable providers (BOARDFAIL).
        startOnCard: (id: string, provider: string) => startOnCard(model, id, provider).then((r) => r.opened),
        refresh: () => model.reload(),
        queueTick: () => queue.tick(),
        queueDebug: () => queue.debug(),
        // The ✓-chip is an AND of two independent facts; a gate that can only
        // see the chip cannot say which half failed.
        approvalProbe: (paneId: number, branch: string) => ({
          cwd: getPaneCwd(paneId as PaneId) ?? null,
          approved: isBranchApproved(branch)
        })
      }
    }
  }
}

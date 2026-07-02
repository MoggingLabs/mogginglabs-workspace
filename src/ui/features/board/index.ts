import type { UiFeature } from '../../core/registry/feature-registry'
import {
  AgentChannels,
  BoardChannels,
  GitChannels,
  TerminalChannels,
  WorktreeChannels,
  type AgentInfo,
  type BoardCard,
  type BoardLane,
  type CreateWorktreeResult,
  type PaneId
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { activeView, onViewChange, setActiveView } from '../../core/shell/view-port'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { openWizard } from '../../core/workspace/wizard-port'
import { getWorkspaces, requestWorkspaceSwitch } from '../../core/workspace/workspace-info-port'
import { onAttentionChange, paneState } from '../../core/attention/attention-port'
import { getPaneCwd, onPaneCwd } from '../../core/layout/pane-cwd'
import { setCommands } from '../../core/commands/command-port'
import { Button, createModal, el, icon, showToast } from '../../components'
import { initApprovals, isBranchApproved, onApprovalsChange } from './approvals-store'

/**
 * Local Kanban board (Phase-3/05): "what should the fleet do next" as a surface whose
 * cards LAUNCH agents. A card becomes a worktree-isolated pane with the task as its
 * first prompt, and the card follows the pane's live state through the attention port
 * (event-driven — zero polling). The board is a VIEW: it launches through the
 * open/wizard/launch seams and never spawns PTYs itself. Card text is USER CONTENT —
 * it round-trips the local db and nothing else (ADR 0005: no telemetry, no notify).
 */

const LANES: { id: BoardLane; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' }
]

const newId = (): string =>
  (crypto?.randomUUID ? crypto.randomUUID() : `card-${Date.now()}-${Math.floor(Math.random() * 1e6)}`).slice(0, 64)

export const boardFeature: UiFeature = {
  name: 'board',
  mount(ctx) {
    const bridge = getBridge()
    let cards: BoardCard[] = []
    let roster: AgentInfo[] = []

    const root = el('div', {})
    root.id = 'view-board'
    ctx.content.append(root)

    // ── persistence (main-owned sqlite; the ONLY home of card text) ──────────
    const load = async (): Promise<void> => {
      cards = ((await bridge.invoke(BoardChannels.list)) as BoardCard[]) ?? []
      render()
    }
    const save = (card: BoardCard): void => {
      card.updatedAt = Date.now()
      void bridge.invoke(BoardChannels.save, card)
    }
    const removeCard = (id: string): void => {
      cards = cards.filter((c) => c.id !== id)
      void bridge.invoke(BoardChannels.remove, id)
      render()
    }

    // ── card editor (title + notes) ───────────────────────────────────────────
    function edit(card: BoardCard | null, lane: BoardLane): void {
      const isNew = card == null
      const c: BoardCard =
        card ?? { id: newId(), title: '', notes: '', lane, createdAt: Date.now(), updatedAt: Date.now() }
      const title = el('input', {
        class: 'board-edit-title',
        attrs: { type: 'text', placeholder: 'Task title', value: c.title }
      }) as HTMLInputElement
      const notes = el('textarea', {
        class: 'board-edit-notes',
        attrs: { rows: '6', placeholder: 'Notes / context the agent should get…' }
      }) as HTMLTextAreaElement
      notes.value = c.notes
      const body = el('div', { class: 'board-edit' }, [title, notes])
      const modal = createModal({ title: isNew ? 'New card' : 'Edit card', width: 520 })
      const saveBtn = Button({
        label: isNew ? 'Add card' : 'Save',
        variant: 'primary',
        onClick: () => {
          c.title = title.value.trim()
          c.notes = notes.value
          if (!c.title) {
            showToast({ tone: 'attention', title: 'A card needs a title' })
            return
          }
          if (isNew) cards.push(c)
          save(c)
          modal.close()
          render()
        }
      })
      const cancel = Button({ label: 'Cancel', onClick: () => modal.close() })
      modal.setBody(body)
      modal.setFooter(el('div', { class: 'board-edit-footer' }, [cancel, saveBtn]))
      modal.open()
      setTimeout(() => title.focus(), 50)
    }

    // ── start an agent on a card (through the open/worktree/write seams) ─────
    async function startOnCard(cardId: string, providerId: string): Promise<boolean> {
      const card = cards.find((c) => c.id === cardId)
      if (!card) return false
      const snap = getWorkspaces()
      const active = snap.workspaces.find((w) => w.id === snap.activeId) ?? snap.workspaces[0]
      const cwd = active?.cwd ?? ''
      if (!cwd) {
        // No folder to anchor the task to — hand off to the wizard instead.
        openWizard({ name: card.title.slice(0, 28), mix: [{ provider: providerId, count: 1 }] })
        showToast({ tone: 'info', title: 'Pick a folder', body: 'The card binds when launched from a workspace.' })
        return false
      }
      // Worktree isolation when the folder is a repo (03) — never blocks the launch.
      let paneCwds: (string | null)[] | undefined
      try {
        const isRepo = (await bridge.invoke(GitChannels.query, cwd)) != null
        if (isRepo) {
          const wt = (await bridge.invoke(WorktreeChannels.create, { repo: cwd })) as CreateWorktreeResult
          if (wt.ok && wt.path) paneCwds = [wt.path]
        }
      } catch {
        /* plain cwd launch */
      }
      const opened = openWorkspaceFromTemplate({
        name: card.title.slice(0, 28) || 'Task',
        cwd,
        paneCount: 1,
        assignments: [providerId],
        paneCwds
      })
      if (!opened) return false
      const paneId = opened.ordinal * 100 + 1
      card.paneId = paneId
      card.workspaceId = opened.id
      card.lane = card.lane === 'todo' ? 'doing' : card.lane
      save(card)
      render()
      // The task IS the agent's first prompt: one write through the existing terminal
      // path, after the launch command has had time to boot the CLI. User content
      // travels renderer -> PTY only (never telemetry/notify/logs).
      const prompt = `${card.title}\n\n${card.notes}`.trim().replace(/\r/g, '')
      setTimeout(() => {
        bridge.send(TerminalChannels.write, { id: paneId as PaneId, data: prompt + '\r' })
      }, 4500)
      return true
    }

    // ── rendering ─────────────────────────────────────────────────────────────
    /** ✓ when the card's bound worktree branch holds a live reviewer sign-off. */
    function approvedChip(card: BoardCard): HTMLElement | null {
      if (!card.paneId) return null
      const cwd = getPaneCwd(card.paneId as PaneId) ?? ''
      const m = /[\\/]\.mogging[\\/]worktrees[\\/]([^\\/]+)$/.exec(cwd)
      if (!m || !isBranchApproved(`mogging/${m[1]}`)) return null
      return el('span', { class: 'board-chip board-chip-approved', attrs: { title: 'Approved by the reviewer' } }, [
        icon('check', 12),
        el('span', { text: 'approved' })
      ])
    }

    function cardStateChip(card: BoardCard): HTMLElement | null {
      if (!card.paneId) return null
      const state = paneState(card.paneId as PaneId)
      if (state === 'attention') {
        const btn = el(
          'button',
          {
            class: 'board-chip board-chip-attention',
            attrs: { type: 'button', title: 'Jump to the pane' },
            onClick: () => {
              if (card.workspaceId) requestWorkspaceSwitch(card.workspaceId)
              setActiveView('grid')
            }
          },
          [icon('bell', 12), el('span', { text: 'needs you' })]
        )
        return btn
      }
      return el('span', { class: `board-chip board-chip-${state}` }, [
        icon('terminal', 12),
        el('span', { text: state === 'busy' ? 'working' : 'agent' })
      ])
    }

    function cardEl(card: BoardCard): HTMLElement {
      const menu = el('div', { class: 'menu board-card-menu', hidden: true })
      const menuBtn = el(
        'button',
        {
          class: 'icon-btn board-card-more',
          attrs: { type: 'button', 'aria-label': 'Card menu' },
          onClick: (e) => {
            e.stopPropagation()
            if (menu.hidden) buildMenu()
            menu.hidden = !menu.hidden
          }
        },
        [icon('more', 14)]
      )
      const host = el(
        'article',
        { class: 'board-card', attrs: { draggable: 'true', 'data-card-id': card.id } },
        [
          el('div', { class: 'board-card-head' }, [
            el('h4', { class: 'board-card-title', text: card.title }),
            menuBtn
          ]),
          ...(card.notes.trim() ? [el('p', { class: 'board-card-notes', text: card.notes })] : []),
          el('div', { class: 'board-card-foot' }, [cardStateChip(card) ?? el('span', {}), approvedChip(card)]),
          menu
        ]
      )
      if (card.paneId && paneState(card.paneId as PaneId) === 'attention') host.dataset.attention = 'true'

      function buildMenu(): void {
        menu.replaceChildren()
        const item = (label: string, run: () => void): HTMLElement =>
          el('button', {
            class: 'menu-item',
            attrs: { type: 'button' },
            text: label,
            onClick: (e) => {
              e.stopPropagation()
              menu.hidden = true
              run()
            }
          })
        menu.append(item('Edit…', () => edit(card, card.lane)))
        for (const a of roster.filter((r) => r.installed)) {
          menu.append(item(`Start ${a.name} on this…`, () => void startOnCard(card.id, a.id)))
        }
        if (card.paneId && card.workspaceId) {
          menu.append(
            item('Go to pane', () => {
              requestWorkspaceSwitch(card.workspaceId as string)
              setActiveView('grid')
            })
          )
        }
        menu.append(item('Delete card', () => removeCard(card.id)))
      }

      host.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/mogging-card', card.id)
        host.classList.add('dragging')
      })
      host.addEventListener('dragend', () => host.classList.remove('dragging'))
      host.addEventListener('dblclick', () => edit(card, card.lane))
      return host
    }

    function render(): void {
      root.replaceChildren()
      const head = el('div', { class: 'board-head' }, [
        el('h1', { class: 'board-title', text: 'Board' }),
        el('span', { class: 'board-sub', text: 'Cards launch agents — local only, yours.' })
      ])
      const lanesEl = el('div', { class: 'board-lanes' })
      for (const lane of LANES) {
        const inLane = cards.filter((c) => c.lane === lane.id)
        const list = el('div', { class: 'board-lane-cards' }, inLane.map(cardEl))
        const laneEl = el('section', { class: 'board-lane', attrs: { 'data-lane': lane.id } }, [
          el('div', { class: 'board-lane-head' }, [
            el('h3', { class: 'board-lane-title', text: lane.label }),
            el('span', { class: 'board-lane-count', text: String(inLane.length) })
          ]),
          list,
          el('button', {
            class: 'board-add',
            attrs: { type: 'button' },
            text: '+ Add card',
            onClick: () => edit(null, lane.id)
          })
        ])
        laneEl.addEventListener('dragover', (e) => {
          e.preventDefault()
          laneEl.classList.add('drop')
        })
        laneEl.addEventListener('dragleave', () => laneEl.classList.remove('drop'))
        laneEl.addEventListener('drop', (e) => {
          e.preventDefault()
          laneEl.classList.remove('drop')
          const id = e.dataTransfer?.getData('text/mogging-card')
          const card = id ? cards.find((c) => c.id === id) : null
          if (card && card.lane !== lane.id) {
            card.lane = lane.id
            save(card)
            render()
          }
        })
        lanesEl.append(laneEl)
      }
      root.append(head, lanesEl)
    }

    // ── live card state: the SAME ports the rail glanceability uses ──────────
    onAttentionChange(() => {
      // Cheap targeted update: re-render only when a bound card's visual would change.
      if (cards.some((c) => c.paneId)) render()
    })
    initApprovals()
    onApprovalsChange(() => {
      if (cards.some((c) => c.paneId)) render()
    })
    onPaneCwd((paneId, cwd) => {
      if (cwd) return
      const card = cards.find((c) => c.paneId === paneId)
      if (card) {
        card.paneId = null
        card.workspaceId = null
        save(card)
        render()
      }
    })

    // ── entry points: titlebar button (shell), palette, keyboard ─────────────
    onViewChange((v) => {
      if (v === 'board') void load()
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
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        setActiveView(activeView() === 'board' ? 'grid' : 'board')
      }
    })

    void (bridge.invoke(AgentChannels.detect) as Promise<AgentInfo[]>).then((r) => {
      roster = r ?? []
    })
    void load()

    // Dev/smoke handle — same pattern as the other features.
    if (import.meta.env.DEV) {
      const g = globalThis as Record<string, unknown>
      const dev = (g.__mogging ?? (g.__mogging = {})) as Record<string, unknown>
      dev.board = {
        list: () => cards.map((c) => ({ ...c })),
        createCard: (title: string, notes = ''): string => {
          const c: BoardCard = { id: newId(), title, notes, lane: 'todo', createdAt: Date.now(), updatedAt: Date.now() }
          cards.push(c)
          save(c)
          render()
          return c.id
        },
        startOnCard: (id: string, provider: string) => startOnCard(id, provider),
        refresh: () => load()
      }
    }
  }
}

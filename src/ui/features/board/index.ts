import type { UiFeature } from '../../core/registry/feature-registry'
import {
  BoardChannels,
  GitChannels,
  IntegrationsChannels,
  SERVICE_LINK_CADENCE_DEFAULT,
  TerminalChannels,
  WorktreeChannels,
  isAgentCliId,
  type AgentCliId,
  type AgentInfo,
  type BoardCard,
  type BoardLane,
  type CreateWorktreeResult,
  type LinkStatus,
  type PaneId,
  type ServiceLink
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { createAsyncGuard } from '../../core/async/async-state'
import { activeView, onViewChange, setActiveView } from '../../core/shell/view-port'
import { openWorkspaceFromTemplate } from '../../core/workspace/open-service'
import { openWizard } from '../../core/workspace/wizard-port'
import { getWorkspaces, requestWorkspaceSwitch } from '../../core/workspace/workspace-info-port'
import { onAttentionChange, paneState } from '../../core/attention/attention-port'
import { onPaneAgentSession } from '../../core/agents/agent-session-port'
import { paneInstance } from '../../core/terminal/pane-instance-port'
import { getPaneCwd, onPaneCwd } from '../../core/layout/pane-cwd'
import { setCommands } from '../../core/commands/command-port'
import { shortcutsBlocked } from '../../core/commands/context'
import { isModKey } from '../../core/commands/shortcuts'
import {
  Button,
  CountBadge,
  EmptyState,
  closeContextMenu,
  confirmDialog,
  createModal,
  el,
  icon,
  openContextMenu,
  showToast,
  type ContextMenuEntry
} from '../../components'
import { initApprovals, isBranchApproved, onApprovalsChange } from './approvals-store'
import { onAgentRegistryChange } from '../../core/agents/registry'

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
    // Service links (8/12): a card <-> a GitHub PR/issue, live via gh.
    let linkSnapshot: { statuses: LinkStatus[]; at: number } = { statuses: [], at: 0 }
    const linksByCard = new Map<string, ServiceLink>()

    const root = el('div', {})
    root.id = 'view-board'
    ctx.content.append(root)

    // ── persistence (main-owned sqlite; the ONLY home of card text) ──────────
    const load = async (): Promise<void> => {
      cards = ((await bridge.invoke(BoardChannels.list)) as BoardCard[]) ?? []
      linksByCard.clear()
      await Promise.all(
        cards.map(async (c) => {
          const l = (await bridge.invoke(IntegrationsChannels.linkGet, c.id)) as ServiceLink | null
          if (l) linksByCard.set(c.id, l)
        })
      )
      linkSnapshot = ((await bridge.invoke(IntegrationsChannels.linkStatusGet)) as typeof linkSnapshot) ?? linkSnapshot
      render()
    }
    // Live status push (8/12) repaints the chips — never a re-fetch.
    bridge.on(IntegrationsChannels.linkStatusChanged, (snap) => {
      linkSnapshot = (snap as typeof linkSnapshot) ?? linkSnapshot
      render()
    })

    // "as of {age}" — the ONE relative formatter.
    const fmtAge = (ts: number): string => {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (s < 60) return `${s}s ago`
      if (s < 3600) return `${Math.round(s / 60)}m ago`
      return `${Math.round(s / 3600)}h ago`
    }

    const GLYPH: Record<string, string> = { open: '◌', draft: '◍', merged: '✔', closed: '✕' }
    /** The card-face status chip (state glyph + checks; stale dims). */
    function serviceLinkChip(card: BoardCard): HTMLElement | null {
      const link = linksByCard.get(card.id)
      if (!link) return null
      const st = linkSnapshot.statuses.find((s) => s.linkId === link.id)
      const num = link.ref.split('#')[1] ?? '?'
      if (!st) return el('span', { class: 'board-link-chip is-loading', text: `#${num} …` })
      const checks = st.checks && st.checks !== 'none' ? ` · ${st.checks}` : ''
      const glyph = st.state ? GLYPH[st.state] ?? '' : ''
      const review = st.reviewDecision === 'changes-requested' ? ' ✎' : st.reviewDecision === 'approved' ? ' ✓' : ''
      const chip = el('span', {
        class: `board-link-chip is-${st.state ?? 'open'} health-${st.health} checks-${st.checks ?? 'none'}`,
        text: `${glyph} #${num}${review}${checks}`
      })
      chip.title = `${link.ref}${st.title ? ` — ${st.title}` : ''} · ${st.health === 'stale' ? 'stale, ' : ''}as of ${fmtAge(st.fetchedAt)}${st.reason ? ` (${st.reason})` : ''}`
      return chip
    }

    function linkCard(card: BoardCard): void {
      const existing = linksByCard.get(card.id)
      const input = el('input', { class: 'browser-sites-input', placeholder: 'GitHub PR/issue URL or owner/repo#123' }) as HTMLInputElement
      if (existing) input.value = existing.ref
      input.addEventListener('keydown', (e) => e.stopPropagation())
      const note = el('div', { class: 'settings-error', role: 'alert', hidden: true })
      const m = createModal({ title: 'Link GitHub PR/issue', width: 460 })
      const saveBtn = Button({
        label: 'Link',
        variant: 'primary',
        onClick: async () => {
          const r = (await bridge.invoke(IntegrationsChannels.linkSet, { cardId: card.id, input: input.value, cadence: SERVICE_LINK_CADENCE_DEFAULT })) as { ok: boolean; reason?: string }
          if (r.ok) {
            m.close()
            await load()
          } else {
            note.textContent = r.reason ?? 'refused'
            note.hidden = false
          }
        }
      })
      m.setBody(el('div', { class: 'mgr-form' }, [input, el('div', { class: 'settings-row-caption', text: 'Read-only: the app observes via your own gh; it never changes the PR.' }), note]))
      m.setFooter(el('div', { class: 'confirm-actions' }, [Button({ label: 'Cancel', variant: 'ghost', onClick: () => m.close() }), saveBtn]))
      m.open()
    }
    // The board mutates optimistically — the card moves on screen before the write lands, which
    // is the right feel and was, until now, a lie: `void invoke(...)` with no catch meant a
    // REJECTED write left the card exactly where the user dropped it, in a board that silently
    // disagreed with the database and would keep disagreeing until the next reload (finding 39).
    //
    // The rollback re-reads `board:list` rather than restoring a snapshot. A snapshot taken here
    // is already too late — callers mutate the card in place (moveCard sets card.lane) BEFORE
    // calling save — and a snapshot taken at every call site would be a guess about what the
    // database thinks. Asking it is not a guess.
    const saveGuard = createAsyncGuard<void>()
    const removeGuard = createAsyncGuard<void>()
    const reconcile = async (): Promise<void> => {
      await load()
      render()
    }
    const save = (card: BoardCard): void => {
      card.updatedAt = Date.now()
      void saveGuard.run(() => bridge.invoke(BoardChannels.save, card) as Promise<void>, {
        action: 'save the card',
        onError: (message) => {
          showToast({ tone: 'danger', title: 'That change was not saved', body: message })
          void reconcile() // put the board back to what is actually stored
        }
      })
    }
    const removeCard = (id: string): void => {
      cards = cards.filter((c) => c.id !== id)
      render()
      void removeGuard.run(() => bridge.invoke(BoardChannels.remove, id) as Promise<void>, {
        action: 'delete the card',
        onError: (message) => {
          showToast({ tone: 'danger', title: 'The card was not deleted', body: message })
          void reconcile() // the card is still there — show that, rather than pretending
        }
      })
    }
    /**
     * Move a card between lanes — the board's central verb, and until now reachable ONLY by
     * dragging (finding 31). Drag is a mouse-only gesture: a keyboard user could create a card,
     * launch an agent on it, link a PR and delete it, but could not move it from "Doing" to
     * "Review". This is the ONE mutation, and BOTH doors — the lane's drop handler and the ⋯
     * menu's "Move to …" items — call it, so the two paths cannot drift apart.
     */
    const moveCard = (card: BoardCard, lane: BoardLane): void => {
      if (card.lane === lane) return
      card.lane = lane
      save(card)
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
    async function startOnCard(cardId: string, providerId: AgentCliId): Promise<boolean> {
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
      const targetInstance = paneInstance(paneId as PaneId)
      card.paneId = paneId
      card.workspaceId = opened.id
      card.lane = card.lane === 'todo' ? 'doing' : card.lane
      save(card)
      render()
      // The task IS the agent's first prompt: one write through the existing terminal path.
      // User content travels renderer -> PTY only (never telemetry/notify/logs).
      //
      // WHEN, though, is the whole problem. This used to fire on a 4.5s timer — a guess about
      // how long a CLI takes to boot, and it lost the race often enough to matter: a slower
      // agent is still starting, so the task lands in the SHELL behind it, gets echoed, and is
      // then wiped the moment the CLI takes over the alternate screen. The task is gone and the
      // agent never saw it — the one thing this feature exists to do.
      //
      // The daemon now says when an agent actually appears in the pane's process subtree
      // (typed-launch detection), so wait for THAT and hand the task to something listening.
      // Detection failure must fail CLOSED. Card text is arbitrary user prose; typing it into
      // a pane whose agent never appeared turns that prose into shell input. Keep the failed
      // pane visible for diagnosis and tell the user the task was NOT sent.
      const prompt = `${card.title}\n\n${card.notes}`.trim().replace(/\r/g, '')
      let handed = false
      let offSession: (() => void) | undefined
      let fallback: ReturnType<typeof setTimeout> | undefined
      let settle: ReturnType<typeof setTimeout> | undefined
      const stillBound = (): boolean => {
        const current = cards.find((c) => c.id === cardId)
        return (
          targetInstance !== undefined &&
          paneInstance(paneId as PaneId) === targetInstance &&
          current?.paneId === paneId &&
          current.workspaceId === opened.id
        )
      }
      const cleanup = (): void => {
        offSession?.()
        offSession = undefined
        if (fallback) clearTimeout(fallback)
        fallback = undefined
        if (settle) clearTimeout(settle)
        settle = undefined
      }
      const hand = (): void => {
        if (handed || !stillBound()) {
          cleanup()
          return
        }
        handed = true
        cleanup()
        bridge.send(TerminalChannels.write, { id: paneId as PaneId, data: prompt + '\r' })
      }
      offSession = onPaneAgentSession((id, session) => {
        // A pane's agent going AWAY is not a cue to type into it — and neither is the app's own
        // LAUNCH, which writes this session the instant it types the command, while the CLI is
        // still booting. Only `running` (the backend saw the process in the pane's PTY subtree)
        // means there is something on the other end of the keyboard.
        if (id !== (paneId as PaneId) || !session?.running) return
        // Positive readiness arrived inside the bounded window. Retire the failure
        // deadline now; the short settle beat belongs to the successful handoff and
        // may legitimately finish just after the nine-second startup budget.
        if (fallback) clearTimeout(fallback)
        fallback = undefined
        if (settle) clearTimeout(settle)
        settle = setTimeout(hand, 800) // it is up; give it a beat to paint a prompt to type into
      })
      fallback = setTimeout(() => {
        if (handed) return
        const bound = stillBound()
        cleanup()
        if (!bound) return
        showToast({
          tone: 'danger',
          title: 'Agent did not start',
          body: 'The task was not sent. Open the pane to inspect the CLI error, then retry from the card.',
          timeout: 0,
          action: {
            label: 'Open pane',
            onClick: () => {
              requestWorkspaceSwitch(opened.id)
              setActiveView('grid')
            }
          }
        })
      }, 9000)
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

    // ── the card ⋯ menu ───────────────────────────────────────────────────────
    /**
     * Finding 31. The ⋯ was a hand-rolled `div.menu` toggled by `.hidden`: no role=menu, no
     * menuitems, no keydown handler at all — no arrows, no Escape, no focus management, no focus
     * return — and a trigger with no aria-haspopup/expanded. It closed on one document-level
     * outside click and nothing else. Every verb the board exists for (start an agent, link a PR,
     * edit, delete) lived behind that mouse-only door.
     *
     * It is also a PURE COMMAND LIST — which is precisely what the house context menu (11/06)
     * already is. So it PORTS onto that primitive instead of growing a second, worse one:
     * role=menu/menuitem, roving focus, Home/End/typeahead, Escape, focus return on every exit
     * path, viewport clamping, single-instance. All of it, for free, and none of it ours to
     * maintain twice. The old menu's document-level `pointerdown` listener — the one render()
     * orphaned on every push (finding 37b) — is DELETED with it; the primitive removes its own
     * on every close.
     */
    /** Which card's menu is up, and the ⋯ it hangs from. null whenever no board menu is open. */
    let openMenu: { cardId: string; trigger: HTMLElement } | null = null
    /**
     * The ⋯ whose OWN pointerdown just dismissed its menu. The primitive's outside-close listens
     * in CAPTURE on document, so it fires on the way DOWN — a beat before the `click` that same
     * gesture produces. Without this note, that click would re-open the menu its own pointerdown
     * had just closed, and ⋯ would stutter instead of toggle. Time-boxed: an abandoned press
     * (pointer down on ⋯, then away, no click) must not swallow a later keyboard Enter on it.
     */
    let dismissed: { cardId: string; at: number } | null = null
    document.addEventListener(
      'pointerdown',
      (e) => {
        // Registered ONCE, at mount — and therefore BEFORE any menu's own outside-close, since
        // registration order decides among capture listeners on the same node. That ordering is
        // the entire point: this is the last moment at which the menu about to be closed is still
        // observably open. (Mount-scoped, not per-render: it cannot accumulate.)
        const trigger = e.target instanceof Element ? e.target.closest<HTMLElement>('.board-card-more') : null
        const cardId = trigger?.closest<HTMLElement>('.board-card')?.dataset.cardId ?? null
        dismissed = cardId && cardId === openMenu?.cardId ? { cardId, at: performance.now() } : null
      },
      true
    )

    /** The card's verbs, in frequency order: start an agent (the board's whole point), move it,
     *  link/manage, edit + navigate, and the destructive Delete LAST. */
    function cardMenuItems(card: BoardCard): ContextMenuEntry[] {
      const items: ContextMenuEntry[] = []
      const linked = linksByCard.get(card.id)
      for (const a of roster.filter((r) => r.installed)) {
        items.push({ label: `Start ${a.name} on this…`, icon: 'sparkles', onSelect: () => void startOnCard(card.id, a.id) })
      }
      if (items.length) items.push({ separator: true })
      // Finding 31: the keyboard's road out of drag-and-drop. LANES is a fixed constant — there is
      // no ordering within a lane to reproduce, only "which lane" — so one item per OTHER lane is
      // the whole feature, and moveCard() is the same mutation the drop handler performs.
      for (const lane of LANES) {
        if (lane.id === card.lane) continue
        items.push({ label: `Move to ${lane.label}`, icon: 'arrow-right', onSelect: () => moveCard(card, lane.id) })
      }
      items.push({ separator: true })
      items.push({
        label: linked ? 'Change GitHub link…' : 'Link GitHub PR/issue…',
        icon: 'git-branch',
        onSelect: () => linkCard(card)
      })
      if (linked) {
        items.push({ label: 'Refresh link', icon: 'rotate-cw', onSelect: () => void bridge.invoke(IntegrationsChannels.linkRefresh, linked.id) })
        items.push({
          label: 'Unlink',
          icon: 'x',
          onSelect: () => void bridge.invoke(IntegrationsChannels.linkRemove, linked.id).then(() => load())
        })
      }
      items.push({ label: 'Edit…', icon: 'pencil', onSelect: () => edit(card, card.lane) })
      if (card.paneId && card.workspaceId) {
        items.push({
          label: 'Go to pane',
          icon: 'terminal',
          onSelect: () => {
            requestWorkspaceSwitch(card.workspaceId as string)
            setActiveView('grid')
          }
        })
      }
      items.push({ separator: true })
      // Bug #7: a destructive act gets a confirm, safe action focused (07b danger pattern).
      items.push({
        label: 'Delete card',
        icon: 'trash',
        onSelect: () => {
          void confirmDialog({
            title: `Delete “${card.title || 'card'}”?`,
            message: 'This removes the card from the board. A bound pane, if any, keeps running.',
            confirmLabel: 'Delete card',
            danger: true
          }).then((ok) => {
            if (ok) removeCard(card.id)
          })
        }
      })
      return items
    }

    function showCardMenu(card: BoardCard, trigger: HTMLElement): void {
      const r = trigger.getBoundingClientRect()
      openContextMenu({
        items: cardMenuItems(card),
        // Hangs down-left from the ⋯ (200 is .ctx-menu's min-width). The primitive clamps the
        // result into the viewport itself, which is what keeps the lane's own overflow scroller
        // from clipping the menu — the 8.5/07 fix, now inherited rather than hand-rolled.
        x: r.right - 200,
        y: r.bottom + 4,
        returnFocus: trigger,
        ariaLabel: `Actions for ${card.title || 'card'}`
      })
      // AFTER, never before: openContextMenu() evicts whatever menu was already up (it is
      // single-instance), and that eviction returns focus to the OLD trigger — whose focus handler
      // clears `openMenu`. Claim the slot first and that eviction would wipe the claim we just
      // made, leaving an open menu the board believes is closed.
      openMenu = { cardId: card.id, trigger }
      trigger.setAttribute('aria-expanded', 'true')
    }

    function cardEl(card: BoardCard): HTMLElement {
      const menuBtn = el(
        'button',
        {
          class: 'icon-btn board-card-more',
          // aria-haspopup tells AT this button OPENS something rather than doing something;
          // aria-expanded says whether it is open right now. The old ⋯ announced neither.
          attrs: { type: 'button', 'aria-label': 'Card menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
          onClick: (e) => {
            e.stopPropagation()
            const swallow = dismissed?.cardId === card.id && performance.now() - dismissed.at < 500
            dismissed = null
            if (swallow) return // this click's own pointerdown already closed it: ⋯ toggles
            showCardMenu(card, menuBtn)
          }
        },
        [icon('more', 14)]
      )
      // The primitive returns focus HERE on every exit path (Escape, outside click, picking an
      // item), and opening the menu always moved focus off this button — so focus landing back on
      // it means "the menu is gone". That is the close hook ContextMenuHandle does not expose, and
      // it is what keeps aria-expanded from lying to a screen reader.
      menuBtn.addEventListener('focus', () => {
        if (openMenu?.trigger === menuBtn) openMenu = null
        menuBtn.setAttribute('aria-expanded', 'false')
      })
      const host = el(
        'article',
        { class: 'board-card', attrs: { draggable: 'true', 'data-card-id': card.id } },
        [
          el('div', { class: 'board-card-head' }, [
            el('h4', { class: 'board-card-title', text: card.title }),
            menuBtn
          ]),
          ...(card.notes.trim() ? [el('p', { class: 'board-card-notes', text: card.notes })] : []),
          el('div', { class: 'board-card-foot' }, [cardStateChip(card), approvedChip(card), serviceLinkChip(card)])
        ]
      )
      if (card.paneId && paneState(card.paneId as PaneId) === 'attention') host.dataset.attention = 'true'

      host.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/mogging-card', card.id)
        host.classList.add('dragging')
      })
      host.addEventListener('dragend', () => host.classList.remove('dragging'))
      host.addEventListener('dblclick', () => edit(card, card.lane))
      return host
    }

    /**
     * WHAT A FULL REBUILD DESTROYS — and why render() has to put it back (finding 37a).
     *
     * render() is a teardown: replaceChildren() and build the whole board again. It runs on every
     * EXTERNAL push — a GitHub link status, an attention change, an approval, a pane's cwd going
     * away, the agent roster reloading — none of which the user asked for and any of which can
     * land mid-gesture. `.board-lane-cards` is a scroll container, so each of those pushes used to
     * slam every lane back to scrollTop 0, and whatever inside the board had focus (a ⋯ button, a
     * "needs you" chip, + Add card) was thrown out with the node holding it. A board that scrolls
     * itself to the top and drops your caret every few seconds is unusable by keyboard and merely
     * infuriating with a mouse.
     *
     * This is capture-and-restore, NOT reconciliation: record where the user is (which card, which
     * control, how far each lane is scrolled), rebuild, put them back — and no-op silently when the
     * target is gone (the card was deleted, the chip changed state). Honest minimum. A keyed diff
     * would be a great deal more machinery for the same promise, and one more thing to get wrong.
     */
    /** The board's focusable controls, each with the scope that identifies WHICH one. */
    const FOCUSABLE = [
      { key: 'more', sel: '.board-card-more', scope: 'card' },
      { key: 'attention', sel: '.board-chip-attention', scope: 'card' },
      { key: 'add', sel: '.board-add', scope: 'lane' },
      { key: 'empty-add', sel: '.empty-state button', scope: 'lane' }
    ] as const
    type FocusMark = { key: string; cardId: string | null; lane: string | null }

    function captureFocus(): FocusMark | null {
      const a = document.activeElement
      if (!(a instanceof HTMLElement) || !root.contains(a)) return null
      for (const f of FOCUSABLE) {
        const hit = a.closest<HTMLElement>(f.sel)
        if (!hit) continue
        return {
          key: f.key,
          cardId: hit.closest<HTMLElement>('.board-card')?.dataset.cardId ?? null,
          lane: hit.closest<HTMLElement>('.board-lane')?.dataset.lane ?? null
        }
      }
      return null
    }

    function restoreFocus(mark: FocusMark | null): void {
      if (!mark) return
      const f = FOCUSABLE.find((x) => x.key === mark.key)
      if (!f) return
      // Re-find by IDENTITY, not by position: a card that moved lanes keeps its id, so its ⋯ is
      // still its ⋯. A card that was deleted resolves to nothing, and we take focus nowhere —
      // yanking the caret to some neighbour is worse than leaving it where the browser put it.
      const scope =
        f.scope === 'card' && mark.cardId
          ? root.querySelector<HTMLElement>(`.board-card[data-card-id="${CSS.escape(mark.cardId)}"]`)
          : mark.lane
            ? root.querySelector<HTMLElement>(`.board-lane[data-lane="${CSS.escape(mark.lane)}"]`)
            : null
      // preventScroll is LOAD-BEARING, not a nicety. focus() scrolls its element into view by
      // default, and the control we are restoring lives inside `.board-lane-cards` — the very
      // scroller restoreScroll() has just put back. Without this, repairing the focus would undo
      // the scroll repair a line above it: refocus a ⋯ near the top of a lane the user had scrolled
      // down, and the lane snaps back up. The user never moved focus; the browser must not scroll.
      scope?.querySelector<HTMLElement>(f.sel)?.focus({ preventScroll: true })
    }

    /** scrollTop per lane, keyed by data-lane — the identity that survives a rebuild. */
    function captureScroll(): Map<string, number> {
      const tops = new Map<string, number>()
      for (const list of root.querySelectorAll<HTMLElement>('.board-lane-cards')) {
        const lane = list.closest<HTMLElement>('.board-lane')?.dataset.lane
        if (lane) tops.set(lane, list.scrollTop)
      }
      return tops
    }

    function restoreScroll(tops: Map<string, number>): void {
      for (const list of root.querySelectorAll<HTMLElement>('.board-lane-cards')) {
        const lane = list.closest<HTMLElement>('.board-lane')?.dataset.lane
        const top = lane ? tops.get(lane) : undefined
        // The browser clamps for us: a lane that lost cards simply lands at its new bottom.
        if (top) list.scrollTop = top
      }
    }

    function render(): void {
      // A menu anchored to a card we are about to destroy has to go FIRST. The primitive hands
      // focus back to that card's ⋯ while it is still in the DOM — which is exactly what
      // captureFocus() wants to find a line later — and it removes its own document-level
      // pointerdown listener on the way out. Skip this and the menu outlives the board it belongs
      // to: floating over a rebuilt lane, anchored to a detached button, its listener orphaned
      // until the next click anywhere (finding 37b).
      if (openMenu) {
        closeContextMenu()
        // Belt AND braces. The trigger's focus handler normally clears this, but only if the
        // trigger was still attached to take focus back. Leave a stale entry here and the NEXT
        // render would close a menu that is not ours — the explorer's, say.
        openMenu = null
      }
      const focusMark = captureFocus()
      const scrollTops = captureScroll()
      root.replaceChildren()
      const head = el('div', { class: 'board-head' }, [
        el('h1', { class: 'board-title', text: 'Board' }),
        el('span', { class: 'board-sub', text: 'Cards launch agents — local only, yours.' })
        // The empty board now speaks per-lane — each empty lane is a house EmptyState
        // (8.5/07b) — so the head no longer hand-rolls its own `.board-empty-hint`.
      ])
      const lanesEl = el('div', { class: 'board-lanes' })
      for (const lane of LANES) {
        const inLane = cards.filter((c) => c.lane === lane.id)
        const list = el(
          'div',
          { class: 'board-lane-cards' },
          inLane.length
            ? inLane.map(cardEl)
            : [
                // An empty lane is a house EmptyState, not silence (8.5/07b). Its action is
                // EmptyState's FIRST `action` caller — add a card straight to THIS lane.
                EmptyState({
                  icon: 'kanban',
                  title: 'No cards',
                  body: 'Add one, or drag a card here.',
                  action: Button({ label: '+ Add card', variant: 'ghost', onClick: () => edit(null, lane.id) })
                })
              ]
        )
        const laneEl = el('section', { class: 'board-lane', attrs: { 'data-lane': lane.id } }, [
          el('div', { class: 'board-lane-head' }, [
            el('h3', { class: 'board-lane-title', text: lane.label }),
            CountBadge(inLane.length, { label: `${inLane.length} ${inLane.length === 1 ? 'card' : 'cards'}` })
          ]),
          list,
          // The standalone add button stays for a lane that already has cards; an empty
          // lane's "+ Add card" lives in its EmptyState action instead (no double button).
          inLane.length
            ? el('button', {
                class: 'board-add',
                attrs: { type: 'button' },
                text: '+ Add card',
                onClick: () => edit(null, lane.id)
              })
            : null
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
          if (card) moveCard(card, lane.id) // the SAME mutation the ⋯ menu's "Move to …" runs
        })
        lanesEl.append(laneEl)
      }
      root.append(head, lanesEl)
      // Both restores run against the LIVE tree (setting scrollTop on a detached node is a no-op),
      // and scroll goes first: focusing a control inside a lane must not fight a scroll that is
      // about to move it.
      restoreScroll(scrollTops)
      restoreFocus(focusMark)
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
      const card = cards.find((c) => c.paneId === paneId)
      if (!card) return
      if (!cwd) {
        card.paneId = null
        card.workspaceId = null
        save(card)
        render()
        return
      }
      // A pane's cwd is no longer fixed at spawn: it is TRACKED, and the shell reports it as it
      // moves. The ✓-chip is a function of that cwd (approvedChip: the pane must be standing in
      // the worktree whose branch was signed off), so a cwd that changes without a render leaves
      // the chip lying — and it always changes, because the launch command's own `cd <worktree>`
      // is learned from the shell AFTER the pane exists. Approval landing first and the pane
      // arriving in the worktree second was exactly the order in which the chip never appeared.
      render()
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
      // Finding 29. A global shortcut that fires while a modal is up, or while the caret is in a
      // text field, is a keystroke stolen from the user: type a G into a card title with Ctrl (or
      // ⌘) still down and the whole Board would vanish from under the modal you were typing into.
      // The `stopPropagation()` calls scattered through the app's inputs never stopped this,
      // because the app's shortcut layer listens in CAPTURE — the event is ours before the input
      // ever sees it. The guard is the only thing that can say no.
      if (shortcutsBlocked(e.target)) return
      // Finding 28. `e.ctrlKey` alone left this shortcut DEAD on macOS, where the platform modifier
      // is ⌘ and ctrlKey is false. isModKey is the one true test — spelled out longhand, this idiom
      // drifts (the Browser dock had the identical bug).
      if (isModKey(e) && e.shiftKey && !e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        setActiveView(activeView() === 'board' ? 'grid' : 'board')
      }
    })

    onAgentRegistryChange((agents) => {
      roster = [...agents]
      if (activeView() === 'board') render()
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
        // Dev/smoke handle: providers arrive as strings — validate against the closed
        // id union rather than widening startOnCard back to `string`.
        startOnCard: (id: string, provider: string) =>
          isAgentCliId(provider) ? startOnCard(id, provider) : Promise.resolve(false),
        refresh: () => load(),
        // The ✓-chip is an AND of two independent facts (approvedChip, above): the pane is
        // standing in the worktree, and that worktree's branch holds a believed sign-off.
        // A gate that can only see the chip cannot say which half failed.
        approvalProbe: (paneId: number, branch: string) => ({
          cwd: getPaneCwd(paneId as PaneId) ?? null,
          approved: isBranchApproved(branch)
        })
      }
    }
  }
}

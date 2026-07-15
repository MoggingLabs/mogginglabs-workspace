import type { UiFeature } from '../../core/registry/feature-registry'
import { clear, el, icon, type IconName } from '../../components'
import { activeView } from '../../core/shell/view-port'
import { allCommands, availability, onCommandsChange, type Command } from '../../core/commands/command-port'
import { trapOverlay, type OverlayTrap } from '../../core/a11y/overlay-trap'
import { getTelemetry } from '../../core/telemetry'

const LISTBOX_ID = 'palette-listbox'
const optionId = (i: number): string => `palette-option-${i}`

const isMac = navigator.platform.toUpperCase().includes('MAC')
const MOD = isMac ? '⌘' : 'Ctrl'

/** Rank a command against a query: prefix > word-start > substring > subsequence. */
function score(cmd: Command, q: string): number {
  const t = cmd.title.toLowerCase()
  if (!q) return 1
  if (t.startsWith(q)) return 100
  if (t.includes(` ${q}`)) return 80
  if (t.includes(q)) return 60
  let ti = 0
  for (const ch of q) {
    ti = t.indexOf(ch, ti)
    if (ti < 0) return 0
    ti++
  }
  return 20
}

/** Category → base rank (the empty-query "top verbs" order) and a leading glyph. */
const HINT_PRI: Record<string, number> = { Workspace: 6, Board: 5, Integrations: 4, App: 3, Trust: 2, Appearance: 1 }
const HINT_ICON: Record<string, IconName> = { Workspace: 'terminal', Board: 'kanban', Integrations: 'plug', App: 'home', Appearance: 'sliders', Trust: 'shield' }
const baseRank = (cmd: Command): number => HINT_PRI[cmd.hint ?? ''] ?? 2
const cmdIcon = (cmd: Command): IconName => HINT_ICON[cmd.hint ?? ''] ?? 'chevron-right'

/** Title split into text + a `<mark>` around the query hit (contiguous match only).
 *  textContent is unchanged, so a gate that reads it (INTEGUX) still matches. */
function highlightTitle(title: string, q: string): (Node | string)[] {
  if (!q) return [title]
  const i = title.toLowerCase().indexOf(q)
  if (i < 0) return [title]
  return [title.slice(0, i), el('mark', { class: 'palette-match', text: title.slice(i, i + q.length) }), title.slice(i + q.length)]
}

/**
 * Command palette (Ctrl/Cmd+K): every registered action, filterable, keyboard-first.
 * Titlebar search trigger doubles as the mouse entry point. Built lazily; renders only
 * while open — nothing on the hot path.
 */
export const paletteFeature: UiFeature = {
  name: 'palette',
  mount(ctx) {
    const trigger = el(
      'button',
      {
        class: 'palette-trigger',
        type: 'button',
        ariaLabel: 'Command palette',
        onClick: () => toggle(true)
      },
      [
        icon('search', 14),
        el('span', { class: 'palette-trigger-label', text: 'Commands' }),
        el('span', { class: 'kbd', text: `${MOD}+K` })
      ]
    )
    ctx.titlebarCenter.append(trigger) // the command box sits dead-center of the bar (5/04)

    // A combobox, spelled out. Real focus never leaves this input by design — which is
    // exactly why aria-activedescendant is not optional: without it, arrowing through the
    // list moved a highlight a screen-reader user was never told about (finding 30).
    const input = el('input', {
      class: 'palette-input',
      type: 'text',
      placeholder: 'Type a command…',
      ariaLabel: 'Search commands',
      role: 'combobox',
      attrs: {
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': LISTBOX_ID
      }
    })
    const list = el('div', { class: 'palette-list', role: 'listbox', attrs: { id: LISTBOX_ID } })
    const panel = el('div', { class: 'palette', role: 'dialog', ariaLabel: 'Command palette' }, [
      el('div', { class: 'palette-search' }, [icon('search', 14), input]),
      list
    ])
    const overlay = el('div', { class: 'palette-overlay', hidden: true }, [panel])
    document.body.append(overlay)

    let openState = false
    let selected = 0
    let visible: Command[] = []
    let opener: Element | null = null
    let trap: OverlayTrap | undefined

    function toggle(next: boolean): void {
      if (next === openState) return
      openState = next
      overlay.hidden = !next
      input.setAttribute('aria-expanded', String(next))
      if (next) {
        opener = document.activeElement // whatever the user left to get here
        input.value = ''
        selected = 0
        renderList()
        trap = trapOverlay(panel)
        input.focus()
        getTelemetry().captureEvent({ name: 'palette.opened' })
      } else {
        // Release before focusing back: the opener lives inside the shell we just inerted.
        trap?.release()
        trap = undefined
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
        opener = null
      }
    }

    function renderList(): void {
      const q = input.value.trim().toLowerCase()
      const inWs = activeView() === 'grid' // in a workspace: its verbs rank first
      const ctxRank = (c: Command): number => (inWs && c.hint === 'Workspace' ? 1 : 0)
      visible = allCommands()
        .map((c) => ({ c, s: score(c, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => {
          if (b.s !== a.s) return b.s - a.s // match strength wins for a typed query
          // empty query (all s===1) + ties: context, then a top-verbs base rank — never
          // the feature-mount registration order the old palette fell back to.
          if (ctxRank(b.c) !== ctxRank(a.c)) return ctxRank(b.c) - ctxRank(a.c)
          if (baseRank(b.c) !== baseRank(a.c)) return baseRank(b.c) - baseRank(a.c)
          return a.c.title.localeCompare(b.c.title)
        })
        .map((x) => x.c)
        .slice(0, 12)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      clear(list)
      if (!visible.length) {
        list.append(el('div', { class: 'palette-empty', text: 'No matching commands' }))
        input.setAttribute('aria-activedescendant', '')
        return
      }
      visible.forEach((cmd, i) => {
        const titleEl = el('span', { class: 'palette-item-title' })
        titleEl.append(...highlightTitle(cmd.title, q))
        // A command that cannot run right now says so HERE, next to itself. The old habit
        // was to run it anyway and toast an apology after the fact (finding 29).
        const avail = availability(cmd)
        const item = el(
          'button',
          {
            class:
              'palette-item' +
              (i === selected ? ' is-selected' : '') +
              (avail !== true ? ' is-disabled' : ''),
            type: 'button',
            role: 'option',
            attrs: { id: optionId(i) },
            tabIndex: -1, // one tab stop — the input. Options are reached with the arrows.
            onClick: () => run(cmd)
          },
          [
            el('span', { class: 'palette-item-icon' }, [icon(cmdIcon(cmd), 14)]),
            titleEl,
            avail !== true ? el('span', { class: 'palette-item-reason', text: avail.reason }) : null,
            cmd.hint ? el('span', { class: 'palette-item-hint', text: cmd.hint }) : null,
            cmd.kbd ? el('span', { class: 'kbd', text: cmd.kbd }) : null
          ]
        )
        item.setAttribute('aria-selected', String(i === selected))
        if (avail !== true) item.setAttribute('aria-disabled', 'true')
        list.append(item)
      })
      // The highlight the input never announced.
      input.setAttribute('aria-activedescendant', optionId(selected))
    }

    function run(cmd: Command): void {
      // The row already prints why it cannot run. Clicking it must not run it — and must not
      // close the palette either, or the explanation leaves with the click.
      if (availability(cmd) !== true) return
      toggle(false)
      cmd.run()
      // Command FAMILY only (e.g. "workspace:switch") — ids can embed per-user uuids.
      getTelemetry().captureEvent({
        name: 'palette.command_run',
        props: { command: cmd.id.split(':').slice(0, 2).join(':') }
      })
    }

    input.addEventListener('input', () => {
      selected = 0
      renderList()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        selected = (selected + delta + visible.length) % Math.max(1, visible.length)
        renderList()
        list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = visible[selected]
        if (cmd) run(cmd)
      }
    })
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) toggle(false)
    })
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.ctrlKey || e.metaKey
        if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault()
          e.stopPropagation()
          toggle(!openState)
        } else if (e.key === 'Escape' && openState) {
          e.preventDefault()
          e.stopPropagation()
          toggle(false)
        }
      },
      true
    )
    onCommandsChange(() => {
      if (openState) renderList()
    })
  }
}

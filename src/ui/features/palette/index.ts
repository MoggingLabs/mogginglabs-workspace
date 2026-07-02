import type { UiFeature } from '../../core/registry/feature-registry'
import { clear, el, icon } from '../../components'
import { allCommands, onCommandsChange, type Command } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'

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
    ctx.titlebarLeft.append(trigger)

    const input = el('input', {
      class: 'palette-input',
      type: 'text',
      placeholder: 'Type a command…',
      ariaLabel: 'Search commands'
    })
    const list = el('div', { class: 'palette-list', role: 'listbox' })
    const panel = el('div', { class: 'palette', role: 'dialog', ariaLabel: 'Command palette' }, [
      el('div', { class: 'palette-search' }, [icon('search', 14), input]),
      list
    ])
    const overlay = el('div', { class: 'palette-overlay', hidden: true }, [panel])
    document.body.append(overlay)

    let openState = false
    let selected = 0
    let visible: Command[] = []

    function toggle(next: boolean): void {
      if (next === openState) return
      openState = next
      overlay.hidden = !next
      if (next) {
        input.value = ''
        selected = 0
        renderList()
        input.focus()
        getTelemetry().captureEvent({ name: 'palette.opened' })
      }
    }

    function renderList(): void {
      const q = input.value.trim().toLowerCase()
      visible = allCommands()
        .map((c) => ({ c, s: score(c, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c)
        .slice(0, 12)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      clear(list)
      if (!visible.length) {
        list.append(el('div', { class: 'palette-empty', text: 'No matching commands' }))
        return
      }
      visible.forEach((cmd, i) => {
        const item = el(
          'button',
          {
            class: 'palette-item' + (i === selected ? ' is-selected' : ''),
            type: 'button',
            role: 'option',
            onClick: () => run(cmd)
          },
          [
            el('span', { class: 'palette-item-title', text: cmd.title }),
            cmd.hint ? el('span', { class: 'palette-item-hint', text: cmd.hint }) : null,
            cmd.kbd ? el('span', { class: 'kbd', text: cmd.kbd }) : null
          ]
        )
        item.setAttribute('aria-selected', String(i === selected))
        list.append(item)
      })
    }

    function run(cmd: Command): void {
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

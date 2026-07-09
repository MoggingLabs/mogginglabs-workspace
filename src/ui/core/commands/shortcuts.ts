import { el } from '../../components'

// The single source of truth for keyboard shortcuts (UX audit KB-01). The ?
// overlay, the Settings › Shortcuts page, and the palette all read from here,
// so the map can't drift from the real bindings. Keys use Ctrl (which the
// handlers accept on every platform via ctrlKey/metaKey); ⌘ works too on macOS.

export interface ShortcutRow {
  keys: string
  label: string
}
export interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: 'Ctrl+K', label: 'Open the command palette' },
      { keys: 'Ctrl+Shift+G', label: 'Board' },
      { keys: 'Ctrl+,', label: 'Settings' },
      { keys: 'Esc', label: 'Back · close an overlay' }
    ]
  },
  {
    title: 'Workspaces',
    rows: [
      { keys: 'Ctrl+1 … 9', label: 'Switch to workspace 1–9' },
      { keys: 'Ctrl+T', label: 'New workspace' }
    ]
  },
  {
    title: 'Panes',
    rows: [
      { keys: 'Ctrl+Alt+← ↑ ↓ →', label: 'Move focus between panes' },
      { keys: 'Ctrl+Shift+D', label: 'New terminal (splits the focused pane)' },
      { keys: 'Ctrl+Shift+Enter', label: 'Zoom the focused pane' }
    ]
  },
  {
    title: 'Tools',
    rows: [
      { keys: 'Ctrl+Shift+B', label: 'Toggle the workspace rail' },
      { keys: 'Ctrl+Shift+U', label: 'Toggle the browser dock' },
      { keys: '?', label: 'Show this shortcuts sheet' }
    ]
  }
]

/** Render a key-combo as individual .kbd chips joined by +. */
function keyChips(keys: string): (Node | string)[] {
  const parts = keys.split('+')
  const out: (Node | string)[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push(' + ')
    out.push(el('span', { class: 'kbd', text: p }))
  })
  return out
}

/** The grouped shortcut list — shared by the ? overlay and the Settings page. */
export function renderShortcutList(): HTMLElement {
  return el(
    'div',
    { class: 'shortcuts-list' },
    SHORTCUTS.map((g) =>
      el('div', { class: 'shortcuts-group' }, [
        el('div', { class: 'shortcuts-group-title', text: g.title }),
        ...g.rows.map((r) =>
          el('div', { class: 'shortcuts-row' }, [
            el('span', { class: 'shortcuts-row-label', text: r.label }),
            el('span', { class: 'shortcuts-row-keys' }, keyChips(r.keys))
          ])
        )
      ])
    )
  )
}

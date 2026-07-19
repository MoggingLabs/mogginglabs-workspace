import { el } from '../../components'

// The single source of truth for keyboard shortcuts (UX audit KB-01). The ?
// overlay, the Settings › Shortcuts page, and the palette all read from here,
// so the map can't drift from the real bindings. Keys use Ctrl (which the
// handlers accept on every platform via ctrlKey/metaKey); ⌘ works too on macOS.

/**
 * The platform modifier, in one place. Ctrl on Windows/Linux, ⌘ on macOS — and the ONLY
 * correct way to ask. Written out longhand at each call site, the idiom drifted: the Board
 * and the Browser each checked `e.ctrlKey` alone, so their shortcuts were dead on a Mac
 * (finding 28). A named function is harder to half-remember than a two-term boolean.
 */
export function isModKey(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

export interface ShortcutRow {
  keys: string
  label: string
  /** F-42: a gesture is not pressable — it must not wear key-cap chips. */
  gesture?: true
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
      // Ctrl+Shift+M verified free at build time (2026-07-19): no handler in src
      // binds M — the Ctrl+Shift+K fallback was not needed.
      { keys: 'Ctrl+Shift+M', label: 'Brain — the workspace index' },
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
      { keys: 'Ctrl+Shift+Enter', label: 'Zoom the focused pane' },
      { keys: 'Ctrl+Shift+=', label: 'Balance the layout (equal rows and columns)' },
      { keys: 'Double-click a divider', label: 'Equal shares for that row/column (= on a focused divider)', gesture: true }
    ]
  },
  {
    // These are intercepted before the terminal, so they behave the same in every agent
    // CLI (Claude Code, Codex, Gemini) and in a bare shell — see TerminalPane.handleKey.
    title: 'Clipboard',
    rows: [
      { keys: 'Ctrl+C', label: 'Copy the selection · with no selection, interrupt (SIGINT)' },
      { keys: 'Ctrl+V', label: 'Paste into the terminal (an image is handed to the agent)' },
      { keys: 'Ctrl+Shift+C', label: 'Copy the selection' },
      { keys: 'Ctrl+Shift+V', label: 'Paste into the terminal' },
      // Over a full-screen agent UI (Claude Code and co. take the mouse), a plain drag is
      // the AGENT's selection — its own copy lands on your clipboard. Shift forces ours.
      { keys: 'Shift + drag', label: 'Select with the app when an agent owns the mouse (⌥ on macOS)', gesture: true },
      { keys: 'Drag a file in', label: 'Insert its full path, quoted for your shell', gesture: true }
    ]
  },
  {
    title: 'Tools',
    rows: [
      { keys: 'Ctrl+Shift+B', label: 'Toggle the workspace rail' },
      { keys: 'Ctrl+Shift+U', label: 'Toggle the browser dock' },
      { keys: 'Ctrl+Shift+E', label: 'Toggle the file explorer' },
      { keys: '?', label: 'Show this shortcuts sheet' }
    ]
  }
]

/** Render a key-combo as individual .kbd chips joined by +. A gesture row (F-42)
 *  renders as quiet italic text instead — a key-cap promises "press this", and a
 *  drag is not pressable. */
function keyChips(r: ShortcutRow): (Node | string)[] {
  if (r.gesture) return [el('span', { class: 'kbd-gesture', text: r.keys })]
  const parts = r.keys.split('+')
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
            el('span', { class: 'shortcuts-row-keys' }, keyChips(r))
          ])
        )
      ])
    )
  )
}

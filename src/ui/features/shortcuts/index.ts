import type { UiFeature } from '../../core/registry/feature-registry'
import { createModal, type ModalHandle } from '../../components'
import { setCommands } from '../../core/commands/command-port'
import { renderShortcutList } from '../../core/commands/shortcuts'

/**
 * The keyboard-shortcuts sheet (UX audit KB-01). ? opens a grouped overlay of
 * every shortcut; the same list also lives in Settings › Shortcuts and the ⌘K
 * palette. ? is ignored while typing (a pane's terminal, an input, another
 * overlay) so it never steals a real keystroke.
 */
export const shortcutsFeature: UiFeature = {
  name: 'shortcuts',
  mount() {
    let modal: ModalHandle | null = null
    const open = (): void => {
      if (!modal) modal = createModal({ title: 'Keyboard shortcuts', variant: 'dialog', width: 460, body: renderShortcutList() })
      if (!modal.isOpen()) modal.open()
    }
    const editable = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return
        if (editable(e.target)) return // a terminal / input owns '?'
        if (document.querySelector('.palette-overlay:not([hidden]), .modal-overlay')) return
        e.preventDefault()
        open()
      },
      true
    )

    setCommands('shortcuts', [{ id: 'shortcuts:open', title: 'Keyboard shortcuts', hint: 'Help', kbd: '?', run: open }])
  }
}

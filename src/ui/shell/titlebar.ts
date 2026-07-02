import { IconButton } from '../components'

/**
 * The header strip over the CONTENT column (the rail runs full-height beside it, so
 * nothing reads as a bar glued across the top). It is a native drag region; the OS
 * window controls overlay its right edge (Windows) or the rail's brand corner (macOS
 * traffic lights). Slots are where features mount triggers/chips — the shell knows
 * no features.
 */
export function createTitlebar(onToggleRail: () => void): {
  el: HTMLElement
  left: HTMLElement
  right: HTMLElement
} {
  const el = document.createElement('header')
  el.id = 'titlebar'

  const toggle = IconButton({
    icon: 'panel-left',
    label: 'Toggle workspace rail',
    title: 'Toggle rail (Ctrl+Shift+B)',
    class: 'rail-toggle',
    onClick: onToggleRail
  })

  const left = document.createElement('div')
  left.className = 'titlebar-left'

  const right = document.createElement('div')
  right.className = 'titlebar-right'

  el.append(toggle, left, right)
  return { el, left, right }
}

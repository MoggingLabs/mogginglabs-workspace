import { el } from './dom'
import { icon } from './icons'

export type PathStatusKind = 'idle' | 'git' | 'ok' | 'warn'

export interface PathStatus {
  kind: PathStatusKind
  text?: string
}

export interface PathInputHandle {
  el: HTMLElement
  input: HTMLInputElement
  value(): string
  setValue(v: string): void
  /** Validation chip: git branch / plain-folder ok / soft warning. Never blocking. */
  setStatus(status: PathStatus): void
  focus(): void
}

export interface PathInputOpts {
  value?: string
  placeholder?: string
  onBrowse?: () => void
  onInput?: (value: string) => void
  onEnter?: (value: string) => void
}

/** Working-folder picker: folder glyph · mono path field · status chip · Browse. */
export function createPathInput(opts: PathInputOpts = {}): PathInputHandle {
  const input = el('input', {
    class: 'input input--mono path-input-field',
    type: 'text',
    value: opts.value ?? '',
    // Neutral, not a fictitious path: the wizard fills the field with the REAL
    // default (the user's home folder), so this ghost shows only when no folder
    // could be resolved at all — and a fake `C:\path\to\your\project` there read
    // as a value someone should retype.
    placeholder: opts.placeholder ?? 'Choose a working folder…',
    ariaLabel: 'Working folder',
    onInput: (e) => opts.onInput?.((e.target as HTMLInputElement).value),
    onKeydown: (e) => {
      if (e.key === 'Enter') opts.onEnter?.((e.target as HTMLInputElement).value)
    }
  })

  const status = el('span', { class: 'path-input-status', hidden: true })

  // THE LEAF STAYS VISIBLE (information review, 2026-08-01). An input clips at its END,
  // so a deep path showed `C:\Users\…\AppData\Loca` — the root everyone already knows —
  // while hiding the leaf, the one segment that answers "where will my terminals start?".
  // Whenever the app writes the value (and again on blur, after the user's caret had it),
  // the view scrolls to the tail; the full path rides the tooltip.
  const showTail = (): void => {
    input.scrollLeft = input.scrollWidth
    input.title = input.value
  }
  input.addEventListener('blur', showTail)
  input.addEventListener('input', () => (input.title = input.value))
  // Chromium resets an UNFOCUSED input's scroll to 0 on reflow — a window resize quietly
  // snapped the view back to the path's head (screenshot-caught). Re-assert the tail
  // whenever the field's own box changes size. Self-disconnecting: the wizard rebuilds
  // this input on every open, and an observer kept alive for a detached input is a leak
  // that grows by one per open.
  const retail = new ResizeObserver(() => {
    if (!input.isConnected) return retail.disconnect()
    if (document.activeElement !== input) showTail()
  })
  retail.observe(input)

  const wrap = el('div', { class: 'path-input' }, [
    el('span', { class: 'path-input-icon' }, [icon('folder', 16)]),
    input,
    status,
    el(
      'button',
      {
        class: 'path-input-browse',
        type: 'button',
        ariaLabel: 'Browse for folder',
        title: 'Browse…',
        onClick: () => opts.onBrowse?.()
      },
      [icon('folder-open', 14), el('span', { text: 'Browse' })]
    )
  ])

  function setStatus(s: PathStatus): void {
    status.className = `path-input-status path-input-status--${s.kind}`
    status.textContent = ''
    if (s.kind === 'idle' || !s.text) {
      status.hidden = true
      return
    }
    status.hidden = false
    if (s.kind === 'git') status.append(icon('git-branch', 12))
    if (s.kind === 'ok') status.append(icon('check-circle', 12))
    if (s.kind === 'warn') status.append(icon('alert', 12))
    status.append(el('span', { text: s.text }))
  }

  if (opts.value) queueMicrotask(showTail) // the initial value obeys the same rule

  return {
    el: wrap,
    input,
    value: () => input.value,
    setValue: (v) => {
      input.value = v
      if (document.activeElement !== input) showTail()
    },
    setStatus,
    focus: () => input.focus()
  }
}

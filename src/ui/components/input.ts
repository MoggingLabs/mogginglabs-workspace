import { el } from './dom'
import { icon } from './icons'

export interface TextInputOpts {
  value?: string
  placeholder?: string
  mono?: boolean
  ariaLabel?: string
  onInput?: (value: string) => void
  onEnter?: (value: string) => void
}

export function TextInput(opts: TextInputOpts = {}): HTMLInputElement {
  return el('input', {
    class: opts.mono ? 'input input--mono' : 'input',
    type: 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder,
    ariaLabel: opts.ariaLabel,
    onInput: (e) => opts.onInput?.((e.target as HTMLInputElement).value),
    onKeydown: (e) => {
      if (e.key === 'Enter') opts.onEnter?.((e.target as HTMLInputElement).value)
    }
  })
}

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
    placeholder: opts.placeholder ?? 'C:\\path\\to\\your\\project',
    ariaLabel: 'Working folder',
    onInput: (e) => opts.onInput?.((e.target as HTMLInputElement).value),
    onKeydown: (e) => {
      if (e.key === 'Enter') opts.onEnter?.((e.target as HTMLInputElement).value)
    }
  })

  const status = el('span', { class: 'path-input-status', hidden: true })

  const wrap = el('div', { class: 'path-input' }, [
    el('span', { class: 'path-input-icon' }, [icon('folder', 15)]),
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
    if (s.kind === 'git') status.append(icon('git-branch', 11))
    if (s.kind === 'ok') status.append(icon('check-circle', 11))
    if (s.kind === 'warn') status.append(icon('alert', 11))
    status.append(el('span', { text: s.text }))
  }

  return {
    el: wrap,
    input,
    value: () => input.value,
    setValue: (v) => {
      input.value = v
    },
    setStatus,
    focus: () => input.focus()
  }
}

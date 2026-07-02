import { el } from './dom'
import { icon, type IconName } from './icons'

export interface ButtonOpts {
  label?: string
  icon?: IconName
  iconRight?: IconName
  variant?: 'primary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  kbd?: string
  title?: string
  ariaLabel?: string
  disabled?: boolean
  onClick?: (e: MouseEvent) => void
}

export function Button(opts: ButtonOpts): HTMLButtonElement {
  const cls = ['btn']
  if (opts.variant) cls.push(`btn--${opts.variant}`)
  if (opts.size && opts.size !== 'md') cls.push(`btn--${opts.size}`)
  return el(
    'button',
    {
      class: cls.join(' '),
      type: 'button',
      title: opts.title,
      ariaLabel: opts.ariaLabel ?? opts.label,
      disabled: opts.disabled,
      onClick: opts.onClick
    },
    [
      opts.icon ? icon(opts.icon) : null,
      opts.label ? el('span', { text: opts.label }) : null,
      opts.iconRight ? icon(opts.iconRight) : null,
      opts.kbd ? el('span', { class: 'kbd', text: opts.kbd }) : null
    ]
  )
}

export interface IconButtonOpts {
  icon: IconName
  label: string // required — icon-only buttons must still be named for AT
  title?: string
  class?: string
  disabled?: boolean
  onClick?: (e: MouseEvent) => void
}

export function IconButton(opts: IconButtonOpts): HTMLButtonElement {
  return el(
    'button',
    {
      class: opts.class ? `icon-btn ${opts.class}` : 'icon-btn',
      type: 'button',
      ariaLabel: opts.label,
      title: opts.title ?? opts.label,
      disabled: opts.disabled,
      onClick: opts.onClick
    },
    [icon(opts.icon)]
  )
}

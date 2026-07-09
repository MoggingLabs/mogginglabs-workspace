import { el, icon } from '../../components'
import { THEMES, type AppTheme } from '../../core/theme/themes'

/**
 * Settings § Appearance — the theme picker as SWATCH TILES, not a text control.
 * A theme is the most visual preference in the app; each tile paints a miniature
 * of the theme out of its own chrome tokens (app ground, a surface card, its text
 * inks, the constant brand dot), so the choice is previewed before it is made.
 * "System" splits its tile: the two palettes the OS scheme resolves to.
 *
 * Same contract as the segmented it replaces: buttons with aria-pressed, a
 * `setValue` that never fires onChange (so theme-state pushes can't loop back).
 */
export interface ThemePickerHandle {
  el: HTMLElement
  value(): string
  setValue(id: string): void
}

const byId = (id: string): AppTheme | undefined => THEMES.find((t) => t.id === id)

/** One half of a preview: the theme's app ground holding a mini surface card. */
function mockHalf(chrome: Record<string, string>): HTMLElement {
  const fallback = byId('midnight')?.chrome ?? {}
  const c = (token: string): string => chrome[token] ?? fallback[token] ?? ''
  return el('span', { class: 'theme-tile-half', style: { background: c('--bg-app') } }, [
    el(
      'span',
      {
        class: 'theme-tile-mock',
        style: { background: c('--bg-surface'), borderColor: c('--border') }
      },
      [
        el('span', { class: 'theme-tile-mockrow' }, [
          el('span', { class: 'theme-tile-dot' }),
          el('span', { class: 'theme-tile-line', style: { background: c('--text-hi'), width: '52%' } })
        ]),
        el('span', { class: 'theme-tile-line', style: { background: c('--text-lo'), width: '78%' } })
      ]
    )
  ])
}

export function createThemePicker(opts: { value: string; onChange: (id: string) => void }): ThemePickerHandle {
  let value = opts.value
  const tiles = new Map<string, HTMLButtonElement>()

  function apply(id: string, fire: boolean): void {
    value = id
    for (const [k, b] of tiles) {
      b.classList.toggle('is-active', k === id)
      b.setAttribute('aria-pressed', String(k === id))
    }
    if (fire) opts.onChange(id)
  }

  const root = el('div', { class: 'theme-grid', role: 'group', ariaLabel: 'Theme' })
  for (const t of THEMES) {
    // System previews both palettes it can resolve to; a concrete theme, its own.
    const halves =
      t.mode === 'system'
        ? [byId('light')?.chrome ?? {}, byId('midnight')?.chrome ?? {}]
        : [t.chrome]
    const tile = el(
      'button',
      {
        class: 'theme-tile',
        type: 'button',
        dataset: { themeId: t.id },
        onClick: () => apply(t.id, true)
      },
      [
        el('span', { class: 'theme-tile-preview', attrs: { 'aria-hidden': 'true' } }, halves.map(mockHalf)),
        el('span', { class: 'theme-tile-name' }, [
          el('span', { text: t.name }),
          el('span', { class: 'theme-tile-check' }, [icon('check-circle', 14)])
        ])
      ]
    )
    tiles.set(t.id, tile)
    root.append(tile)
  }
  apply(value, false)

  return { el: root, value: () => value, setValue: (id) => apply(id, false) }
}

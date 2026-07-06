import { UsageChannels, USAGE_DISPLAY_DEFAULTS, type UsageConfig, type UsageDisplayConfig } from '@contracts'
import { createCheckbox, el } from '../../components'
import { getBridge } from '../../core/ipc/bridge'
import { getTelemetry } from '../../core/telemetry'

/**
 * Settings § Usage — display controls (Phase-7/10). What the titlebar gauge
 * mirrors (merged / pinned / auto), what the icon shows, how resets render,
 * and the popover's order/density. Everything persists via usage:displaySet
 * and paints live — display is PAINT-ONLY, never a refetch. The 7/12 full
 * Usage tab grows around this module.
 */
export function createUsageDisplayControls(): HTMLElement {
  const root = el('div', { class: 'settings-consents usage-display-cfg' })
  void (async () => {
    try {
      const cfg: UsageDisplayConfig = {
        ...USAGE_DISPLAY_DEFAULTS,
        ...(((await getBridge().invoke(UsageChannels.displayGet)) as UsageDisplayConfig) ?? {})
      }
      const providers = (((await getBridge().invoke(UsageChannels.configGet)) as UsageConfig | null)?.providers ?? []).map((p) => p.id)
      const set = (patch: Partial<UsageDisplayConfig>): void => {
        void getBridge().invoke(UsageChannels.displaySet, patch)
        // Enums + booleans ONLY (ADR 0005) — never a provider id or number.
        getTelemetry().captureEvent({
          name: 'usage.display',
          props: {
            mode: patch.mode ?? cfg.mode,
            bars: patch.showBars ?? cfg.showBars,
            pct: patch.showPct ?? cfg.showPct,
            glyph: patch.showGlyph ?? cfg.showGlyph,
            label: patch.showLabel ?? cfg.showLabel,
            reset: patch.resetStyle ?? cfg.resetStyle,
            density: patch.density ?? cfg.density,
            order: patch.order ?? cfg.order
          }
        })
        Object.assign(cfg, patch)
      }
      const select = (cls: string, label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement => {
        const s = el('select', { class: `usage-display-select ${cls}`, ariaLabel: label }) as HTMLSelectElement
        for (const [v, text] of options) s.append(el('option', { value: v, text }))
        s.value = value
        s.addEventListener('change', () => onChange(s.value))
        return s
      }
      const pinSel = select('usage-display-pin', 'Pinned provider', providers.map((id) => [id, id]), cfg.pin ?? providers[0] ?? '', (v) => set({ mode: 'pinned', pin: v }))
      const modeSel = select(
        'usage-display-mode',
        'Gauge mode',
        [
          ['merged', 'Merged — highest severity'],
          ['auto', 'Auto — highest usage'],
          ['pinned', 'Pinned provider']
        ],
        cfg.mode,
        (v) => {
          pinSel.hidden = v !== 'pinned'
          if (v === 'pinned') set({ mode: 'pinned', pin: pinSel.value || undefined })
          else set({ mode: v as UsageDisplayConfig['mode'] })
        }
      )
      pinSel.hidden = cfg.mode !== 'pinned'
      const resetSel = select(
        'usage-display-reset',
        'Reset time style',
        [
          ['countdown', 'Countdown (2d 4h)'],
          ['absolute', 'Absolute (Tue 14:00)'],
          ['relative', 'Relative (tomorrow 14:00)']
        ],
        cfg.resetStyle,
        (v) => set({ resetStyle: v as UsageDisplayConfig['resetStyle'] })
      )
      const densitySel = select(
        'usage-display-density',
        'Popover density',
        [
          ['roomy', 'Roomy'],
          ['compact', 'Compact']
        ],
        cfg.density,
        (v) => set({ density: v as UsageDisplayConfig['density'] })
      )
      const orderSel = select(
        'usage-display-order',
        'Popover order',
        [
          ['severity', 'By severity (runs-out first)'],
          ['manual', 'Manual pin order']
        ],
        cfg.order,
        (v) => set({ order: v as UsageDisplayConfig['order'] })
      )
      // Manual pin order stays an unadorned id list until 7/12's grid.
      const pinOrder = el('input', { class: 'usage-display-pinorder', ariaLabel: 'Manual provider order (comma-separated ids)' }) as HTMLInputElement
      pinOrder.type = 'text'
      pinOrder.placeholder = 'provider ids, comma-separated'
      pinOrder.value = cfg.pinOrder.join(', ')
      pinOrder.addEventListener('change', () =>
        set({ pinOrder: pinOrder.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64) })
      )
      const check = (label: string, cls: string, checked: boolean, key: 'showBars' | 'showPct' | 'showGlyph' | 'showLabel'): HTMLElement => {
        const c = createCheckbox({ label, checked, onChange: (on) => set({ [key]: on }) })
        c.el.classList.add(cls)
        return c.el
      }
      root.append(
        el('div', { class: 'usage-display-row' }, [el('span', { class: 'settings-row-caption', text: 'Gauge shows' }), modeSel, pinSel]),
        el('div', { class: 'usage-display-row' }, [
          check('Bars', 'usage-display-bars', cfg.showBars, 'showBars'),
          check('%', 'usage-display-pct', cfg.showPct, 'showPct'),
          check('Glyph', 'usage-display-glyph', cfg.showGlyph, 'showGlyph'),
          check('Label', 'usage-display-label', cfg.showLabel, 'showLabel')
        ]),
        el('div', { class: 'usage-display-row' }, [el('span', { class: 'settings-row-caption', text: 'Resets' }), resetSel]),
        el('div', { class: 'usage-display-row' }, [
          el('span', { class: 'settings-row-caption', text: 'Popover' }),
          densitySel,
          orderSel,
          pinOrder
        ])
      )
    } catch {
      root.append(el('span', { class: 'settings-row-caption', text: 'Display config unavailable.' }))
    }
  })()
  return root
}

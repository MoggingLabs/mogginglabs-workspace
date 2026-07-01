import type { ProviderCount, ResolvedLayout } from '@contracts'

// The 05 grid sizes. A mix's total selects the smallest grid that fits; the remainder is
// padded with `shell` panes. (Kept in sync with the layout feature's TEMPLATE_COUNTS.)
const GRIDS = [1, 2, 4, 6, 8, 9, 12, 16]

/**
 * Map a provider mix -> a concrete grid: the smallest 05 grid >= the total pane count, with
 * each slot assigned a provider (expanded from the mix) and any remaining slots padded with
 * `shell`. Caps at 16 panes. Pure + Electron-free — no credentials, just provider ids.
 */
export function resolveLayout(mix: ProviderCount[]): ResolvedLayout {
  const expanded: string[] = []
  for (const m of mix) {
    for (let i = 0; i < Math.max(0, Math.floor(m.count)); i++) expanded.push(m.provider)
  }
  const total = Math.min(expanded.length, 16)
  const paneCount = GRIDS.find((g) => g >= total) ?? 16
  const assignments = expanded.slice(0, total)
  while (assignments.length < paneCount) assignments.push('shell')
  return { paneCount: Math.max(1, paneCount), assignments: assignments.length ? assignments : ['shell'] }
}

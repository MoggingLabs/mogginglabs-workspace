import { ABS_MAX_PANES, type ProviderCount, type ResolvedLayout } from '@contracts'

// The 05 grid sizes. A mix's total selects the smallest grid that fits; the remainder is
// padded with `shell` panes. (Kept in sync with the layout feature's TEMPLATE_COUNTS.)
const GRIDS = [1, 2, 4, 6, 8, 9, 12, 16]

/**
 * Map a provider mix -> a concrete grid: the smallest 05 grid >= the total pane count, with
 * each slot assigned a provider (expanded from the mix) and any remaining slots padded with
 * `shell`. Caps at the contract ceiling (ABS_MAX_PANES). Pure + Electron-free — no credentials, just provider ids.
 *
 * `exact` keeps the total AS IS instead of padding up to a template grid — the wizard's
 * dynamic painter produces any pane count up to the screen-derived limit (three panes is a real layout there, not
 * "a 4-grid minus one"), and its mix already carries the exact shell fill.
 */
export function resolveLayout(mix: ProviderCount[], exact = false): ResolvedLayout {
  const expanded: ResolvedLayout['assignments'] = []
  for (const m of mix) {
    // The cap binds INSIDE the loop. `mix` is renderer input (TemplateChannels.resolve passes
    // it straight in), so capping only the RESULT still expanded a count of 1e9 — or Infinity —
    // into an array on the main process first, freezing the app before the cap was reached.
    const n = Math.min(Math.max(0, Math.floor(m.count)), ABS_MAX_PANES - expanded.length)
    for (let i = 0; i < n; i++) expanded.push(m.provider)
    if (expanded.length >= ABS_MAX_PANES) break
  }
  const total = expanded.length
  const paneCount = exact ? total : (GRIDS.find((g) => g >= total) ?? total)
  const assignments = expanded.slice(0, total)
  while (assignments.length < paneCount) assignments.push('shell')
  return { paneCount: Math.max(1, paneCount), assignments: assignments.length ? assignments : ['shell'] }
}

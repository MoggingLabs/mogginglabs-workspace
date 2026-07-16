import { ABS_MAX_PANES, type ProviderCount, type ResolvedLayout } from '@contracts'

// The 05 grid sizes. A mix's total selects the smallest grid that fits; the remainder is
// padded with `shell` panes. (Kept in sync with the layout feature's TEMPLATE_COUNTS.)
const GRIDS = [1, 2, 4, 6, 8, 9, 12, 16]

/**
 * Map a provider mix -> a concrete grid: the smallest 05 grid >= the total pane count, with
 * each slot assigned a provider (expanded from the mix) and any remaining slots padded with
 * `shell`. Pure + Electron-free — no credentials, just provider ids.
 *
 * Two dialects, two caps:
 *   default — the template callers (Home chips, Board, dev handles): totals pad up to the
 *             smallest curated grid and cap at the LARGEST one, exactly the pre-capacity
 *             contract those callers were built against;
 *   `exact` — the wizard's dynamic painter: the total IS the layout (three panes is a real
 *             arrangement, never "a 4-grid minus one"), bounded only by the contract
 *             ceiling — the screen-derived limit was already enforced painter-side.
 * The cap binds INSIDE the expansion loop either way: `mix` is renderer input, so capping
 * only the RESULT would still expand a count of 1e9 — or Infinity — into an array on the
 * main process first, freezing the app before the cap was reached.
 */
export function resolveLayout(mix: ProviderCount[], exact = false): ResolvedLayout {
  const cap = exact ? ABS_MAX_PANES : GRIDS[GRIDS.length - 1]!
  const expanded: ResolvedLayout['assignments'] = []
  for (const m of mix) {
    const n = Math.min(Math.max(0, Math.floor(m.count)), cap - expanded.length)
    for (let i = 0; i < n; i++) expanded.push(m.provider)
    if (expanded.length >= cap) break
  }
  const total = expanded.length
  const paneCount = exact ? total : (GRIDS.find((g) => g >= total) ?? cap)
  const assignments = expanded.slice(0, total)
  while (assignments.length < paneCount) assignments.push('shell')
  return { paneCount: Math.max(1, paneCount), assignments: assignments.length ? assignments : ['shell'] }
}

import type { AgentConfigValue } from '@contracts'
import type { AgentConfigMerge } from './sources'

/**
 * How one config layer's value combines with the layers beneath it.
 *
 * `AgentConfigMerge` has three members (sources.ts) and the merge took a BOOLEAN —
 * `loaded.source.merge === 'deep-concat-arrays'`. Narrowing three values to one bit at the
 * call site made `'replace'` and `'deep'` the same function: both recursed into objects and
 * unioned their keys. A layer declaring `merge: 'replace'` — Aider declares it on all three
 * of its layers (sources.ts) — could not replace anything object-valued. The nearer layer's
 * object was merged into the farther one's, so the effective value shown to the user
 * contained keys from a file that provider does not read at that path.
 *
 * The mode is now the parameter and the switch is exhaustive, so a fourth mode is a compile
 * error here rather than a silent fall-through into whichever branch happens to run.
 *
 * `base` is what the layers further away already produced; `next` is the nearer layer.
 */
export function mergeValues(
  base: AgentConfigValue | undefined,
  next: AgentConfigValue,
  merge: AgentConfigMerge
): AgentConfigValue {
  if (base === undefined) return next

  switch (merge) {
    case 'replace':
      // The nearer layer IS the value. No recursion — that was the bug.
      return next

    case 'deep':
    case 'deep-concat-arrays': {
      const concatArrays = merge === 'deep-concat-arrays'
      if (Array.isArray(base) && Array.isArray(next)) {
        if (!concatArrays) return next
        const out = [...base]
        for (const item of next) if (!out.some((existing) => sameValue(existing, item))) out.push(item)
        return out
      }
      if (isPlainObject(base) && isPlainObject(next)) {
        const out: Record<string, AgentConfigValue> = { ...base }
        for (const [key, value] of Object.entries(next)) out[key] = mergeValues(out[key], value, merge)
        return out
      }
      return next
    }
  }
}

const isPlainObject = (v: AgentConfigValue): v is Record<string, AgentConfigValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The identity predicate that makes 'deep-concat-arrays' a UNION rather than an append.
 *  Deliberately byte-identical to service.ts's `sameValue` — key order therefore matters, as
 *  it always has. Changing that is a separate question from which merge mode runs, and mixing
 *  the two into one commit is how a behaviour change arrives unannounced. */
const sameValue = (a: AgentConfigValue, b: AgentConfigValue): boolean => JSON.stringify(a) === JSON.stringify(b)

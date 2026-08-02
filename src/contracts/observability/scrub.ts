/**
 * What may leave this machine in an error report.
 *
 * ADR 0005 requires the Sentry adapter to set BOTH `beforeSend` and `beforeBreadcrumb`, and to
 * drop console breadcrumbs. It set neither hook's full job: `beforeSend` deleted three
 * top-level fields (`server_name`, `user`, `request`) and nothing else, and `beforeBreadcrumb`
 * did not exist at all — so the SDK's default console integration attached whatever the app had
 * logged to every event. This repo logs absolute paths as a matter of course
 * (`[env] PATH repaired — <abs dirs>`), and an installer step reports `C:\Users\<name>\…`.
 *
 * Two rules, and the second is the one that is easy to get wrong.
 *
 *   A home directory is a USERNAME. Every path under it is replaced by `~`, everywhere in the
 *   event — not just in the fields someone remembered to list. Stack frames, `extra`,
 *   breadcrumb messages and the exception value all carry them.
 *
 *   Renderer breadcrumbs arrive PRE-EMBEDDED in `event.breadcrumbs[]` and never pass through
 *   main's `beforeBreadcrumb`. So `beforeSend` has to walk them too, or the hook that exists
 *   protects only the process that happens to raise the error.
 *
 * Pure and string-shaped on purpose: the adapter holds the SDK, this holds the policy, and the
 * policy is the part worth testing.
 */

/** Categories whose whole point is to record what the app said to itself. */
const DROPPED_CATEGORIES = new Set(['console', 'debug'])

/** A home directory, and the path separators it can be spelled with. */
function homePatterns(homeDir: string): RegExp[] {
  const trimmed = homeDir.replace(/[\\/]+$/, '')
  if (!trimmed) return []
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Both separators, because a path can be reported either way on Windows, and
  // case-insensitively because Windows paths are.
  const either = escaped.replace(/\\\\|\//g, '[\\\\/]')
  return [new RegExp(either, 'gi')]
}

/** Replace every occurrence of the user's home directory with `~`. */
export function scrubHomePaths(text: string, homeDir: string): string {
  let out = text
  for (const re of homePatterns(homeDir)) out = out.replace(re, '~')
  return out
}

/** Walk a value, rewriting every string. Arrays and plain objects only — anything else is
 *  returned untouched, so a Buffer or a class instance is never silently reshaped. */
function deepScrub(value: unknown, homeDir: string, depth = 0): unknown {
  if (depth > 12) return value // a cyclic or absurdly nested payload is not worth chasing
  if (typeof value === 'string') return scrubHomePaths(value, homeDir)
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, homeDir, depth + 1))
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepScrub(v, homeDir, depth + 1)
    return out
  }
  return value
}

export interface ScrubbableBreadcrumb {
  category?: string
  message?: string
  data?: Record<string, unknown>
}

/**
 * A breadcrumb, scrubbed — or null to drop it entirely.
 *
 * Console breadcrumbs are dropped rather than scrubbed: their content is whatever the app
 * chose to log, which is not a category anyone reviews before it ships.
 */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T, homeDir: string): T | null {
  if (crumb.category && DROPPED_CATEGORIES.has(crumb.category)) return null
  return deepScrub(crumb, homeDir) as T
}

export interface ScrubbableEvent {
  server_name?: unknown
  user?: unknown
  request?: unknown
  breadcrumbs?: ScrubbableBreadcrumb[]
  [key: string]: unknown
}

/**
 * An error event, scrubbed. Drops the three identity fields outright, then rewrites home paths
 * everywhere else — INCLUDING the breadcrumbs the renderer embedded before main ever saw them.
 */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T, homeDir: string): T {
  const out = { ...(event as ScrubbableEvent) }
  delete out.server_name // hostname
  delete out.user
  delete out.request // urls / headers / env

  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs
      .map((c) => scrubBreadcrumb(c, homeDir))
      .filter((c): c is ScrubbableBreadcrumb => c !== null)
  }
  return deepScrub(out, homeDir) as T
}

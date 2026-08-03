import { execFile } from 'node:child_process'
import { resolveOnPath } from '@backend/features/agents'
import { spawnPlan } from '@backend/platform/spawn-tool'
import { getSettingsStore } from './app-settings'

// Which OPTIONAL flags the installed CLIs actually accept.
//
// The app assigns a claude session id with `--session-id <uuid>` so a pane's identity is
// known before the CLI starts (see src/main/agents.ts). That flag does not exist in every
// claude version, and a CLI that meets an unknown flag EXITS — so guessing wrong here
// would break every fresh launch, not degrade one. Hence: the answer is probed from the
// CLI's own `--help`, never inferred from a version number, and a launch only passes the
// flag when a probe has actually said yes.
//
// Shape of the promise: reads are SYNCHRONOUS and free (an in-memory mirror, seeded from
// the settings store at boot so the very first launch of a run is already covered), while
// probing happens OFF the launch path and re-runs when the CLI's version moves. An
// unknown answer means "omit the flag" — exactly the behavior that shipped before this
// existed, so the failure mode is the old world, not a broken one.

const KEY = 'agents.capabilities.claude'
const PROBE_TIMEOUT_MS = 5_000

interface ClaudeCapabilities {
  /** The version the answers below were probed against. */
  version: string
  /** `--session-id <uuid>` is accepted. */
  sessionId: boolean
}

let mirror: ClaudeCapabilities | null = null
let loaded = false

/** Seed the mirror from the store. Cheap and synchronous; safe to call repeatedly. */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = getSettingsStore()?.getSetting(KEY)
    const parsed = raw ? (JSON.parse(raw) as ClaudeCapabilities) : null
    if (parsed && typeof parsed.version === 'string' && typeof parsed.sessionId === 'boolean') mirror = parsed
  } catch {
    /* unreadable or junk — probe will re-establish it */
  }
}

/**
 * May this launch carry `--session-id`? Synchronous by contract: it is read while a
 * launch command is being built. Unknown ⇒ false ⇒ the flag is omitted and the pane
 * falls back to discovering its identity, exactly as it did before.
 */
export function claudeSupportsSessionId(): boolean {
  ensureLoaded()
  return mirror?.sessionId === true
}

/**
 * Run a CLI and hand back everything it said, or null if it could not be run at all.
 *
 * Two Windows facts stand between "run claude --help" and an answer, and missing either
 * one produces the SAME silent wrong result — an empty read, which this probe would have
 * recorded as "the flag is unsupported". Every Windows install would then have quietly
 * forfeited assigned session ids with nothing appearing broken:
 *
 *   1. `execFile('claude', …)` does no PATHEXT resolution and fails ENOENT. Resolve to an
 *      absolute path first — and PATHEXT-first, because npm drops BOTH a `claude` POSIX
 *      script and a `claude.cmd` in the same folder and only the latter is runnable here.
 *   2. Node has refused to spawn a `.cmd` directly since CVE-2024-27980 (EINVAL). The
 *      repo already answers that: spawnPlan wraps it in `cmd.exe /d /s /c` with quoting
 *      that refuses anything re-interpretable. Reused rather than re-solved.
 */
function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const exe = resolveOnPath(bin)
      if (!exe) return resolve(null)
      const plan = spawnPlan(exe, args)
      execFile(
        plan.file,
        plan.args,
        {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          ...(plan.verbatim ? { windowsVerbatimArguments: true } : {})
        },
        (err, stdout, stderr) => resolve(err && !stdout ? null : `${stdout ?? ''}${stderr ?? ''}`)
      )
    } catch {
      resolve(null)
    }
  })
}

/** The run's in-flight probe, so a launch can join it instead of racing it. */
let probing: Promise<void> | null = null

/**
 * Wait for a FIRST answer, at most `budgetMs`. Only ever waits on an install that has
 * never been probed — once the memo exists, `claudeSupportsSessionId()` is already true
 * or false and this returns immediately.
 *
 * Why this exists: the probe is two short spawns of a node CLI, which is a few seconds,
 * and a workspace that opens on boot can easily beat it. Losing that race is safe (the
 * flag is omitted) but not free — the pane spends its whole life without an assigned
 * identity because of startup ordering. Callers fold this into work they are already
 * awaiting, so on every launch after the first it costs nothing at all.
 */
export function awaitAgentCapabilities(budgetMs: number): Promise<void> {
  ensureLoaded()
  if (mirror || !probing) return Promise.resolve()
  return Promise.race([probing, new Promise<void>((r) => setTimeout(r, budgetMs))])
}

/**
 * Probe the installed claude and persist what it accepts. Called from app wiring, never
 * from a launch: two short-lived spawns, at most once per run (and skipped entirely when
 * the version has not moved since the last probe). Never throws.
 */
export function refreshAgentCapabilities(): Promise<void> {
  probing ??= probe().finally(() => {
    probing = null
  })
  return probing
}

async function probe(): Promise<void> {
  ensureLoaded()
  try {
    const versionOut = await run('claude', ['--version'])
    if (!versionOut) return // not installed, or not answering — keep whatever we knew
    const version = versionOut.trim().split(/\s+/)[0] ?? versionOut.trim()
    if (mirror && mirror.version === version) return // already answered for this build
    const help = await run('claude', ['--help'])
    if (help === null) return
    const next: ClaudeCapabilities = { version, sessionId: /--session-id\b/.test(help) }
    mirror = next
    getSettingsStore()?.setSetting(KEY, JSON.stringify(next))
  } catch {
    /* a capability probe must never break the app — the unknown answer is the safe one */
  }
}

/** Test/gate seam: state the answer without spawning anything. */
export function setClaudeCapabilitiesForSmoke(next: ClaudeCapabilities | null): void {
  loaded = true
  mirror = next
}

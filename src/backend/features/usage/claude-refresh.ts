import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPty, type IPty } from '../../platform/pty-host'
import { defaultShell, shellArgs } from '../../platform/shell'
import { killPtyTree } from '../../platform/process-tree'

// Delegated Claude OAuth refresh (phase-11 rebuild, RC5). When the on-disk
// access token expires, the app used to go silently alert-dead until the user
// happened to run `claude` themselves. The fix is the reference
// implementation's (steipete/CodexBar `ClaudeOAuthDelegatedRefreshCoordinator`):
// we NEVER touch the refresh token — refresh-token rotation belongs to the
// CLI, and a second client using it would corrupt the CLI's session. Instead
// we run the CLI briefly (`/status` in a throwaway PTY); refreshing its own
// credentials is the CLI's side effect; we just watch the credential file
// change and re-read it.
//
// Discipline, all from the reference: SINGLE-FLIGHT (concurrent polls join the
// in-flight attempt), COOLDOWN (5 min between attempts, 20 s after a spawn
// failure — a broken CLI must not be hammered), and a DEDICATED PROBE CWD so
// the auto-answered first-run trust prompt trusts a scratch directory, never
// the user's project.

const COOLDOWN_MS = 5 * 60_000
const COOLDOWN_FAIL_MS = 20_000
const DEFAULT_TIMEOUT_MS = 8_000
/** The CLI renders prompts (trust dir / theme / telemetry) before the REPL —
 *  a bare Enter accepts the default of each. The reference nudges on this
 *  cadence too. */
const NUDGE_EVERY_MS = 800
const POLL_EVERY_MS = 300

export type RefreshOutcome = 'refreshed' | 'unchanged' | 'cooldown' | 'spawn-failed'

export interface RefreshDeps {
  /** Injectable for the smoke — the real one is the pty seam. */
  spawn?: (env: Record<string, string>, cwd: string) => IPty
  now?: () => number
  timeoutMs?: number
}

interface AttemptState {
  lastAttemptAt: number
  lastCooldownMs: number
  inFlight: Promise<RefreshOutcome> | null
}
const state: AttemptState = { lastAttemptAt: 0, lastCooldownMs: 0, inFlight: null }

/** What we compare to see the CLI actually wrote fresh credentials. */
function credentialFingerprint(home: string): string {
  const file = join(home, '.credentials.json')
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function scrubbedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  // The probe must be a plain terminal: not a node child of Electron
  // (ELECTRON_RUN_AS_NODE breaks every `npm`-shimmed CLI), and not a pane
  // (the daemon-injected identity would make the CLI's hooks report a pane
  // that does not exist).
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MOGGING_PANE_ID
  delete env.MOGGING_DAEMON_ENDPOINT
  env.CLAUDE_CONFIG_DIR = home // refresh THE home we read, not a default one
  return env
}

function defaultSpawn(env: Record<string, string>, cwd: string): IPty {
  const { proc } = spawnPty(defaultShell(), shellArgs(), {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env
  })
  return proc
}

async function performAttempt(home: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const before = credentialFingerprint(home)
  const probeCwd = join(tmpdir(), 'mogging-claude-probe')
  try {
    mkdirSync(probeCwd, { recursive: true })
  } catch {
    /* tmpdir exists */
  }
  let proc: IPty
  try {
    proc = (deps.spawn ?? defaultSpawn)(scrubbedEnv(home), probeCwd)
  } catch {
    state.lastCooldownMs = COOLDOWN_FAIL_MS
    return 'spawn-failed'
  }
  state.lastCooldownMs = COOLDOWN_MS
  // The login shell resolves `claude` exactly as the user's own terminal
  // would (rc files, PATH, .cmd shims) — the install service's pattern.
  proc.write('claude /status\r')

  const deadline = now() + timeoutMs
  let nudgeAt = now() + NUDGE_EVERY_MS
  try {
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
      const current = credentialFingerprint(home)
      if (current && current !== before) return 'refreshed'
      if (now() >= nudgeAt) {
        proc.write('\r') // accept a first-run prompt sitting between us and the REPL
        nudgeAt = now() + NUDGE_EVERY_MS
      }
    }
    return 'unchanged'
  } finally {
    try {
      killPtyTree(proc)
    } catch {
      /* already gone */
    }
  }
}

/** Ask the Claude CLI to refresh its own credentials. Joins an in-flight
 *  attempt; respects the cooldown; never throws. */
export function attemptClaudeRefresh(home: string, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now
  if (state.inFlight) return state.inFlight
  const cooldown = state.lastCooldownMs || COOLDOWN_MS
  if (state.lastAttemptAt && now() - state.lastAttemptAt < cooldown) return Promise.resolve('cooldown')
  state.lastAttemptAt = now()
  state.inFlight = performAttempt(home, deps).finally(() => {
    state.inFlight = null
  })
  return state.inFlight
}

/** Smoke hook: reset the cooldown/single-flight latch between asserts. */
export function resetClaudeRefreshStateForTest(): void {
  state.lastAttemptAt = 0
  state.lastCooldownMs = 0
  state.inFlight = null
}

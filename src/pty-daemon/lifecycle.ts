// Daemon lifecycle plumbing: per-user + per-version runtime dir, atomic single-instance
// lock (with stale takeover), endpoint discovery file, and logging. No Electron here —
// the daemon runs under plain Node / Electron-as-Node. (ADR 0006.)
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION, channelFromEnv, runtimeSegment } from '@contracts'
import { isAlive, pipeAlive } from '@backend/platform/pid'
import { ensureRuntimeDir } from '@backend/platform/runtime-paths'

// Re-exported: index.ts and the migration surface historically imported these from here.
export { isAlive, pipeAlive } from '@backend/platform/pid'

/** The daemon's runtime dir, created + tightened. THE shared derivation lives in
 *  @backend/platform/runtime-paths (ensureRuntimeDir) — the app's client derives the
 *  same path from the same helper, so the two cannot drift onto different sockets. */
export function runtimeDir(): string {
  return ensureRuntimeDir()
}

export const endpointPath = (): string => path.join(runtimeDir(), 'endpoint.json')
export const lockPath = (): string => path.join(runtimeDir(), 'daemon.lock')
export const logPath = (): string => path.join(runtimeDir(), 'daemon.log')

/** Named pipe (Windows) or unix socket path (macOS/Linux), namespaced by channel+version+pid.
 *  Pipe names are a GLOBAL namespace on Windows — the channel segment keeps a dev daemon's pipe
 *  visibly distinct from a release's even before the pid disambiguates. */
export function socketAddress(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mogginglabs-${runtimeSegment(channelFromEnv())}-${pid}`
    : path.join(runtimeDir(), `daemon-${pid}.sock`)
}

/** Does `owner` still look like a live DAEMON (not merely a live pid)? `kill(pid, 0)` is
 *  not identity: Windows recycles pids aggressively, and a crashed daemon whose pid was
 *  handed to an unrelated process would otherwise hold the lock forever (no daemon could
 *  ever start again on this channel). The daemon's own named pipe is the identity proof;
 *  a young lock (owner may not have created its pipe yet) trusts the pid alone. */
function ownerHoldsLock(owner: number, lockFile: string): boolean {
  if (!isAlive(owner)) return false
  if (process.platform !== 'win32') return true
  if (pipeAlive(socketAddress(owner))) return true
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs < 30_000 // startup grace: pipe not up yet
  } catch {
    return false
  }
}

/** Atomic single-instance lock via exclusive create. Takes over a stale lock whose owner
 *  is dead. Returns true iff this process now owns the lock. */
export function acquireLock(): boolean {
  const p = lockPath()
  const claim = (): boolean => {
    const fd = fs.openSync(p, 'wx') // O_EXCL: fails if the file already exists
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  }
  try {
    return claim()
  } catch {
    try {
      const owner = Number(fs.readFileSync(p, 'utf8'))
      if (owner && ownerHoldsLock(owner, p)) return false // a live daemon owns it
      // Stale takeover, TOCTOU-safe: never unlink the lock path itself — two racing
      // takeovers can both read the same dead pid, and the slower unlink would destroy
      // the faster contender's FRESHLY CLAIMED lock (two daemons both "owning" the
      // singleton, both restoring sessions.db, duplicate resumes). Renaming the stale
      // file aside is atomic and succeeds for exactly ONE contender; everyone then
      // funnels through claim(), where O_EXCL picks the single winner.
      const aside = `${p}.stale.${process.pid}`
      try {
        fs.renameSync(p, aside)
      } catch {
        /* another contender moved it first — claim() below decides the winner */
      }
      try {
        fs.unlinkSync(aside)
      } catch {
        /* best effort */
      }
      return claim()
    } catch {
      return false
    }
  }
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(lockPath())
  } catch {
    /* already gone */
  }
}

export function writeEndpoint(ep: {
  version: number
  address: string
  token: string
  pid: number
  /** Self-taken hash of the bundle this daemon booted from (build-stamp.ts). The app compares
   *  it against the bundle it would spawn and retires us in place when we are stale code. */
  build?: string
}): void {
  fs.writeFileSync(endpointPath(), JSON.stringify(ep), { mode: 0o600 })
}

export function clearEndpoint(): void {
  try {
    fs.unlinkSync(endpointPath())
  } catch {
    /* already gone */
  }
}

export function log(msg: string): void {
  try {
    fs.appendFileSync(logPath(), new Date().toISOString() + ' ' + msg + '\n')
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Live daemon endpoints from OTHER protocol versions. Because paths are namespaced by
 * version, an app update starts its OWN daemon and never clashes with an old one (no tmux
 * "kill-server"; old sessions keep running = no data loss). This surfaces those old daemons
 * so a future update can MIGRATE their sessions (via agent `--resume` + snapshot, Phase-1/03).
 */
export function otherVersionEndpoints(): Array<{ version: number; pid: number; address: string }> {
  const found: Array<{ version: number; pid: number; address: string }> = []
  try {
    const runRoot = path.dirname(runtimeDir())
    // Channel-scoped on purpose: a dev daemon must only ever surface DEV sessions to migrate.
    // Matching the other channel here would offer a release's live sessions to a repo checkout.
    const pattern = channelFromEnv() === 'dev' ? /^dev-v(\d+)$/ : /^v(\d+)$/
    for (const name of fs.readdirSync(runRoot)) {
      const m = pattern.exec(name)
      if (!m || Number(m[1]) === DAEMON_PROTOCOL_VERSION) continue
      try {
        const ep = JSON.parse(fs.readFileSync(path.join(runRoot, name, 'endpoint.json'), 'utf8'))
        // pipeAlive: same pid-recycling honesty as the lock — a recycled pid must not
        // surface a phantom "live" old-version daemon whose sessions we then try to migrate.
        if (ep && typeof ep.pid === 'number' && isAlive(ep.pid) && typeof ep.address === 'string' && pipeAlive(ep.address)) {
          found.push({ version: ep.version, pid: ep.pid, address: ep.address })
        }
      } catch {
        /* no/invalid endpoint in that version dir */
      }
    }
  } catch {
    /* run root missing */
  }
  return found
}

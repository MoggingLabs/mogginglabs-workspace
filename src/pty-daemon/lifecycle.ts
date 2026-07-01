// Daemon lifecycle plumbing: per-user + per-version runtime dir, atomic single-instance
// lock (with stale takeover), endpoint discovery file, and logging. No Electron here —
// the daemon runs under plain Node / Electron-as-Node. (ADR 0006.)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'

const APP = 'MoggingLabs'

/** Per-user, per-protocol-version runtime dir. Namespacing by version means different
 *  app versions never collide on socket/lock/endpoint (ADR 0006 anti-kill-server). */
export function runtimeDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  const dir = path.join(base, APP, 'run', 'v' + DAEMON_PROTOCOL_VERSION)
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      /* best effort */
    }
  }
  return dir
}

export const endpointPath = (): string => path.join(runtimeDir(), 'endpoint.json')
export const lockPath = (): string => path.join(runtimeDir(), 'daemon.lock')
export const logPath = (): string => path.join(runtimeDir(), 'daemon.log')

/** Named pipe (Windows) or unix socket path (macOS/Linux), namespaced by version + pid. */
export function socketAddress(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mogginglabs-v${DAEMON_PROTOCOL_VERSION}-${pid}`
    : path.join(runtimeDir(), `daemon-${pid}.sock`)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
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
      if (owner && isAlive(owner)) return false // a live daemon owns it
      fs.unlinkSync(p) // stale — take over
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

export function writeEndpoint(ep: { version: number; address: string; token: string; pid: number }): void {
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

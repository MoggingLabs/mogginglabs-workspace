import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { channelFromEnv, runtimeSegment, type ReleaseChannel } from '@contracts'

// THE per-user, per-protocol-version, per-channel runtime root — derived ONCE.
// The daemon (pty-daemon/lifecycle.ts) and the app's client (main/daemon-client.ts)
// used to each carry their own copy of this derivation, joined by a "MUST match the
// other" comment: the socket, lock, endpoint and CLI runtime all key off it, so a
// one-character drift between the two would make the app miss its own daemon entirely.
// One function, no cross-reference to maintain. Electron-free — the daemon runs under
// plain Node / Electron-as-Node, and the client is deliberately electron-import-free.

const APP = 'MoggingLabs'

/** The OS base under which every MoggingLabs runtime path lives. */
export function runtimeBaseDir(): string {
  return process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
}

/** The runtime dir for a channel (default: the inherited MOGGING_CHANNEL). PURE — it
 *  derives the path and does NOT create it, so read-only callers (endpoint discovery,
 *  the run-root janitor, migration) pay no filesystem cost and never create phantom
 *  dirs. Version + channel namespacing keeps app updates and a dev checkout off each
 *  other's socket/lock/endpoint (ADR 0006). */
export function runtimeDir(channel: ReleaseChannel = channelFromEnv()): string {
  return path.join(runtimeBaseDir(), APP, 'run', runtimeSegment(channel))
}

/** Dirs this process has already created + tightened (keyed by path — a fixture that
 *  swaps LOCALAPPDATA between calls must still get each dir ensured). */
const ensuredDirs = new Set<string>()

/** runtimeDir(), created and (POSIX) tightened to 0700 — memoized, because it sits under
 *  every log line and endpoint write and an unmemoized ensure paid two syscalls per call. */
export function ensureRuntimeDir(channel: ReleaseChannel = channelFromEnv()): string {
  const dir = runtimeDir(channel)
  if (!ensuredDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dir, 0o700)
      } catch {
        /* best effort */
      }
    }
    ensuredDirs.add(dir)
  }
  return dir
}

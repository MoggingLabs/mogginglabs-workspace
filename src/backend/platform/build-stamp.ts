import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * The daemon BUILD STAMP: a content hash of the daemon bundle, taken by both sides of the
 * spawn. The daemon hashes its own entry file at startup and records it in endpoint.json;
 * the app hashes the file it WOULD spawn and compares. Equal bytes, equal hash — so a
 * mismatch means exactly one thing: the daemon that is already running was started from a
 * different build than the one on disk.
 *
 * This is the second half of a split. DAEMON_PROTOCOL_VERSION answers "can an old daemon
 * still SPEAK to this app?" — it moves only for capability breaks, and each move mints a new
 * run/v<N> dir and a full retire-and-migrate. The stamp answers "is the running daemon's
 * CODE the code I ship?" — and on a mismatch the app retires it gracefully in place, in the
 * same dir (shutdown persists the store; the fresh spawn's cold-start restore does the
 * rest). Before the split, that second question had no answer: v0.11.1 fixed a tracker bug
 * that lives INSIDE the daemon, changed no wire at all, and would have reached nobody —
 * every updated app would have reconnected to the surviving daemon still running the buggy
 * code, until the machine rebooted. Burning a protocol version per behaviour fix was the
 * interim answer, and it turned the version into a build counter and the run root into a
 * graveyard (eight dead dirs on the first machine we counted).
 *
 * Deliberately the file's BYTES, not a version string: a version constant must be bumped by
 * a human remembering to, which is the exact failure mode this exists to remove. Both
 * bundles read the path through Electron's asar-patched fs (the daemon entry ships inside
 * app.asar), so packaged and dev builds hash identically.
 *
 * Truncated to 16 hex chars: this distinguishes builds, it does not defend against an
 * adversary — endpoint.json is already trusted (0600, per-user dir, holds the auth token).
 */
export function buildStampOf(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    // Unreadable entry (a packaging arrangement we did not foresee): no stamp. Callers
    // treat "no expectation" as "never retire" — a stale daemon beats a respawn loop.
    return null
  }
}

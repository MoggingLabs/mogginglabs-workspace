// The run-root janitor. Every protocol bump leaves its run/v<N> directory behind, and until
// this module NOTHING ever deleted one: the first machine we audited carried eight of them —
// 31 MB — each still holding the daemon's 48-character auth token (for a pid long dead) and a
// sessions.db full of terminal scrollback. A dead token is not exploitable (the pipe it
// authenticated died with its process), but it is a secret with no lifecycle, and the custody
// rule exists precisely to forbid that shape: a secret in our custody rests as OS-vault
// ciphertext or does not rest at all (ADR 0008(h)). Stale scrollback is the same failure with
// the user's terminal history in it.
//
// THE RULES — every one is a refusal, because a false KEEP costs 4 MB and a false DELETE
// costs a live daemon its endpoint, token and store out from under it:
//
//   channel-scoped   a prod app touches only `v<N>`, a dev app only `dev-v<N>` — the same
//                    scoping every other cross-dir read has (migration, otherVersionEndpoints).
//   strictly older   only version < ours. The current dir is the live one; a FUTURE dir
//                    belongs to a newer release the user may be running side by side — an old
//                    app deleting a new app's runtime would be sabotage in the other direction.
//   verifiably dead  a live pid keeps the dir, full stop. That is a running older release,
//                    and ADR 0006's whole anti-kill-server stance protects it. Liveness errs
//                    toward keeping: kill(pid, 0) alone decides (a recycled pid merely defers
//                    the sweep to a later boot — cheap), and an unreadable endpoint means the
//                    daemon is gone (it writes the file as its last startup act; a dir with a
//                    store but no endpoint is a crashed or pre-endpoint daemon, equally dead).
//
// Runs at every boot, AFTER migration (the just-drained source dir is dead by then and swept
// in the same pass that made it so). Idempotent, best-effort, bounded: a locked file leaves a
// partial dir for the next boot; a sweep failure is logged and never blocks a launch.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION, channelFromEnv } from '@contracts'
import type { ReleaseChannel } from '@contracts'
import { runtimeDir } from './daemon-client'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface SweepReport {
  /** Directory basenames removed (dead, strictly older, same channel). */
  swept: string[]
  /** Same-channel older dirs KEPT because a live pid owns them. */
  keptLive: string[]
}

/**
 * The testable core: sweep one run root for one channel at one current version. The boot
 * wrapper below binds the real values; the DAEMONCUSTODY gate drives this directly with a
 * fixture root and a matrix of live/dead/current/future/foreign-channel dirs.
 */
export function sweepRunRoot(root: string, currentVersion: number, channel: ReleaseChannel): SweepReport {
  const report: SweepReport = { swept: [], keptLive: [] }
  const pattern = channel === 'dev' ? /^dev-v(\d+)$/ : /^v(\d+)$/
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return report // no root yet — first boot on this machine
  }
  for (const name of names) {
    const m = pattern.exec(name)
    if (!m) continue // foreign channel or not a version dir — never ours to judge
    const version = Number(m[1])
    if (!Number.isInteger(version) || version >= currentVersion) continue // current/future: keep
    const dir = path.join(root, name)
    let livePid: number | null = null
    try {
      const ep = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8')) as { pid?: number }
      if (typeof ep?.pid === 'number' && isAlive(ep.pid)) livePid = ep.pid
    } catch {
      /* no/unreadable endpoint — the daemon never finished starting, or is long gone */
    }
    if (livePid !== null) {
      report.keptLive.push(name)
      continue
    }
    try {
      // maxRetries: Windows holds directory handles a beat after a process dies; a still-locked
      // file after the retries leaves a partial dir, and the next boot finishes the job.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      report.swept.push(name)
    } catch {
      /* locked — next boot */
    }
  }
  return report
}

/** The boot entry: sweep OUR channel's root at OUR version. Called after migration; a throw
 *  never escapes (the janitor must never be the reason the app fails to start). */
export function sweepDeadRunDirs(): SweepReport {
  try {
    const report = sweepRunRoot(path.dirname(runtimeDir()), DAEMON_PROTOCOL_VERSION, channelFromEnv())
    if (report.swept.length > 0) {
      console.warn(`[daemon] swept ${report.swept.length} dead runtime dir(s): ${report.swept.join(', ')}`)
    }
    return report
  } catch {
    return { swept: [], keptLive: [] }
  }
}

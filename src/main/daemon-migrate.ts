// Seamless protocol-version updates (the migration `lifecycle.ts` has promised since
// Phase-1/03). A new app version speaks a NEW daemon protocol and therefore starts its own
// daemon in a fresh run/v<N> dir — safe by construction (ADR 0006 anti-kill-server), but on
// its own that means every pane comes back BLANK after an update, while the OLD daemon keeps
// the user's agents running invisibly, forever. This module makes the hand-off invisible:
//
// On the FIRST launch of a new protocol version (our runtime dir has no sessions.db yet):
//   1. Find the newest OLDER-version runtime dir on the SAME channel (never across dev/prod).
//   2. If that daemon is ALIVE: capture every pane's LIVE state over the old daemon's own
//      wire protocol — `list` for the pane set (live cwd + command label), `capture` for the
//      retained scrollback. This is FRESHER than its persisted store (whose writes coalesce
//      ~2s behind), so nothing the user just saw is lost. Then ask it to `shutdown`: its
//      agent processes end HERE, deliberately, and come back via each CLI's own resume in
//      the restored panes — the same "never a frozen process" semantics as a cold restore.
//   3. If it is DEAD: read its persisted sessions.db (the best state that exists).
//   4. Seed OUR sessions.db with those panes. The new daemon's normal cold-start restore
//      then does the rest: fresh shells at the same cwd, repainted scrollback, resume.
//
// Wire compatibility: `hello`/`list`→`panes`/`capture`→`captured`/`shutdown` have been
// stable since protocol v2, and the handshake version + auth token are read from the OLD
// daemon's endpoint file — no old protocol constant is restated here (protocol gate). A v1
// daemon (no `capture`) simply degrades to its persisted rows per pane.
//
// Everything is bounded and best-effort: any failure at any step degrades to exactly the
// pre-migration behavior (a blank fresh daemon; the old one untouched) — never a blocked
// launch, never a destroyed store. The old dir is left in place as a natural backup.
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION, channelFromEnv, createLineFramer } from '@contracts'
import type { DaemonEndpoint, PaneInfo, PersistedPane, RemoteConnection } from '@contracts'
import { normalizePaneCwd } from '@backend/features/agent-state'
import { SessionStore } from '@backend/features/workspace'
import { isAlive } from '@backend/platform/pid'
import { runtimeDir } from './daemon-client'

/** Hard ceiling on the whole migration, endpoint probe to store write. A once-ever first
 *  boot may spend this; a normal launch never enters this module past the two guards. */
const OVERALL_DEADLINE_MS = 10_000
const CONNECT_TIMEOUT_MS = 3_000
const LIST_TIMEOUT_MS = 2_000
const CAPTURE_TIMEOUT_MS = 2_500
const SHUTDOWN_WAIT_MS = 4_000
/** How long we let the `shutdown` frame drain before tearing the socket down anyway. */
const SHUTDOWN_FLUSH_MS = 500
const REMOTE_IDENTITY_PERSISTENCE_PROTOCOL_VERSION = 7

export type DaemonMigrationResult = number | 'deferred'

export class DaemonMigrationDeferredError extends Error {
  constructor() {
    super('legacy remote sessions are still active and require confirmed POSIX host settings')
    this.name = 'DaemonMigrationDeferredError'
  }
}

export function persistedRowsForDeadSource(
  sourceVersion: number,
  persisted: ReadonlyMap<string, PersistedPane>
): PersistedPane[] {
  const rows = [...persisted.values()]
  if (sourceVersion >= REMOTE_IDENTITY_PERSISTENCE_PROTOCOL_VERSION) return rows
  return rows.map((row) => ({ ...row, command: undefined }))
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface MigrationSource {
  version: number
  dir: string
  /** Set only when a live daemon owns the dir (endpoint present + pid alive). */
  endpoint: DaemonEndpoint | null
}

/** The newest same-channel, older-version runtime dir worth migrating from: one holding
 *  either a live daemon or a persisted session store. */
function findMigrationSource(): MigrationSource | null {
  const root = path.dirname(runtimeDir())
  // Channel-scoped on purpose (mirrors lifecycle.ts's otherVersionEndpoints): a dev app
  // must never ingest — or shut down — a release's sessions, nor the reverse.
  const pattern = channelFromEnv() === 'dev' ? /^dev-v(\d+)$/ : /^v(\d+)$/
  let best: MigrationSource | null = null
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const name of names) {
    const m = pattern.exec(name)
    if (!m) continue
    const version = Number(m[1])
    if (!Number.isInteger(version) || version >= DAEMON_PROTOCOL_VERSION) continue
    if (best && version <= best.version) continue
    const dir = path.join(root, name)
    let endpoint: DaemonEndpoint | null = null
    try {
      const ep = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8')) as DaemonEndpoint
      if (ep && typeof ep.pid === 'number' && typeof ep.address === 'string' && isAlive(ep.pid)) endpoint = ep
    } catch {
      /* no/invalid endpoint — store-only candidate */
    }
    const hasStore = fs.existsSync(path.join(dir, 'sessions.db'))
    if (endpoint || hasStore) best = { version, dir, endpoint }
  }
  return best
}

/** Read an old dir's persisted panes. Best-effort: a locked/corrupt store yields []. */
function readPersistedPanes(dir: string): PersistedPane[] {
  const dbPath = path.join(dir, 'sessions.db')
  if (!fs.existsSync(dbPath)) return []
  let store: SessionStore | null = null
  try {
    store = new SessionStore(dbPath)
    return store.loadPanes()
  } catch {
    return []
  } finally {
    try {
      store?.close()
    } catch {
      /* best effort */
    }
  }
}

/** Everything learned from a live old daemon: its pane set with live scrollback. */
export interface LiveCapture {
  panes: Array<{ info: Pick<PaneInfo, 'id' | 'cwd' | 'title' | 'remoteName'>; scrollback: string | null }>
}

function matchedPersistedRemote(
  info: LiveCapture['panes'][number]['info'],
  old: PersistedPane | undefined
): PersistedPane['remote'] | null {
  const liveRemoteName = info.remoteName || undefined
  return liveRemoteName && old?.remote?.platform === 'posix' && old.remote.name === liveRemoteName
    ? old.remote
    : null
}

/** Whether retiring this live daemon can preserve every remote pane. The legacy wire
 * only exposes a saved-host name, so a matching, explicitly POSIX persisted host is the
 * minimum identity needed to recreate its SSH target after shutdown. */
export function liveCaptureHasRestorableRemoteIdentity(
  live: LiveCapture,
  persisted: ReadonlyMap<string, PersistedPane>
): boolean {
  return live.panes.every(({ info }) => !info.remoteName || !!matchedPersistedRemote(info, persisted.get(info.id)))
}

/** Enrich a legacy live capture from current, explicitly confirmed host settings. Protocol v6
 * persisted no SSH columns, so this is the recovery path after the user confirms the old host
 * as POSIX in Settings and restarts. Ambiguous display names remain deferred. */
export function addConfirmedRemoteIdentities(
  live: LiveCapture,
  persisted: Map<string, PersistedPane>,
  confirmedRemotes: readonly RemoteConnection[]
): void {
  for (const { info } of live.panes) {
    if (!info.remoteName || matchedPersistedRemote(info, persisted.get(info.id))) continue
    const matches = confirmedRemotes.filter((remote) => remote.name === info.remoteName)
    if (matches.length !== 1) continue
    const old = persisted.get(info.id)
    persisted.set(info.id, {
      ...old,
      id: info.id,
      workspaceId: old?.workspaceId ?? 'default',
      cwd: old?.cwd ?? '',
      remote: { ...matches[0] },
      command: info.title ?? old?.command,
      scrollback: old?.scrollback ?? '',
      updatedAt: old?.updatedAt ?? Date.now()
    })
  }
}

/** Merge live daemon truth with persisted-only session metadata. Live pane membership,
 * title and scrollback win. Live cwd replaces a local cwd or refines `remote.cwd`; remote
 * identity and reported-cwd context survive because the old wire does not expose them. */
export function mergeLiveCaptureRows(
  live: LiveCapture,
  persisted: ReadonlyMap<string, PersistedPane>,
  updatedAt = Date.now()
): PersistedPane[] {
  return live.panes.flatMap(({ info, scrollback }) => {
    const old = persisted.get(info.id)
    const liveRemoteName = info.remoteName || undefined
    const matchedRemoteIdentity = matchedPersistedRemote(info, old)
    const matchedRemote = matchedRemoteIdentity && old
      ? { pane: old, remote: matchedRemoteIdentity }
      : null

    // Live locality is authoritative because pane ids are reusable. A live remote pane
    // cannot be reconstructed without its persisted host pointer, and a name mismatch is
    // evidence that the row belongs to an older occupant of this id. Refuse that pane
    // instead of silently restoring it as a local shell or on the wrong SSH target.
    if (liveRemoteName && !matchedRemote) return []

    // Conversely, a live local pane must shed stale remote/report context left behind by
    // a previous remote occupant of the same id. Local-to-local rows retain their context.
    const oldForIdentity = !liveRemoteName && old?.remote ? undefined : old
    const liveRemoteCwd = matchedRemote
      ? normalizePaneCwd(info.cwd, { mustExist: false, platform: 'linux' })
      : null
    return [{
      ...oldForIdentity,
      id: info.id,
      workspaceId: oldForIdentity?.workspaceId ?? 'default',
      // PaneInfo.cwd is on the remote machine for an SSH pane. Keep the top-level
      // launch cwd intact and carry the live remote path into the SSH bootstrap spec.
      cwd: matchedRemote ? matchedRemote.pane.cwd : (info.cwd || oldForIdentity?.cwd || ''),
      remote: matchedRemote
        ? { ...matchedRemote.remote, cwd: liveRemoteCwd ?? matchedRemote.remote.cwd }
        : undefined,
      command: info.title ?? oldForIdentity?.command,
      scrollback: scrollback ?? oldForIdentity?.scrollback ?? '',
      updatedAt
    }]
  })
}

/**
 * Speak the OLD daemon's protocol (version + token from ITS endpoint file) to capture the
 * live pane set, then ask it to shut down. Returns null if the conversation failed or the
 * caller's safety preflight refuses retirement; either way the old daemon stays running.
 * A per-pane capture failure only costs that pane's live tail (its persisted row applies).
 */
function captureAndRetireOldDaemon(
  ep: DaemonEndpoint,
  deadlineAt: number,
  mayRetire: (live: LiveCapture) => boolean
): Promise<LiveCapture | null> {
  return new Promise((resolve) => {
    let settled = false
    let retireStarted = false
    let retireResult: LiveCapture | null = null
    const sock = net.connect(ep.address)
    sock.setEncoding('utf8')
    const finish = (result: LiveCapture | null): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve(result)
    }
    const connectTimer = setTimeout(() => finish(null), Math.min(CONNECT_TIMEOUT_MS, deadlineAt - Date.now()))

    let panes: PaneInfo[] | null = null
    const captured = new Map<string, string>()
    let pending = 0
    let phase: 'hello' | 'list' | 'capture' = 'hello'
    let phaseTimer: ReturnType<typeof setTimeout> | undefined

    const send = (m: unknown): void => {
      try {
        sock.write(JSON.stringify(m) + '\n')
      } catch {
        finish(null)
      }
    }

    const done = (): void => {
      if (retireStarted || settled) return
      const result: LiveCapture = {
        panes: (panes ?? []).map((p) => ({
          info: { id: p.id, cwd: p.cwd, title: p.title, remoteName: p.remoteName },
          scrollback: captured.get(p.id) ?? null
        }))
      }
      // Decide while the old daemon and its PTYs are still alive. Older stores did not
      // persist SSH identity, and PaneInfo.remoteName alone cannot recreate a host target.
      if (!mayRetire(result)) {
        console.warn('[daemon] live remote pane identity is incomplete; leaving old daemon running')
        finish(null)
        return
      }
      retireStarted = true
      retireResult = result
      // Retire the old daemon LAST, after its state is safely in hand — and only once the
      // frame is actually FLUSHED. finish() destroys the socket, and destroy() discards
      // queued writes: a dropped `shutdown` left the old daemon alive, the caller's pid
      // wait then timed out and seeded the store anyway, and the new daemon respawned every
      // migrated agent while the originals kept running invisibly (duplicate live agents
      // after an update). The write callback fires when the bytes reach the OS; the grace
      // timer keeps a stalled flush from hanging the migration, and the caller's
      // SHUTDOWN_WAIT_MS pid check stays the outer guard either way.
      let settledAfterWrite = false
      const settle = (): void => {
        if (settledAfterWrite) return
        settledAfterWrite = true
        finish(result)
      }
      try {
        sock.write(JSON.stringify({ t: 'shutdown' }) + '\n', () => settle())
      } catch {
        settle()
        return
      }
      setTimeout(settle, SHUTDOWN_FLUSH_MS)
    }

    const startCapture = (): void => {
      phase = 'capture'
      if (!panes || panes.length === 0) {
        done()
        return
      }
      pending = panes.length
      for (const p of panes) send({ t: 'capture', id: p.id, lastLines: 10000 })
      // One shared timeout: whatever hasn't answered by then migrates from its
      // persisted row instead (a v1 daemon answers none of them — all degrade).
      phaseTimer = setTimeout(done, Math.min(CAPTURE_TIMEOUT_MS, Math.max(250, deadlineAt - Date.now())))
    }

    const framer = createLineFramer((obj) => {
      const m = obj as { t?: string; reason?: string; panes?: PaneInfo[]; id?: string; data?: string }
      if (m.t === 'error' && phase === 'hello') {
        finish(null) // auth refused — not ours to touch
        return
      }
      if (m.t === 'welcome' && phase === 'hello') {
        clearTimeout(connectTimer)
        phase = 'list'
        // Prefer the explicit list reply, but keep welcome's panes as the fallback for
        // old daemons whose `list` predates the control API.
        if (Array.isArray(m.panes)) panes = m.panes
        send({ t: 'list' })
        phaseTimer = setTimeout(() => {
          if (panes) startCapture()
          else finish(null)
        }, Math.min(LIST_TIMEOUT_MS, Math.max(250, deadlineAt - Date.now())))
        return
      }
      if (m.t === 'panes' && phase === 'list') {
        clearTimeout(phaseTimer)
        if (Array.isArray(m.panes)) panes = m.panes
        startCapture()
        return
      }
      if (m.t === 'captured' && phase === 'capture' && typeof m.id === 'string') {
        captured.set(m.id, typeof m.data === 'string' ? m.data : '')
        pending--
        if (pending <= 0) {
          clearTimeout(phaseTimer)
          done()
        }
      }
    })
    sock.on('data', (chunk: string) => framer(chunk))
    sock.on('error', () => finish(retireStarted ? retireResult : null))
    sock.on('close', () => finish(retireStarted ? retireResult : null))
    sock.on('connect', () => {
      // The version WE claim is the version the endpoint file declares — the old daemon
      // only accepts its own, and that is the point: we are its guest, briefly.
      send({ t: 'hello', v: ep.version, token: ep.token })
    })
  })
}

/**
 * The entry point: run once per protocol-version transition, BEFORE the first daemon
 * spawn. Returns how many panes were migrated (0 = nothing to do / degraded gracefully).
 */
export async function migrateOlderDaemonSessions(
  confirmedRemotes: readonly RemoteConnection[] = []
): Promise<DaemonMigrationResult> {
  const deadlineAt = Date.now() + OVERALL_DEADLINE_MS
  const targetDb = path.join(runtimeDir(), 'sessions.db')
  // Idempotence guard: our store existing means this version has already run (its daemon
  // creates the file on first boot) or already migrated. Either way: hands off.
  if (fs.existsSync(targetDb)) return 0

  const source = findMigrationSource()
  if (!source) return 0

  // Persisted rows first: they are the complete source for a dead daemon and supply metadata
  // the live wire does not carry. Read before shutdown so a mid-write WAL lock can only happen
  // while the old daemon still owns the file (and is caught by the try/catch inside).
  let persisted = new Map(readPersistedPanes(source.dir).map((p) => [p.id, p]))

  let rows: PersistedPane[]
  let live: LiveCapture | null = null
  if (source.endpoint) {
    live = await captureAndRetireOldDaemon(
      source.endpoint,
      deadlineAt,
      (capture) => {
        addConfirmedRemoteIdentities(capture, persisted, confirmedRemotes)
        return liveCaptureHasRestorableRemoteIdentity(capture, persisted)
      }
    )
    if (!live) {
      // A live source remains authoritative until it can be captured and retired. Importing
      // even its persisted rows could resume duplicate agents beside their original PTYs.
      console.warn(`[daemon] v${source.version} daemon is live but could not be captured; migration deferred`)
      return 'deferred'
    }

    // Captured bytes are not authority to duplicate a still-live process. Leave this
    // protocol's store absent unless retirement is confirmed, so a later launch can retry.
    const waitUntil = Math.min(Date.now() + SHUTDOWN_WAIT_MS, deadlineAt)
    while (isAlive(source.endpoint.pid) && Date.now() < waitUntil) await delay(100)
    if (isAlive(source.endpoint.pid)) {
      console.warn(`[daemon] v${source.version} daemon did not retire after capture; migration deferred`)
      return 'deferred'
    }

    // Shutdown calls persistNow before closing the old store. Re-read after the graceful
    // wait so identity comes from the final snapshot, not a coalesced pre-reuse write.
    const finalPersisted = readPersistedPanes(source.dir)
    if (finalPersisted.length > 0) {
      const finalById = new Map(finalPersisted.map((p) => [p.id, p]))
      // A partial/corrupt reread cannot invalidate the safety decision after the old PTY
      // is gone. Keep the preflight snapshot unless the final one can restore every remote.
      if (liveCaptureHasRestorableRemoteIdentity(live, finalById)) persisted = finalById
    }

    // Live membership/locality is authoritative. The merge refuses remote panes whose
    // final persisted SSH identity is missing or mismatched instead of restoring local.
    rows = mergeLiveCaptureRows(live, persisted)
  } else {
    // Pre-v7 stores did not record remote identity, so a dead source cannot tell a local pane
    // from an SSH pane. Never auto-resume its command in a local shell; the app workspace
    // manifest remains the authority that can safely relaunch/replace the slot after attach.
    // Scrollback and cwd still migrate, so this degrades continuity without running work on
    // the wrong machine or in the wrong project.
    rows = persistedRowsForDeadSource(source.version, persisted)
  }

  if (rows.length === 0) return 0

  // Seed our store; the new daemon's normal cold-start restore does everything else.
  // Migration runs BEFORE ensureDaemon, so our runtime dir may not exist yet.
  fs.mkdirSync(path.dirname(targetDb), { recursive: true })
  let target: SessionStore | null = null
  try {
    target = new SessionStore(targetDb)
    target.savePanes(rows)
  } finally {
    try {
      target?.close()
    } catch {
      /* best effort */
    }
  }
  console.warn(`[daemon] migrated ${rows.length} pane(s) from protocol v${source.version} (${live ? 'live capture' : 'persisted store'})`)
  return rows.length
}

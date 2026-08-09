/**
 * One-time repair for panes that lost their agent and profile.
 *
 *   npx tsx scripts/repair-pane-launch.ts              # dry run — prints the plan, writes nothing
 *   npx tsx scripts/repair-pane-launch.ts --apply      # back up, then write
 *   npx tsx scripts/repair-pane-launch.ts --apply --strip-banners
 *
 * WHY THIS EXISTS. Restore recovered a pane's agent by matching the first token of its
 * persisted `command` against a table of CLI names. Every command the app builds starts with
 * `cd` (features/agents/launch.ts cdPrefix), so it matched nothing: on a real store, 0 of 34
 * panes resumed and all 13 that carried a profile pointer lost it. The code fix records launch
 * INTENT going forward; this recovers what the existing rows can still prove.
 *
 * TWO EVIDENCE SOURCES, both already on disk — nothing here is inferred:
 *   1. `panes.command` — the composed launch line. Parsed by the SAME parser the app uses
 *      (imported, never re-implemented: a second copy of that grammar is a second thing to
 *      keep in agreement, which is the class of bug this whole repair is cleaning up).
 *   2. `app_workspaces.assignments[slot]` / `pane_profile_ids[slot]` — the workspace manifest,
 *      written for every agent launch the app performed INCLUDING hand-typed ones it detected.
 *      This is the only source for rows whose `command` is NULL.
 *
 * AND ONE THAT LOOKS TEMPTING AND IS WRONG: which config home holds a cwd's `.jsonl`
 * transcripts. `poolProviderSessions` unions a cwd's sessions into the launch home on every
 * launch by design, so the same session id exists under several homes with identical mtimes.
 * Presence proves nothing. Do not add it.
 *
 * SAFETY
 *   · Dry run unless --apply.
 *   · REFUSES to write while the daemon is alive. It rewrites sessions.db from its own live
 *     panes on a coalesced timer, so a repair applied underneath it is clobbered within
 *     seconds — silently, and with the store's own contents as the winner.
 *   · Backs up sessions.db + -wal + -shm before the first write.
 *   · Never deletes a row. Fixture-cwd rows are REPAIRED from the manifest, not dropped: at
 *     least one of them (pane 1401) holds a real session transcript, so a cleanup keyed on
 *     the cwd pattern would have destroyed user data.
 *   · --strip-banners is opt-in and removes only PROVABLE restore artifacts — a cmd.exe
 *     banner block immediately following the restore mode-reset. That seam is written by
 *     restore, never typed by a user.
 */

import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LAUNCH_INTENT_VERSION, normalizeLaunchIntent, type PaneLaunchIntent } from '@contracts'
import { parseLegacyLaunchCommand } from '@backend/features/workspace/legacy-launch-parse'
import { RESTORE_MODE_RESET } from '@backend/features/terminal/pane-shared'

const APPLY = process.argv.includes('--apply')
const STRIP = process.argv.includes('--strip-banners')

// ---- locate the two stores -------------------------------------------------------------

const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const runRoot = join(localAppData, 'MoggingLabs', 'run')

/** The newest protocol-versioned run dir that actually has a store. */
function findRunDir(): string | null {
  if (!existsSync(runRoot)) return null
  const dirs = readdirSync(runRoot)
    .filter((d) => /^v\d+$/.test(d) && existsSync(join(runRoot, d, 'sessions.db')))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
  return dirs.length ? join(runRoot, dirs[0]) : null
}

const runDir = findRunDir()
if (!runDir) {
  console.error(`no sessions.db found under ${runRoot}`)
  process.exit(2)
}
const sessionsDb = join(runDir, 'sessions.db')
const settingsDb = join(roaming, 'mogginglabs-workspace', 'app-settings.db')

// ---- refuse to fight a live daemon -----------------------------------------------------

function daemonPid(): number | null {
  try {
    const ep = JSON.parse(readFileSync(join(runDir!, 'endpoint.json'), 'utf8')) as { pid?: number }
    if (typeof ep.pid !== 'number') return null
    try {
      process.kill(ep.pid, 0) // signal 0 = liveness probe, never delivered
      return ep.pid
    } catch {
      return null // stale endpoint from a dead daemon
    }
  } catch {
    return null
  }
}

// ---- load ------------------------------------------------------------------------------

interface PaneRow {
  id: string
  cwd: string
  command: string | null
  agent_id: string | null
  launch_intent: string | null
  scrollback: string
  updated_at: number
}

const sess = new DatabaseSync(sessionsDb, { readOnly: !APPLY })

// The intent columns only exist once a build that knows about them has opened this store.
// Repairing a store the fixed app has NOT yet opened is the normal case — that is the whole
// point of running this before the first launch — so read defensively and create them at
// apply time rather than requiring the app to go first.
const paneCols = new Set(
  (sess.prepare('pragma table_info(panes)').all() as unknown as Array<{ name: string }>).map((c) => c.name)
)
const hasIntentColumns = paneCols.has('agent_id') && paneCols.has('launch_intent')
const panes = sess
  .prepare(
    hasIntentColumns
      ? 'select id, cwd, command, agent_id, launch_intent, scrollback, updated_at from panes'
      : 'select id, cwd, command, NULL as agent_id, NULL as launch_intent, scrollback, updated_at from panes'
  )
  .all() as unknown as PaneRow[]

/** paneId -> what the workspace manifest says this slot was running. */
function manifestIntents(): Map<string, { agentId: string; profileId?: string; cwd?: string; workspace: string }> {
  const out = new Map<string, { agentId: string; profileId?: string; cwd?: string; workspace: string }>()
  if (!existsSync(settingsDb)) return out
  const db = new DatabaseSync(settingsDb, { readOnly: true })
  const parse = (v: unknown): unknown[] | null => {
    try {
      return v ? (JSON.parse(String(v)) as unknown[]) : null
    } catch {
      return null
    }
  }
  type WsRow = { name: string; ordinal: number; assignments: string; pane_cwds: string; pane_profile_ids: string; pane_ids: string }
  for (const w of db.prepare('select name, ordinal, assignments, pane_cwds, pane_profile_ids, pane_ids from app_workspaces').all() as unknown as WsRow[]) {
    const agents = parse(w.assignments) ?? []
    const profiles = parse(w.pane_profile_ids) ?? []
    const cwds = parse(w.pane_cwds) ?? []
    const ids = parse(w.pane_ids)
    agents.forEach((agent, i) => {
      if (typeof agent !== 'string' || !agent || agent === 'shell') return
      // Explicit pane ids when the manifest has them; otherwise the positional formula
      // (contracts/domain/pane.ts PANE_SLOT_STRIDE) the app itself uses for the slot.
      const paneId = String(ids?.[i] ?? w.ordinal * 100 + (i + 1))
      out.set(paneId, {
        agentId: agent,
        profileId: typeof profiles[i] === 'string' ? (profiles[i] as string) : undefined,
        cwd: typeof cwds[i] === 'string' ? (cwds[i] as string) : undefined,
        workspace: w.name
      })
    })
  }
  db.close()
  return out
}

const manifest = manifestIntents()

// ---- compute the repairs ---------------------------------------------------------------

/** A cmd.exe banner block that directly follows the restore seam is an artifact OF the
 *  restore — nothing a user typed can produce it there. Anything else stays. */
const BANNER = /^(?:\x1b\[[\d?;]*[a-zA-Z]|\x1b[()][A-Z0-9]|\s)*Microsoft Windows \[Version [^\]]*\]\r?\n\(c\) Microsoft Corporation\. All rights reserved\.\r?\n\r?\n/

function stripRestoreBanners(s: string): { text: string; removed: number } {
  let out = ''
  let i = 0
  let removed = 0
  for (;;) {
    const at = s.indexOf(RESTORE_MODE_RESET, i)
    if (at === -1) {
      out += s.slice(i)
      break
    }
    const after = at + RESTORE_MODE_RESET.length
    out += s.slice(i, after)
    const m = BANNER.exec(s.slice(after, after + 600))
    if (m) {
      removed++
      i = after + m[0].length
    } else {
      i = after
    }
  }
  return { text: out, removed }
}

interface Repair {
  id: string
  intent?: PaneLaunchIntent
  source?: 'command' | 'manifest'
  cwdFrom?: string
  cwdTo?: string
  bannersRemoved?: number
  scrollback?: string
}

const repairs: Repair[] = []
for (const row of panes) {
  const r: Repair = { id: row.id }

  if (row.agent_id === null && row.launch_intent === null) {
    // 1. the composed command line
    const fromCommand = parseLegacyLaunchCommand(row.command, { cwd: row.cwd, at: row.updated_at })
    if (fromCommand) {
      r.intent = fromCommand
      r.source = 'command'
    } else {
      // 2. the workspace manifest — the ONLY source for a NULL-command row
      const m = manifest.get(row.id)
      if (m) {
        const intent = normalizeLaunchIntent({
          v: LAUNCH_INTENT_VERSION,
          agentId: m.agentId,
          cwd: m.cwd || row.cwd,
          profileId: m.profileId,
          source: 'legacy',
          at: row.updated_at
        })
        if (intent) {
          r.intent = intent
          r.source = 'manifest'
          // A fixture temp dir the manifest disagrees with: repair the cwd rather than
          // dropping the row — this is where a real transcript was found living under a
          // throwaway path.
          if (m.cwd && m.cwd !== row.cwd) {
            r.cwdFrom = row.cwd
            r.cwdTo = m.cwd
          }
        }
      }
    }
  }

  if (STRIP && row.scrollback) {
    const { text, removed } = stripRestoreBanners(row.scrollback)
    if (removed > 0) {
      r.bannersRemoved = removed
      r.scrollback = text
    }
  }

  if (r.intent || r.cwdTo || r.bannersRemoved) repairs.push(r)
}

// ---- report ----------------------------------------------------------------------------

console.log(`store        : ${sessionsDb}`)
console.log(`manifest     : ${existsSync(settingsDb) ? settingsDb : '(not found — manifest recovery unavailable)'}`)
console.log(`panes        : ${panes.length}`)
console.log('')

const byCommand = repairs.filter((r) => r.source === 'command')
const byManifest = repairs.filter((r) => r.source === 'manifest')
const withProfile = repairs.filter((r) => r.intent?.profileId || r.intent?.configDir)

if (repairs.length === 0) console.log('nothing to repair.')
else {
  console.log('pane   | agent  | profile / home                        | from      | note')
  console.log('-------+--------+---------------------------------------+-----------+---------------------------')
  for (const r of repairs) {
    const home = r.intent?.configDir ?? r.intent?.profileId ?? (r.intent ? '(provider default)' : '')
    const note = [
      r.cwdTo ? `cwd -> ${r.cwdTo}` : '',
      r.bannersRemoved ? `-${r.bannersRemoved} restore banner(s)` : ''
    ]
      .filter(Boolean)
      .join(', ')
    console.log(
      `${r.id.padEnd(6)} | ${(r.intent?.agentId ?? '').padEnd(6)} | ${String(home).padEnd(37)} | ${(r.source ?? '').padEnd(9)} | ${note}`
    )
  }
}

console.log('')
console.log(`launch intent recovered : ${byCommand.length + byManifest.length}  (${byCommand.length} from the command line, ${byManifest.length} from the manifest)`)
console.log(`  ...carrying a profile : ${withProfile.length}`)
if (STRIP) console.log(`restore banners removed : ${repairs.reduce((a, r) => a + (r.bannersRemoved ?? 0), 0)}`)

// Panes the manifest calls agents but which no source could reconstruct.
const unrecovered = panes.filter(
  (row) => row.agent_id === null && row.launch_intent === null && !repairs.some((r) => r.id === row.id && r.intent)
)
if (unrecovered.length) {
  console.log(`\nno intent recoverable   : ${unrecovered.length} (plain shells, or agent panes nothing ever recorded)`)
  console.log(`  ${unrecovered.map((r) => r.id).join(', ')}`)
}

// ---- apply -----------------------------------------------------------------------------

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write (stop the app first).')
  sess.close()
  process.exit(0)
}

const pid = daemonPid()
if (pid) {
  console.error(
    `\nREFUSING TO WRITE: the daemon is running (pid ${pid}).\n` +
      'It rewrites sessions.db from its own live panes on a coalesced timer, so anything\n' +
      'written here would be silently overwritten within seconds. Quit the app, confirm the\n' +
      'daemon process is gone, then re-run.'
  )
  sess.close()
  process.exit(3)
}

const stamp = new Date(panes.reduce((a, r) => Math.max(a, r.updated_at), 0) || 0).toISOString().replace(/[:.]/g, '-')
for (const suffix of ['', '-wal', '-shm']) {
  const src = sessionsDb + suffix
  if (existsSync(src)) {
    const dest = `${src}.bak-${stamp}`
    copyFileSync(src, dest)
    console.log(`backed up ${src}\n       -> ${dest}`)
  }
}

// Same shape as the store's own addColumnIfMissing: additive, and a no-op once the app has
// opened this file. Doing it here means the repair does not depend on launching first.
if (!hasIntentColumns) {
  if (!paneCols.has('agent_id')) sess.exec('ALTER TABLE panes ADD COLUMN agent_id TEXT')
  if (!paneCols.has('launch_intent')) sess.exec('ALTER TABLE panes ADD COLUMN launch_intent TEXT')
  console.log('added the agent_id / launch_intent columns')
}

const setIntent = sess.prepare('update panes set agent_id = ?, launch_intent = ? where id = ?')
const setCwd = sess.prepare('update panes set cwd = ? where id = ?')
const setScrollback = sess.prepare('update panes set scrollback = ? where id = ?')
let wrote = 0
for (const r of repairs) {
  if (r.intent) setIntent.run(r.intent.agentId, JSON.stringify(r.intent), r.id)
  if (r.cwdTo) setCwd.run(r.cwdTo, r.id)
  if (r.scrollback !== undefined) setScrollback.run(r.scrollback, r.id)
  wrote++
}
sess.close()
console.log(`\napplied to ${wrote} pane(s).`)

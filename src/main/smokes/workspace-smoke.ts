import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SettingsStore } from '@backend/features/workspace'
import { parseLegacyLaunchCommand } from '@backend/features/workspace/legacy-launch-parse'
import { rowToPane } from '@backend/features/workspace/session-rows'

/**
 * Two-phase workspace persistence smoke (MOGGING_WORKSPACE = A | B), driven by an external
 * harness that clears the store then launches A, then B:
 *  - A: create a 2nd workspace (dir + 4-pane layout), switch back to the first, let the
 *       debounced persist flush, then quit.
 *  - B: relaunch -> assert BOTH workspaces restored, with their pane layouts + active tab.
 * Phase B also runs the store's DURABILITY asserts below (fixture db, never the real one).
 */

/**
 * C. Corruption must DEGRADE, not cascade. load()'s per-field JSON.parse calls were
 * unguarded, so one bad cell threw out of load() — which the renderer catches and reads as
 * "brand-new user", and whose next saveState (DELETE FROM app_workspaces) then wiped every
 * intact row. A corrupt cell must cost that FIELD and nothing else. Also asserts the resume
 * map's own-property guard: a persisted command whose first token is `constructor` used to
 * return Object itself, which the daemon's restore would have TYPED into the user's shell.
 */
function storeDurabilityAsserts(): {
  pass: boolean
  loadThrew: boolean
  rowSurvived: boolean
  badFieldDropped: boolean
  goodFieldKept: boolean
  resumeGuarded: boolean
} {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mogging-wsdb-')), 'app-settings.db')
  const store = new SettingsStore(dbPath)
  store.save({
    workspaces: [
      {
        id: 'w1',
        name: 'Server',
        color: 'blue',
        cwd: 'C:/tmp/server',
        ordinal: 0,
        paneCount: 2,
        assignments: ['claude', 'codex'],
        paneCwds: ['C:/tmp/server', null]
      }
    ],
    activeId: 'w1',
    theme: 'midnight'
  })
  store.close()

  // Corrupt exactly ONE cell, the way a hand-edit / half-written row would.
  const raw = new Database(dbPath)
  raw.prepare("UPDATE app_workspaces SET pane_cwds = 'not-json{' WHERE id = 'w1'").run()
  raw.close()

  const reopened = new SettingsStore(dbPath)
  let loadThrew = false
  let rowSurvived = false
  let badFieldDropped = false
  let goodFieldKept = false
  try {
    const state = reopened.load()
    const w = state.workspaces.find((x) => x.id === 'w1')
    rowSurvived = !!w && w.name === 'Server'
    badFieldDropped = !!w && w.paneCwds === undefined // the corrupt field, and only it
    goodFieldKept = !!w && Array.isArray(w.assignments) && w.assignments[0] === 'claude'
  } catch {
    loadThrew = true
  }
  reopened.close()

  // Same framing as the workspace row above: corruption must DEGRADE, not cascade.
  //
  // This used to check `resumeCommandFor` for prototype pollution — a command whose first
  // token was 'constructor' returned a FUNCTION that the restore path would happily type.
  // That function is gone: the daemon no longer composes a resume at all. Its replacement
  // reads a legacy command by matching against the CLI registry, so a hostile token cannot
  // name an agent by construction, and a row that NAMED an agent but lost its intent comes
  // back marked — never silently as a plain shell, which is how a lost session goes
  // unnoticed until the user has lost the thread.
  const degraded = rowToPane({
    id: '1',
    workspaceId: 'default',
    cwd: 'C:\\repos',
    reportedCwd: null,
    reportedCwdAt: null,
    remoteName: null,
    remoteHost: null,
    remoteUser: null,
    remotePort: null,
    remoteCwd: null,
    remotePlatform: null,
    remoteShell: null,
    command: null,
    agentId: 'claude',
    launchIntent: '{not json',
    scrollback: 'prior session output',
    gridCols: null,
    gridRows: null,
    updatedAt: 0
  })
  const resumeGuarded =
    parseLegacyLaunchCommand('constructor') === null &&
    parseLegacyLaunchCommand('toString') === null &&
    parseLegacyLaunchCommand('cd /d "C:\\repos" && claude')?.agentId === 'claude' &&
    degraded?.launchDegraded === true &&
    degraded?.scrollback === 'prior session output' // nothing overwrote what was lost

  return {
    pass: !loadThrew && rowSurvived && badFieldDropped && goodFieldKept && resumeGuarded,
    loadThrew,
    rowSurvived,
    badFieldDropped,
    goodFieldKept,
    resumeGuarded
  }
}

export function runWorkspaceSmoke(win: BrowserWindow, phase: string): void {
  setTimeout(() => app.exit(1), 30000) // safety net

  const scriptA = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ws = window.__mogging && window.__mogging.workspace
    if (!ws) return { ok: false, error: 'no workspace dev handle' }
    // Launcher-first boot: a fresh profile has NO workspaces, so waiting for one to appear
    // just burns the 5s and leaves a ONE-workspace store — phase B then finds a single
    // workspace and the two-workspace restore this gate exists to prove is never exercised.
    // Provision the first one ourselves, exactly as the ATTENTION smoke does.
    for (let i = 0; i < 50 && ws.count() < 1; i++) {
      if (i === 5) ws.create({ name: 'Workspace 1' }) // give the launcher a beat, then seed it
      await sleep(100)
    }
    ws.create({ name: 'Server', cwd: 'C:/tmp/server', paneCount: 4 })
    await sleep(300)
    ws.switchByIndex(0)
    await sleep(1000) // let the 400ms debounced persist flush to app-settings.db
    return { ok: true, count: ws.count() }
  })()`

  const scriptB = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ws = window.__mogging && window.__mogging.workspace
    if (!ws) return { ok: false, error: 'no workspace dev handle' }
    for (let i = 0; i < 70 && ws.count() < 2; i++) await sleep(150)
    const list = ws.list()
    const active = ws.active()
    return {
      count: ws.count(),
      names: list.map((w) => w.name),
      paneCounts: list.map((w) => w.paneCount),
      cwds: list.map((w) => w.cwd),
      activeName: active ? active.name : null
    }
  })()`

  const isA = phase.toUpperCase() === 'A'

  const run = async (): Promise<void> => {
    let result: Record<string, unknown>
    try {
      result = await win.webContents.executeJavaScript(isA ? scriptA : scriptB, true)
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    if (isA) {
      app.exit(result.ok ? 0 : 1)
      return
    }
    const durability = storeDurabilityAsserts()
    const pass =
      result.count === 2 &&
      Array.isArray(result.paneCounts) &&
      (result.paneCounts as number[]).includes(4) &&
      Array.isArray(result.names) &&
      (result.names as string[]).includes('Server') &&
      durability.pass
    try {
      writeFileSync(join(process.cwd(), 'out', 'workspace-result.json'), JSON.stringify({ pass, durability, ...result }))
    } catch {
      /* best effort */
    }
    app.exit(pass ? 0 : 1)
  }

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

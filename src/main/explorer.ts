import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { createExplorerWatcher, listExplorer, type ExplorerWatcher } from '@backend/features/explorer'
import { canonical, isUnder } from '@backend/platform/fs-paths'
import {
  EXPLORER_DOCK_WIDTH,
  ExplorerChannels,
  type ExplorerActionResult,
  type ExplorerDockInit,
  type ExplorerResult,
  type ExplorerWatchStats
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { waitForExplorerRaceAudit } from './explorer-race-audit-faults'

// App-wiring: the explorer's read-only listing (Phase-11/01, ADR 0010) + the dock's
// chrome state (11/03). The logic lives in @backend (Electron-free, testable); main
// only binds it to a channel and refuses malformed input before the backend ever sees
// it — the `fs-browse.ts` posture.
//
// `explorer:list` reads the filesystem; the watch verbs (11/04) implement the liveness
// law over `@backend`'s Electron-free pool — main owns only the IPC seam and the WINDOW
// VISIBILITY hooks, which the backend cannot see. The KV verbs persist DOCK CHROME
// (open / width / show-hidden) in the app's own settings store, exactly like
// `browser.open` / `browser.width`: they touch no user file, so ADR 0010's "no write
// verb on explorer channels" stance is intact.

const KV_OPEN = 'explorer.open'
const KV_WIDTH = 'explorer.width'
const KV_HIDDEN = 'explorer.showHidden'

let watcher: ExplorerWatcher | null = null

/** Smoke-only: the live pool's counts, read without an IPC round trip. */
export function explorerWatchStats(): ExplorerWatchStats {
  return watcher?.stats() ?? { handles: 0, polls: 0, suspended: false }
}

// ── The delegation seam (11/06) ─────────────────────────────────────────────
// These are the app's FIRST file-path shell calls, so the port is injectable from the
// start: a smoke that "tests" open-with-the-OS by actually launching the operator's editor
// is not a test, it is a prank. The recording spy is the only witness a gate ever gets.

export interface ExplorerShellPort {
  /** Electron's contract: resolves to '' on success, else an error message. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

const electronShell: ExplorerShellPort = {
  openPath: (p) => shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p)
}
let shellPort: ExplorerShellPort = electronShell

/** FAKE-parts rule: a smoke installs a recording spy; passing null restores the real shell. */
export function setExplorerShellPortForSmoke(port: ExplorerShellPort | null): void {
  shellPort = port ?? electronShell
}

/** The folder the dock is SHOWING. '' while it is closed — and a closed dock has no
 *  actions, because it has no boundary to check them against. */
let actionRoot = ''

/**
 * Every path-taking verb passes through here. The renderer is our own code, so this is not
 * a trust boundary against a hostile caller — it is the guard that makes "read-only,
 * inside the tree you can see" true BY CONSTRUCTION rather than by everyone remembering.
 */
function guard(p: unknown): { path: string } | ExplorerActionResult {
  if (typeof p !== 'string' || !p) return { ok: false, reason: 'invalid' }
  const path = canonical(p)
  if (!isAbsolute(path)) return { ok: false, reason: 'invalid' }
  if (!actionRoot || !isUnder(path, actionRoot)) return { ok: false, reason: 'outside-root' }
  if (!existsSync(path)) return { ok: false, reason: 'missing' }
  return { path }
}

/** The exact function the channel runs, exported so the FSLIST smoke exercises the
 *  validation seam with zero UI. Junk in -> an `invalid` refusal out, never a throw.
 *  Async only because the drive-root listing is (a dead network mapping must not block the
 *  main process — see platform/fs-paths driveRoots); ipcMain.handle awaits a promise anyway. */
export async function handleExplorerList(req: unknown): Promise<ExplorerResult> {
  const r = req as { path?: unknown; showHidden?: unknown } | null | undefined
  if (typeof r?.path !== 'string') return { ok: false, reason: 'invalid', path: '' }
  return listExplorer({ path: r.path, showHidden: r.showHidden === true })
}

export function registerExplorer(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(ExplorerChannels.list, async (_e, req: unknown) => {
    const path = typeof (req as { path?: unknown } | null)?.path === 'string'
      ? String((req as { path: string }).path)
      : ''
    await waitForExplorerRaceAudit(path)
    return handleExplorerList(req)
  })

  // ── The liveness law (11/04, ADR 0010.d) ──────────────────────────────────
  // A coalesced batch of DIR PATHS — never a file, never a byte of content, never
  // telemetry (ADR 0005). The renderer re-lists exactly these and nothing else.
  watcher = createExplorerWatcher((dirs) => {
    try {
      getWin()?.webContents.send(ExplorerChannels.changed, { dirs })
    } catch {
      /* window gone mid-flush */
    }
  })

  // The renderer declares its WHOLE expanded set every time (there is deliberately no
  // incremental add verb — a leaked watcher has nowhere to hide). `[]` tears it down.
  ipcMain.on(ExplorerChannels.watch, (_e, p: { dirs?: unknown }) => {
    const dirs = Array.isArray(p?.dirs) ? (p.dirs as unknown[]).filter((d): d is string => typeof d === 'string' && !!d) : []
    watcher?.setDirs(dirs)
  })
  ipcMain.on(ExplorerChannels.unwatch, () => watcher?.setDirs([]))
  ipcMain.handle(ExplorerChannels.stats, (): ExplorerWatchStats => explorerWatchStats())

  // The suspend rule: a window nobody is looking at watches nothing. The mcp-status
  // hooks, verbatim — every handle closes, the poll parks, and `show`/`restore` costs
  // ONE reconcile pass over the visible set.
  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => watcher?.suspend())
    w.on('minimize', () => watcher?.suspend())
    w.on('show', () => watcher?.resume())
    w.on('restore', () => watcher?.resume())
  })
  app.on('before-quit', () => watcher?.dispose())

  // Read ONCE before the dock first paints — an explorer left open must not flash shut
  // on boot (the `browser:init` precedent).
  ipcMain.handle(ExplorerChannels.init, (): ExplorerDockInit => {
    const s = getSettingsStore()
    return {
      open: s?.getSetting(KV_OPEN) === '1',
      width: Number(s?.getSetting(KV_WIDTH)) || EXPLORER_DOCK_WIDTH,
      showHidden: s?.getSetting(KV_HIDDEN) === '1'
    }
  })

  ipcMain.on(ExplorerChannels.setOpen, (_e, p: { open?: unknown }) => {
    getSettingsStore()?.setSetting(KV_OPEN, p?.open === true ? '1' : '')
  })

  ipcMain.on(ExplorerChannels.setWidth, (_e, p: { width?: unknown }) => {
    const w = Number(p?.width)
    if (Number.isFinite(w) && w > 0) getSettingsStore()?.setSetting(KV_WIDTH, String(Math.round(w)))
  })

  ipcMain.on(ExplorerChannels.setShowHidden, (_e, p: { showHidden?: unknown }) => {
    getSettingsStore()?.setSetting(KV_HIDDEN, p?.showHidden === true ? '1' : '')
  })

  // ── Delegation (11/06) ────────────────────────────────────────────────────
  ipcMain.on(ExplorerChannels.root, (_e, p: unknown) => {
    actionRoot = typeof p === 'string' && p ? canonical(p) : ''
  })

  ipcMain.handle(ExplorerChannels.open, async (_e, p: unknown): Promise<ExplorerActionResult> => {
    const g = guard(p)
    if (!('path' in g)) return g
    try {
      // The OS decides what opens this, not us — that is the whole point (ADR 0002's
      // neutrality, extended to files). We hand it over and step back.
      const err = await shellPort.openPath(g.path)
      return err ? { ok: false, reason: 'denied' } : { ok: true }
    } catch {
      return { ok: false, reason: 'denied' }
    }
  })

  ipcMain.handle(ExplorerChannels.reveal, (_e, p: unknown): ExplorerActionResult => {
    const g = guard(p)
    if (!('path' in g)) return g
    try {
      shellPort.showItemInFolder(g.path)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'denied' }
    }
  })
}

export function disposeExplorer(): void {
  watcher?.dispose()
  watcher = null
  actionRoot = ''
  ipcMain.removeHandler(ExplorerChannels.list)
  ipcMain.removeHandler(ExplorerChannels.init)
  ipcMain.removeHandler(ExplorerChannels.stats)
  ipcMain.removeHandler(ExplorerChannels.open)
  ipcMain.removeHandler(ExplorerChannels.reveal)
  ipcMain.removeAllListeners(ExplorerChannels.root)
  ipcMain.removeAllListeners(ExplorerChannels.watch)
  ipcMain.removeAllListeners(ExplorerChannels.unwatch)
  ipcMain.removeAllListeners(ExplorerChannels.setOpen)
  ipcMain.removeAllListeners(ExplorerChannels.setWidth)
  ipcMain.removeAllListeners(ExplorerChannels.setShowHidden)
}

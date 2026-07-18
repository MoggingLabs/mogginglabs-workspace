import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { BrainService } from '@backend/features/brain'
import { BrainChannels, type BrainAnswer, type BrainChangedEvent } from '@contracts'

// App-wiring for the workspace brain (ADR 0018). The logic lives in @backend
// (Electron-free, testable); main derives the ONE path Electron owns — the db dir
// under the userData layout — refuses malformed input before the backend ever sees
// it (the explorer.ts posture: junk in → an `invalid` refusal out, never a throw),
// and pushes `brain:changed` after any accepted rebuild. This step is lifecycle
// only: identity, status, typed refusals; 03 brings the graph, 04 the freshness
// law. Nothing here (or in the backend it binds) forwards a path, a symbol, or
// memory text to telemetry (ADR 0005).

let service: BrainService | null = null

/** Lazy: userData is re-pointed by MOGGING_USERDATA in every gate, so the paths
 *  resolve at first use, never at import. Main's whole contribution is the three
 *  paths Electron owns; the engine is @backend's. */
function ensureService(): BrainService {
  if (!service) {
    service = new BrainService({
      baseDir: join(app.getPath('userData'), 'brain'),
      workerFile: join(app.getAppPath(), 'out', 'main', 'brain-worker.js'),
      grammarsDir: join(app.getAppPath(), 'assets', 'grammars')
    })
  }
  return service
}

/** The exact function `brain:status` runs, exported so the BRAINCORE smoke
 *  exercises the validation seam with zero UI. */
export function handleBrainStatus(req: unknown): BrainAnswer {
  const root = (req as { root?: unknown } | null | undefined)?.root
  if (typeof root !== 'string' || !root) return { ok: false, reason: 'invalid' }
  return ensureService().status(root)
}

/** The exact function `brain:rebuild` runs — same seam, same refusals. Awaits the
 *  worker's ONE transactional commit and answers the fresh status. */
export function handleBrainRebuild(req: unknown): Promise<BrainAnswer> {
  const root = (req as { root?: unknown } | null | undefined)?.root
  if (typeof root !== 'string' || !root) {
    return Promise.resolve({ ok: false, reason: 'invalid' })
  }
  return ensureService().rebuild(root)
}

/** Where a project's db lives — exported for the BRAINCORE smoke's "under
 *  userData, never under a root" assertion. */
export function brainBaseDir(): string {
  return join(app.getPath('userData'), 'brain')
}

/** Smoke-only introspection: the LRU's live handle count, a full close (the next
 *  call reopens lazily — dispose is a lifecycle law, not a shutdown-only path), and
 *  the canonical dump (the BRAINGRAPH gate's determinism spine). */
export function brainDebug(): {
  openCount: () => number
  dispose: () => void
  dump: (root: string) => string | null
} {
  return {
    openCount: () => service?.openCount() ?? 0,
    dispose: () => disposeBrain(),
    dump: (root: string) => ensureService().dump(root)
  }
}

export function disposeBrain(): void {
  service?.dispose()
  service = null
}

export function registerBrain(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(BrainChannels.status, (_e, req: unknown) => handleBrainStatus(req))
  ipcMain.handle(BrainChannels.rebuild, async (_e, req: unknown) => {
    const answer = await handleBrainRebuild(req)
    if (answer.ok) {
      const event: BrainChangedEvent = {
        projectKey: answer.projectKey,
        generation: answer.generation,
        dirty: answer.dirty
      }
      try {
        getWin()?.webContents.send(BrainChannels.changed, event)
      } catch {
        /* window gone */
      }
    }
    return answer
  })
}

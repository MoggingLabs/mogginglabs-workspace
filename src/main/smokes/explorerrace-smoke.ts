import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explorerRaceAudit, setExplorerRaceAudit } from '../explorer-race-audit-faults'
import { setExplorerShellPortForSmoke } from '../explorer'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

function makeRepo(path: string, file: string): void {
  git(path, ['init'])
  git(path, ['config', 'user.email', 'explorer-race@mogging.test'])
  git(path, ['config', 'user.name', 'Explorer Race'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(path, file), `${file}\n`)
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', 'fixture'])
}

// Audit regression: a delayed `src` listing loses to a fast `src2` switch,
// and sibling-prefix paths never pass renderer or main containment checks.
export function runExplorerRaceSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  let root = ''

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const opened: string[] = []
    const revealed: string[] = []
    try {
      root = mkdtempSync(join(tmpdir(), 'mogging-explorer-race-'))
      const src = join(root, 'src')
      const src2 = join(root, 'src2')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(src)
      mkdirSync(src2)
      makeRepo(src, 'A.txt')
      makeRepo(src2, 'B.txt')
      const aFile = join(src, 'A.txt')
      const bFile = join(src2, 'B.txt')
      setExplorerShellPortForSmoke({
        openPath: async (path) => {
          opened.push(path)
          return ''
        },
        showItemInFolder: (path) => revealed.push(path)
      })

      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'src', cwd: ${JSON.stringify(src)} })`)
      await sleep(500)
      await ES(`window.__mogging.workspace.create({ name: 'src2', cwd: ${JSON.stringify(src2)} })`)
      await sleep(500)
      await ES(`window.__mogging.workspace.create({ name: 'empty' })`)
      await sleep(500)
      const workspaces = await ES<{ id: string }[]>(`window.__mogging.workspace.list()`)
      const indexSrc = 0
      const indexSrc2 = 1
      const indexEmpty = 2
      const switchTo = (index: number): Promise<void> =>
        ES(`window.__mogging.workspace.switchByIndex(${index})`).then(() => undefined)
      await switchTo(indexSrc2)
      await ES(`window.__mogging.explorer.toggle(true)`)
      await sleep(800)

      setExplorerRaceAudit({ [src]: 1000 })
      await switchTo(indexSrc)
      let delayedStarted = false
      for (let i = 0; i < 80; i++) {
        delayedStarted = explorerRaceAudit()?.events.some(
          (event) => event.path === src && event.stage === 'start'
        ) === true
        if (delayedStarted) break
        await sleep(50)
      }
      const switchedToSrc2At = Date.now()
      await switchTo(indexSrc2)
      let delayedFinished = false
      for (let i = 0; i < 80; i++) {
        delayedFinished = explorerRaceAudit()?.events.some(
          (event) => event.path === src && event.stage === 'finish'
        ) === true
        if (delayedFinished) break
        await sleep(50)
      }
      await sleep(300)

      const raceUi = await ES<{
        root: string
        names: string[]
        gitRoot: string
        watch: { handles: number; polls: number }
      }>(`(async () => ({
        root: window.__mogging.explorer.rootPath(),
        names: window.__mogging.explorer.rowNames(),
        gitRoot: window.__mogging.explorer.gitRoot(),
        watch: await window.__mogging.explorer.watchStats()
      }))()`)
      for (let i = 0; i < 30 && raceUi.gitRoot !== src2; i++) {
        await sleep(200)
        raceUi.gitRoot = await ES<string>(`window.__mogging.explorer.gitRoot()`)
      }
      const delayedFinish = explorerRaceAudit()?.events.find(
        (event) => event.path === src && event.stage === 'finish'
      )
      const bOpen = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(bFile)})`
      )
      const staleAOpen = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(aFile)})`
      )
      const raceOk =
        delayedStarted && delayedFinished && !!delayedFinish && delayedFinish.at > switchedToSrc2At &&
        raceUi.root === src2 && raceUi.names.includes('B.txt') && !raceUi.names.includes('A.txt') &&
        raceUi.gitRoot === src2 && raceUi.watch.handles >= 1 &&
        bOpen.ok === true && staleAOpen.ok === false && staleAOpen.reason === 'outside-root' &&
        opened.length === 1 && opened[0] === bFile

      // Root at `src` and aim every boundary check at the existing sibling
      // `src2/B.txt`; raw startsWith would accept it, segment-aware checks refuse.
      await switchTo(indexSrc)
      for (let i = 0; i < 50; i++) {
        if ((await ES<string>(`window.__mogging.explorer.rootPath()`)) === src) break
        await sleep(100)
      }
      await sleep(200)
      const boundary = await ES<{
        child: boolean
        sibling: boolean
        rootDefault: boolean
        rootAllowed: boolean
      }>(`({
        child: window.__mogging.explorer.within(${JSON.stringify(src)}, ${JSON.stringify(aFile)}),
        sibling: window.__mogging.explorer.within(${JSON.stringify(src)}, ${JSON.stringify(bFile)}),
        rootDefault: window.__mogging.explorer.within(${JSON.stringify(src)}, ${JSON.stringify(src)}),
        rootAllowed: window.__mogging.explorer.within(${JSON.stringify(src)}, ${JSON.stringify(src)}, true)
      })`)
      const siblingOpen = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(bFile)})`
      )
      const siblingReveal = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osReveal(${JSON.stringify(bFile)})`
      )
      const boundaryOk =
        boundary.child && !boundary.sibling && !boundary.rootDefault && boundary.rootAllowed &&
        siblingOpen.ok === false && siblingOpen.reason === 'outside-root' &&
        siblingReveal.ok === false && siblingReveal.reason === 'outside-root' &&
        opened.length === 1 && revealed.length === 0

      // Empty-root transition clears UI, watchers, git, and the action guard as
      // one state; the previous root cannot remain actionable behind the empty view.
      await switchTo(indexEmpty)
      await sleep(300)
      const emptyUi = await ES<{
        root: string
        rows: number
        gitRoot: string
        watch: { handles: number; polls: number }
      }>(`(async () => ({
        root: window.__mogging.explorer.rootPath(),
        rows: window.__mogging.explorer.rowNames().length,
        gitRoot: window.__mogging.explorer.gitRoot(),
        watch: await window.__mogging.explorer.watchStats()
      }))()`)
      const emptyAction = await ES<{ ok: boolean; reason?: string }>(
        `window.__mogging.explorer.osOpen(${JSON.stringify(aFile)})`
      )
      const emptyOk =
        emptyUi.root === '' && emptyUi.rows === 0 && emptyUi.gitRoot === '' &&
        emptyUi.watch.handles === 0 && emptyUi.watch.polls === 0 &&
        emptyAction.ok === false && emptyAction.reason === 'outside-root' && opened.length === 1

      const pass = workspaces.length === 3 && raceOk && boundaryOk && emptyOk
      result = {
        pass,
        raceOk,
        boundaryOk,
        emptyOk,
        delayedStarted,
        delayedFinished,
        raceUi,
        bOpen,
        staleAOpen,
        boundary,
        siblingOpen,
        siblingReveal,
        emptyUi,
        emptyAction,
        opened,
        revealed,
        auditEvents: explorerRaceAudit()?.events ?? []
      }
    } catch (error) {
      result = { pass: false, error: String(error), auditEvents: explorerRaceAudit()?.events ?? [] }
    }
    setExplorerRaceAudit(null)
    setExplorerShellPortForSmoke(null)
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'explorerrace-result.json'), JSON.stringify(result, null, 2))
    } catch {
      // best effort
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}


import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardDebug, boardForWorkspaceId } from '../board'
import { getSettingsStore } from '../app-settings'

// Env-gated Board-v2 MODEL gate (MOGGING_BOARDV2). The claims that make the
// board "own tasks", each driven through the REAL paths and each of which
// fails against a board that regressed to v1 behavior:
//   (a) per-PROJECT identity — two workspaces on one repo share ONE board; a
//       LINKED WORKTREE workspace resolves to its parent repo's board; a
//       different folder gets a different board; no workspace → Unfiled
//   (b) legacy migration — pre-v2 rows (board_id NULL) land on their launch
//       workspace's project board, or Unfiled when unresolvable; nothing lost
//   (c) CAS — a stale expectedRevision is REFUSED with reason 'conflict' AND
//       the fresh card in the reply; the write does not land
//   (d) ordering — beforeId places a card; the order round-trips the db
//   (e) live push — a write that never touched the renderer (main-side)
//       repaints the OPEN board without any refresh call
//   (f) archive — archived cards leave board:list, appear in board:archived,
//       and restore intact
//   (g) activity — created/moved land in the card's local log

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function runBoardV2Smoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 30, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1800)

      // (a0) No workspace yet: the board view resolves to Unfiled.
      const preBoard = (await ES(`window.__mogging.board.activeBoard()`)) as { projectKey: string } | null
      const unfiledFirst = preBoard?.projectKey === '::unfiled'

      // The world: repoA (+ a real linked worktree), and a plain folderB.
      // Canonical roots (realpathSync.native): the board resolver keys a project off
      // git's own answer, which is always the LONG canonical path — a workspace
      // created on a runner's 8.3-alias temp cwd (C:\Users\RUNNER~1\…) resolved to a
      // key the smoke's raw string never matched (identityOk null, win+mac sweeps,
      // run 29547052949). Same alias family as filesmilestone's fix.
      const repoA = realpathSync.native(mkdtempSync(join(tmpdir(), 'mogging-bv2-a-')))
      git(repoA, ['init'])
      git(repoA, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      git(repoA, ['config', 'user.email', 'smoke@mogging.test'])
      git(repoA, ['config', 'user.name', 'Mogging Smoke'])
      git(repoA, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(repoA, 'readme.txt'), 'a\n')
      git(repoA, ['add', '-A'])
      git(repoA, ['commit', '-m', 'init'])
      mkdirSync(join(repoA, '.mogging'), { recursive: true })
      writeFileSync(join(repoA, '.mogging', '.gitignore'), '*\n')
      const wtPath = join(repoA, '.mogging', 'worktrees', 'wt1')
      git(repoA, ['worktree', 'add', wtPath, '-b', 'mogging/wt1'])
      const folderB = realpathSync.native(mkdtempSync(join(tmpdir(), 'mogging-bv2-b-')))

      type WsMeta = { id: string }
      const wsA = (await ES(`window.__mogging.workspace.create({ name: 'RepoA', cwd: ${JSON.stringify(repoA)} })`)) as WsMeta
      await sleep(600)
      const wsWt = (await ES(`window.__mogging.workspace.create({ name: 'Wt', cwd: ${JSON.stringify(wtPath)} })`)) as WsMeta
      await sleep(600)
      const wsB = (await ES(`window.__mogging.workspace.create({ name: 'FolderB', cwd: ${JSON.stringify(folderB)} })`)) as WsMeta
      await sleep(1200) // workspace state persists (main resolves boards from it)

      // (a) project identity, resolved MAIN-side (the same resolver agents get).
      const bA = boardForWorkspaceId(wsA.id)
      const bWt = boardForWorkspaceId(wsWt.id)
      const bB = boardForWorkspaceId(wsB.id)
      const identityOk =
        !!bA && !!bWt && !!bB && bA.id === bWt.id && bA.id !== bB.id && bA.projectKey === boardDebug().projectKey(repoA)

      // (b) legacy migration: plant pre-v2 rows, then migrate.
      const store = getSettingsStore()
      if (!store) throw new Error('no settings store')
      store.plantLegacyBoardCardForSmoke({
        id: 'legacy-a',
        title: 'legacy on repoA',
        notes: '',
        lane: 'todo',
        paneId: null,
        workspaceId: wsA.id,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000
      })
      store.plantLegacyBoardCardForSmoke({
        id: 'legacy-orphan',
        title: 'legacy orphan',
        notes: '',
        lane: 'done',
        paneId: null,
        workspaceId: null,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000
      })
      boardDebug().migrateNow()
      const migA = store.getCard('legacy-a')
      const migOrphan = store.getCard('legacy-orphan')
      const unfiled = store.findBoardByProjectKey('::unfiled')
      const migrationOk =
        migA?.boardId === bA?.id &&
        !!unfiled &&
        migOrphan?.boardId === unfiled.id &&
        migA?.title === 'legacy on repoA' &&
        migOrphan?.lane === 'done'

      // FolderB is the active workspace: renderer cards land on ITS board.
      type Card = { id: string; revision: number; lane: string; position: number }
      const mk = async (title: string): Promise<string> =>
        String(await ES(`window.__mogging.board.createCard(${JSON.stringify(title)}, '')`))
      const t1 = await mk('BV2 first')
      const t2 = await mk('BV2 second')
      const t3 = await mk('BV2 third')
      await sleep(400)

      // (c) CAS: stale revision refused WITH the fresh card; nothing lands.
      const stale = (await ES(
        `window.bridge.invoke('board:patch', { id: ${JSON.stringify(t1)}, expectedRevision: 999, patch: { title: 'clobbered' } })`
      )) as { ok: boolean; reason?: string; card?: { title: string; revision: number } }
      const after = (await ES(`window.__mogging.board.refresh().then(() => window.__mogging.board.list())`)) as {
        id: string
        title: string
        revision: number
      }[]
      const t1After = after.find((c) => c.id === t1)
      const casRefusedOk =
        stale.ok === false && stale.reason === 'conflict' && stale.card?.title === 'BV2 first' && t1After?.title === 'BV2 first'
      const good = (await ES(
        `window.bridge.invoke('board:patch', { id: ${JSON.stringify(t1)}, expectedRevision: ${t1After?.revision ?? 0}, patch: { title: 'BV2 first (edited)' } })`
      )) as { ok: boolean; card?: { revision: number } }
      const casAcceptedOk = good.ok === true && (good.card?.revision ?? 0) === (t1After?.revision ?? 0) + 1

      // (d) ordering: t3 before t1 → [t3, t1, t2], straight from the db.
      await ES(
        `window.bridge.invoke('board:patch', { id: ${JSON.stringify(t3)}, patch: { lane: 'todo', beforeId: ${JSON.stringify(t1)} } })`
      )
      const bBid = bB?.id ?? ''
      const ordered = (await ES(`window.bridge.invoke('board:list', ${JSON.stringify(bBid)})`)) as Card[]
      const todoOrder = ordered.filter((c) => c.lane === 'todo').map((c) => c.id)
      const orderingOk = JSON.stringify(todoOrder) === JSON.stringify([t3, t1, t2])

      // (e) live push: a MAIN-side write repaints the open board, no refresh.
      await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Board"]')?.click()`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await waitTrue(`!!document.querySelector('.board-card[data-card-id=${JSON.stringify(t2)}]')`)
      const pushed = boardDebug().patchDirect(t2, { lane: 'review' })
      const pushOk =
        pushed.ok &&
        (await waitTrue(
          `!!document.querySelector('.board-lane[data-lane="review"] .board-card[data-card-id=${JSON.stringify(t2)}]')`,
          25,
          200
        ))

      // (f) archive: leaves the lanes, stays queryable, restores intact.
      await ES(`window.bridge.invoke('board:patch', { id: ${JSON.stringify(t2)}, patch: { archivedAt: Date.now() } })`)
      const liveAfterArchive = (await ES(`window.bridge.invoke('board:list', ${JSON.stringify(bBid)})`)) as Card[]
      const archivedList = (await ES(`window.bridge.invoke('board:archived', ${JSON.stringify(bBid)})`)) as Card[]
      await ES(`window.bridge.invoke('board:patch', { id: ${JSON.stringify(t2)}, patch: { archivedAt: null } })`)
      const liveAfterRestore = (await ES(`window.bridge.invoke('board:list', ${JSON.stringify(bBid)})`)) as Card[]
      const archiveOk =
        !liveAfterArchive.some((c) => c.id === t2) &&
        archivedList.some((c) => c.id === t2) &&
        liveAfterRestore.some((c) => c.id === t2)

      // (g) activity: the log narrates created + moved.
      const activity = (await ES(`window.bridge.invoke('board:activity', ${JSON.stringify(t2)})`)) as {
        verb: string
        actor: string
      }[]
      const verbs = activity.map((a) => a.verb)
      const activityOk = verbs.includes('created') && verbs.includes('moved') && verbs.includes('archived')

      const pass =
        unfiledFirst && identityOk && migrationOk && casRefusedOk && casAcceptedOk && orderingOk && pushOk && archiveOk && activityOk
      result = {
        pass,
        unfiledFirst,
        identityOk,
        boards: { a: bA?.id, wt: bWt?.id, b: bB?.id, aKey: bA?.projectKey },
        migrationOk,
        mig: { a: migA?.boardId, orphan: migOrphan?.boardId, unfiled: unfiled?.id },
        casRefusedOk,
        stale,
        casAcceptedOk,
        orderingOk,
        todoOrder,
        expectedOrder: [t3, t1, t2],
        pushOk,
        archiveOk,
        activityOk,
        verbs
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardv2-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

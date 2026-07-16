import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setIntegrationsGrant } from '../integrations'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated Board-v2 AGENT-surface gate (MOGGING_BOARDMCP): full CRUD over the
// REAL MCP server + app endpoint, and every guard that keeps "full control"
// from meaning "agents can trample each other or the user":
//   (a) create_card lands on the CALLER'S project board (scoped by pane), with
//       priority/labels parsed, and returns the card (id + revision)
//   (b) list_board / get_card are SCOPED — a granted agent in ANOTHER project
//       cannot even see the card, and its update refuses 'unknown card'
//   (c) claim exclusivity — pane A claims; pane B's update/claim/archive are
//       refused NAMING pane A; B's comment still lands (coordination is free);
//       release by B refused ('not the holder'), release by A works, then B
//       may write
//   (d) CAS over the wire — update_card with a stale expectedRevision refuses
//       and carries the fresh card; the write does not land
//   (e) archive_card, not delete — the card leaves the lanes but survives in
//       the archived set; no delete tool exists in ANY tools/list frame
//   (f) every accepted write is attributable — the workspace trail carries the
//       verbs with the acting pane
export function runBoardMcpSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const frames: string[] = []

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) => res({ code: err ? 1 : 0, stdout: String(stdout) })
      )
    })

  type ToolResult = { content?: { type?: string; text?: string }[]; isError?: boolean }
  const callTool = async (
    c: PaneMcpSmokeClient,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ text: string; isError: boolean; rpcError: string | null }> => {
    const m = await c.rpc('tools/call', { name, arguments: args })
    if (m.error) return { text: '', isError: false, rpcError: m.error.message ?? 'error' }
    const r = (m.result ?? {}) as ToolResult
    return { text: r.content?.[0]?.text ?? '', isError: r.isError === true, rpcError: null }
  }
  /** Board writes append the fresh card JSON after the first line. */
  const cardOf = (text: string): Record<string, unknown> | null => {
    const nl = text.indexOf('\n')
    try {
      return JSON.parse(nl >= 0 ? text.slice(nl + 1) : text) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const clients: PaneMcpSmokeClient[] = []
    try {
      await sleep(1500)
      // Two PROJECTS (plain folders — distinct boards), both fully granted:
      // the scope assertions below must fail on scope, never on the grant.
      const dirA = mkdtempSync(join(tmpdir(), 'mogging-bmcp-a-'))
      const dirB = mkdtempSync(join(tmpdir(), 'mogging-bmcp-b-'))
      type WsMeta = { id: string; ordinal: number }
      const wsA = (await ES(
        `window.__mogging.workspace.create({ name: 'A', cwd: ${JSON.stringify(dirA)}, paneCount: 2 })`
      )) as WsMeta
      await sleep(2500)
      const a1 = String(wsA.ordinal * 100 + 1)
      const a2 = String(wsA.ordinal * 100 + 2)
      const wsB = (await ES(
        `window.__mogging.workspace.create({ name: 'B', cwd: ${JSON.stringify(dirB)}, paneCount: 1 })`
      )) as WsMeta
      await sleep(2500)
      const b1 = String(wsB.ordinal * 100 + 1)
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      setIntegrationsGrant({ workspaceId: wsB.id, writeTools: 'all', web: 'off', actOrigins: [] })
      await sleep(1200) // workspace rows persist (grant + board resolve from them)

      const mcpPath = join(root, 'bin', 'mogging-mcp.mjs')
      const onFrame = (frame: string): void => {
        frames.push(frame)
      }
      const cA1 = await spawnPaneMcpSmokeClient({ cli, paneId: a1, mcpPath, onFrame })
      clients.push(cA1)
      await cA1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const cA2 = await spawnPaneMcpSmokeClient({ cli, paneId: a2, mcpPath, onFrame })
      clients.push(cA2)
      await cA2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const cB1 = await spawnPaneMcpSmokeClient({ cli, paneId: b1, mcpPath, onFrame })
      clients.push(cB1)
      await cB1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // (a) create: full metadata, server-assigned identity, caller's board.
      const created = await callTool(cA1, 'create_card', {
        title: 'BOARDMCP task',
        note: 'created over the wire',
        column: 'todo',
        priority: 'high',
        labels: 'parser, perf'
      })
      const createdCard = cardOf(created.text)
      const cardId = String(createdCard?.id ?? '')
      const createOk =
        !created.isError &&
        !created.rpcError &&
        !!cardId &&
        createdCard?.priority === 'high' &&
        JSON.stringify(createdCard?.labels) === JSON.stringify(['parser', 'perf']) &&
        createdCard?.revision === 0

      const listA = await callTool(cA1, 'list_board')
      const listAOk = !listA.isError && listA.text.includes('BOARDMCP task')

      // (b) scope: a granted agent in ANOTHER project sees and touches nothing.
      const listB = await callTool(cB1, 'list_board')
      const outOfScopeGet = await callTool(cB1, 'get_card', { card: cardId })
      const outOfScopeWrite = await callTool(cB1, 'update_card', { card: cardId, column: 'done' })
      const scopeOk =
        !listB.isError &&
        !listB.text.includes('BOARDMCP task') &&
        outOfScopeGet.isError &&
        /unknown-card|unknown card/.test(outOfScopeGet.text) &&
        outOfScopeWrite.isError &&
        /unknown card/.test(outOfScopeWrite.text)

      // (c) claim exclusivity, same board (panes a1 vs a2).
      const claimed = await callTool(cA1, 'claim_card', { card: cardId })
      const blockedUpdate = await callTool(cA2, 'update_card', { card: cardId, column: 'doing' })
      const blockedClaim = await callTool(cA2, 'claim_card', { card: cardId })
      const blockedArchive = await callTool(cA2, 'archive_card', { card: cardId })
      const freeComment = await callTool(cA2, 'comment_card', { card: cardId, body: 'B here — can I take this?' })
      const wrongRelease = await callTool(cA2, 'release_card', { card: cardId })
      const rightRelease = await callTool(cA1, 'release_card', { card: cardId })
      const nowAllowed = await callTool(cA2, 'update_card', { card: cardId, column: 'doing' })
      const claimOk =
        !claimed.isError &&
        !claimed.rpcError &&
        blockedUpdate.isError &&
        blockedUpdate.text.includes(`pane ${a1}`) &&
        blockedClaim.isError &&
        blockedArchive.isError &&
        !freeComment.isError &&
        wrongRelease.isError &&
        /not.?holder|does not hold/i.test(wrongRelease.text) &&
        !rightRelease.isError &&
        !nowAllowed.isError

      // (d) CAS over the wire: stale refuses + carries the fresh card; no clobber.
      const fresh = cardOf(nowAllowed.text)
      const freshRev = Number(fresh?.revision ?? -1)
      const staleWrite = await callTool(cA1, 'update_card', {
        card: cardId,
        title: 'CLOBBERED',
        expectedRevision: freshRev - 1
      })
      const getBack = await callTool(cA1, 'get_card', { card: cardId })
      const getCard = (JSON.parse(getBack.text) as { card?: { title?: string; revision?: number } }).card
      const casOk =
        staleWrite.isError &&
        /changed since/.test(staleWrite.text) &&
        getCard?.title === 'BOARDMCP task' &&
        (await callTool(cA1, 'update_card', { card: cardId, title: 'BOARDMCP task v2', expectedRevision: getCard?.revision })).isError ===
          false

      // (e) archive, never delete.
      const archived = await callTool(cA1, 'archive_card', { card: cardId })
      const listAfterArchive = await callTool(cA1, 'list_board')
      const boardIdA = (JSON.parse(listAfterArchive.text) as { board?: { id?: string } }).board?.id ?? ''
      const archivedRows = (await ES(
        `window.bridge.invoke('board:archived', ${JSON.stringify(boardIdA)})`
      )) as { id: string }[]
      const archiveOk =
        !archived.isError &&
        !listAfterArchive.text.includes('BOARDMCP task') &&
        archivedRows.some((c) => c.id === cardId)
      const noDeleteTool = !frames.join('\n').includes('"delete_card"')

      // (f) attribution: the trail carries the write verbs with the acting pane.
      const trail = (await ES(
        `window.bridge.invoke('integrations:trail:list', ${JSON.stringify(wsA.id)})`
      )) as { verb: string; pane: string }[]
      const trailVerbs = new Set(trail.map((t) => t.verb))
      const trailOk =
        ['create_card', 'claim_card', 'comment_card', 'update_card', 'archive_card'].every((v) => trailVerbs.has(v)) &&
        trail.some((t) => t.pane === a1) &&
        trail.some((t) => t.pane === a2)

      // Activity narrates the claim dance for the human (get_card's tail).
      const withActivity = (await ES(`window.bridge.invoke('board:activity', ${JSON.stringify(cardId)})`)) as {
        verb: string
        actor: string
      }[]
      const activityOk =
        withActivity.some((a) => a.verb === 'comment' && a.actor === `pane ${a2}`) &&
        withActivity.some((a) => a.verb === 'claimed' && a.actor === `pane ${a1}`)

      const pass = createOk && listAOk && scopeOk && claimOk && casOk && archiveOk && noDeleteTool && trailOk && activityOk
      result = {
        pass,
        createOk,
        createdCard,
        listAOk,
        scopeOk,
        outOfScopeGetMsg: outOfScopeGet.text,
        outOfScopeWriteMsg: outOfScopeWrite.text,
        claimOk,
        blockedUpdateMsg: blockedUpdate.text,
        wrongReleaseMsg: wrongRelease.text,
        casOk,
        staleMsg: staleWrite.text,
        archiveOk,
        noDeleteTool,
        trailOk,
        trailVerbs: [...trailVerbs],
        activityOk
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
    }
    for (const c of clients) c.kill()
    try {
      writeFileSync(join(root, 'out', 'boardmcp-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

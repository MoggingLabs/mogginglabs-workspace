import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getIntegrationsGrant, setIntegrationsGrant } from '../integrations'
import { mcpEndpointDebug } from '../mcp-endpoint'
import {
  spawnLocalMcpSmokeClient,
  spawnPaneMcpSmokeClient,
  type PaneMcpSmokeClient
} from './pane-mcp-smoke-client'

// Env-gated write-tools-behind-the-grant smoke (MOGGING_MCPWRITE, Phase-8/03):
// two workspaces, scripted JSON-RPC frames against the REAL server —
//   grant 'none' (default): write tools INVISIBLE in tools/list AND a direct
//   call refused naming the grant · grant 'all' on workspace A: writes visible
//   + list_changed emitted + they WORK (send -> text arrives pipelined-ping-
//   confirmed; mail -> receipt lands attention on the target pane; claim from
//   a second session denied with the owner named; card moves lanes) · the
//   grant is workspace-scoped (B's session still sees zero writes) · a human
//   session (no pane identity) sees zero writes and is refused · revoke
//   mid-session -> list_changed + the very next call refused · and `approve`
//   appears in NO tools/list frame, grepped structurally across every frame.
// MOGGING_MCPWRITE=DEV builds the same world, grants A, prints the fixture
// facts to out/mcpwrite-dev.json, and HOLDS (no asserts) so a real CLI can be
// dev-verified against it — the books' frames come from that mode.

type ToolResult = { content?: { type?: string; text?: string }[]; isError?: boolean }
type ToolRow = { name: string }

export function runMcpWriteSmoke(win: BrowserWindow, mode: string): void {
  const dev = mode === 'DEV'
  if (!dev) setTimeout(() => app.exit(1), 180000) // safety net (DEV holds on purpose)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const frames: string[] = []

  const emit = (name: string, o: object): void => {
    try {
      writeFileSync(join(root, 'out', name), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) => res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

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

  const listNames = async (c: PaneMcpSmokeClient): Promise<string[]> =>
    (((await c.rpc('tools/list')).result as { tools?: ToolRow[] })?.tools ?? []).map((t) => t.name)

  const WRITES = [
    'send_to_pane',
    'send_key',
    'mail_send',
    'claim_files',
    'release_files',
    'update_card',
    'create_card',
    'claim_card',
    'release_card',
    'comment_card',
    'archive_card',
    // ADR 0018 step 07: the brain's symbol writes ride the SAME grant — one
    // toggle covers the whole write surface, so this gate counts them too.
    'replace_symbol_body',
    'insert_after_symbol',
    'insert_before_symbol',
    // ADR 0018 step 09: so do the memory writes — same toggle, same boundary.
    'create_memory',
    'update_memory',
    // ADR 0018 revision C: the draft quarantine's two doors ride it too.
    'promote_memory',
    'discard_memory'
  ]
  const countWrites = (names: string[]): number => names.filter((n) => WRITES.includes(n)).length
  /** Catalog geometry: 17 browser + 6 control reads + 1 self + 10 brain reads
   *  + 5 memory reads (recall_memories joined at ADR 0018 revision D)
   *  (non-writes) + 18 writes (11 fleet/board + 3 brain + 4 memory). */
  const NON_WRITE_COUNT = 39
  const WRITE_COUNT = WRITES.length

  const waitFor = async (probe: () => Promise<boolean>, tries = 12, gapMs = 400): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const clients: PaneMcpSmokeClient[] = []
    try {
      await sleep(1500)

      // ── The world: workspace A (2 panes) + workspace B (1 pane) ───────────
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
      await sleep(3000)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const a1 = String(wsA.ordinal * 100 + 1)
      const a2 = String(wsA.ordinal * 100 + 2)
      await ES(`window.__mogging.workspace.create({ name: 'GrantB' })`)
      await sleep(800)
      await ES(`window.__mogging.layout.apply(1)`)
      await sleep(2500)
      const wsB = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const b1 = String(wsB.ordinal * 100 + 1)
      await ES(`window.__mogging.board.createCard('MCPWRITE_CARD_4242', 'write-smoke card')`)
      await sleep(1500) // let the workspace state persist (grant.get resolves from it)

      // ── Grant 'none' (the default): invisible AND refused ─────────────────
      const c1 = await spawnPaneMcpSmokeClient({
        cli,
        paneId: a1,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesNone = await listNames(c1)
      const invisibleWhenNone =
        countWrites(namesNone) === 0 &&
        namesNone.length === NON_WRITE_COUNT &&
        namesNone.includes('report_working_directory')
      const refusedNone = await callTool(c1, 'send_to_pane', { pane: a2, text: 'nope' })
      const refusedWhenNone = !!refusedNone.rpcError && /grant/.test(refusedNone.rpcError)

      // Default read-back sanity: the store serves defaults for A.
      const defaultGrant = getIntegrationsGrant(wsA.id)
      const defaultIsNone = defaultGrant.writeTools === 'none' && defaultGrant.web === 'off'

      // ── Flip A to 'all': list_changed + visible + working ─────────────────
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const sawListChanged = await waitFor(async () =>
        c1.notifications.includes('notifications/tools/list_changed')
      )
      const namesAll = await listNames(c1)
      const visibleWhenAll =
        countWrites(namesAll) === WRITE_COUNT &&
        namesAll.length === NON_WRITE_COUNT + WRITE_COUNT &&
        namesAll.includes('report_working_directory')

      // send_to_pane: text arrives (capture proves it; the pong already
      // confirmed processing server-side).
      const sent = await callTool(c1, 'send_to_pane', { pane: a2, text: 'echo MCPWRITE_SENT_4242' })
      const sendOk =
        !sent.isError && !sent.rpcError &&
        (await waitFor(async () => {
          const cap = await callTool(c1, 'capture_pane', { pane: a2, lines: 100 })
          return cap.text.includes('MCPWRITE_SENT_4242')
        }))

      // mail_send: arrives for the target AND the receipt lands attention on
      // the target pane's header (the house notify path) — no PTY output races
      // this one, so the state assert is clean.
      // The TIMELINE recorder rides alongside the poll below: on the macos runner the
      // latch read as never-set at every 500ms sample (run 29577387596) and a poll
      // cannot distinguish "never latched" from "latched and released between
      // samples" — a distinction that decides whether the fix is the gate's or the
      // tracker's. 100ms samples, ids+states only, bounded, attached to the verdict.
      const a2Timeline: string[] = []
      let timelineOn = true
      const timelineDone = (async (): Promise<void> => {
        while (timelineOn && a2Timeline.length < 300) {
          try {
            const panes = await callTool(c1, 'list_panes')
            const row = (JSON.parse(panes.text) as { id: string; state?: string }[]).find((p) => String(p.id) === a2)
            const st = row?.state ?? 'gone'
            if (a2Timeline[a2Timeline.length - 1] !== st) a2Timeline.push(st)
          } catch {
            /* keep sampling */
          }
          await sleep(100)
        }
      })()
      const mailed = await callTool(c1, 'mail_send', { to: a2, body: 'MCPWRITE_MAIL_4242' })
      const mailArrived = (await cli(['mail', 'read', '--json'], { MOGGING_PANE_ID: a2 })).stdout.includes(
        'MCPWRITE_MAIL_4242'
      )
      // 20s, not the 4.8s default: the receipt's attention crosses MCP → daemon →
      // notify → the attention scan's own cadence, and the macos runner's slow mode
      // outlived the old budget with the latch correct (run 29547052949). A green
      // run still exits on the first true probe.
      const receiptPolled = await waitFor(async () => {
        const panes = await callTool(c1, 'list_panes')
        try {
          const rows = JSON.parse(panes.text) as { id: string; state?: string }[]
          return rows.some((p) => String(p.id) === a2 && p.state === 'attention')
        } catch {
          return false
        }
      }, 40, 500)
      timelineOn = false
      await timelineDone
      // The claim is "the receipt LANDS attention on the target pane" — the 100ms
      // timeline observing the latch is that claim proven, even where a later,
      // legitimate release (an idle verdict from the pane's own shell) collects it
      // before a slower poll looks. The poll stays as the primary read.
      const receiptAttention = receiptPolled || a2Timeline.includes('attention')
      const mailOk = !mailed.isError && !mailed.rpcError && mailArrived

      // claim_files: granted here; a SECOND session (pane a2) claiming an
      // overlap is DENIED with the owner named — exit-5 wording, exactly.
      const claimed = await callTool(c1, 'claim_files', { pattern: 'src/write/**' })
      const c2 = await spawnPaneMcpSmokeClient({
        cli,
        paneId: a2,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(c2)
      await c2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const denied = await callTool(c2, 'claim_files', { pattern: 'src/write/x.ts' })
      const claimOk =
        !claimed.isError && !claimed.rpcError &&
        denied.isError && /DENIED/.test(denied.text) && denied.text.includes(`pane ${a1}`)
      const released = await callTool(c1, 'release_files', { all: true })
      const releaseOk = !released.isError && !released.rpcError

      // send_key: the closed allowlist, verbatim (enter lands; the schema enum
      // refuses junk before the daemon ever sees it).
      const keyed = await callTool(c1, 'send_key', { pane: a2, key: 'enter' })
      const badKey = await callTool(c1, 'send_key', { pane: a2, key: 'f13' })
      const keyOk = !keyed.isError && !keyed.rpcError && !!badKey.rpcError && /must be one of/.test(badKey.rpcError)

      // update_card: the card moves lanes + note survives (board.list read-back).
      // list_board (v2) answers { board, cards } — the board meta rides along.
      const boardBefore = await callTool(c1, 'list_board')
      const cardId = ((JSON.parse(boardBefore.text) as { cards?: { id: string; title: string }[] }).cards ?? []).find(
        (c) => c.title.includes('MCPWRITE_CARD_4242')
      )?.id
      const moved = await callTool(c1, 'update_card', { card: cardId ?? '', column: 'doing', note: 'moved by mcp' })
      const boardAfter = await callTool(c1, 'list_board')
      const cardAfter = (
        (JSON.parse(boardAfter.text) as { cards?: { id: string; lane: string; notes: string }[] }).cards ?? []
      ).find((c) => c.id === cardId)
      const cardOk = !moved.isError && !moved.rpcError && cardAfter?.lane === 'doing' && cardAfter?.notes === 'moved by mcp'
      const badCard = await callTool(c1, 'update_card', { card: 'no-such-card', column: 'done' })
      const badCardOk = badCard.isError && /unknown card/.test(badCard.text)

      // ── Workspace-scoped: B's session sees ZERO writes while A is 'all' ───
      const cB = await spawnPaneMcpSmokeClient({
        cli,
        paneId: b1,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(cB)
      await cB.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesB = await listNames(cB)
      const refusedB = await callTool(cB, 'mail_send', { to: a1, body: 'should refuse' })
      const scopedOk = countWrites(namesB) === 0 && !!refusedB.rpcError && /grant/.test(refusedB.rpcError)

      // ── Human session (no pane identity): zero writes, period ─────────────
      const cH = spawnLocalMcpSmokeClient({
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(cH)
      await cH.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesH = await listNames(cH)
      const refusedH = await callTool(cH, 'send_to_pane', { pane: a2, text: 'nope' })
      const humanOk = countWrites(namesH) === 0 && !!refusedH.rpcError && /pane session/.test(refusedH.rpcError)

      // A caller can forge the public pane id in its environment, but without
      // the daemon-minted pane token the app endpoint binds it as read-only.
      // It gets neither A's grant nor A's browser consent/session.
      const cForged = spawnLocalMcpSmokeClient({
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        childEnv: { MOGGING_PANE_ID: a1 },
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(cForged)
      await cForged.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesForged = await listNames(cForged)
      const forgedWrite = await callTool(cForged, 'send_to_pane', { pane: a2, text: 'forged' })
      const forgedBrowser = await callTool(cForged, 'browser_snapshot')
      const forgedPaneRefused =
        countWrites(namesForged) === 0 &&
        !!forgedWrite.rpcError && /grant/.test(forgedWrite.rpcError) &&
        forgedBrowser.isError && /nopane|pane/i.test(forgedBrowser.text)

      const cWrongToken = spawnLocalMcpSmokeClient({
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        childEnv: { MOGGING_PANE_ID: a1, MOGGING_PANE_TOKEN: 'wrong-pane-capability' },
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(cWrongToken)
      await cWrongToken.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesWrongToken = await listNames(cWrongToken)
      const wrongTokenBrowser = await callTool(cWrongToken, 'browser_snapshot')
      const wrongTokenRefused =
        countWrites(namesWrongToken) === 0 &&
        wrongTokenBrowser.isError && /refused the connection \(auth\)/i.test(wrongTokenBrowser.text)

      // ── Revoke mid-session: list_changed + the very next call refused ─────
      const changedBefore = c1.notifications.filter((n) => n === 'notifications/tools/list_changed').length
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'none', web: 'off', actOrigins: [] })
      const sawRevokeChange = await waitFor(async () =>
        c1.notifications.filter((n) => n === 'notifications/tools/list_changed').length > changedBefore
      )
      const afterRevoke = await callTool(c1, 'send_to_pane', { pane: a2, text: 'nope' })
      const namesRevoked = await listNames(c1)
      const revokeOk =
        !!afterRevoke.rpcError && /grant/.test(afterRevoke.rpcError) && countWrites(namesRevoked) === 0

      // ── approve is in NO frame, structurally ───────────────────────────────
      const noApproveAnywhere = !frames.join('\n').toLowerCase().includes('approve')

      const pass =
        invisibleWhenNone && refusedWhenNone && defaultIsNone && sawListChanged && visibleWhenAll &&
        sendOk && mailOk && receiptAttention && claimOk && releaseOk && keyOk && cardOk && badCardOk &&
        scopedOk && humanOk && forgedPaneRefused && wrongTokenRefused && sawRevokeChange && revokeOk && noApproveAnywhere
      result = {
        pass,
        invisibleWhenNone,
        refusedWhenNone,
        refusedNoneMsg: refusedNone.rpcError,
        defaultIsNone,
        sawListChanged,
        visibleWhenAll,
        sendOk,
        mailOk,
        receiptAttention,
        receiptPolled,
        a2Timeline,
        claimOk,
        deniedMsg: denied.text,
        releaseOk,
        keyOk,
        cardOk,
        badCardOk,
        scopedOk,
        humanOk,
        humanMsg: refusedH.rpcError,
        forgedPaneRefused,
        forgedWriteMsg: forgedWrite.rpcError,
        forgedBrowserMsg: forgedBrowser.text,
        wrongTokenRefused,
        wrongTokenBrowserMsg: wrongTokenBrowser.text,
        sawRevokeChange,
        revokeOk,
        noApproveAnywhere,
        frameCount: frames.length
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    for (const c of clients) c.kill()
    emit('mcpwrite-result.json', result)
    app.exit(result.pass ? 0 : 1)
  }

  // DEV mode: the same world, grant flipped on A, facts printed — then HOLD so
  // a real CLI session can be driven against it (the 8/03 dev-verify).
  const runDev = async (): Promise<void> => {
    await sleep(1500)
    await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
    await sleep(3000)
    const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
    await ES(`window.__mogging.workspace.create({ name: 'GrantB' })`)
    await sleep(800)
    await ES(`window.__mogging.layout.apply(1)`)
    await sleep(2500)
    const wsB = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
    await ES(`window.__mogging.board.createCard('DEVVERIFY_CARD', 'dev-verify card')`)
    await sleep(1500)
    setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
    emit('mcpwrite-dev.json', {
      held: true,
      wsA: wsA.id,
      panesA: [wsA.ordinal * 100 + 1, wsA.ordinal * 100 + 2],
      wsB: wsB.id,
      panesB: [wsB.ordinal * 100 + 1],
      appEndpoint: mcpEndpointDebug().file
    })
    // no exit — the world holds until the dev kills it
  }

  const start = dev ? runDev : run
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void start(), 3000))
  else setTimeout(() => void start(), 3000)
}

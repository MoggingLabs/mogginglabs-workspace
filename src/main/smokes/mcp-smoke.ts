import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setAgentConsent } from '../browser-dock'
import { mcpEndpointDebug } from '../mcp-endpoint'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated house-MCP-server smoke (MOGGING_MCP, Phase-8/02): the ONE server,
// both upstreams, catalog-as-data. Fixture world (daemon + app endpoint up,
// panes/mail/claims/board planted), then the REAL `bin/mogging-mcp.mjs` is
// spawned as a child and driven with scripted JSON-RPC frames:
//   initialize (serverInfo `mogging`) -> tools/list (browser + control reads,
//   ZERO write tools, equal to the contracts catalog via the copied file,
//   byte-compared) -> each control read against its planted fixture -> one
//   browser read in the SAME session (both upstreams, one session) -> error
//   cases (unknown pane, malformed args, write tool names the 8/03 grant,
//   unknown tool) -> upstreams degrade INDEPENDENTLY (a daemon-less child
//   answers control with a clean JSON-RPC error naming the fix while browser
//   still works; an app-less child does the reverse) -> and NO frame anywhere
//   carries either endpoint token (grepped, both directions).
// Zero network: the only page served is this smoke's own 127.0.0.1 fixture.

type Rpc = { result?: Record<string, unknown>; error?: { code?: number; message?: string } }
type ToolResult = { content?: { type?: string; text?: string }[]; isError?: boolean }

export function runMcpSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  let pageServer: Server | null = null
  const frames: string[] = [] // every line every child ever wrote — the token grep surface

  const emit = (o: object): void => {
    try {
      writeFileSync(join(root, 'out', 'mcp-result.json'), JSON.stringify(o, null, 2))
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

  const servePage = (): Promise<number> =>
    new Promise((resolve) => {
      pageServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>MCPPAGE_4242</title><h1>MCPPAGE_4242</h1><button id="b">Go</button>`)
      })
      pageServer.listen(0, '127.0.0.1', () => {
        const addr = pageServer?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const clients: PaneMcpSmokeClient[] = []
    try {
      await sleep(1500)

      // ── Fixture world: 4 shell panes, planted scrollback/mail/claim/card ──
      // FOUR, not two, and the reason is the identity path itself. The MCP server now proves
      // WHICH pane it is with the daemon-minted MOGGING_PANE_TOKEN, which exists nowhere but
      // inside that pane — so a pane-bound session is a REAL process launched in a REAL pane
      // (spawnPaneMcpSmokeClient types it there). That process then HOLDS the pane's foreground
      // for as long as the session is open: a second `mogging send` into the same pane hands its
      // bytes to the running bridge's stdin, the shell never sees a command, and the second
      // session simply never connects. One live pane-bound session per pane. The three sessions
      // below are three panes; pane2 stays free as the write/mail TARGET.
      await ES(`window.__mogging.templates.open([{provider:'shell',count:4}])`)
      await sleep(3000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const pane1 = String(base + 1)
      const pane2 = String(base + 2)
      const pane3 = String(base + 3) // the daemon-less session (c2)
      const pane4 = String(base + 4) // the app-less session (c3)
      await cli(['send', pane1, 'echo MCP_CAPTURE_4242'])
      await cli(['mail', 'send', '--to', pane1, 'MCP_MAIL_4242'], { MOGGING_PANE_ID: pane2 })
      await cli(['claim', 'src/mcp/**'], { MOGGING_PANE_ID: pane1 })
      await ES(`window.__mogging.board.createCard('MCP_CARD_4242', 'planted by the mcp smoke')`)
      const port = await servePage()
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      setAgentConsent(true)
      await sleep(1000)

      // ── The catalog files: committed copy byte-equals contracts source ────
      const contractsCatalog = readFileSync(join(root, 'src', 'contracts', 'integrations', 'mcp-catalog.json'), 'utf8')
      const binCatalog = readFileSync(join(root, 'bin', 'mcp-catalog.json'), 'utf8')
      const catalogBytesOk = contractsCatalog === binCatalog

      // ── Session 1: the real path (both upstreams in ONE session) ──────────
      const c1 = await spawnPaneMcpSmokeClient({
        cli,
        paneId: pane1,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(c1)
      const init = (await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })).result as {
        serverInfo?: { name?: string }
        capabilities?: { tools?: { listChanged?: boolean } }
      }
      const serverInfoOk = init?.serverInfo?.name === 'mogging'
      const listChangedOk = init?.capabilities?.tools?.listChanged === true

      type ToolRow = { name: string; title?: string; description?: string; inputSchema?: unknown }
      const served = ((await c1.rpc('tools/list')).result as { tools?: ToolRow[] })?.tools ?? []
      const expected = (JSON.parse(contractsCatalog) as (ToolRow & { access: string })[]).filter(
        (t) => t.access !== 'write'
      )
      // Served tools/list EQUALS the catalog's non-write rows: same order,
      // same name/title/description/inputSchema — drift fails.
      const toolsEqualCatalog =
        served.length === expected.length &&
        expected.every(
          (e, i) =>
            served[i].name === e.name &&
            served[i].title === e.title &&
            served[i].description === e.description &&
            JSON.stringify(served[i].inputSchema) === JSON.stringify(e.inputSchema)
        )
      const noWritesServed = !served.some((t) =>
        ['send_to_pane', 'send_key', 'mail_send', 'claim_files', 'release_files', 'update_card'].includes(t.name)
      )
      const noApproveAnywhere = !JSON.stringify(served).toLowerCase().includes('approve')

      // ── Each control read against its planted fixture ─────────────────────
      const panes = await callTool(c1, 'list_panes')
      const listPanesOk =
        !panes.isError && !panes.rpcError && panes.text.includes(`"${pane1}"`) && panes.text.includes(`"${pane2}"`)

      const cap = await callTool(c1, 'capture_pane', { pane: pane1, lines: 200 })
      const captureOk = !cap.isError && !cap.rpcError && cap.text.includes('MCP_CAPTURE_4242')

      const mail = await callTool(c1, 'mail_read', {})
      const mailOk = !mail.isError && !mail.rpcError && mail.text.includes('MCP_MAIL_4242')

      const owners = await callTool(c1, 'list_owners')
      const ownersOk =
        !owners.isError && !owners.rpcError && owners.text.includes('src/mcp/**') && owners.text.includes(pane1)

      const board = await callTool(c1, 'list_board')
      const boardOk = !board.isError && !board.rpcError && board.text.includes('MCP_CARD_4242')

      // ── One browser read, SAME session: the second upstream lights up ─────
      await callTool(c1, 'browser_navigate', { url: `127.0.0.1:${port}` })
      await sleep(1200)
      const snap = await callTool(c1, 'browser_snapshot')
      const browserOk = !snap.isError && !snap.rpcError && snap.text.includes('MCPPAGE_4242')

      // ── Error cases: spec errors, never crashes ────────────────────────────
      const badPane = await callTool(c1, 'capture_pane', { pane: '99999' })
      const unknownPaneOk = badPane.isError && /unknown pane/.test(badPane.text)

      const malformed = await callTool(c1, 'capture_pane', {})
      const malformedOk = !!malformed.rpcError && /pane/.test(malformed.rpcError)

      // 8/03: writes exist now but this world never granted them — the default
      // 'none' refusal must name the grant (and the tool stays unlisted).
      const write = await callTool(c1, 'send_to_pane', { pane: pane1, text: 'nope' })
      const writeRefusedOk = !!write.rpcError && /grant/.test(write.rpcError) && /OFF/.test(write.rpcError)

      const unknown = await callTool(c1, 'frobnicate', {})
      const unknownToolOk = !!unknown.rpcError && /unknown tool/.test(unknown.rpcError)

      // still alive after every error case?
      const alive = await callTool(c1, 'list_owners')
      const aliveAfterErrorsOk = !alive.isError && !alive.rpcError

      // ── Independent degradation: no daemon -> control names the fix, browser
      //    still works (one session, before AND after the control failure) ────
      const c2 = await spawnPaneMcpSmokeClient({
        cli,
        paneId: pane3,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        childEnv: { MOGGING_DAEMON_ENDPOINT: join(root, 'out', 'absent-daemon.json') },
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(c2)
      await c2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const c2snap1 = await callTool(c2, 'browser_snapshot')
      const c2panes = await callTool(c2, 'list_panes')
      const c2snap2 = await callTool(c2, 'browser_snapshot')
      const daemonDownOk =
        !c2snap1.isError && !c2snap1.rpcError &&
        !!c2panes.rpcError && /daemon is not running/.test(c2panes.rpcError) && /MOGGING_DAEMON_ENDPOINT|open the app/.test(c2panes.rpcError) &&
        !c2snap2.isError && !c2snap2.rpcError

      // ── ...and the reverse: no app -> browser errors, control still works ──
      const c3 = await spawnPaneMcpSmokeClient({
        cli,
        paneId: pane4,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        childEnv: { MOGGING_BROWSER_ENDPOINT: join(root, 'out', 'absent-app.json') },
        onFrame: (frame) => frames.push(frame)
      })
      clients.push(c3)
      await c3.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const c3snap = await callTool(c3, 'browser_snapshot')
      const c3panes = await callTool(c3, 'list_panes')
      const appDownOk =
        c3snap.isError && /app is not running/.test(c3snap.text) && !c3panes.isError && !c3panes.rpcError

      // ── Token hygiene: NO frame from any child carries either token ───────
      const appEp = JSON.parse(readFileSync(mcpEndpointDebug().file, 'utf8')) as { token: string }
      // The CLI's discovery, mirrored per-OS (qa-smokes exports both vars).
      const runtimeBase =
        process.platform === 'win32'
          ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
          : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
      const daemonEpFile =
        process.env.MOGGING_DAEMON_ENDPOINT ||
        // Derived, never a literal: the runtime dir is namespaced by the protocol version
        // (ADR 0006), so a hardcoded 'v3' silently pointed at a directory no daemon writes.
        join(runtimeBase, 'MoggingLabs', 'run', `v${DAEMON_PROTOCOL_VERSION}`, 'endpoint.json')
      const daemonEp = JSON.parse(readFileSync(daemonEpFile, 'utf8')) as { token: string }
      const allFrames = frames.join('\n')
      const noTokenLeak =
        appEp.token.length > 10 && daemonEp.token.length > 10 &&
        !allFrames.includes(appEp.token) && !allFrames.includes(daemonEp.token)

      const pass =
        catalogBytesOk && serverInfoOk && listChangedOk && toolsEqualCatalog && noWritesServed && noApproveAnywhere &&
        listPanesOk && captureOk && mailOk && ownersOk && boardOk && browserOk &&
        unknownPaneOk && malformedOk && writeRefusedOk && unknownToolOk && aliveAfterErrorsOk &&
        daemonDownOk && appDownOk && noTokenLeak
      result = {
        pass,
        catalogBytesOk,
        serverInfoOk,
        listChangedOk,
        toolsEqualCatalog,
        servedCount: served.length,
        noWritesServed,
        noApproveAnywhere,
        listPanesOk,
        captureOk,
        mailOk,
        ownersOk,
        boardOk,
        browserOk,
        unknownPaneOk,
        malformedOk,
        writeRefusedOk,
        writeRefusedMsg: write.rpcError,
        unknownToolOk,
        aliveAfterErrorsOk,
        daemonDownOk,
        daemonDownMsg: c2panes.rpcError,
        appDownOk,
        noTokenLeak,
        frameCount: frames.length
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    for (const c of clients) c.kill()
    pageServer?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

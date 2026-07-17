import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserAgentResult,
  BrowserAgentVerb,
  LinkStatus,
  McpServerEntry,
  ServiceAdapter,
  ServiceLink,
  WorkspaceToolPlan
} from '@contracts'
import {
  ServiceEngine,
  composePlanEntries,
  materializePlanFor,
  saveServer,
  type CliHomes,
  type GrantKv
} from '@backend/features/integrations'
import { mgrApply, mgrStatus, houseServerEntry } from '../mcp-manager'
import { setIntegrationsGrant, setToolPlan } from '../integrations'
import {
  spawnLocalMcpSmokeClient,
  spawnPaneMcpSmokeClient,
  type PaneMcpSmokeClient
} from './pane-mcp-smoke-client'
import { agentAct, browserDriver, confirmPendingActOrigin, dockPageEval, setAgentConsent } from '../browser-dock'
import { emitBridgeEvent, saveWebhook } from '../event-bridge'
import { flushTrailForSmoke, readTrail } from '../trail'
import { resolveServiceKeyEnv, serviceKeyClear, serviceKeyNames, serviceKeySet } from '../service-keys'
import { getDaemonClient } from '../daemon-relay'
import { getSettingsStore } from '../app-settings'
import { softFps, softGapMs } from './smoke-shell'

// Env-gated INTEGRATIONS MILESTONE (MOGGING_INTEGMILESTONE, Phase-8/14) — the
// freeze proof that all FIVE Phase-8 directions COMPOSE in ONE fixture world,
// ZERO network. Each direction is asserted through its REAL exported units, and
// the composed surface must not move the machine budget. Asserts a–h:
//   (a) the MCP manager applies the house server into a FIXTURE Claude home
//       (dialect-correct entry) and a scoped tool-plan materializes EXACTLY the
//       planned servers (the unplanned global absent);
//   (b) an MCP session (pane identity) lists panes, captures a tail, reads mail
//       under grant 'none' — no write tools listed, a write refused naming the
//       grant;
//   (c) grant 'all' -> list_changed; the session claims a glob and sends to its
//       own pane (confirmed by capture + a receipt attention); an ungranted
//       second workspace sees zero writes;
//   (d) agent-web ACTS on the GRANTED fixture origin and is REFUSED on the
//       ungranted one — both land in the trail (web/ok + web/refused);
//   (e) a loopback receiver gets a bridge `notify`; a dead second webhook never
//       stalls the emit;
//   (f) a FAKE PR flips to approved — the chip follows, the owning pane is
//       notified (attention), and `review-changed` fires at a webhook;
//   (g) structural: `approve` in NO tools/list frame; the receipt landed; each
//       Settings surface keeps ONE renderer module (integrations.ts for the MCP
//       knobs; webhooks.ts and activity.ts for their own tabs);
//   (h) the custody sweep: every fixture secret (vault key, webhook URL token,
//       the fixture cookie value) is ABSENT in plaintext across the whole
//       fixture userData (our stores), the CLI homes, and every frame/trail.
// Budgets are sampled DURING the composed surface (dock open + live panes).

type ToolResult = { content?: { type?: string; text?: string }[]; isError?: boolean }
type ToolRow = { name: string }

const BUDGET = { maxFrameGapMs: softGapMs(150), minAvgFps: softFps(30), maxHeapMB: 320 }
const WRITES = ['send_to_pane', 'send_key', 'mail_send', 'claim_files', 'release_files', 'update_card']

// Fixture secrets — fixed for the run so the custody grep is exact.
const VAULT_NAME = 'MOG_INTEGMILE_KEY'
const VAULT_SECRET = 'mlw-integmile-secret-0a1b2c3d4e5f'
const HOOK_TOKEN = '/hook/tok_integmile_7f3a2b1c9d0e'
const COOKIE_VAL = 'INTEGMILE_COOKIE_4242'

// The scoped-plan fixture servers (a). One planned, one global-only.
const SENTRY: McpServerEntry = { id: 'sentry', label: 'Sentry', transport: 'stdio', command: 'sentry-mcp', args: [] }
const POSTHOG: McpServerEntry = { id: 'posthog', label: 'PostHog', transport: 'stdio', command: 'posthog-mcp', args: [] }

export function runIntegMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 235000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const frames: string[] = [] // every MCP child frame — the 'approve' + custody grep surface
  const servers: Server[] = []
  const clients: PaneMcpSmokeClient[] = [] // every spawned MCP child — killed at the end
  const mcpPath = join(root, 'bin', 'mogging-mcp.mjs')

  const emit = (o: object): void => {
    try {
      writeFileSync(join(root, 'out', 'integmilestone-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const cli = (
    args: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout, stderr) => res({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    })

  /**
   * A pane-bound MCP session: the REAL server, launched INSIDE the pane, exactly as an agent
   * launches it. That is the only place the daemon-minted MOGGING_PANE_TOKEN exists, and the app
   * endpoint now binds a session to a pane on that token alone — a server spawned from the main
   * process with a hand-set MOGGING_PANE_ID is a claim, not a proof, and gets a read-only session
   * with no grant and no browser (the forgery mcpwrite-smoke asserts). (b) and (c) below are ABOUT
   * the grant reaching a pane's session, so they have to hold a session that really is one.
   *
   * One live session per pane — the bridge holds the pane's foreground (pane-mcp-smoke-client.ts).
   */
  const paneMcpClient = async (paneId: string): Promise<PaneMcpSmokeClient> => {
    const c = await spawnPaneMcpSmokeClient({ cli, paneId, mcpPath, onFrame: (frame) => frames.push(frame) })
    clients.push(c)
    return c
  }

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
  const countWrites = (names: string[]): number => names.filter((n) => WRITES.includes(n)).length
  const waitFor = async (probe: () => Promise<boolean>, tries = 15, gapMs = 400): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const act = (v: BrowserAgentVerb): Promise<BrowserAgentResult> => agentAct(v)
  const pageText = async (): Promise<string> => String((await dockPageEval(`document.body.innerText`)) ?? '')
  const clickInPage = (sel: string): Promise<unknown> | null =>
    dockPageEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)
  const refFor = async (name: string): Promise<string> => {
    const snap = await act({ verb: 'snapshot' })
    return snap.nodes?.find((n) => n.name.includes(name))?.ref ?? ''
  }

  /** A cookie-login fixture site (label distinguishes the two origins). */
  const serveSite = (label: string): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        const loggedIn = new RegExp(`(?:^|;\\s*)sid=${COOKIE_VAL}(?:;|$)`).test(String(req.headers.cookie ?? ''))
        res.writeHead(200, { 'content-type': 'text/html' })
        if (!loggedIn) {
          res.end(
            `<!doctype html><title>${label}</title><div id="who">OUT_${label}</div>` +
              `<button id="login" onclick="document.cookie='sid=${COOKIE_VAL}; max-age=86400'; location.reload()">Log in</button>`
          )
          return
        }
        res.end(
          `<!doctype html><title>${label}</title><div id="who">IN_${label}</div>` +
            `<button id="act" onclick="var d=document.createElement('div');d.id='acted';d.textContent='ACTED';document.body.appendChild(d)">Do the thing</button>`
        )
      })
      server.listen(0, '127.0.0.1', () => {
        const a = server.address()
        servers.push(server)
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })

  // Poll list_panes (through a fresh short-lived session) for a pane's attention. `list_panes` is
  // a control READ — it goes to the daemon, on the daemon's own token, and needs no pane binding
  // — so this one stays an ordinary out-of-pane session and never occupies the pane it watches.
  const waitForPaneAttention = async (pane: string): Promise<boolean> => {
    const c = spawnLocalMcpSmokeClient({
      mcpPath,
      childEnv: { MOGGING_PANE_ID: pane },
      onFrame: (frame) => frames.push(frame)
    })
    clients.push(c)
    await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
    for (let i = 0; i < 15; i++) {
      const p = await callTool(c, 'list_panes')
      try {
        if ((JSON.parse(p.text) as { id: string; state?: string }[]).some((x) => String(x.id) === pane && x.state === 'attention')) return true
      } catch {
        /* not yet */
      }
      await sleep(400)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    // The bridge loopback receiver (e) + (f).
    const received: { path: string; body: string }[] = []
    const receiver = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ path: req.url ?? '', body })
        res.writeHead(200)
        res.end('ok')
      })
    })
    try {
      await sleep(1500)
      const store = getSettingsStore()

      // ══ (a) Manager into a FIXTURE Claude home + a scoped plan ══════════════
      const fixRoot = join(app.getPath('userData'), 'integmile-fixtures')
      const homes: CliHomes = { home: join(fixRoot, 'home'), codexDir: join(fixRoot, 'codex'), geminiDir: join(fixRoot, 'gemini') }
      mkdirSync(homes.home, { recursive: true })
      mkdirSync(homes.codexDir, { recursive: true })
      mkdirSync(homes.geminiDir, { recursive: true })
      const applyOk = mgrApply('mogging', 'claude-code', homes).ok
      const claudeFile = join(homes.home, '.claude.json')
      const claudeParsed = JSON.parse(readFileSync(claudeFile, 'utf8')) as {
        mcpServers?: Record<string, { type?: string; command?: string; _managedBy?: string }>
      }
      const dialectOk =
        applyOk &&
        claudeParsed.mcpServers?.mogging?.type === 'stdio' &&
        claudeParsed.mcpServers?.mogging?._managedBy === 'mogginglabs' &&
        mgrStatus('mogging', homes).find((s) => s.cli === 'claude-code')?.state === 'applied'

      const planDir = join(fixRoot, 'toolplans')
      const planRepo = mkdtempSync(join(tmpdir(), 'mog-integmile-'))
      const plan: WorkspaceToolPlan = { workspaceId: 'ws-fix', entries: { sentry: ['claude-code'] }, inheritGlobal: false }
      const planEntries = composePlanEntries(plan, 'claude-code', [SENTRY, POSTHOG], houseServerEntry())
      const mat = materializePlanFor({ cli: 'claude-code', entries: planEntries, inheritGlobal: false, planDir, cwd: planRepo, workspaceId: 'ws-fix' })
      const planKeys = Object.keys((JSON.parse(mat.files[0].content) as { mcpServers: object }).mcpServers).sort()
      const planScopedOk =
        JSON.stringify(planKeys) === JSON.stringify(['mogging', 'sentry']) && // planned exactly — posthog (global) absent
        mat.launchArgs.includes('--strict-mcp-config')

      // ══ World: workspace A (2 shell panes) — the MCP-session substrate ══════
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
      await sleep(3000)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const a1 = String(wsA.ordinal * 100 + 1)
      const a2 = String(wsA.ordinal * 100 + 2)

      // ══ (b) MCP session, pane identity, grant 'none' ════════════════════════
      const c1 = await paneMcpClient(a1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesNone = await listNames(c1)
      const noneNoWrites = countWrites(namesNone) === 0
      const panes = await callTool(c1, 'list_panes')
      const listPanesOk = !panes.isError && !panes.rpcError && panes.text.includes(`"${a1}"`) && panes.text.includes(`"${a2}"`)
      const mailRead = await callTool(c1, 'mail_read', {})
      const mailReadOk = !mailRead.isError && !mailRead.rpcError
      const capture = await callTool(c1, 'capture_pane', { pane: a1, lines: 100 })
      const captureReadOk = !capture.isError && !capture.rpcError
      const writeNone = await callTool(c1, 'send_to_pane', { pane: a2, text: 'nope' })
      const writeRefusedNone = !!writeNone.rpcError && /grant/.test(writeNone.rpcError)
      const bOk = noneNoWrites && listPanesOk && mailReadOk && captureReadOk && writeRefusedNone

      // ══ (c) grant 'all' -> list_changed + a real write, confirmed ═══════════
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const sawListChanged = await waitFor(async () => c1.notifications.includes('notifications/tools/list_changed'))
      const namesAll = await listNames(c1)
      const writesVisible = countWrites(namesAll) === 6
      const claimed = await callTool(c1, 'claim_files', { pattern: 'src/integmile/**' })
      const sent = await callTool(c1, 'send_to_pane', { pane: a2, text: 'echo INTEGMILE_SENT_4242' })
      const sendLanded = await waitFor(async () => {
        const cap = await callTool(c1, 'capture_pane', { pane: a2, lines: 100 })
        return cap.text.includes('INTEGMILE_SENT_4242')
      })
      // The 100ms transition recorder alongside the poll — the latch may be observed
      // and then legitimately released (an idle verdict from the pane's own shell)
      // between slower samples; a recorded 'attention' IS the claim proven. mcpwrite
      // carries the full story (run 29577387596).
      const a2Seen: string[] = []
      let a2Rec = true
      const a2RecDone = (async (): Promise<void> => {
        while (a2Rec && a2Seen.length < 300) {
          try {
            const p = await callTool(c1, 'list_panes')
            const st = (JSON.parse(p.text) as { id: string; state?: string }[]).find((x) => String(x.id) === a2)?.state ?? 'gone'
            if (a2Seen[a2Seen.length - 1] !== st) a2Seen.push(st)
          } catch {
            /* keep sampling */
          }
          await sleep(100)
        }
      })()
      const mailed = await callTool(c1, 'mail_send', { to: a2, body: 'INTEGMILE_MAIL_4242' })
      const receiptPolled = await waitFor(async () => {
        const p = await callTool(c1, 'list_panes')
        try {
          return (JSON.parse(p.text) as { id: string; state?: string }[]).some((x) => String(x.id) === a2 && x.state === 'attention')
        } catch {
          return false
        }
      }, 40, 500)
      a2Rec = false
      await a2RecDone
      const receiptAttention = receiptPolled || a2Seen.includes('attention')
      await callTool(c1, 'release_files', { all: true })
      const cWriteOk = !claimed.isError && !claimed.rpcError && !sent.isError && !sent.rpcError && !mailed.isError && !mailed.rpcError
      // A second, UNGRANTED workspace sees zero writes.
      await ES(`window.__mogging.workspace.create({ name: 'Ungranted' })`)
      await sleep(800)
      await ES(`window.__mogging.layout.apply(1)`)
      await sleep(2500)
      const wsB = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const b1 = String(wsB.ordinal * 100 + 1)
      const cB = await paneMcpClient(b1)
      await cB.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const namesB = await listNames(cB)
      const refusedB = await callTool(cB, 'mail_send', { to: a1, body: 'nope' })
      const scopedOk = countWrites(namesB) === 0 && !!refusedB.rpcError && /grant/.test(refusedB.rpcError)
      const cOk = sawListChanged && writesVisible && cWriteOk && sendLanded && receiptAttention && scopedOk

      // ══ (d) agent-web: granted origin acts, ungranted refused — both trailed ═
      const portA = await serveSite('A')
      const portB = await serveSite('B')
      const originA = `http://127.0.0.1:${portA}`
      const originB = `http://127.0.0.1:${portB}`
      await ES(`window.__mogging.workspace.create({ name: 'Web' })`)
      await sleep(1500)
      const webWsId = ((await ES('window.__mogging.workspace.active()')) as { id: string }).id
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(600)
      setAgentConsent(true, webWsId)
      browserDriver.navigate(originA)
      await sleep(1500)
      await clickInPage('#login')
      await sleep(1200)
      const actRefA = await refFor('Do the thing')
      // Granted + confirmed click on origin A -> web/ok
      setIntegrationsGrant({ workspaceId: webWsId, writeTools: 'none', web: 'signed-in', actOrigins: [originA] })
      const pending = await act({ verb: 'click', target: actRefA })
      await sleep(400)
      confirmPendingActOrigin(originA)
      await sleep(300)
      const grantedClick = await act({ verb: 'click', target: actRefA })
      const grantedActed = grantedClick.ok && (await pageText()).includes('ACTED')
      // Ungranted origin B -> refused
      browserDriver.navigate(originB)
      await sleep(1500)
      const bRef = await refFor('Log in')
      const refusedClick = await act({ verb: 'click', target: bRef || 'button' })
      const ungrantedRefused = !refusedClick.ok && /ungranted origin/.test(refusedClick.reason ?? '')
      flushTrailForSmoke()
      const webTrail = readTrail(webWsId)
      const trailOkEntry = webTrail.find((t) => t.source === 'web' && t.outcome === 'ok' && t.target === originA)
      const trailRefEntry = webTrail.find((t) => t.source === 'web' && t.outcome === 'refused' && t.target === originB)
      const dOk = !pending.ok && grantedActed && ungrantedRefused && !!trailOkEntry && !!trailRefEntry

      // ══ (e) bridge notify to a loopback receiver; a dead webhook stalls nada ═
      const recvPort = await new Promise<number>((resolve) => {
        receiver.listen(0, '127.0.0.1', () => {
          const a = receiver.address()
          resolve(typeof a === 'object' && a ? a.port : 0)
        })
      })
      const recvBase = `http://127.0.0.1:${recvPort}`
      const saveNotify = saveWebhook({ label: 'integmile-notify', url: `${recvBase}${HOOK_TOKEN}`, events: ['notify'], insecureAck: false })
      saveWebhook({ label: 'integmile-dead', url: 'http://192.0.2.1/hook', events: ['notify'], insecureAck: true })
      const t0 = Date.now()
      emitBridgeEvent('notify', { workspace: wsA.id, pane: a1, note: 'composed' })
      const emitMs = Date.now() - t0
      const notifyDelivered = await waitFor(async () => {
        const got = received.find((r) => r.path === HOOK_TOKEN)
        if (!got) return false
        try {
          const p = JSON.parse(got.body) as { v?: number; event?: string; note?: string }
          return p.v === 1 && p.event === 'notify' && p.note === 'composed'
        } catch {
          return false
        }
      })
      const eOk = saveNotify.ok && emitMs < 250 && notifyDelivered

      // ══ (f) a FAKE PR flips to approved — chip, pane notify, review-changed ══
      // A card owned by a real pane (startOnCard opens a task workspace + binds).
      await ES(`window.__mogging.workspace.create({ name: 'Service', cwd: ${JSON.stringify(mkdtempSync(join(tmpdir(), 'mog-svc-')))} })`)
      await sleep(1500)
      const svcCardId = String(await ES(`window.__mogging.board.createCard('INTEGMILE_PR', 'linked to a fake PR')`))
      await ES(`window.__mogging.board.startOnCard(${JSON.stringify(svcCardId)}, 'shell')`)
      await sleep(3000)
      const svcCard = ((await ES(`window.__mogging.board.list()`)) as { id: string; paneId?: number | null; workspaceId?: string }[]).find(
        (c) => c.id === svcCardId
      )
      const svcPane = svcCard?.paneId ?? 0
      const svcWsId = svcCard?.workspaceId ?? ''
      // A webhook for review-changed, scoped to the card's workspace.
      saveWebhook({ label: 'integmile-review', url: `${recvBase}/review`, events: ['review-changed'], workspaceId: svcWsId, insecureAck: false })
      // The flip adapter + a local engine wired to the SAME sinks services.ts uses.
      let decision: 'review-required' | 'approved' = 'review-required'
      const flip: ServiceAdapter = {
        id: 'fake',
        async detect() {
          return { ok: true }
        },
        async fetch(l: ServiceLink): Promise<LinkStatus> {
          return { linkId: l.id, health: 'fresh', fetchedAt: Date.now(), state: 'open', reviewDecision: decision, checks: 'passing', title: 'Ship the button' }
        }
      }
      const transitions: string[] = []
      const engine = new ServiceEngine({
        adapters: { fake: flip },
        onPush: () => {},
        onTransition: (link, label) => {
          transitions.push(label)
          const card = getSettingsStore()?.getCard(link.cardId) ?? null
          if (card?.paneId != null) getDaemonClient()?.notify(String(card.paneId), 'attention', label)
          emitBridgeEvent('review-changed', { workspace: card?.workspaceId ?? '', card: link.cardId, note: label })
        },
        jitter: () => 0
      })
      const svcLink: ServiceLink = { id: 'lnk_integmile', service: 'fake', cardId: svcCardId, kind: 'pr', ref: 'acme/web#77', cadence: 'manual' }
      engine.setLinks([svcLink])
      await sleep(80) // first fetch (review-required) — NOT a transition
      const chipBefore = engine.statusFor('lnk_integmile')?.reviewDecision === 'review-required'
      decision = 'approved'
      engine.refresh('lnk_integmile')
      await sleep(120)
      const chipFollows = engine.statusFor('lnk_integmile')?.reviewDecision === 'approved'
      const transitionFired = transitions.length === 1 && transitions[0] === 'PR #77: approved'
      const paneNotified = svcPane > 0 && (await waitForPaneAttention(String(svcPane)))
      const reviewDelivered = await waitFor(async () => {
        const got = received.find((r) => r.path === '/review')
        if (!got) return false
        try {
          const p = JSON.parse(got.body) as { event?: string; card?: string; note?: string }
          return p.event === 'review-changed' && p.card === svcCardId && p.note === 'PR #77: approved'
        } catch {
          return false
        }
      })
      const fOk = chipBefore && chipFollows && transitionFired && paneNotified && reviewDelivered

      // ══ Budgets sampled DURING the composed surface (dock open, live panes) ══
      const perf = (await ES(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const gaps = []; let last = performance.now()
        let on = true
        const tick = (now) => { gaps.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        await sleep(1500)
        on = false
        const total = gaps.reduce((a, c) => a + c, 0)
        return {
          maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
          avgFps: Math.round((gaps.length / (total / 1000)) * 10) / 10,
          heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0
        }
      })()`)) as { maxGapMs: number; avgFps: number; heapMB: number }
      const budgetOk = perf.maxGapMs <= BUDGET.maxFrameGapMs && perf.avgFps >= BUDGET.minAvgFps && perf.heapMB <= BUDGET.maxHeapMB

      // ══ (g) structural: approve nowhere; receipt landed; knobs in ONE module ═
      const allFrames = frames.join('\n')
      const noApprove = !allFrames.toLowerCase().includes('approve')
      const knobsModule = join(root, 'src', 'ui', 'features', 'settings', 'integrations.ts')
      const knobsSrc = existsSync(knobsModule) ? readFileSync(knobsModule, 'utf8') : ''
      // ONE home per concern, three homes total since the tab split: the MCP knobs
      // — connect (catalog), scoping (tool-plan), grants, keys — stay wired from
      // integrations.ts; the event bridge renders only from webhooks.ts and the
      // trail viewer only from activity.ts. (Service-links are per-card, not a
      // Settings knob.)
      const webhooksModule = join(root, 'src', 'ui', 'features', 'settings', 'webhooks.ts')
      const webhooksSrc = existsSync(webhooksModule) ? readFileSync(webhooksModule, 'utf8') : ''
      const activityModule = join(root, 'src', 'ui', 'features', 'settings', 'activity.ts')
      const activitySrc = existsSync(activityModule) ? readFileSync(activityModule, 'utf8') : ''
      const knobsInOneModule =
        knobsSrc.length > 0 &&
        /grant/i.test(knobsSrc) && /catalog/i.test(knobsSrc) && /plan/i.test(knobsSrc) &&
        /webhook/i.test(webhooksSrc) && /trail/i.test(activitySrc)
      const gOk = noApprove && receiptAttention && knobsInOneModule

      // ══ (h) the custody sweep: the three secrets, plaintext, NOWHERE ours ════
      // Land the vault key (ciphertext at rest) so its plaintext is a real target.
      const keySet = serviceKeySet(VAULT_NAME, VAULT_SECRET)
      const keyCipher = store?.getSetting(`integrations.vaultkey.${VAULT_NAME}`) ?? ''
      const keyStoredAsCipher = keySet.ok && serviceKeyNames().includes(VAULT_NAME) && keyCipher.length > 0 && !keyCipher.includes(VAULT_SECRET)

      // A stored key is no longer a key every pane gets. It is materialized into a pane's env
      // ONLY where something actually asked for it: an MCP server that REFERENCES ${NAME}, which
      // this workspace's tool plan PLANNED for that pane's CLI (service-keys.ts,
      // referencedServiceKeyNames). Custody is the point of (h), and "who may hold this" is
      // custody — so hold the resolver to BOTH halves: the planned CLI gets the secret, and the
      // plain shell, and any workspace that never planned the server, get nothing at all.
      const keyWsId = 'integmile-scoped-ws'
      const kv: GrantKv | null = store
        ? { get: (key) => store.getSetting(key), set: (key, value) => store.setSetting(key, value) }
        : null
      const serverSaved =
        !!kv &&
        saveServer(kv, {
          id: 'integmile-vault',
          label: 'Integmile vault fixture',
          transport: 'stdio',
          command: 'integmile-mcp',
          env: { [VAULT_NAME]: `\${${VAULT_NAME}}` } // the REFERENCE ships; the value never does
        }).ok
      setToolPlan({ workspaceId: keyWsId, entries: { 'integmile-vault': 'all-clis' }, inheritGlobal: false })
      const keyResolves =
        serverSaved &&
        resolveServiceKeyEnv(keyWsId, 'claude')[VAULT_NAME] === VAULT_SECRET && // planned + referenced
        resolveServiceKeyEnv(keyWsId, 'shell')[VAULT_NAME] === undefined && // a plain shell is not an agent
        resolveServiceKeyEnv(wsA.id, 'claude')[VAULT_NAME] === undefined // a workspace that planned nothing

      const SECRETS = [VAULT_SECRET, HOOK_TOKEN, COOKIE_VAL]
      // Our custody = userData EXCEPT the browser session partitions (the site's
      // OWN cookie jar is theirs) and the big binary caches.
      const SKIP = new Set([
        'Cache', 'GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache', 'ShaderCache', 'GrShaderCache', 'blob_storage', 'Partitions'
      ])
      const offenders: string[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > 9) return
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const name of entries) {
          if (SKIP.has(name)) continue
          const full = join(dir, name)
          let st
          try {
            st = statSync(full)
          } catch {
            continue
          }
          if (st.isDirectory()) walk(full, depth + 1)
          else if (st.isFile() && st.size < 8_000_000) {
            try {
              const body = readFileSync(full, 'latin1')
              for (const s of SECRETS) if (body.includes(s)) offenders.push(`${full} :: ${s.slice(0, 12)}`)
            } catch {
              /* unreadable */
            }
          }
        }
      }
      walk(app.getPath('userData'), 0)
      const atRestClean = offenders.length === 0
      // The frames + every trail carry no secret either.
      const trailJson = JSON.stringify([readTrail(), readTrail(webWsId), readTrail(wsA.id), readTrail(svcWsId)])
      const framesClean = SECRETS.every((s) => !allFrames.includes(s))
      const trailsClean = SECRETS.every((s) => !trailJson.includes(s))
      const hOk = keyStoredAsCipher && keyResolves && atRestClean && framesClean && trailsClean

      const pass = dialectOk && planScopedOk && bOk && cOk && dOk && eOk && fOk && budgetOk && gOk && hOk
      result = {
        pass,
        dialectOk,
        planScopedOk,
        bOk,
        cOk,
        receiptPolled,
        a2Seen,
        dOk,
        eOk,
        fOk,
        budgetOk,
        perf,
        budget: BUDGET,
        gOk,
        noApprove,
        knobsInOneModule,
        hOk,
        offenders: offenders.slice(0, 6),
        transitions,
        emitMs
      }
    } catch (e) {
      result = { pass: false, error: String(e), stack: e instanceof Error ? e.stack : undefined }
    }
    // Cleanup the fixture vault key (leave nothing behind).
    try {
      serviceKeyClear(VAULT_NAME)
    } catch {
      /* best effort */
    }
    for (const c of clients) c.kill()
    for (const s of servers) s.close()
    receiver.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

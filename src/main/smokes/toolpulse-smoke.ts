import { app, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpPreset, ProviderEntry } from '@contracts'
import { MCP_PRESETS, injectProviderEntryForSmoke } from '@backend/features/integrations'
import {
  connect,
  submitKey,
  listConnections,
  sweepConnections,
  verifyConnection,
  verifyStatsForSmoke
} from '../connections'
import { pauseConnectionPulseForSmoke } from '../connection-pulse'
import { setToolPlan } from '../integrations'
import { materializeToolPlanAtLaunch } from '../tool-plan'

// Env-gated LIVE status-engine smoke (MOGGING_TOOLPULSE, phase-tools/03). Boots the REAL
// app and drives the ONE verification engine against a local fixture — zero external
// network, zero real credentials. The knobs (interval / budget / concurrency / jitter /
// pre-launch budget) are accelerated by index.dev.ts BEFORE boot arms the heartbeat.
//
//   (a) HEARTBEAT   — the background pulse re-stamps `verifiedAt` (cause `heartbeat`)
//       on the accelerated interval, twice; then a direct beat with slow probes proves
//       the BUDGET (launches cut, cursor resumes, the next beat covers the rest) and
//       the STAGGER (the fixture's peak concurrent tools/list ≤ the bound).
//   (b) KEY-AUTH    — a key connection with a catalog `verification` block is verified
//       against the provider's own endpoint (the fixture asserts the exact path), and
//       its MCP endpoint is NOT re-probed after connect.
//   (c) PAGE ENTRY  — entering Integrations requests exactly ONE sweep (cause counted).
//   (d) PRE-LAUNCH  — a plan carrying a connected tool verifies BEFORE the env
//       materializes (the fixture sees the probe arrive while no plan file exists) and
//       a 5s-delayed probe does NOT delay the launch past the ~1.5s budget.
//   (e) ATTENTION   — a service that fails FOR REAL raises the app-wide badge while
//       Settings is NOT active; a network-blackholed one NEVER raises; recovery clears.
//
// MUTATION-RED ×2, proven LIVE on every pass (the TOOLCRED pattern):
//   · MOGGING_PULSE_BREAK_OFFLINE — a broken network-down classifier makes the
//     blackholed service raise attention, which is exactly what (e) must catch;
//   · MOGGING_PULSE_BREAK_BUDGET  — a broken budget makes the delayed probe hold the
//     launch for the full probe, which is exactly what (d) must catch.

const SLOW_PROBE_MS = 5000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

type SvcMode = 'ok' | 'err' | 'blackhole'

interface FixtureState {
  latencyMs: number
  modes: Map<string, SvcMode>
  listInflight: number
  listPeak: number
  verifyKeyHits: number
  verifyKeyPaths: string[]
  keyMcpHits: number
  slowMs: number
  planPath: string | null
  planFileExistedAtSlowProbe: boolean | null
}

function startFixture(state: FixtureState): Promise<{ origin: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''
        const p = url.pathname

        // The catalog verification endpoint (b): the provider's own REST probe.
        if (p === '/verify-key') {
          state.verifyKeyHits += 1
          state.verifyKeyPaths.push(p)
          const authz = String(req.headers.authorization ?? '')
          if (authz === 'Bearer key-good') return sendJson(res, 200, { ok: true })
          return sendJson(res, 401, { error: 'bad key' })
        }

        // MCP resources: /svc/<name> (no-auth), /key-mcp (Bearer key-good), /slow-mcp.
        const svc = /^\/svc\/([a-z]+)$/.exec(p)?.[1]
        const isKeyMcp = p === '/key-mcp'
        const isSlow = p === '/slow-mcp'
        if (!svc && !isKeyMcp && !isSlow) return sendJson(res, 404, {})

        const mode: SvcMode = svc ? (state.modes.get(svc) ?? 'ok') : 'ok'
        if (mode === 'blackhole') {
          // The machine-offline shape: the socket dies with no HTTP answer at all.
          req.destroy()
          return
        }
        if (isKeyMcp) {
          state.keyMcpHits += 1
          if (String(req.headers.authorization ?? '') !== 'Bearer key-good') {
            res.writeHead(401).end()
            return
          }
        }
        let msg: { id?: number; method?: string }
        try {
          msg = JSON.parse(body)
        } catch {
          return sendJson(res, 400, {})
        }
        if (msg.method === 'initialize') {
          if (isSlow && state.planPath && state.planFileExistedAtSlowProbe === null) {
            // The ORDER proof for (d): the pre-launch probe arrives before any env
            // materializes — so the plan file must not exist yet.
            state.planFileExistedAtSlowProbe = existsSync(state.planPath)
          }
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: `Fixture-${svc ?? p}` }, capabilities: { tools: {} } }
          })
        }
        if (msg.method === 'notifications/initialized') {
          res.writeHead(202).end()
          return
        }
        if (msg.method === 'tools/list') {
          if (mode === 'err') {
            return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'quota exhausted for this workspace' } })
          }
          const delay = isSlow ? state.slowMs : state.latencyMs
          state.listInflight += 1
          state.listPeak = Math.max(state.listPeak, state.listInflight)
          setTimeout(() => {
            state.listInflight -= 1
            sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', inputSchema: {} }] } })
          }, delay)
          return
        }
        sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [] } })
      })()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })
    })
  })
}

export function runToolPulseSmoke(win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 220000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const stateOf = (id: string) => listConnections().find((c) => c.id === id)
  const waitFor = async (test: () => boolean, tries = 40, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true
      await sleep(gap)
    }
    return test()
  }

  const state: FixtureState = {
    latencyMs: 40,
    modes: new Map(),
    listInflight: 0,
    listPeak: 0,
    verifyKeyHits: 0,
    verifyKeyPaths: [],
    keyMcpHits: 0,
    slowMs: 0,
    planPath: null,
    planFileExistedAtSlowProbe: null
  }

  let result: Record<string, unknown> = { pass: false }
  let fixture: { origin: string; close: () => void } | null = null

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture(state)
      const origin = fixture.origin
      const HEART = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const
      const mk = (id: string, path: string, authKinds: McpPreset['authKinds']): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: `${origin}${path}`,
        authKinds,
        envRefSlots: [],
        cliQuirks: {},
        grantCopy: 'Fixture connection for the TOOLPULSE gate.',
        verifiedAt: '2026-07-24'
      })
      // Fixture presets (test-only push — the CONNLIVE precedent; production
      // MCP_PRESETS is untouched by any shipped code path).
      ;(MCP_PRESETS as McpPreset[]).push(
        ...HEART.map((n) => mk(`pulse-${n}`, `/svc/${n}`, ['none'])),
        mk('pulse-key', '/key-mcp', ['token']),
        // /slow-mcp: no-auth like /svc/*, but its tools/list latency is the separate
        // `slowMs` knob — instant during connect, 5s during the pre-launch phase.
        mk('pulse-slow', '/slow-mcp', ['none'])
      )
      // The catalog row for the key service (b): a declared verification endpoint,
      // injected the way only this gate may (fixture provenance named).
      injectProviderEntryForSmoke({
        id: 'pulse-key',
        label: 'pulse-key',
        source: 'fixture://toolpulse',
        mcp: { transport: 'http', url: `${origin}/key-mcp` },
        methods: [{ key: 'apiKey', kind: 'apiKey', name: 'API key', rank: 1 }],
        verification: { method: 'GET', endpoint: `${origin}/verify-key`, source: 'fixture://toolpulse' }
      } as ProviderEntry)

      // ── Connect the fleet (fast fixture) ────────────────────────────────────
      for (const n of HEART) {
        const r = await connect(`pulse-${n}`)
        if (!r.ok) throw new Error(`connect pulse-${n} refused: ${r.reason}`)
      }
      const slowConn = await connect('pulse-slow')
      if (!slowConn.ok) throw new Error(`connect pulse-slow refused: ${slowConn.reason}`)
      const keyHitsBeforeSubmit = state.verifyKeyHits
      const keyConn = await submitKey('pulse-key', 'key-good')
      if (!keyConn.ok) throw new Error(`submitKey pulse-key refused: ${keyConn.reason}`)
      const proveBeforeSaveHitOk = state.verifyKeyHits === keyHitsBeforeSubmit + 1
      const keyMcpHitsAfterConnect = state.keyMcpHits

      // ── (a-1) the background heartbeat re-stamps verifiedAt on the knob ─────
      const heartbeatStamped = await waitFor(() =>
        HEART.every((n) => {
          const c = stateOf(`pulse-${n}`)
          return c?.state === 'connected' && typeof c.verifiedAt === 'number' && c.verifyCause === 'heartbeat'
        })
      )
      const firstStamp = stateOf('pulse-alpha')?.verifiedAt ?? 0
      const heartbeatRestamped = await waitFor(() => (stateOf('pulse-alpha')?.verifiedAt ?? 0) > firstStamp)

      // The direct phases below measure their own sweeps — hold the pulse still and
      // let any in-flight beat drain.
      pauseConnectionPulseForSmoke(true)
      await sleep(2500)

      // ── (a-2) budget + stagger, deterministically ────────────────────────────
      state.latencyMs = 900
      state.listPeak = 0
      state.listInflight = 0
      const beat1 = await sweepConnections('heartbeat', { cursor: 0 })
      const budgetCutOk = beat1.stoppedForBudget && !beat1.coveredAll && beat1.launched.length < 7
      const beat2 = await sweepConnections('heartbeat', { cursor: beat1.nextCursor })
      const covered = new Set([...beat1.launched, ...beat2.launched])
      const cursorResumeOk = covered.size === 7 // two beats together reach every connection
      const maxConc = Number(process.env.MOGGING_PULSE_MAXCONC ?? '2')
      const staggerOk = state.listPeak > 0 && state.listPeak <= maxConc
      state.latencyMs = 40

      // ── (b) key-auth verified via the catalog verification endpoint ─────────
      const keyHitsBefore = state.verifyKeyHits
      const keyBefore = stateOf('pulse-key')?.verifiedAt ?? 0
      await verifyConnection('pulse-key', 'manual')
      const keyAfter = stateOf('pulse-key')
      const keyVerifyOk =
        state.verifyKeyHits === keyHitsBefore + 1 &&
        state.verifyKeyPaths.every((x) => x === '/verify-key') &&
        (keyAfter?.verifiedAt ?? 0) > keyBefore &&
        keyAfter?.verifyCause === 'manual' &&
        keyAfter?.state === 'connected' &&
        // The MCP endpoint was NOT re-probed after connect: every verification of a
        // key service with a catalog block rides the declared endpoint instead.
        state.keyMcpHits === keyMcpHitsAfterConnect
      const catalogPathHitOk = proveBeforeSaveHitOk && keyVerifyOk

      // ── (c) page entry = one sweep exactly ──────────────────────────────────
      // Fresh userData → Settings opens on 'appearance'; the integrations tab click
      // is the ONE entry. (Counters are SWEEPS by cause, not per-connection probes.)
      const sweepsBefore = verifyStatsForSmoke().sweeps['page-entry']
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1200)
      const sweepsAfterEntry = verifyStatsForSmoke().sweeps['page-entry']
      const pageEntryOnceOk = sweepsAfterEntry === sweepsBefore + 1
      // Leave Settings — (e) must observe the badge while Settings is NOT active.
      await ES(`(document.querySelector('.settings-back')?.click(), 1)`)
      await sleep(400)

      // ── (e) attention: real failure raises, blackhole never, recovery clears ──
      state.modes.set('alpha', 'err') // reached-and-refused: a REAL failure
      state.modes.set('bravo', 'blackhole') // the machine-offline shape: says nothing
      await sweepConnections('heartbeat', { cursor: 0 })
      const stats1 = verifyStatsForSmoke()
      const raisedOk = stats1.failing.includes('pulse-alpha')
      const blackholeQuietOk = !stats1.failing.includes('pulse-bravo')
      const alphaAfterFail = stateOf('pulse-alpha')
      // The no-downgrade law under the heartbeat: reached-and-refused NEVER un-connects.
      const noDowngradeOk = alphaAfterFail?.state === 'connected'
      const bravoAfterHole = stateOf('pulse-bravo')
      // Offline says nothing: no state flip, no verifyCause churn, stamp untouched.
      const offlineSaysNothingOk = bravoAfterHole?.state === 'connected'
      const settingsInactiveOk = await ES<boolean>(`!document.querySelector('#app.view-settings')`)
      const badgeShownOk = await ES<boolean>(
        `(() => { const f = document.querySelector('.rail-conn-attn-footer'); const d = document.querySelector('.connattn-dot'); return !!f && !f.hidden && !!d && !d.hidden })()`
      )
      // Recovery clears the edge.
      state.modes.set('alpha', 'ok')
      state.modes.set('bravo', 'ok')
      await sweepConnections('heartbeat', { cursor: 0 })
      const clearedOk = verifyStatsForSmoke().failing.length === 0
      const badgeClearedOk = await ES<boolean>(
        `(() => { const f = document.querySelector('.rail-conn-attn-footer'); return !!f && f.hidden })()`
      )

      // ── MUTATION-RED 1: break the network-down classifier → (e) must red ─────
      state.modes.set('bravo', 'blackhole')
      process.env.MOGGING_PULSE_BREAK_OFFLINE = '1'
      await sweepConnections('heartbeat', { cursor: 0 })
      const mutationOfflineRed = verifyStatsForSmoke().failing.includes('pulse-bravo')
      delete process.env.MOGGING_PULSE_BREAK_OFFLINE
      state.modes.set('bravo', 'ok')
      await sweepConnections('heartbeat', { cursor: 0 }) // recovery clears the mutation's alarm
      const mutationCleanupOk = verifyStatsForSmoke().failing.length === 0

      // ── (d) pre-launch: verify before env, launch never waits past budget ────
      const scratch = mkdtempSync(join(tmpdir(), 'toolpulse-'))
      setToolPlan({ workspaceId: 'ws-pulse', entries: { 'pulse-slow': 'all-clis' }, inheritGlobal: false })
      state.planPath = join(app.getPath('userData'), 'toolplans', 'plan-ws-pulse-claude-code.json')
      state.planFileExistedAtSlowProbe = null
      state.slowMs = SLOW_PROBE_MS
      const preBefore = verifyStatsForSmoke().causes['pre-launch']
      const t0 = Date.now()
      const launch = await materializeToolPlanAtLaunch({ agentId: 'claude', cwd: scratch, workspaceId: 'ws-pulse' })
      const launchMs = Date.now() - t0
      const budgetMs = Number(process.env.MOGGING_PRELAUNCH_BUDGET_MS ?? '1500')
      const preLaunchRanOk = verifyStatsForSmoke().causes['pre-launch'] === preBefore + 1
      const launchWithinBudgetOk = launch.ok && launchMs < budgetMs + 2000 && launchMs < SLOW_PROBE_MS - 500
      const verifyBeforeEnvOk = state.planFileExistedAtSlowProbe === false
      await sleep(SLOW_PROBE_MS + 500) // let the straggling probe land as status

      // ── MUTATION-RED 2: break the budget → (d) must red ──────────────────────
      state.planFileExistedAtSlowProbe = null
      process.env.MOGGING_PULSE_BREAK_BUDGET = '1'
      const t1 = Date.now()
      await materializeToolPlanAtLaunch({ agentId: 'claude', cwd: scratch, workspaceId: 'ws-pulse' })
      const mutatedMs = Date.now() - t1
      delete process.env.MOGGING_PULSE_BREAK_BUDGET
      const mutationBudgetRed = mutatedMs >= SLOW_PROBE_MS - 500

      result = {
        pass:
          proveBeforeSaveHitOk &&
          heartbeatStamped &&
          heartbeatRestamped &&
          budgetCutOk &&
          cursorResumeOk &&
          staggerOk &&
          catalogPathHitOk &&
          pageEntryOnceOk &&
          raisedOk &&
          blackholeQuietOk &&
          noDowngradeOk &&
          offlineSaysNothingOk &&
          settingsInactiveOk &&
          badgeShownOk &&
          clearedOk &&
          badgeClearedOk &&
          mutationOfflineRed &&
          mutationCleanupOk &&
          preLaunchRanOk &&
          launchWithinBudgetOk &&
          verifyBeforeEnvOk &&
          mutationBudgetRed,
        heartbeatStamped,
        heartbeatRestamped,
        budgetCutOk,
        cursorResumeOk,
        staggerOk,
        proveBeforeSaveHitOk,
        keyVerifyOk,
        pageEntryOnceOk,
        raisedOk,
        blackholeQuietOk,
        noDowngradeOk,
        offlineSaysNothingOk,
        settingsInactiveOk,
        badgeShownOk,
        clearedOk,
        badgeClearedOk,
        mutationOfflineRed,
        mutationCleanupOk,
        preLaunchRanOk,
        launchWithinBudgetOk,
        verifyBeforeEnvOk,
        mutationBudgetRed,
        observed: {
          beat1: { launched: beat1.launched.length, stoppedForBudget: beat1.stoppedForBudget, peak: state.listPeak },
          beat2: { launched: beat2.launched.length },
          launchMs,
          mutatedMs,
          verifyKeyHits: state.verifyKeyHits,
          keyMcpHits: state.keyMcpHits,
          stats: verifyStatsForSmoke()
        }
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      fixture?.close()
    } catch {
      /* already closing */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'toolpulse-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

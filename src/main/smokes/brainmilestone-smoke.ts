import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTelemetry } from '@backend'
import {
  BRAIN_DRAIN_QUIET_MS,
  distillHttpAttemptsForSmoke,
  embedHttpAttemptsForSmoke,
  serializeMemory
} from '@backend/features/brain'
import {
  DAEMON_PROTOCOL_VERSION,
  MCP_BRAIN_WRITE_TOOL_NAMES,
  MCP_MEMORY_WRITE_TOOL_NAMES,
  type Telemetry
} from '@contracts'
import { getSettingsStore } from '../app-settings'
import { brainDebug, handleBrainRebuild, handleBrainStatus, setEmbedTarget, setSemanticAllowed } from '../brain'
import { runtimeDir } from '../daemon-client'
import { setIntegrationsGrant } from '../integrations'
import { flushTrailForSmoke, readTrail } from '../trail'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// ── THE PHASE-12 MILESTONE (MOGGING_BRAINMILESTONE) ──────────────────────────
// The pack's ONLY authority on "Phase 12 done". Everything the fourteen steps
// promised, in ONE composed run, on ONE fixture world — a real 5k-file git repo
// with TWO linked worktrees, real shell panes, real board launches, the REAL
// `bin/mogging-mcp.mjs` driven from inside the launched pane. Zero real
// network (spied); the daemon untouched (endpoint version equal before/after).
// Nothing here is new machinery: every arm composes what a step gate already
// owns in isolation.
//
//   (a) the repo + TWO worktrees index once: the siblings' parse-cache
//       hit-rate ≥ 90% (identical bytes parse ONCE), partitions disjoint;
//   (b) a board card launches a REAL agent-shaped pane with orientAtLaunch ON
//       → the first prompt opens with the repomap (captured through `mogging
//       capture`, the human's own eyes), generation-stamped;
//   (c) THAT pane answers find_symbol → get_neighbors → shortest_path on
//       hand-derived fixture truth, over real MCP;
//   (d) a real shell pane appends a function → within ≤ 2 ticks the node is
//       queryable through the tool and dirty settles to 0 — polled, never
//       slept;
//   (e) a granted replace_symbol_body lands atomically → the NEXT query sees
//       the new node; a stale retry refuses carrying the fresh hash and the
//       disk stays untouched; the trail counts every write, landed or refused;
//   (f) get_library_docs answers the dep at its lockfile-pinned version,
//       OFFLINE — docs from the bytes on disk, source stamped;
//   (g) create_memory in checkout A + a REAL git merge → found from B's own
//       pane session, root-labeled B;
//   (h) the cipher arc, end to end: a REAL scripted pane's fail→fix OSC 133
//       session auto-drafts at session end; a granted promote lands it as
//       team truth; the NEXT board launch injects it (the recall section
//       captured, attribution-stamped); and with FAKE-embedder consent a
//       vocabulary-DISJOINT query finds it — labeled probabilistic — while
//       exact search honestly misses;
//   (i) the perf claim: DURING a forced full re-index of the ~5k-file fixture
//       with 16 live panes, the docs/05 + docs/07 budgets hold (worst rAF gap,
//       long frames, heap) — worker isolation measured, not asserted — and a
//       round-trip echo proves pane responsiveness under load;
//   (j) ADR 0005: the telemetry recorded for the WHOLE run carries zero
//       fixture paths, symbol names, or memory text (a recording adapter sat
//       on the port from the first byte);
//   (k) custody: before the grant, the write verbs are absent AND forced
//       calls refuse — zero writes happen; the embed/distill HTTP spies read
//       zero (no real-net socket ever); the daemon protocol number is equal
//       before and after.
// Verdict: out/brainmilestone-result.json.

const BUDGET = { maxFrameGapMs: 150, maxLongFrames100: 0, minAvgFps: 30, maxHeapMB: 300 }
const TICK_MS = 2500

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const fold = (p: string): string => p.replace(/\//g, '\\').toLocaleLowerCase('en-US')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ── (e)'s hand-known write truth (the brainwrite rules, fixture-local names) ─
const TARGET_BEFORE = 'export function mzAlpha(): number {\n  return 1\n}\n\nexport function mzOmega(): number {\n  return 2\n}\n'
const ALPHA_BODY = 'export function mzAlpha(): number {\n  const x = 40\n  return x + 2\n}\n'
const TARGET_AFTER = ALPHA_BODY + '\nexport function mzOmega(): number {\n  return 2\n}\n'

// ── (f)'s library fixture (the braindocs shape, one dep) ─────────────────────
const ACME_README = '# acme-lib\n\nIntro.\n\n## Usage\n\nACME_USAGE_7100 call acmeGreet.\n'
const ACME_DTS = 'export declare function acmeGreet(name: string): string\n'

// ── (g)/(h)'s memory seeds. No seed shares a trigram with the (h4) probe
//    'flumoxed' — the semantic find must be the promoted arc draft, not an
//    accident of vocabulary. ─────────────────────────────────────────────────
const QUATERNION = serializeMemory({
  slug: 'quaternion-panes',
  description: 'How the quaternion pane arithmetic packs ids',
  tags: ['arithmetic'],
  body: 'The quaternion pack maps pane ids. See [[gear-rules]].\n'
})
const GEAR = serializeMemory({
  slug: 'gear-rules',
  description: 'The gear rules ledger',
  tags: ['arithmetic'],
  body: 'Gear ledger notes. Back to [[quaternion-panes]].\n'
})

// ── (h1)'s scripted arc: REAL OSC 133 marks through the REAL PTY — fail
//    (exit 1), retry verbatim, fix (exit 0). The braincap vocabulary. ─────────
const ARC_COMMAND = 'node flumox-probe.mjs'
const ARC_SOURCE =
  `const w = (s) => process.stdout.write(s)\n` +
  `const OSC = (s) => '\\x1b]133;' + s + '\\x07'\n` +
  `w(OSC('A') + OSC('B') + ${JSON.stringify(ARC_COMMAND)} + OSC('C') + '\\r\\n')\n` +
  `w('flumox exploding\\r\\n')\n` +
  `w(OSC('D;1'))\n` +
  `w(OSC('A') + OSC('B') + ${JSON.stringify(ARC_COMMAND)} + OSC('C') + '\\r\\n')\n` +
  `w('flumox fixed\\r\\n')\n` +
  `w(OSC('D;0'))\n`

// ~5k files: the hand-truth shapes (the 03 fixture, verbatim) + a generated
// field that makes the perf claim mean something.
const GLOB_FILES = 5010

const HAND_FIXTURE: Record<string, string> = {
  'tsconfig.json': `{\n  "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"] } }\n}\n`,
  '.gitignore': 'node_modules/\n',
  'src/lib/util.ts': `export function tally(): number {\n  return 1\n}\n`,
  'src/alpha.ts': `import { tally } from '@lib/util'\nimport { readFileSync } from 'fs'\n\nexport class Base {}\nexport interface Zeta {}\n\nexport function alpha(): number {\n  readFileSync('x')\n  return tally()\n}\n`,
  'src/gamma.ts': `import { Base, Zeta } from './alpha'\n\nexport class Gamma extends Base implements Zeta {\n  run(): number {\n    return compute()\n  }\n}\n\nfunction compute(): number {\n  return 2\n}\n`,
  'src/target.ts': TARGET_BEFORE,
  'mut.ts': `export function mut(): number {\n  return 1\n}\n`,
  'package.json': JSON.stringify({ name: 'brainms-fixture', dependencies: { 'acme-lib': '^1.0.0' } }),
  'package-lock.json': JSON.stringify(
    {
      name: 'brainms-fixture',
      lockfileVersion: 3,
      packages: { '': { name: 'brainms-fixture' }, 'node_modules/acme-lib': { version: '1.2.3' } }
    },
    null,
    2
  ),
  'node_modules/acme-lib/package.json': JSON.stringify({ name: 'acme-lib', version: '1.2.3', types: 'index.d.ts' }),
  'node_modules/acme-lib/README.md': ACME_README,
  'node_modules/acme-lib/index.d.ts': ACME_DTS,
  '.memory/quaternion-panes.md': QUATERNION,
  '.memory/gear-rules.md': GEAR
}

interface Fixture {
  base: string
  repo: string
  wt1: string
  wt2: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainms-')))
  const repo = join(base, 'repo')
  for (const [rel, src] of Object.entries(HAND_FIXTURE)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), src)
  }
  // The field: one def per file, unique names, nothing colliding with the
  // hand truth. This is what makes "full re-index under load" a real claim.
  mkdirSync(join(repo, 'field'))
  for (let i = 0; i < GLOB_FILES; i++) {
    writeFileSync(join(repo, 'field', `f${String(i).padStart(4, '0')}.ts`), `export function fld${i}(): number {\n  return ${i}\n}\n`)
  }
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  // autocrlf OFF: the (a) claim is the cache on IDENTICAL bytes across
  // checkouts — a CRLF rewrite would be an honest miss and a dishonest gate.
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])
  mkdirSync(join(repo, '.mogging'), { recursive: true })
  writeFileSync(join(repo, '.mogging', '.gitignore'), '*\n')
  const wt1 = join(repo, '.mogging', 'worktrees', 'wt1')
  const wt2 = join(repo, '.mogging', 'worktrees', 'wt2')
  git(repo, ['worktree', 'add', wt1, '-b', 'mogging/ms-wt1'])
  git(repo, ['worktree', 'add', wt2, '-b', 'mogging/ms-wt2'])
  // The REAL panes' tools, OUTSIDE every checkout (.mjs would become rows).
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'append') appendFileSync(${JSON.stringify(join(repo, 'mut.ts'))}, '\\nexport function freshface(): number {\\n  return 5\\n}\\n')\n`
  )
  writeFileSync(join(base, 'arc.mjs'), ARC_SOURCE)
  return { base, repo, wt1, wt2 }
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

type NodeHit = { id: string; kind: string; name: string; file: string; startLine: number; endLine: number; root?: string }
type MemHit = { slug: string; probabilistic?: boolean; provider?: string; model?: string }

export function runBrainMilestoneSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainmilestone-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (existsSync(resultFile)) {
    app.exit(0)
    return
  }
  const write = (o: object): void => {
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: brainmilestone smoke did not complete' })
    app.exit(1)
  }, 420000)

  // (j)'s witness: a recorder on the PORT for the whole run — every event,
  // breadcrumb, and context any code path emits lands here for the final scan.
  const telemetryCalls: string[] = []
  const recorder: Telemetry = {
    init: () => undefined,
    captureError: (error, context) => void telemetryCalls.push(JSON.stringify({ error: String(error), context })),
    captureEvent: (event) => void telemetryCalls.push(JSON.stringify(event)),
    addBreadcrumb: (crumb) => void telemetryCalls.push(JSON.stringify(crumb)),
    setContext: (key, value) => void telemetryCalls.push(JSON.stringify({ key, value })),
    flush: () => Promise.resolve()
  }
  setTelemetry(recorder)

  const wc = win.webContents
  wc.setBackgroundThrottling(false) // (i) measures OUR main thread, not the compositor's scheduling
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const runStart = Date.now()

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 20000, windowsHide: true },
        (err, stdout) => res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

  const call = async (c: PaneMcpSmokeClient, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const m = await c.rpc('tools/call', { name, arguments: args })
    if (m.error) return { ok: false, isError: false, rpcError: m.error.message ?? 'error', text: '', data: {} }
    const r = (m.result ?? {}) as { content?: { text?: string }[]; isError?: boolean }
    const text = r.content?.[0]?.text ?? ''
    let data: Record<string, unknown> = {}
    if (r.isError !== true) {
      try {
        data = JSON.parse(text) as Record<string, unknown>
      } catch {
        /* non-JSON success payloads keep data empty */
      }
    }
    return { ok: r.isError !== true, isError: r.isError === true, rpcError: null, text, data }
  }

  const hits = (a: ToolAnswer, key: string): NodeHit[] => (Array.isArray(a.data[key]) ? (a.data[key] as NodeHit[]) : [])
  const mems = (a: ToolAnswer): MemHit[] => (Array.isArray(a.data.memories) ? (a.data.memories as MemHit[]) : [])

  // Capture is the HUMAN'S eyes on the pane, and cmd.exe re-echoes wrapped
  // input with cursor jumps and OVERLAP fragments at the wrap column — a
  // needle can exist on screen yet never as contiguous bytes ("session-3-" +
  // CSI + "-node"). Strip the escapes, then match the needle's characters in
  // order with a small tolerated gap between each pair — reflow-proof, still
  // order-exact.
  const OSC_RE = new RegExp(String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`, 'g')
  const CSI_RE = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, 'g')
  const stripAnsi = (s: string): string => s.replace(OSC_RE, '').replace(CSI_RE, '').replace(/[\r\n]/g, '')
  const wrapTolerant = (needle: string): RegExp =>
    new RegExp(
      needle
        .split('')
        .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^]{0,6}?')
    )
  const seen = (flat: string, needle: string): number => {
    const m = wrapTolerant(needle).exec(flat)
    return m ? m.index : -1
  }

  const until = async (pred: () => boolean | Promise<boolean>, capMs: number, stepMs = 300): Promise<{ ok: boolean; ms: number }> => {
    const t0 = Date.now()
    for (;;) {
      if (await pred()) return { ok: true, ms: Date.now() - t0 }
      if (Date.now() - t0 > capMs) return { ok: false, ms: Date.now() - t0 }
      await sleep(stepMs)
    }
  }

  /** The daemon endpoint's live protocol claim — (k)'s before/after witness. */
  const endpointVersion = (): number => {
    try {
      const ep = JSON.parse(readFileSync(join(runtimeDir(), 'endpoint.json'), 'utf8')) as { version?: number }
      return typeof ep.version === 'number' ? ep.version : -1
    } catch {
      return -1
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      fx = makeFixture()
      const F = fx
      const protoBefore = endpointVersion()
      await sleep(1500)

      // ── The world: workspace A on the repo (pane 1 = A's MCP bridge, pane 2
      //    = the ops shell, pane 3 = the arc pane), workspace B on worktree 1
      //    (pane 1 = B's bridge). ─────────────────────────────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'BrainMS', cwd: ${JSON.stringify(F.repo)}, paneCount: 3 })`)
      await sleep(4500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneBridge = String(wsA.ordinal * 100 + 1)
      const paneOps = String(wsA.ordinal * 100 + 2)
      const paneArc = wsA.ordinal * 100 + 3
      await ES(`window.__mogging.workspace.create({ name: 'BrainMS-B', cwd: ${JSON.stringify(F.wt1)}, paneCount: 1 })`)
      await sleep(3500)
      const wsB = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneB1 = String(wsB.ordinal * 100 + 1)
      await ES(`window.__mogging.workspace.switchByIndex(0)`)
      await sleep(800)

      // ── (a) index once: main cold, both siblings ≥ 90% cache hits ──────────
      const coldT0 = Date.now()
      const bMain = await handleBrainRebuild({ root: F.repo })
      if (!bMain.ok) throw new Error('main rebuild refused: ' + JSON.stringify(bMain))
      const coldIndexMs = Date.now() - coldT0
      const b1 = await handleBrainRebuild({ root: F.wt1 })
      const b2 = await handleBrainRebuild({ root: F.wt2 })
      if (!b1.ok || !b2.ok) throw new Error('sibling rebuild refused: ' + JSON.stringify({ b1, b2 }))
      const rate = (a: { cacheHits: number; cacheMisses: number }): number =>
        a.cacheHits + a.cacheMisses ? a.cacheHits / (a.cacheHits + a.cacheMisses) : 0
      const wt1Rate = rate(b1)
      const wt2Rate = rate(b2)
      const filesPerCheckout = bMain.files
      const indexOnceOk =
        bMain.cacheMisses === bMain.files && bMain.cacheHits === 0 && // cold: every byte paid for once…
        filesPerCheckout >= 5000 &&
        wt1Rate >= 0.9 && wt2Rate >= 0.9 && // …and the siblings ride the cache
        b2.files === filesPerCheckout * 3 // three partitions, one db

      // ── A's bridge: the REAL server inside a repo-checkout pane. Custody,
      //    freshness, writes, docs, and memory all speak through THIS session —
      //    its own checkout is the repo, which is what the write wall scopes to.
      const cA = await spawnPaneMcpSmokeClient({ cli, paneId: paneBridge, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(cA)
      await cA.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (k-first) custody: no grant → write verbs absent, forced calls
      //    refuse, zero bytes move ─────────────────────────────────────────────
      const served = (((await cA.rpc('tools/list')).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)
      const WRITES = [...MCP_BRAIN_WRITE_TOOL_NAMES, ...MCP_MEMORY_WRITE_TOOL_NAMES] as string[]
      const forcedWrite = await call(cA, 'replace_symbol_body', { id: 'f'.repeat(40), expectedFileHash: 'a'.repeat(64), body: 'nope' })
      const forcedMem = await call(cA, 'create_memory', { name: 'nope', description: 'x', body: 'x' })
      const grantWallOk =
        served.includes('find_symbol') && // reads stay free…
        served.every((n) => !WRITES.includes(n)) && // …writes are not even visible
        !!forcedWrite.rpcError && /grant/i.test(forcedWrite.rpcError) &&
        !!forcedMem.rpcError && /grant/i.test(forcedMem.rpcError) &&
        readFileSync(join(F.repo, 'src', 'target.ts'), 'utf8') === TARGET_BEFORE // zero writes happened

      // ── (b) a board card launches a REAL agent-shaped pane, map injected ───
      // The replay must OUTWAIT the creation lineup's 900ms timer: a detection
      // landing inside that window is recorded as the slot's manifest
      // assignment (noteAgentLaunch), and the still-pending lineup then reads
      // the LIVE array and types a REAL `claude` into the pane — whose TUI
      // takes the alternate screen and wipes the composed prompt. The step
      // gates replay later by accident of their polling; the milestone waits
      // on purpose. (Recorded as a platform find in the pack freeze.)
      const confirmAgentUp = async (paneId: number): Promise<void> => {
        await sleep(1600)
        await ES(`window.__mogging.agents.detected({ id: ${paneId}, agentId: 'claude', cwd: ${JSON.stringify(F.repo)}, sinceMs: Date.now() })`)
      }
      const paneOf = async (cardId: string): Promise<number> => {
        const bound = await until(() => getSettingsStore()?.getCard(cardId)?.paneId != null, 25000)
        const pane = getSettingsStore()?.getCard(cardId)?.paneId
        if (!bound.ok || pane == null) throw new Error(`card ${cardId} never bound a pane`)
        return pane
      }
      const captureHas = async (pane: number, needle: string, capMs = 30000): Promise<string> => {
        let last = ''
        const got = await until(async () => {
          const c = await cli(['capture', String(pane), '--lines', '400'])
          last = c.stdout
          return c.code === 0 && wrapTolerant(needle).test(stripAnsi(last))
        }, capMs, 700)
        if (!got.ok) throw new Error(`pane ${pane} capture never showed ${needle} — tail=${JSON.stringify(last.slice(-400))}`)
        return last
      }

      const card1 = (await ES(
        `window.__mogging.board.createCard('BRAINMS_TASK_7100', 'BRAINMS_TASK_7100 tighten the gear coupling')`
      )) as string
      const started1 = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(card1)}, 'shell')`)) as boolean
      const paneL1 = await paneOf(String(card1))
      await confirmAgentUp(paneL1)
      const cap1 = await captureHas(paneL1, 'BRAINMS_TASK_7100')
      const cap1Flat = stripAnsi(cap1)
      const mapFenceAt = seen(cap1Flat, '```repomap')
      const mapStampAt = seen(cap1Flat, '[repomap: generation')
      const taskAt = seen(cap1Flat, 'BRAINMS_TASK_7100')
      const launchOk =
        started1 &&
        mapFenceAt >= 0 &&
        mapStampAt > mapFenceAt && // generation-stamped, visibly
        taskAt > mapFenceAt // the map opens the prompt; the task follows it

      // ── The launched pane's OWN client: the REAL server inside the pane the
      //    card started. Its checkout is the launch worktree, so it reads the
      //    project under scope:'project' — every hit root-labeled. ────────────
      const cLaunch = await spawnPaneMcpSmokeClient({ cli, paneId: String(paneL1), mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(cLaunch)
      await cLaunch.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (c) fixture truth from THAT pane: find_symbol → get_neighbors →
      //    shortest_path, project-scoped, anchored on the repo partition ──────
      const projGamma = await call(cLaunch, 'find_symbol', { name: 'Gamma', scope: 'project' })
      const gamma = hits(projGamma, 'matches').find((n) => fold(String(n.root ?? '')) === fold(F.repo))
      const projTally = await call(cLaunch, 'find_symbol', { name: 'tally', scope: 'project' })
      const tally = hits(projTally, 'matches').find((n) => fold(String(n.root ?? '')) === fold(F.repo))
      const nb = await call(cLaunch, 'get_neighbors', { id: gamma?.id ?? '', direction: 'both', scope: 'project' })
      const nbRows = (nb.data.neighbors ?? []) as { node: NodeHit; edge: { kind: string; direction: string } }[]
      const path3 = await call(cLaunch, 'shortest_path', { from: gamma?.id ?? '', to: tally?.id ?? '', scope: 'project' })
      const graphTruthOk =
        projGamma.ok &&
        !!gamma && gamma.kind === 'class' && gamma.file === 'src/gamma.ts' && gamma.startLine === 3 &&
        nb.ok &&
        nbRows.some((r) => r.node.name === 'Base' && r.edge.kind === 'extends' && r.edge.direction === 'out') &&
        nbRows.some((r) => r.node.name === 'Zeta' && r.edge.kind === 'implements' && r.edge.direction === 'out') &&
        path3.ok && path3.data.found === true && path3.data.depth === 3 &&
        (path3.data.nodes as unknown[]).length === 4
      // (a)'s partition-disjointness, through the same wire: every indexed
      // checkout is its own labeled home for the symbol, ids never shared. The
      // board launch mints worktrees of its own, so ≥ 3 — the three we built
      // must each be present, distinctly.
      const projRoots = hits(projGamma, 'matches').map((n) => fold(String(n.root ?? '')))
      const projIds = new Set(hits(projGamma, 'matches').map((n) => n.id))
      const partitionsOk =
        projGamma.ok && projRoots.length >= 3 && projIds.size === projRoots.length &&
        projRoots.includes(fold(F.repo)) && projRoots.includes(fold(F.wt1)) && projRoots.includes(fold(F.wt2))

      // ── (d) a REAL shell appends a function → ≤ 2 ticks, dirty settles 0 ───
      // The board launch just minted a worktree whose partition may reconcile
      // in the background — start the freshness clock from a SETTLED world, or
      // the measurement charges the tick with someone else's work.
      await until(async () => {
        const s = await call(cA, 'brain_status')
        return s.ok && s.data.dirty === false && (s.data.status as { indexing?: boolean } | undefined)?.indexing !== true
      }, 60000, 500)
      const st0 = await call(cA, 'brain_status')
      const gen0 = st0.data.generation as number
      const sent = await cli(['send', paneOps, 'node ../ops.mjs append'])
      if (sent.code !== 0) throw new Error('could not drive the ops pane')
      const freshBudgetMs = 2 * TICK_MS + BRAIN_DRAIN_QUIET_MS
      const appeared = await until(async () => {
        const s = await call(cA, 'brain_status')
        return s.ok && (s.data.generation as number) > gen0 && s.data.dirty === false
      }, freshBudgetMs + 6000, 250)
      const freshSym = await call(cA, 'find_symbol', { name: 'freshface' })
      const freshOk =
        appeared.ok && appeared.ms <= freshBudgetMs + 1500 && // ≤ 2 ticks + the quiet window (+ poll grain)
        freshSym.ok && hits(freshSym, 'matches').length === 1 && hits(freshSym, 'matches')[0].file === 'mut.ts'

      // ── (e) the granted write: atomic landing, next-query truth, stale
      //    retry refused with the fresh hash ──────────────────────────────────
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const grantVisible = await until(async () => {
        const names = (((await cA.rpc('tools/list')).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)
        return WRITES.every((n) => names.includes(n))
      }, 15000)
      const symAlpha = await call(cA, 'find_symbol', { name: 'mzAlpha' })
      const alpha = hits(symAlpha, 'matches')[0]
      const nodeAlpha = await call(cA, 'get_node', { id: alpha?.id ?? '' })
      const hash0 = String(nodeAlpha.data.fileHash ?? '')
      const replaced = await call(cA, 'replace_symbol_body', { id: alpha?.id ?? '', expectedFileHash: hash0, body: ALPHA_BODY })
      const diskAfter = readFileSync(join(F.repo, 'src', 'target.ts'))
      const omegaNow = await call(cA, 'find_symbol', { name: 'mzOmega' }) // the NEXT query — no wait
      const writeOk =
        grantVisible.ok &&
        hash0 === sha256(TARGET_BEFORE) && // the CAS handshake's truth is the disk's
        replaced.ok &&
        diskAfter.equals(Buffer.from(TARGET_AFTER, 'utf8')) &&
        omegaNow.ok && hits(omegaNow, 'matches')[0]?.startLine === 6 // the shifted truth, already served
      const staleRetry = await call(cA, 'replace_symbol_body', { id: alpha?.id ?? '', expectedFileHash: hash0, body: ALPHA_BODY })
      const staleOk =
        staleRetry.isError &&
        /stale|changed/.test(staleRetry.text) &&
        staleRetry.text.includes(sha256(TARGET_AFTER)) && // the fresh truth rides the refusal
        readFileSync(join(F.repo, 'src', 'target.ts')).equals(diskAfter) // refused = untouched

      // ── (f) library docs at the pinned version, OFFLINE ────────────────────
      const docs = await call(cA, 'get_library_docs', { name: 'acme-lib' })
      const docsOk =
        docs.ok &&
        docs.data.version === '1.2.3' && // the lockfile's pin, not a guess
        docs.data.source === 'disk' && // the bytes on disk, no socket
        String(docs.data.readme ?? '').includes('ACME_USAGE_7100') &&
        JSON.stringify(docs.data).includes('acmeGreet')

      // ── (g) create_memory in A + REAL git merge → found from B ─────────────
      const created = await call(cA, 'create_memory', {
        name: 'merge-carried-note',
        description: 'Carried home by git',
        body: 'The zanzibar seam sits here.\n',
        tags: 'ops'
      })
      git(F.repo, ['add', '-A'])
      git(F.repo, ['commit', '-m', 'memories from checkout A'])
      git(F.wt1, ['merge', 'main'])
      const cB = await spawnPaneMcpSmokeClient({ cli, paneId: paneB1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(cB)
      await cB.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      let mergedHit: MemHit | undefined
      const merged = await until(async () => {
        const found = await call(cB, 'search_memories', { query: 'zanzibar' })
        mergedHit = mems(found)[0]
        return !!mergedHit && mergedHit.slug === 'merge-carried-note' && fold(String((mergedHit as { root?: string }).root ?? '')) === fold(F.wt1)
      }, 4 * TICK_MS + 15000, 700)
      const mergeOk = created.ok && merged.ok

      // ── (h) the cipher arc ─────────────────────────────────────────────────
      // (h1) the fail→fix session auto-drafts at session end.
      const draftsDir = join(F.repo, '.memory', 'drafts')
      const draftFiles = (): string[] => {
        try {
          return readdirSync(draftsDir).sort()
        } catch {
          return []
        }
      }
      const arcSent = await cli(['send', String(paneArc), 'node ../arc.mjs'])
      if (arcSent.code !== 0) throw new Error('could not drive the arc pane')
      const paneBlocks = `(() => { const p = (window.__mogging.panes || []).find((x) => x.id === ${paneArc}); return p ? p.blocks() : [] })()`
      const arcTracked = await until(async () => {
        const blocks = (await ES<{ command: string; exitCode?: number }[]>(paneBlocks)) ?? []
        const runs = blocks.filter((b) => b.command === ARC_COMMAND)
        return runs.length >= 2 && runs.some((b) => b.exitCode === 1) && runs.some((b) => b.exitCode === 0)
      }, 30000, 500)
      if (!arcTracked.ok) throw new Error('the arc pane never tracked its blocks')
      await cli(['send', String(paneArc), 'exit'])
      const draftLanded = await until(() => draftFiles().some((f) => f.startsWith('session-')), 30000, 500)
      const draftFile = draftFiles().find((f) => f.startsWith('session-')) ?? ''
      const draftSlug = draftFile.replace(/\.md$/, '')
      const draftBytes = draftFile ? readFileSync(join(draftsDir, draftFile), 'utf8') : ''
      const draftOk =
        draftLanded.ok &&
        draftBytes.includes(`\`${ARC_COMMAND}\` — exit 1`) &&
        draftBytes.includes('succeeded on attempt 2') &&
        draftBytes.includes('auto: true') &&
        draftBytes.includes('source: session')

      // (h2) a granted promote lands it as team truth — bytes verbatim.
      const preMove = draftFile ? readFileSync(join(draftsDir, draftFile)) : Buffer.alloc(0)
      let promoted: ToolAnswer = { ok: false, isError: false, rpcError: null, text: '', data: {} }
      const promotedLanded = await until(async () => {
        promoted = await call(cA, 'promote_memory', { slug: draftSlug })
        return promoted.ok
      }, 15000, 400)
      const promotedPath = join(F.repo, '.memory', `${draftSlug}.md`)
      const promoteOk =
        promotedLanded.ok &&
        !draftFiles().includes(draftFile) &&
        existsSync(promotedPath) &&
        readFileSync(promotedPath).equals(preMove)

      // (h3) the NEXT board launch is briefed with it — captured, stamped.
      const card2 = (await ES(
        `window.__mogging.board.createCard('BRAINMS_ARC_7200', 'BRAINMS_ARC_7200 investigate the flumox failure arc')`
      )) as string
      const started2 = (await ES(`window.__mogging.board.startOnCard(${JSON.stringify(card2)}, 'shell')`)) as boolean
      const paneL2 = await paneOf(String(card2))
      await confirmAgentUp(paneL2)
      const cap2 = await captureHas(paneL2, 'BRAINMS_ARC_7200')
      const cap2Flat = stripAnsi(cap2)
      const memFenceAt = seen(cap2Flat, '```team-memory')
      const slugInCap = seen(cap2Flat, draftSlug) >= 0
      const stampInCap = seen(cap2Flat, '[team-memory: generation') >= 0 && seen(cap2Flat, ', exact]') >= 0
      // Ground truth beside the capture: the compose seam itself, same task,
      // repo root, A's anchor — the BYTE-exact section the launch typed (the
      // capture proves it reached the pane; the seam proves what it said).
      const composed2 = await ES<string>(
        `window.__mogging.agents.compose(${JSON.stringify('BRAINMS_ARC_7200 investigate the flumox failure arc')}, ${JSON.stringify(F.repo)}, ${JSON.stringify(wsA.id)})`
      )
      const composed2Mem = /```team-memory\n([\s\S]*?)\n```/.exec(composed2)?.[1] ?? ''
      const recallOk =
        started2 &&
        memFenceAt >= 0 &&
        slugInCap && // the promoted arc, briefing the next agent — on screen
        stampInCap &&
        composed2Mem.includes(draftSlug) && // …and byte-exact at the seam
        /\[team-memory: generation \d+, exact\]$/.test(composed2Mem)

      // (h4) FAKE-embedder consent: a vocabulary-DISJOINT query finds it,
      // labeled — and exact search honestly misses the same query.
      const exactMiss = await call(cA, 'search_memories', { query: 'flumoxed' })
      if (!setSemanticAllowed(wsA.id, true)) throw new Error('consent flip refused')
      const cfg = setEmbedTarget(wsA.id, 'fake:', 'fake-milestone')
      if (!cfg.ok) throw new Error('embed target refused: ' + (cfg.reason ?? ''))
      let semHits: MemHit[] = []
      const semFound = await until(async () => {
        const sem = await call(cA, 'search_memories', { query: 'flumoxed', mode: 'semantic' })
        semHits = sem.ok ? mems(sem) : []
        return semHits.length > 0 && semHits[0].slug === draftSlug
      }, 30000, 700)
      const semanticOk =
        exactMiss.ok && mems(exactMiss).length === 0 && // FTS does not stem — the honest miss
        semFound.ok &&
        semHits.every((h) => h.probabilistic === true && h.provider === 'fake' && h.model === 'fake-milestone')
      setSemanticAllowed(wsA.id, false) // the deterministic default returns

      // ── (i) the perf claim: full re-index of the field, under 16 live panes ─
      await ES(`(() => {
        Object.defineProperty(window.screen, 'availWidth', { get: () => 1920, configurable: true })
        Object.defineProperty(window.screen, 'availHeight', { get: () => 1080, configurable: true })
        return 1
      })()`)
      await ES(`window.__mogging.workspace.create({ name: 'BrainMS-Load', cwd: ${JSON.stringify(F.repo)} })`)
      await sleep(1200)
      const wsC = (await ES('window.__mogging.workspace.active()')) as { ordinal: number }
      await ES(`window.__mogging.layout.apply(16)`)
      const baseC = wsC.ordinal * 100
      const mountedRes = await until(
        async () => ((await ES<number>(`window.__mogging.panes.filter((p) => p.id > ${baseC} && p.id <= ${baseC + 16}).length`)) ?? 0) === 16,
        60000,
        500
      )
      const mounted = await ES<number>(`window.__mogging.panes.filter((p) => p.id > ${baseC} && p.id <= ${baseC + 16}).length`)
      await sleep(8000) // sixteen shells reach a prompt

      // Touch every field file: the next index pass must PARSE the world again,
      // not ride the cache — that is what "forced full re-index" claims.
      for (let i = 0; i < GLOB_FILES; i++) {
        appendFileSync(join(F.repo, 'field', `f${String(i).padStart(4, '0')}.ts`), `// touched ${i}\n`)
      }
      const reindexT0 = Date.now()
      const genBeforeLoad = (handleBrainStatus({ root: F.repo }) as { generation?: number }).generation ?? -1
      // The forced door: an explicit rebuild. The tick's own drain may hold the
      // queue (busy is a typed law, not an error) — either path re-parses the
      // whole touched field, which is the load the budget must survive.
      void handleBrainRebuild({ root: F.repo })

      const framesPromise = ES<{ frames: number; avgFps: number; maxGapMs: number; over100: number }>(`(async () => {
        const gaps = []
        let last = performance.now()
        const t0 = last
        await new Promise((res) => {
          const step = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            if (now - t0 >= 6000) return res()
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
        const warm = gaps.slice(3)
        const total = warm.reduce((a, b) => a + b, 0)
        return {
          frames: gaps.length,
          avgFps: Math.round((warm.length / (total / 1000)) * 10) / 10,
          maxGapMs: Math.round(Math.max(...warm) * 10) / 10,
          over100: warm.filter((g) => g > 100).length
        }
      })()`)
      // The echo round-trip, DURING the window: a real keystroke path through
      // the daemon into pane C1 and back out through capture.
      const echoT0 = Date.now()
      await cli(['send', String(baseC + 1), 'echo MZPING7100'])
      let sawIndexing = false
      const indexingWatch = until(() => {
        const s = handleBrainStatus({ root: F.repo }) as { indexing?: boolean; dirty?: boolean }
        if (s.indexing === true || s.dirty === true) sawIndexing = true
        return sawIndexing
      }, 6000, 100)
      const frames = await framesPromise
      await indexingWatch
      const echoBack = await until(async () => {
        const c = await cli(['capture', String(baseC + 1), '--lines', '80'])
        return c.code === 0 && c.stdout.includes('MZPING7100')
      }, 15000, 400)
      const echoMs = Date.now() - echoT0
      const heapMB = await ES<number>(`Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)`)
      const settled = await until(() => {
        const s = handleBrainStatus({ root: F.repo }) as { ok?: boolean; generation?: number; dirty?: boolean; indexing?: boolean }
        return s.ok === true && (s.generation ?? -1) > genBeforeLoad && s.dirty === false && s.indexing === false
      }, 240000, 1000)
      const reindexMs = Date.now() - reindexT0
      const gpuSoft = process.env.MOGGING_CI_GPU === 'soft'
      const budgetOk =
        mountedRes.ok && mounted === 16 &&
        sawIndexing && settled.ok && // the load was REAL and it finished
        frames.avgFps >= BUDGET.minAvgFps &&
        heapMB > 0 && heapMB <= BUDGET.maxHeapMB &&
        (gpuSoft
          ? frames.over100 <= 5 // software-GL runners: loudly relaxed, like every budget gate
          : frames.maxGapMs <= BUDGET.maxFrameGapMs && frames.over100 <= BUDGET.maxLongFrames100) &&
        echoBack.ok

      // ── (j) ADR 0005: zero paths, symbol names, or memory text ─────────────
      flushTrailForSmoke()
      const trailRows = readTrail(wsA.id).filter((e) => e.ts >= runStart)
      const writeTrail = trailRows.filter((e) => (WRITES as string[]).includes(e.verb))
      const markers = ['mog-brainms', 'Gamma', 'mzAlpha', 'freshface', 'quaternion', 'flumox', 'zanzibar', 'acme-lib', draftSlug].filter(Boolean)
      const telemetryJson = telemetryCalls.join('\n')
      const trailJson = JSON.stringify(trailRows)
      const telemetryOk = !markers.some((m) => telemetryJson.includes(m))
      // The trail: replace ok + stale refused + create ok + promote ok — and
      // never a path, symbol, or byte of content.
      const trailOk =
        writeTrail.length === 4 &&
        writeTrail.filter((e) => e.outcome === 'ok').length === 3 &&
        writeTrail.filter((e) => e.outcome === 'refused').length === 1 &&
        !markers.some((m) => trailJson.includes(m))

      // ── (k) custody's closing numbers ──────────────────────────────────────
      const protoAfter = endpointVersion()
      const socketsOk = embedHttpAttemptsForSmoke() === 0 && distillHttpAttemptsForSmoke() === 0
      const protocolOk = protoBefore === DAEMON_PROTOCOL_VERSION && protoAfter === protoBefore

      const pass =
        indexOnceOk && launchOk && grantWallOk && graphTruthOk && partitionsOk && freshOk &&
        writeOk && staleOk && docsOk && mergeOk && draftOk && promoteOk && recallOk && semanticOk &&
        budgetOk && telemetryOk && trailOk && socketsOk && protocolOk
      result = {
        pass,
        indexOnceOk, filesPerCheckout, wt1Rate: Math.round(wt1Rate * 1000) / 10, wt2Rate: Math.round(wt2Rate * 1000) / 10,
        coldIndexMs,
        launchOk, mapFenceAt, taskAt,
        grantWallOk,
        graphTruthOk, pathDepth: path3.data.depth ?? null,
        partitionsOk, projRoots,
        freshOk, freshMs: appeared.ms, freshBudgetMs,
        writeOk, staleOk, staleMsg: staleRetry.text.slice(0, 200),
        docsOk, docsVersion: docs.data.version ?? null, docsSource: docs.data.source ?? null,
        mergeOk, mergeMs: merged.ms,
        draftOk, draftSlug,
        promoteOk,
        recallOk, memFenceAt, slugInCap, stampInCap,
        recallCapTail: memFenceAt >= 0 ? cap2Flat.slice(Math.max(0, memFenceAt - 80), memFenceAt + 800) : cap2Flat.slice(-800),
        composed2Mem,
        semanticOk, semTop: semHits[0] ?? null,
        budgetOk, budget: BUDGET, mounted, frames, heapMB, echoMs, echoBack: echoBack.ok, reindexMs, sawIndexing, gpuSoft,
        telemetryOk, telemetryCallCount: telemetryCalls.length,
        trailOk, trailOutcomes: writeTrail.map((e) => `${e.verb}:${e.outcome}:${e.reason ?? ''}`),
        socketsOk,
        protocolOk, protoBefore, protoAfter,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    for (const c of clients) c.kill()
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* sixteen live shells hold cwds — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

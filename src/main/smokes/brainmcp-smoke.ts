import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MCP_BRAIN_READ_TOOL_NAMES } from '@contracts'
import { brainDebug, handleBrainRebuild } from '../brain'
import { mcpEndpointDebug } from '../mcp-endpoint'
import { spawnLocalMcpSmokeClient, spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated brain-over-MCP smoke (MOGGING_BRAINMCP, ADR 0018 step 05): the brain
// MEETS the agents. The REAL `bin/mogging-mcp.mjs` is driven as a REAL stdio MCP
// client from inside REAL panes (the phase-8 precedent) against the 03 fixture:
//   (a) every one of the seven read tools answers fixture-known truth;
//   (b) pagination: page 2 via cursor — no overlap, stable order;
//   (c) shortest_path finds the known 3-hop chain; maxDepth 1 refuses too-deep;
//   (d) scope custody: a caller in worktree A never sees B's partition without
//       scope='project'; with it, every hit carries a root label;
//   (e) stamps: a real shell mutates a file, and the generation advance is
//       VISIBLE THROUGH THE TOOL — freshness meets the agent wire;
//   (f) a ~500-hit glob truncates with the flag set (the no-silent-caps rule);
//   (g) tools/list carries exactly the seven brain reads and zero brain writes.
// Plus the paneless door: a bare session must name a root; reads stay free.
//
// MOGGING_BRAINMCP=HOLD is the MANUAL-FIRST door: build the same world, write
// its coordinates to out/brainmcp-manual.json, and STAY UP so a human can drive
// the server bare ("what defines X / what calls it") — no assertions, no exit.
// Verdict (normal mode): out/brainmcp-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const fold = (p: string): string => p.replace(/\//g, '\\').toLocaleLowerCase('en-US')

// The 03 fixture (braingraph's shapes verbatim — Gamma/Base/Zeta, the import
// chain, tally, the ambiguous dup) + mut.ts (the freshness arm's target) + a
// glob field big enough to overflow the max page (120 files x 4 defs).
const FIXTURE: Record<string, string> = {
  'tsconfig.json': `{\n  "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"] } }\n}\n`,
  'src/lib/util.ts': `export function tally(): number {\n  return 1\n}\n`,
  'src/alpha.ts': `import { tally } from '@lib/util'\nimport { readFileSync } from 'fs'\n\nexport class Base {}\nexport interface Zeta {}\n\nexport function alpha(): number {\n  readFileSync('x')\n  return tally()\n}\n`,
  'src/gamma.ts': `import { Base, Zeta } from './alpha'\n\nexport class Gamma extends Base implements Zeta {\n  run(): number {\n    return compute()\n  }\n}\n\nfunction compute(): number {\n  return 2\n}\n`,
  'py/main.py': `from helper import greet\n\ndef top():\n    return greet()\n`,
  'py/helper.py': `def greet():\n    return 1\n`,
  'dup_a.ts': `export function dup(): number {\n  return 1\n}\n`,
  'dup_b.ts': `export function dup(): number {\n  return 2\n}\n`,
  'caller.ts': `export function caller(): number {\n  return dup()\n}\n`,
  'mut.ts': `export function mut(): number {\n  return 1\n}\n`
}

interface Fixture {
  base: string
  repo: string
  wt: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainmcp-')))
  const repo = join(base, 'repo')
  for (const [rel, src] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), src)
  }
  // The glob field: 480 defs answering name glob "genfn*".
  mkdirSync(join(repo, 'glob'))
  for (let i = 0; i < 120; i++) {
    let src = ''
    for (let j = 0; j < 4; j++) src += `export function genfn${i}x${j}(): number {\n  return ${j}\n}\n`
    writeFileSync(join(repo, 'glob', `g${String(i).padStart(3, '0')}.ts`), src)
  }
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])
  mkdirSync(join(repo, '.mogging'), { recursive: true })
  writeFileSync(join(repo, '.mogging', '.gitignore'), '*\n')
  const wt = join(repo, '.mogging', 'worktrees', 'wt1')
  git(repo, ['worktree', 'add', wt, '-b', 'mogging/wt1'])
  // The REAL pane's mutation tool, OUTSIDE both checkouts (.mjs would be a row).
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'append') appendFileSync(${JSON.stringify(join(repo, 'mut.ts'))}, '\\nexport function freshface(): number {\\n  return 5\\n}\\n')\n`
  )
  return { base, repo, wt }
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

export function runBrainMcpSmoke(win: BrowserWindow): void {
  const hold = process.env.MOGGING_BRAINMCP === 'HOLD'
  const resultFile = join(app.getAppPath(), 'out', 'brainmcp-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (!hold && existsSync(resultFile)) {
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
  if (!hold) {
    setTimeout(() => {
      write({ pass: false, error: 'TIMEOUT: brainmcp smoke did not complete' })
      app.exit(1)
    }, 280000)
  }

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
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

  type NodeHit = { id: string; kind: string; name: string; file: string; startLine: number; root?: string }
  const hits = (a: ToolAnswer, key: string): NodeHit[] => (Array.isArray(a.data[key]) ? (a.data[key] as NodeHit[]) : [])

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The world: workspace A on the main checkout (2 panes: bridge +
      //    mutation shell), workspace B on the linked worktree (1 pane) ────────
      await ES(`window.__mogging.workspace.create({ name: 'BrainA', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const ordA = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal
      await ES(`window.__mogging.workspace.create({ name: 'BrainB', cwd: ${JSON.stringify(F.wt)}, paneCount: 1 })`)
      await sleep(3500)
      const ordB = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal
      const paneA1 = String(ordA * 100 + 1)
      const paneA2 = String(ordA * 100 + 2)
      const paneB1 = String(ordB * 100 + 1)

      const bA = await handleBrainRebuild({ root: F.repo })
      const bB = await handleBrainRebuild({ root: F.wt })
      if (!bA.ok || !bB.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify({ bA, bB }))

      if (hold) {
        // ── The manual-first door: the world stays up; a human drives the
        //    server bare. No assertions, no exit — Ctrl-C owns teardown. ───────
        writeFileSync(
          join(root, 'out', 'brainmcp-manual.json'),
          JSON.stringify({ repo: F.repo, wt: F.wt, appEndpoint: mcpEndpointDebug().file, mcpBin: join(root, 'bin', 'mogging-mcp.mjs') }, null, 2)
        )
        return
      }

      // ── The client: the REAL server, spawned inside pane A1 ────────────────
      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (g) registration honesty: exactly the seven, zero brain writes ─────
      const served = (((await c1.rpc('tools/list')).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)
      const seven = [...MCP_BRAIN_READ_TOOL_NAMES]
      const brainServed = served.filter((n) => (seven as string[]).includes(n))
      const sevenOk =
        brainServed.length === 7 &&
        seven.every((n) => served.includes(n)) &&
        served.filter((n) => n.includes('brain') || n.includes('graph') || n.includes('symbol') || n.includes('references')).every((n) => (seven as string[]).includes(n))

      // ── (a) fixture-known truth through every tool ─────────────────────────
      const st = await call(c1, 'brain_status')
      const stStatus = (st.data.status ?? {}) as Record<string, unknown>
      const statusOk =
        st.ok &&
        typeof st.data.generation === 'number' &&
        st.data.dirty === false &&
        fold(String(st.data.root)) === fold(F.repo) &&
        (stStatus.files as number) > 120 &&
        (stStatus.resolvedRefs as number) >= 6 &&
        (stStatus.droppedRefs as number) >= 1 &&
        (stStatus.languages as string[]).includes('typescript')

      const symGamma = await call(c1, 'find_symbol', { name: 'Gamma' })
      const gammaA = hits(symGamma, 'matches')[0]
      const symbolOk =
        symGamma.ok && symGamma.data.matchedBy === 'exact' && hits(symGamma, 'matches').length === 1 &&
        !!gammaA && gammaA.kind === 'class' && gammaA.file === 'src/gamma.ts' && gammaA.startLine === 3 &&
        gammaA.root === undefined // checkout scope: unlabeled

      const symTally = await call(c1, 'find_symbol', { name: 'tally' })
      const tallyA = hits(symTally, 'matches')[0]

      const nodeAns = await call(c1, 'get_node', { id: gammaA?.id ?? '' })
      const nodeOk =
        nodeAns.ok &&
        (nodeAns.data.node as NodeHit | undefined)?.name === 'Gamma' &&
        String((nodeAns.data.node as { sig?: string } | undefined)?.sig ?? '').includes('class Gamma')

      const nb = await call(c1, 'get_neighbors', { id: gammaA?.id ?? '', direction: 'both' })
      const nbRows = (nb.data.neighbors ?? []) as { node: NodeHit; edge: { kind: string; direction: string } }[]
      const nbHas = (name: string, kind: string, direction: string): boolean =>
        nbRows.some((r) => r.node.name === name && r.edge.kind === kind && r.edge.direction === direction)
      const neighborsOk =
        nb.ok && nbHas('Base', 'extends', 'out') && nbHas('Zeta', 'implements', 'out') &&
        nbRows.some((r) => r.node.kind === 'module' && r.edge.kind === 'defines' && r.edge.direction === 'in')

      const classes = await call(c1, 'query_graph', { kind: 'class' })
      const classNames = hits(classes, 'nodes').map((n) => n.name)
      const queryOk =
        classes.ok && classNames.includes('Gamma') && classNames.includes('Base') &&
        hits(classes, 'nodes').every((n) => n.root === undefined)

      const refs = await call(c1, 'find_references', { name: 'tally' })
      const refRows = (refs.data.references ?? []) as { node: NodeHit }[]
      const refsOk =
        refs.ok && refRows.length >= 1 && refRows.some((r) => r.node.kind === 'module' && r.node.file === 'src/alpha.ts') &&
        typeof refs.data.note === 'string' && /dropped/.test(String(refs.data.note))
      const refsDup = await call(c1, 'find_references', { name: 'dup' })
      const dupOk =
        refsDup.ok && (refsDup.data.targets as unknown[]).length === 2 &&
        ((refsDup.data.references ?? []) as unknown[]).length === 0 && typeof refsDup.data.note === 'string'

      // ── (b) + (f): pagination with a stable order, and the truncation flag ─
      const p1 = await call(c1, 'query_graph', { name: 'genfn*', limit: 50 })
      const p2 = await call(c1, 'query_graph', { name: 'genfn*', limit: 50, cursor: String(p1.data.cursor ?? '') })
      const full = await call(c1, 'query_graph', { name: 'genfn*', limit: 200 })
      const p1Ids = hits(p1, 'nodes').map((n) => n.id)
      const p2Ids = hits(p2, 'nodes').map((n) => n.id)
      const fullIds = hits(full, 'nodes').map((n) => n.id)
      const pagingOk =
        p1.ok && p2.ok && p1Ids.length === 50 && p2Ids.length === 50 &&
        p1.data.truncated === true && typeof p1.data.cursor === 'string' &&
        !p1Ids.some((id) => p2Ids.includes(id)) && // no overlap
        JSON.stringify([...p1Ids, ...p2Ids]) === JSON.stringify(fullIds.slice(0, 100)) // stable order
      const truncatedOk = full.ok && fullIds.length === 200 && full.data.truncated === true // 480 hits > max page

      // ── (c) the known 3-hop chain; maxDepth 1 refuses too-deep ─────────────
      const path3 = await call(c1, 'shortest_path', { from: gammaA?.id ?? '', to: tallyA?.id ?? '' })
      const pathOk =
        path3.ok && path3.data.found === true && path3.data.depth === 3 &&
        (path3.data.nodes as unknown[]).length === 4 && (path3.data.edges as unknown[]).length === 3
      const tooDeep = await call(c1, 'shortest_path', { from: gammaA?.id ?? '', to: tallyA?.id ?? '', maxDepth: 1 })
      const tooDeepOk = tooDeep.isError && /refused/.test(tooDeep.text) && /maxDepth/.test(tooDeep.text)

      // ── (d) scope custody across worktrees ─────────────────────────────────
      const cB = await spawnPaneMcpSmokeClient({ cli, paneId: paneB1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(cB)
      await cB.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const symGammaB = await call(cB, 'find_symbol', { name: 'Gamma' })
      const gammaB = hits(symGammaB, 'matches')[0]
      const bScopeOk =
        symGammaB.ok && hits(symGammaB, 'matches').length === 1 &&
        !!gammaB && gammaB.id !== gammaA?.id && // B's partition, not A's
        fold(String(symGammaB.data.root)) === fold(F.wt)
      const crossDenied = await call(c1, 'get_node', { id: gammaB?.id ?? '' })
      const crossAllowed = await call(c1, 'get_node', { id: gammaB?.id ?? '', scope: 'project' })
      const projGamma = await call(c1, 'find_symbol', { name: 'Gamma', scope: 'project' })
      const projRoots = hits(projGamma, 'matches').map((n) => fold(String(n.root ?? '')))
      const custodyOk =
        crossDenied.isError && /unknown node/.test(crossDenied.text) && // never a sibling's by default
        crossAllowed.ok && fold(String((crossAllowed.data.node as NodeHit).root ?? '')) === fold(F.wt) &&
        projGamma.ok && projRoots.length === 2 &&
        projRoots.includes(fold(F.repo)) && projRoots.includes(fold(F.wt)) // every hit labeled

      // ── (e) stamps: a REAL shell mutates; the tool shows the generation move ─
      const gen0 = st.data.generation as number
      const sent = await cli(['send', paneA2, 'node ../ops.mjs append'])
      if (sent.code !== 0) throw new Error('could not drive the mutation pane')
      let stamped: ToolAnswer | null = null
      const t0 = Date.now()
      while (Date.now() - t0 < 20000) {
        const s = await call(c1, 'brain_status')
        if (s.ok && (s.data.generation as number) > gen0 && s.data.dirty === false) {
          stamped = s
          break
        }
        await sleep(400)
      }
      const fresh = await call(c1, 'find_symbol', { name: 'freshface' })
      const stampOk =
        stamped !== null && (stamped.data.generation as number) === gen0 + 1 &&
        fresh.ok && hits(fresh, 'matches').length === 1 && hits(fresh, 'matches')[0].file === 'mut.ts'

      // ── The paneless door: bare sessions name a root; reads stay free ──────
      const cL = spawnLocalMcpSmokeClient({
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs'),
        childEnv: { MOGGING_BROWSER_ENDPOINT: mcpEndpointDebug().file, MOGGING_PANE_ID: '', MOGGING_PANE_TOKEN: '' }
      })
      clients.push(cL)
      await cL.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const bareNoRoot = await call(cL, 'brain_status')
      const bareWithRoot = await call(cL, 'brain_status', { root: F.repo })
      const bareMissing = await call(cL, 'brain_status', { root: join(F.base, 'nowhere') })
      const bareOk =
        bareNoRoot.isError && /root/.test(bareNoRoot.text) &&
        bareWithRoot.ok && fold(String(bareWithRoot.data.root)) === fold(F.repo) &&
        bareMissing.isError && /does not exist/.test(bareMissing.text)

      // ── Junk in → typed refusals out, and the session survives them ────────
      const badKind = await call(c1, 'query_graph', { kind: 'flavor' })
      const badCursor = await call(c1, 'query_graph', { cursor: 'garbage' })
      const junkOk =
        !!badKind.rpcError && /one of/.test(badKind.rpcError) && // the bin's schema enum
        badCursor.isError && /cursor/.test(badCursor.text) && // the serve layer's typed refusal
        (await call(c1, 'brain_status')).ok // still alive

      const pass =
        sevenOk && statusOk && symbolOk && nodeOk && neighborsOk && queryOk && refsOk && dupOk &&
        pagingOk && truncatedOk && pathOk && tooDeepOk && bScopeOk && custodyOk && stampOk && bareOk && junkOk
      result = {
        pass,
        sevenOk, brainServed,
        statusOk, statusFiles: stStatus.files, statusGen: st.data.generation,
        symbolOk, nodeOk, neighborsOk, neighborCount: nbRows.length, queryOk,
        refsOk, refNote: refs.data.note, dupOk,
        pagingOk, truncatedOk,
        pathOk, pathDepth: path3.data.depth, tooDeepOk, tooDeepMsg: tooDeep.text,
        bScopeOk, custodyOk, projRoots,
        stampOk, stampedGen: stamped?.data.generation ?? null,
        bareOk, junkOk,
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
      /* a live shell may hold the cwd — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

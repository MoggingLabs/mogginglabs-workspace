import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTelemetry } from '@backend'
import { serializeMemory } from '@backend/features/brain'
import { MCP_MEMORY_WRITE_TOOL_NAMES, type Telemetry } from '@contracts'
import { brainBaseDir, brainDebug, handleBrainRebuild } from '../brain'
import { setIntegrationsGrant } from '../integrations'
import { flushTrailForSmoke, readTrail } from '../trail'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated memory-graph smoke (MOGGING_MEMGRAPH, ADR 0018 step 09 / Phase
// 2.5): `.memory/` — the team's wikilink knowledge graph — through the REAL
// `bin/mogging-mcp.mjs` from inside REAL panes, on a fixture repo + linked
// worktree:
//   (a) create from a HOSTILE name (`"; rm -rf / [[x]]"`) lands sanitized and
//       inert: the slug kebab-cases, the file's frontmatter is byte-exact, a
//       collision refuses `exists`, and the sentinel file still stands;
//   (b) `[[wikilinks]]` across the seeds answer EXACT links and backlinks; a
//       link to an unwritten slug is reported dangling and its backlinks are
//       queryable (wanted knowledge, not an error);
//   (c) FTS finds a body term, and the ranked order is IDENTICAL across two
//       runs of the same query (bm25 — deterministic, stance (a));
//   (d) suggest_connections puts the fixture-known neighbor first WITH its
//       fixed-weight breakdown (auditable arithmetic, never an opinion);
//   (e) update with a stale hash refuses carrying the fresh hash and the disk
//       is untouched; the corrected update lands with the head preserved;
//   (f) a REAL shell pane edits a memory → the tick routes it and the index
//       absorbs it (the backlink appears) — no rebuild, no explicit poke;
//   (g) no grant: writes are absent from tools/list AND refuse when forced;
//       reads still answer (the reads-free stance holds for memories);
//   (h) delete the brain db, rebuild → search restored: the FILES are the
//       truth, the index is disposable;
//   (i) `.memory/` contains ONLY `.md` files after the whole run;
//   plus the MERGE proof (the DoD's spine): a memory written in checkout A is
//   carried into worktree B by REAL git merge, B's own partition reindexes on
//   the head move, and a search from B's pane serves it root-labeled B.
// Trail rows carry counts only; a telemetry recorder sits on the port for the
// whole run and no memory text may appear in it. Verdict: out/memgraph-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const fold = (p: string): string => p.replace(/\//g, '\\').toLocaleLowerCase('en-US')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ── The seed graph (links/tags/terms designed so every score is fixture-known) ─

const ALPHA = serializeMemory({
  slug: 'alpha-notes',
  description: 'How the alpha subsystem is wired',
  tags: ['brain', 'ops'],
  body: 'Alpha wiring notes. See [[beta-notes]] and [[gamma-notes]]. The quicksilver seam sits here.\n'
})
const BETA = serializeMemory({
  slug: 'beta-notes',
  description: 'Beta subsystem gotchas',
  tags: ['beta'],
  body: 'Beta gotchas. Related: [[alpha-notes]]. Still unwritten: [[wanted-topic]].\n'
})
const GAMMA = serializeMemory({
  slug: 'gamma-notes',
  description: 'Gamma quicksilver quicksilver notes',
  tags: ['ops'],
  body: 'Gamma: quicksilver quicksilver.\n'
})
// delta shares 2 outgoing links (beta, gamma) with alpha, 1 tag (ops), and 1
// slug term (notes) — score 3*2 + 2*1 + 1*1 = 9, and it is NOT linked to alpha
// in either direction, so it is alpha's top suggestion by construction.
const DELTA = serializeMemory({
  slug: 'delta-notes',
  description: 'Delta rollout playbook',
  tags: ['ops'],
  body: 'Delta playbook. Under [[beta-notes]] constraints, mirrors [[gamma-notes]].\n'
})

const HOSTILE_NAME = '"; rm -rf / [[x]]"'
const HOSTILE_SLUG = 'rm-rf-x'
const CREATE_DESCRIPTION = 'Hostile-name landing check'
const CREATE_BODY = 'Memory created by the smoke. Links [[alpha-notes]]. Term: zanzibar.'
const CREATE_FILE = serializeMemory({
  slug: HOSTILE_SLUG,
  description: CREATE_DESCRIPTION,
  tags: ['ops'],
  body: CREATE_BODY
})
const UPDATE_BODY = 'Updated by the smoke. Still links [[alpha-notes]]. Term: zanzibar.'

const PANE_APPEND = '\nAppended by a real pane: [[rm-rf-x]].\n'

const FIXTURE: Record<string, string> = {
  'src/keep.ts': 'export function keeper(): number {\n  return 1\n}\n',
  '.memory/alpha-notes.md': ALPHA,
  '.memory/beta-notes.md': BETA,
  '.memory/gamma-notes.md': GAMMA,
  '.memory/delta-notes.md': DELTA,
  'KEEP.txt': 'sentinel: still being here means the hostile name never executed\n'
}

interface Fixture {
  base: string
  repo: string
  wt: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-memgraph-')))
  const repo = join(base, 'repo')
  for (const [rel, src] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), src)
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
  // The REAL pane's out-of-band mutation tool, OUTSIDE both checkouts.
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'append') appendFileSync(${JSON.stringify(join(repo, '.memory', 'gamma-notes.md'))}, ${JSON.stringify(PANE_APPEND)})\n`
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

type MemHit = { slug: string; name: string; description: string; tags: string[]; root: string }
type LinkOut = { slug: string; dangling: boolean }
type BacklinkOut = { slug: string; root: string }
type SuggestOut = {
  slug: string
  root: string
  score: number
  breakdown: { sharedLinks: string[]; sharedTags: string[]; sharedTerms: string[]; weights: Record<string, number> }
}

export function runMemGraphSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'memgraph-result.json')
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
    write({ pass: false, error: 'TIMEOUT: memgraph smoke did not complete' })
    app.exit(1)
  }, 280000)

  // The telemetry witness: a recorder on the PORT for the whole run — memory
  // text (names, slugs, bodies, paths) must never appear in any of it.
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
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const runStart = Date.now()

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

  const listNames = async (c: PaneMcpSmokeClient): Promise<string[]> =>
    (((await c.rpc('tools/list')).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)

  const waitFor = async (probe: () => Promise<boolean> | boolean, tries = 40, gapMs = 500): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const mems = (a: ToolAnswer): MemHit[] => (Array.isArray(a.data.memories) ? (a.data.memories as MemHit[]) : [])
  const WRITE2 = [...MCP_MEMORY_WRITE_TOOL_NAMES] as string[]

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The world: workspace A on the repo (pane 1 = MCP bridge, pane 2 =
      //    the mutation shell) + workspace B on the WORKTREE (pane 1 = the
      //    B-side MCP bridge for the merge proof). ───────────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'MemA', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)
      const paneA2 = String(wsA.ordinal * 100 + 2)
      await ES(`window.__mogging.workspace.create({ name: 'MemB', cwd: ${JSON.stringify(F.wt)}, paneCount: 1 })`)
      await sleep(3500)
      const wsB = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneB1 = String(wsB.ordinal * 100 + 1)

      const bA = await handleBrainRebuild({ root: F.repo })
      const bB = await handleBrainRebuild({ root: F.wt })
      if (!bA.ok || !bB.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify({ bA, bB }))

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (g-first) no grant: writes invisible AND refused; reads answer ─────
      const namesNone = await listNames(c1)
      const forcedNone = await call(c1, 'create_memory', { name: 'x', description: 'x', body: 'x' })
      const readNone = await call(c1, 'search_memories', { query: 'quicksilver' })
      const noGrantOk =
        namesNone.every((n) => !WRITE2.includes(n)) &&
        namesNone.includes('search_memories') && // reads stay free
        !!forcedNone.rpcError && /grant/.test(forcedNone.rpcError) &&
        readNone.ok && mems(readNone).length === 2

      // ── The seeds are INDEX truth, not code: the walk never saw .memory/ ───
      const memNodes = await call(c1, 'query_graph', { file: '.memory/*' })
      const carveOutOk = memNodes.ok && Array.isArray(memNodes.data.nodes) && (memNodes.data.nodes as unknown[]).length === 0

      // ── (a) grant on; hostile-name create lands sanitized, byte-exact ──────
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const listChangedOk = await waitFor(() => c1.notifications.includes('notifications/tools/list_changed'), 25, 400)
      const namesAll = await listNames(c1)
      const visibleOk = WRITE2.every((n) => namesAll.includes(n))

      const created = await call(c1, 'create_memory', {
        name: HOSTILE_NAME,
        description: CREATE_DESCRIPTION,
        body: CREATE_BODY,
        tags: 'ops'
      })
      const createdPath = join(F.repo, '.memory', `${HOSTILE_SLUG}.md`)
      const createdDisk = existsSync(createdPath) ? readFileSync(createdPath) : Buffer.alloc(0)
      const collision = await call(c1, 'create_memory', { name: HOSTILE_SLUG, description: 'again', body: 'nope' })
      const createOk =
        created.ok &&
        created.data.slug === HOSTILE_SLUG &&
        created.data.fileHash === sha256(createdDisk) &&
        createdDisk.equals(Buffer.from(CREATE_FILE, 'utf8')) && // frontmatter byte-exact
        existsSync(join(F.repo, 'KEEP.txt')) && // nothing executed
        collision.isError && /exists/.test(collision.text)

      // Indexed BEFORE the reply: the very next search already serves it.
      const foundNow = await call(c1, 'search_memories', { query: 'zanzibar' })
      const immediateOk = foundNow.ok && mems(foundNow).length === 1 && mems(foundNow)[0].slug === HOSTILE_SLUG

      // ── (b) wikilinks: links, backlinks, and the dangling target ───────────
      const alpha = await call(c1, 'get_memory', { slug: 'alpha-notes' })
      const alphaLinks = (alpha.data.links ?? []) as LinkOut[]
      const alphaBack = (alpha.data.backlinks ?? []) as BacklinkOut[]
      const beta = await call(c1, 'get_memory', { slug: 'beta-notes' })
      const betaLinks = (beta.data.links ?? []) as LinkOut[]
      const wanted = await call(c1, 'find_backlinks', { slug: 'wanted-topic' })
      const wantedBack = (wanted.data.backlinks ?? []) as BacklinkOut[]
      const linksOk =
        alpha.ok &&
        JSON.stringify(alphaLinks) === JSON.stringify([{ slug: 'beta-notes', dangling: false }, { slug: 'gamma-notes', dangling: false }]) &&
        alphaBack.map((b) => b.slug).join(',') === 'beta-notes,rm-rf-x' &&
        beta.ok &&
        betaLinks.some((l) => l.slug === 'wanted-topic' && l.dangling === true) &&
        wanted.ok &&
        wanted.data.exists === false &&
        wantedBack.length === 1 && wantedBack[0].slug === 'beta-notes'

      // ── (c) FTS: found, and the ranked order is STABLE across two runs ─────
      const q1 = await call(c1, 'search_memories', { query: 'quicksilver' })
      const q2 = await call(c1, 'search_memories', { query: 'quicksilver' })
      const order1 = mems(q1).map((m) => `${m.slug}@${fold(m.root)}`)
      const order2 = mems(q2).map((m) => `${m.slug}@${fold(m.root)}`)
      const searchOk =
        q1.ok && q2.ok &&
        order1.length === 2 &&
        new Set(mems(q1).map((m) => m.slug)).has('alpha-notes') &&
        new Set(mems(q1).map((m) => m.slug)).has('gamma-notes') &&
        JSON.stringify(order1) === JSON.stringify(order2)

      // ── (d) suggestions: the fixture-known neighbor first, WITH breakdown ──
      const suggest = await call(c1, 'suggest_connections', { slug: 'alpha-notes' })
      const suggestions = (suggest.data.suggestions ?? []) as SuggestOut[]
      const top = suggestions[0]
      const suggestOk =
        suggest.ok &&
        !!top && top.slug === 'delta-notes' && top.score === 9 &&
        JSON.stringify(top.breakdown.sharedLinks) === JSON.stringify(['beta-notes', 'gamma-notes']) &&
        JSON.stringify(top.breakdown.sharedTags) === JSON.stringify(['ops']) &&
        JSON.stringify(top.breakdown.sharedTerms) === JSON.stringify(['notes']) &&
        top.breakdown.weights.link === 3 && top.breakdown.weights.tag === 2 && top.breakdown.weights.term === 1

      // ── (e) stale CAS refuses (disk untouched), corrected update lands ─────
      const preStale = readFileSync(createdPath)
      const stale = await call(c1, 'update_memory', {
        slug: HOSTILE_SLUG,
        expectedFileHash: 'a'.repeat(64),
        body: 'never lands'
      })
      const staleOk =
        stale.isError &&
        /stale|changed/.test(stale.text) &&
        stale.text.includes(sha256(preStale)) && // the fresh hash rides the refusal
        readFileSync(createdPath).equals(preStale) // refused = untouched

      const updated = await call(c1, 'update_memory', {
        slug: HOSTILE_SLUG,
        expectedFileHash: sha256(preStale),
        body: UPDATE_BODY
      })
      const updatedDisk = readFileSync(createdPath)
      const headKept = updatedDisk.toString('utf8').startsWith(CREATE_FILE.slice(0, CREATE_FILE.indexOf('---\n', 4) + 4))
      const updateOk =
        updated.ok &&
        updated.data.fileHash === sha256(updatedDisk) &&
        headKept && // frontmatter preserved verbatim
        updatedDisk.toString('utf8').endsWith(UPDATE_BODY + '\n')

      // ── (f) a REAL pane edits a memory → the tick routes, the index follows ─
      const sent = await cli(['send', paneA2, 'node ../ops.mjs append'])
      if (sent.code !== 0) throw new Error('could not drive the mutation pane')
      const paneEditAbsorbed = await waitFor(async () => {
        const back = await call(c1, 'find_backlinks', { slug: HOSTILE_SLUG })
        return ((back.data.backlinks ?? []) as BacklinkOut[]).some((b) => b.slug === 'gamma-notes')
      })

      // ── The MERGE proof: A commits, B merges — REAL git carries it home ────
      git(F.repo, ['add', '-A'])
      git(F.repo, ['commit', '-m', 'memories from checkout A'])
      git(F.wt, ['merge', 'main'])
      const c2 = await spawnPaneMcpSmokeClient({ cli, paneId: paneB1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c2)
      await c2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      // B's OWN partition must reindex off the head move (no rebuild, no poke)
      // and win the freshest-copy election — the hit is root-labeled B.
      const mergeOk = await waitFor(async () => {
        const found = await call(c2, 'search_memories', { query: 'zanzibar' })
        const hit = mems(found)[0]
        return !!hit && hit.slug === HOSTILE_SLUG && fold(hit.root) === fold(F.wt)
      })

      // ── (h) delete the brain db, rebuild → search restored from FILES ──────
      brainDebug().dispose()
      rmSync(brainBaseDir(), { recursive: true, force: true })
      const rebuilt = await handleBrainRebuild({ root: F.repo })
      const afterRebuild = await call(c1, 'search_memories', { query: 'zanzibar' })
      const rebuildOk = rebuilt.ok && afterRebuild.ok && mems(afterRebuild)[0]?.slug === HOSTILE_SLUG

      // ── (g-second) revoke: the next write refuses; reads still answer ──────
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'none', web: 'off', actOrigins: [] })
      const revoked = await waitFor(async () => {
        const r = await call(c1, 'create_memory', { name: 'after-revoke', description: 'x', body: 'x' })
        return !!r.rpcError && /grant|OFF/.test(r.rpcError)
      }, 15, 400)
      const readsSurvive = (await call(c1, 'get_memory', { slug: 'alpha-notes' })).ok

      // ── (i) `.memory/` holds ONLY .md files, in BOTH checkouts ─────────────
      const onlyMd = (dir: string): boolean => readdirSync(dir).every((e) => e.endsWith('.md'))
      const onlyMdOk = onlyMd(join(F.repo, '.memory')) && onlyMd(join(F.wt, '.memory'))

      // ── The trail: counts only, zero memory text anywhere ──────────────────
      flushTrailForSmoke()
      const trailRows = readTrail(wsA.id).filter((e) => e.ts >= runStart && WRITE2.includes(e.verb))
      const trailJson = JSON.stringify(trailRows)
      const markers = ['zanzibar', 'quicksilver', 'alpha-notes', 'rm-rf-x', 'mog-memgraph', 'wanted-topic']
      const trailOk =
        trailRows.length === 4 && // create ok · collision refused · stale refused · update ok
        trailRows.filter((e) => e.outcome === 'ok').length === 2 &&
        trailRows.filter((e) => e.outcome === 'refused').length === 2 &&
        trailRows.every((e) => e.target === '1 memory') &&
        !markers.some((m) => trailJson.includes(m))
      const telemetryJson = telemetryCalls.join('\n')
      const telemetryOk = !markers.some((m) => telemetryJson.includes(m))

      const pass =
        noGrantOk && carveOutOk && listChangedOk && visibleOk && createOk && immediateOk &&
        linksOk && searchOk && suggestOk && staleOk && updateOk && paneEditAbsorbed &&
        mergeOk && rebuildOk && revoked && readsSurvive && onlyMdOk && trailOk && telemetryOk
      result = {
        pass,
        noGrantOk,
        forcedNoneMsg: forcedNone.rpcError,
        carveOutOk,
        listChangedOk,
        visibleOk,
        createOk,
        createDiag: { isError: created.isError, msg: created.text.slice(0, 300), disk: createdDisk.toString('latin1'), collisionMsg: collision.text.slice(0, 200) },
        immediateOk,
        linksOk,
        linksDiag: { alphaLinks, alphaBack, betaLinks, wantedExists: wanted.data.exists ?? null, wantedBack },
        searchOk,
        searchOrder: order1,
        suggestOk,
        suggestTop: top ?? null,
        staleOk,
        staleMsg: stale.text.slice(0, 300),
        updateOk,
        paneEditAbsorbed,
        mergeOk,
        rebuildOk,
        revoked,
        readsSurvive,
        onlyMdOk,
        trailOk,
        trailOutcomes: trailRows.map((e) => `${e.verb}:${e.outcome}:${e.reason ?? ''}`),
        telemetryOk,
        telemetryCallCount: telemetryCalls.length,
        memoryRescans: brainDebug().memoryRescans(),
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

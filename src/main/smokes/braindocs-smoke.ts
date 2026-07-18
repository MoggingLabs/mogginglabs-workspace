import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brainDebug, handleBrainRebuild, setLibFetchAllowed } from '../brain'
import { mcpEndpointDebug } from '../mcp-endpoint'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated library-lens smoke (MOGGING_BRAINDOCS, ADR 0018 step 08): version
// truth from lockfiles, docs from the bytes on disk, network strictly opt-in.
// The REAL `bin/mogging-mcp.mjs` drives the two new reads from a REAL pane:
//   (a) versions EXACT per lockfile (npm v3 + requirements pair); ranges are
//       reported AS ranges with pinned:false; transitives listed, not direct;
//   (b) get_library_docs answers from DISK — version + source:'disk' stamped,
//       the bundled .d.ts distilled to signatures (the known one present),
//       README topic filter works, scoped @names resolve end-to-end;
//   (c) a REAL shell bumps the lockfile → the tick re-resolves: new version,
//       installed:false, the OLD version's doc row PRUNED (the reference law);
//   (d) consent OFF: fetch:true refuses naming consent and ZERO sockets reach
//       the (local, injected) registry; consent ON: docs land with
//       source:'registry', version pinned, the size cap held on an oversized
//       README; hostile names open no socket;
//   (e) hostile dep names (../../evil) refuse as unknown keys — never paths.
// MOGGING_BRAINDOCS=HOLD: build the same world, write coordinates, stay up —
// the manual-first door the by-hand pinned-API verification drives.
// Verdict: out/braindocs-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const ACME_README = '# acme-lib\n\nIntro paragraph.\n\n## Usage\n\nACME_USAGE_4242 call acmeGreet.\n\n## License\n\nMIT_MARKER_4242\n'
const ACME_DTS = 'export declare function acmeGreet(name: string): AcmeResult\nexport interface AcmeResult {\n  greeting: string\n}\n'
const GHOST_README = 'GHOST_README_4242 — published docs for the pinned release.'

const LOCK = (acmeVersion: string): string =>
  JSON.stringify(
    {
      name: 'braindocs-fixture',
      lockfileVersion: 3,
      packages: {
        '': { name: 'braindocs-fixture' },
        'node_modules/acme-lib': { version: acmeVersion },
        'node_modules/@acme/scoped': { version: '1.0.5' },
        'node_modules/ghost-lib': { version: '9.9.9' },
        'node_modules/fat-lib': { version: '1.0.0' },
        'node_modules/transitive-x': { version: '0.9.0' }
      }
    },
    null,
    2
  )

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'braindocs-fixture',
    dependencies: { 'acme-lib': '^1.0.0', '@acme/scoped': '^1.0.0', 'ghost-lib': '^9.0.0', 'fat-lib': '^1.0.0' }
  }),
  'package-lock.json': LOCK('1.2.3'),
  'requirements.txt': 'fake-py==2.0.0\nloosepkg>=1.0\n',
  '.gitignore': 'node_modules/\n.venv/\n',
  'src/app.ts': 'export function main(): number {\n  return 1\n}\n',
  'node_modules/acme-lib/package.json': JSON.stringify({ name: 'acme-lib', version: '1.2.3', types: 'index.d.ts', exports: { '.': './index.js' } }),
  'node_modules/acme-lib/README.md': ACME_README,
  'node_modules/acme-lib/index.d.ts': ACME_DTS,
  'node_modules/@acme/scoped/package.json': JSON.stringify({ name: '@acme/scoped', version: '1.0.5' }),
  'node_modules/@acme/scoped/README.md': '# scoped\n\nSCOPED_README_4242\n',
  '.venv/Lib/site-packages/fake_py/__init__.py': '"""FakePy — FAKEPY_DOC_4242 fixture docstring."""\n\nVALUE = 1\n',
  '.venv/Lib/site-packages/fake_py-2.0.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: fake-py\nVersion: 2.0.0\n'
}

interface Fixture {
  base: string
  repo: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-braindocs-')))
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
  // The REAL pane's lockfile bump, OUTSIDE the checkout.
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { writeFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'bump') writeFileSync(${JSON.stringify(join(repo, 'package-lock.json'))}, ${JSON.stringify(LOCK('1.3.0'))})\n`
  )
  return { base, repo }
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

type LibRow = {
  ecosystem: string
  name: string
  version: string
  pinned: boolean
  direct: boolean
  installed: boolean
  installedVersion?: string
  hasDocs: boolean
}

export function runBrainDocsSmoke(win: BrowserWindow): void {
  const hold = process.env.MOGGING_BRAINDOCS === 'HOLD'
  const resultFile = join(app.getAppPath(), 'out', 'braindocs-result.json')
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
      write({ pass: false, error: 'TIMEOUT: braindocs smoke did not complete' })
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

  const waitFor = async (probe: () => Promise<boolean>, tries = 60, gapMs = 600): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const rowsOf = (a: ToolAnswer): LibRow[] => (Array.isArray(a.data.libraries) ? (a.data.libraries as LibRow[]) : [])
  const rowOf = (a: ToolAnswer, name: string): LibRow | undefined => rowsOf(a).find((r) => r.name === name)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    let registry: http.Server | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The LOCAL fixture registry (the injection seam): counts every
      //    connection, serves pinned-version JSON, never touched offline. ────
      let connections = 0
      registry = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/ghost-lib/9.9.9') {
          res.end(JSON.stringify({ name: 'ghost-lib', version: '9.9.9', readme: GHOST_README }))
        } else if (req.url === '/fat-lib/1.0.0') {
          res.end(JSON.stringify({ name: 'fat-lib', version: '1.0.0', readme: 'FAT_START_4242 ' + 'x'.repeat(100_000) }))
        } else {
          res.statusCode = 404
          res.end('{}')
        }
      })
      registry.on('connection', () => {
        connections += 1
      })
      const port = await new Promise<number>((resolve, reject) => {
        registry!.once('error', reject)
        registry!.listen(0, '127.0.0.1', () => resolve((registry!.address() as { port: number }).port))
      })
      process.env.MOGGING_BRAIN_REGISTRY_NPM = `http://127.0.0.1:${port}`

      // ── The world: ONE workspace, pane 1 = MCP bridge, pane 2 = the shell ──
      await ES(`window.__mogging.workspace.create({ name: 'BrainDocs', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)
      const paneA2 = String(wsA.ordinal * 100 + 2)

      const built = await handleBrainRebuild({ root: F.repo })
      if (!built.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(built))

      if (hold) {
        writeFileSync(
          join(root, 'out', 'braindocs-manual.json'),
          JSON.stringify(
            { repo: F.repo, appEndpoint: mcpEndpointDebug().file, mcpBin: join(root, 'bin', 'mogging-mcp.mjs'), panes: [paneA1, paneA2], workspaceId: wsA.id },
            null,
            2
          )
        )
        return
      }

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (a) version truth, exact per lockfile ──────────────────────────────
      const list = await call(c1, 'list_libraries')
      const acme = rowOf(list, 'acme-lib')
      const scoped = rowOf(list, '@acme/scoped')
      const ghost = rowOf(list, 'ghost-lib')
      const transitive = rowOf(list, 'transitive-x')
      const fakePy = rowOf(list, 'fake-py')
      const loose = rowOf(list, 'loosepkg')
      const versionsOk =
        list.ok &&
        !!acme && acme.version === '1.2.3' && acme.pinned && acme.direct && acme.installed && acme.hasDocs &&
        !!scoped && scoped.version === '1.0.5' && scoped.installed && scoped.hasDocs &&
        !!ghost && ghost.version === '9.9.9' && ghost.pinned && !ghost.installed && !ghost.hasDocs &&
        !!transitive && !transitive.direct &&
        !!fakePy && fakePy.ecosystem === 'py' && fakePy.version === '2.0.0' && fakePy.pinned && fakePy.installed && fakePy.hasDocs
      const rangeOk = !!loose && loose.version === '>=1.0' && loose.pinned === false && loose.installed === false
      const pyOnly = await call(c1, 'list_libraries', { ecosystem: 'py' })
      const filterOk = pyOnly.ok && rowsOf(pyOnly).length >= 2 && rowsOf(pyOnly).every((r) => r.ecosystem === 'py')

      // ── (b) docs from DISK: version + source stamped, signatures distilled ─
      const docs = await call(c1, 'get_library_docs', { name: 'acme-lib' })
      const sigs = Array.isArray(docs.data.signatures) ? (docs.data.signatures as string[]) : []
      const diskDocsOk =
        docs.ok && docs.data.version === '1.2.3' && docs.data.source === 'disk' && docs.data.hasDocs === true &&
        String(docs.data.readme).includes('ACME_USAGE_4242') &&
        sigs.some((s) => s.includes('acmeGreet')) &&
        Array.isArray(docs.data.exports) && (docs.data.exports as string[]).length > 0
      const topic = await call(c1, 'get_library_docs', { name: 'acme-lib', topic: 'usage' })
      const topicOk =
        topic.ok && String(topic.data.readme).includes('ACME_USAGE_4242') && !String(topic.data.readme).includes('MIT_MARKER_4242')
      const scopedDocs = await call(c1, 'get_library_docs', { name: '@acme/scoped' })
      const scopedOk = scopedDocs.ok && scopedDocs.data.version === '1.0.5' && String(scopedDocs.data.readme).includes('SCOPED_README_4242')
      const pyDocs = await call(c1, 'get_library_docs', { name: 'fake-py' })
      const pyDocsOk = pyDocs.ok && pyDocs.data.version === '2.0.0' && pyDocs.data.source === 'disk' && String(pyDocs.data.readme).includes('FAKEPY_DOC_4242')

      // ── (d1) consent OFF: the fetch verb refuses, ZERO sockets opened ──────
      const noConsent = await call(c1, 'get_library_docs', { name: 'ghost-lib', fetch: true })
      const consentOffOk =
        noConsent.isError && /consent|allowed/i.test(noConsent.text) && connections === 0

      // Without fetch, the missing dep answers honest absence — version-stamped.
      const ghostPlain = await call(c1, 'get_library_docs', { name: 'ghost-lib' })
      const absentOk = ghostPlain.ok && ghostPlain.data.hasDocs === false && ghostPlain.data.version === '9.9.9'

      // ── (d2) consent ON via the ONE per-workspace knob: registry docs land ─
      setLibFetchAllowed(wsA.id, true)
      const fetched = await call(c1, 'get_library_docs', { name: 'ghost-lib', fetch: true })
      const fetchOk =
        fetched.ok && fetched.data.source === 'registry' && fetched.data.version === '9.9.9' &&
        String(fetched.data.readme).includes('GHOST_README_4242') && connections > 0
      // The landing is CACHED: a second ask opens no new socket.
      const connAfterFetch = connections
      const cachedAgain = await call(c1, 'get_library_docs', { name: 'ghost-lib' })
      const cachedOk = cachedAgain.ok && cachedAgain.data.source === 'registry' && connections === connAfterFetch
      // Size cap held on an oversized published README.
      const fat = await call(c1, 'get_library_docs', { name: 'fat-lib', fetch: true })
      const fatOk =
        fat.ok && fat.data.truncated === true && String(fat.data.readme).length <= 65_536 &&
        String(fat.data.readme).includes('FAT_START_4242')

      // ── (e) hostile names: keys, never paths — and never sockets ───────────
      const connBeforeHostile = connections
      const evil = await call(c1, 'get_library_docs', { name: '../../evil', fetch: true })
      const evilPlain = await call(c1, 'get_library_docs', { name: '../../evil' })
      const hostileOk =
        evil.isError && /unknown library/i.test(evil.text) &&
        evilPlain.isError && /unknown library/i.test(evilPlain.text) &&
        connections === connBeforeHostile

      // ── (c) the shell bumps the lockfile → the tick re-resolves ────────────
      const sent = await cli(['send', paneA2, 'node ../ops.mjs bump'])
      if (sent.code !== 0) throw new Error('could not drive the bump pane')
      const rebumped = await waitFor(async () => {
        const l = await call(c1, 'list_libraries', { ecosystem: 'npm' })
        return rowOf(l, 'acme-lib')?.version === '1.3.0'
      })
      const listAfter = await call(c1, 'list_libraries', { ecosystem: 'npm' })
      const acmeAfter = rowOf(listAfter, 'acme-lib')
      const docsAfter = await call(c1, 'get_library_docs', { name: 'acme-lib' })
      const bumpOk =
        rebumped &&
        !!acmeAfter && acmeAfter.version === '1.3.0' && acmeAfter.installed === false &&
        acmeAfter.installedVersion === '1.2.3' && acmeAfter.hasDocs === false &&
        docsAfter.ok && docsAfter.data.hasDocs === false && docsAfter.data.version === '1.3.0' // the old row is PRUNED

      const pass =
        versionsOk && rangeOk && filterOk && diskDocsOk && topicOk && scopedOk && pyDocsOk &&
        consentOffOk && absentOk && fetchOk && cachedOk && fatOk && hostileOk && bumpOk
      result = {
        pass,
        versionsOk,
        rangeOk,
        filterOk,
        diskDocsOk,
        sigCount: sigs.length,
        topicOk,
        scopedOk,
        pyDocsOk,
        consentOffOk,
        consentOffMsg: noConsent.text.slice(0, 200),
        absentOk,
        fetchOk,
        cachedOk,
        fatOk,
        hostileOk,
        bumpOk,
        acmeAfter: acmeAfter ?? null,
        connections,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    for (const c of clients) c.kill()
    try {
      registry?.close()
    } catch {
      /* already down */
    }
    delete process.env.MOGGING_BRAIN_REGISTRY_NPM
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

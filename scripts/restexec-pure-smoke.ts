// The REST-bridge executor suite (ADR 0021, phase-restbridge/02) — pure,
// hermetic, no Electron. qa-smokes gate: RESTEXEC.
//
//   npm run smoke:restexec-pure
//
// A local FIXTURE REST API drives the REAL bridge core
// (src/backend/features/integrations/rest-bridge.ts). The assertions are the
// gate's letter:
//
//   (a) tools/list is exactly the catalog set, names/descriptions verbatim;
//   (b) a read call lands with the key injected per restAuth (the fixture
//       asserts the header), and a bad/unknown/missing arg is a TYPED refusal
//       with ZERO fixture hits;
//   (c) pagination merges the provider's same-origin `next` pages and STOPS at
//       the cap (3 pages, said honestly); the ~50KB response cap truncates with
//       an honest sentence;
//   (d) a 429 carrying the catalog's reset header retries ONCE per the retry
//       grammar — the fixture asserts the spacing;
//   (e) a write tool REFUSES without writeTools:'all' (zero hits, the refusal
//       names the switch) and executes with it (exactly one hit);
//   (f) a path-traversal / absolute-URL arg into a PATH slot is refused with
//       zero fixture hits; `${config}` placeholders resolve from the STORED
//       config only, and an unconfigured one refuses, zero hits.
//
// MUTATION-REDS (proven on every run): (e') the write gate disabled — the
// ungranted write MUST land at the fixture, proving (e)'s zero-hit assertion
// bites; (f') pinning disabled — the traversal arg MUST reach the fixture,
// proving (f)'s refusal is load-bearing, not decorative.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  executeRestTool,
  handleRestBridgeRpc,
  restToolsListResult,
  type RestBridgeService
} from '../src/backend/features/integrations/rest-bridge'
import type { ProviderEntry } from '../src/contracts/integrations/provider-catalog'

let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── The fixture REST API ─────────────────────────────────────────────────────
const hits = { things: [] as Array<{ path: string; auth: string }>, posts: 0, limited: [] as number[], big: 0, cfg: [] as string[] }
let base = ''
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (url.pathname.startsWith('/api/projects/')) {
    hits.things.push({ path: url.pathname + url.search, auth: String(req.headers.authorization ?? '') })
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const pages: Record<number, { results: string[]; next: string | null }> = {
      0: { results: ['a', 'b'], next: `${base}/api/projects/p1/things?offset=2` },
      2: { results: ['c'], next: `${base}/api/projects/p1/things?offset=3` },
      3: { results: ['d'], next: `${base}/api/projects/p1/things?offset=4` },
      4: { results: ['e'], next: null }
    }
    json(200, pages[offset] ?? { results: [], next: null })
    return
  }
  if (url.pathname === '/api/things' && req.method === 'POST') {
    hits.posts++
    json(200, { created: true })
    return
  }
  if (url.pathname === '/api/big') {
    hits.big++
    json(200, { blob: 'x'.repeat(100_000) })
    return
  }
  if (url.pathname === '/api/limited') {
    hits.limited.push(Date.now())
    if (hits.limited.length === 1) json(429, { error: 'rate limited' }, { 'x-reset': '1' })
    else json(200, { ok: true })
    return
  }
  if (url.pathname.startsWith('/cfg/')) {
    hits.cfg.push(url.pathname)
    json(200, { pong: true })
    return
  }
  res.writeHead(404).end('{}')
})

function fixtureEntry(): ProviderEntry {
  return {
    id: 'fixture',
    label: 'Fixture',
    source: 'https://example.com/docs',
    methods: [
      { key: 'api-key', kind: 'apiKey', name: 'Paste an API key', rank: 1, connectionConfig: [{ key: 'REGION', label: 'Region' }] },
      { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
    ],
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Api-Key' },
    requiredPermissions: ['thing:read', 'thing:write'],
    retry: { atHeader: 'x-reset', errorCodes: ['429'] },
    restTools: [
      {
        name: 'list_things',
        description: 'List the things in a project.',
        method: 'GET',
        endpoint: `${base}/api/projects/{project_id}/things`,
        params: [
          { key: 'project_id', in: 'path', type: 'string', required: true },
          { key: 'search', in: 'query', type: 'string' }
        ],
        pagination: { pageParam: 'offset', itemsPath: 'results' },
        source: 'https://example.com/docs/things'
      },
      { name: 'read_blob', description: 'Read the big blob.', method: 'GET', endpoint: `${base}/api/big`, responsePath: 'blob', source: 'https://example.com/docs/big' },
      { name: 'read_limited', description: 'Read the rate-limited thing.', method: 'GET', endpoint: `${base}/api/limited`, source: 'https://example.com/docs/limited' },
      { name: 'ping_region', description: 'Ping the configured region.', method: 'GET', endpoint: `${base}/cfg/\${REGION}/ping`, source: 'https://example.com/docs/ping' },
      {
        name: 'create_thing',
        description: 'Create a thing.',
        method: 'POST',
        endpoint: `${base}/api/things`,
        params: [{ key: 'name', in: 'body', type: 'string', required: true }],
        readOnly: false,
        source: 'https://example.com/docs/things#create'
      }
    ]
  }
}

const svc = (over: Partial<RestBridgeService> = {}): RestBridgeService => ({
  entry: fixtureEntry(),
  token: 'tok123',
  writeGranted: false,
  connectionConfig: { REGION: 'us' },
  ...over
})

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const entry = fixtureEntry()

  // ── (a) tools/list: the catalog set, verbatim ──────────────────────────────
  console.log('(a) tools/list from the catalog')
  {
    const resp = (await handleRestBridgeRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, svc())) as { result: { tools: Array<{ name: string; description: string }> } }
    const tools = resp.result.tools
    check('exactly the catalog set', JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(entry.restTools!.map((t) => t.name)))
    check('descriptions verbatim', tools.every((t, i) => t.description === entry.restTools![i]!.description))
    check('within the anti-explosion cap', tools.length <= 12)
    const init = (await handleRestBridgeRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, svc())) as { result: { serverInfo: { name: string } } }
    check('initialize answers as the house bridge', init.result.serverInfo.name === 'mogging-rest-bridge')
    const note = await handleRestBridgeRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, svc())
    check('a notification gets no response (the spec forbids one)', note === null)
    check('tools/list result matches restToolsListResult verbatim', JSON.stringify(tools) === JSON.stringify(restToolsListResult(entry).tools))
  }

  // ── (b) a read call: key injected, args typed-validated ────────────────────
  console.log('(b) read call + typed refusals')
  {
    hits.things.length = 0
    const out = await executeRestTool('list_things', { project_id: 'p1' }, svc())
    check('the read landed', out.ok)
    check('the key rode restAuth exactly (header + scheme)', hits.things[0]?.auth === 'Api-Key tok123', `saw "${hits.things[0]?.auth}"`)
    const before = hits.things.length
    const badType = await executeRestTool('list_things', { project_id: 42 }, svc())
    check('a mistyped arg is a typed refusal', !badType.ok && badType.text.includes('must be a string'))
    const unknown = await executeRestTool('list_things', { project_id: 'p1', bogus: 1 }, svc())
    check('an unknown arg is a typed refusal naming the valid params', !unknown.ok && unknown.text.includes('Valid params'))
    const missing = await executeRestTool('list_things', {}, svc())
    check('a missing required arg is a typed refusal', !missing.ok && missing.text.includes('Missing required'))
    check('refusals made ZERO fixture hits', hits.things.length === before, `saw ${hits.things.length - before} extra`)
    const noTool = await executeRestTool('nope', {}, svc())
    check('an unknown tool is refused with the real roster', !noTool.ok && noTool.text.includes('list_things'))
  }

  // ── (c) pagination cap + response cap ──────────────────────────────────────
  console.log('(c) pagination + the response cap')
  {
    hits.things.length = 0
    const out = await executeRestTool('list_things', { project_id: 'p1' }, svc())
    check('pages merged across the provider’s next links', out.ok && out.text.startsWith(JSON.stringify(['a', 'b', 'c', 'd'])), out.text.slice(0, 80))
    check('STOPPED at 3 pages (the fixture has 5)', hits.things.length === 3, `saw ${hits.things.length}`)
    check('says more pages exist, honestly', out.text.includes('More pages exist'))
    const big = await executeRestTool('read_blob', {}, svc())
    check('the ~50KB cap truncated', big.ok && big.text.length < 51_000, `len ${big.text.length}`)
    check('…with the honest sentence', big.text.includes('Truncated: the full response exceeded'))
  }

  // ── (d) the catalog retry grammar on 429 ───────────────────────────────────
  console.log('(d) 429 retry per the catalog grammar')
  {
    hits.limited.length = 0
    const out = await executeRestTool('read_limited', {}, svc())
    check('retried once and succeeded', out.ok && hits.limited.length === 2, `hits ${hits.limited.length}`)
    const spacing = (hits.limited[1] ?? 0) - (hits.limited[0] ?? 0)
    check('the spacing honored the provider’s reset header (~1s)', spacing >= 900 && spacing <= 5_000, `spacing ${spacing}ms`)
  }

  // ── (e) the write gate ─────────────────────────────────────────────────────
  console.log('(e) the write gate')
  {
    hits.posts = 0
    const refused = await executeRestTool('create_thing', { name: 'x' }, svc({ writeGranted: false }))
    check('an ungranted write REFUSES, naming the switch', !refused.ok && refused.text.includes('Write tools'))
    check('…with ZERO fixture hits', hits.posts === 0, `saw ${hits.posts}`)
    const allowed = await executeRestTool('create_thing', { name: 'x' }, svc({ writeGranted: true }))
    check('a granted write executes — exactly one hit', allowed.ok && hits.posts === 1, `saw ${hits.posts}`)
    // (e') MUTATION-RED: gate disabled → the ungranted write MUST land.
    const mutated = await executeRestTool('create_thing', { name: 'x' }, svc({ writeGranted: false, _testDisableWriteGate: true }))
    check("mutation-red (e'): without the gate the ungranted write lands — the zero-hit assertion bites", mutated.ok && hits.posts === 2, `saw ${hits.posts}`)
  }

  // ── (f) pinning ────────────────────────────────────────────────────────────
  console.log('(f) pinning: no agent-steered URLs')
  {
    hits.things.length = 0
    const absolute = await executeRestTool('list_things', { project_id: 'https://evil.example/x' }, svc())
    check('an absolute-URL arg into a path slot is refused', !absolute.ok && absolute.text.includes('plain path segment'))
    const traversal = await executeRestTool('list_things', { project_id: '../admin' }, svc())
    check('a traversal arg into a path slot is refused', !traversal.ok && traversal.text.includes('plain path segment'))
    check('both refusals made ZERO fixture hits', hits.things.length === 0, `saw ${hits.things.length}`)
    hits.cfg.length = 0
    const cfg = await executeRestTool('ping_region', {}, svc())
    check('${config} resolved from the STORED config only', cfg.ok && hits.cfg[0] === '/cfg/us/ping', hits.cfg[0])
    const noCfg = await executeRestTool('ping_region', {}, svc({ connectionConfig: {} }))
    check('an unconfigured placeholder refuses, zero hits', !noCfg.ok && noCfg.text.includes('REGION') && hits.cfg.length === 1)
    // (f') MUTATION-RED: pinning disabled → the traversal MUST reach the fixture.
    hits.things.length = 0
    await executeRestTool('list_things', { project_id: '../admin' }, svc({ _testDisablePinning: true }))
    check("mutation-red (f'): without the pin the traversal reaches the fixture — the refusal is load-bearing", hits.things.length >= 1, `saw ${hits.things.length}`)
  }

  server.close()
  if (failures) {
    console.error(`RESTEXEC: ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('RESTEXEC: the bridge executor holds — catalog tools/list, typed refusals, key injection, pagination + response caps, retry grammar, the write gate, pinning (mutation-reds proven live)')
}

main().catch((e) => {
  console.error('RESTEXEC: crashed', e)
  server.close()
  process.exit(1)
})

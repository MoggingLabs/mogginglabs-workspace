#!/usr/bin/env node
// RESTIMPORT — the curator gate (ADR 0021, phase-restbridge/03).
//
//   node scripts/check-restimport.mjs
//
// Drives scripts/curate-rest-tools.mjs against the 20-op fixture spec
// (tests/fixtures/openapi-curator-fixture.json — a FILE: the curator's --url
// convenience never runs inside a gate):
//   (a) menu mode lists all 20 operations, every read ranked before any write;
//   (b) picking 4 emits a draft that PASSES check-catalog --entry except for
//       the deliberate TODO-reword markers (asserted PRESENT on every drafted
//       description — the human rewording pass is forced), and passes CLEAN
//       once the markers are reworded away;
//   (c) picking 13 refuses on the step-01 cap;
//   (d) every emitted `source` names the fixture spec's own URL + the op's
//       JSON pointer;
//   (e) a write op emits `readOnly:false`.
// MUTATION-REDS (live, every run): --test-disable-cap must make the 13-pick
// SUCCEED (proving (c) bites) and --test-no-todo must emit NO marker (proving
// (b)'s marker assertion bites).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SPEC = 'tests/fixtures/openapi-curator-fixture.json'
const SPEC_URL = 'https://api.example.test/docs/openapi.json'

let failures = 0
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Run the curator; capture stdout/stderr/code without throwing. */
function curate(args) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/curate-rest-tools.mjs', SPEC, '--service', 'fixture', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

/** Judge an emitted block with the SAME judge that guards shipped rows. */
function judgeEntry(restTools) {
  const entry = {
    id: 'curated',
    label: 'Curated Fixture',
    source: 'https://api.example.test/docs',
    methods: [
      { key: 'api-key', kind: 'apiKey', name: 'Paste an API key', rank: 1 },
      { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
    ],
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Bearer', source: 'https://api.example.test/docs/auth' },
    requiredPermissions: ['read:all', 'write:all'],
    restTools
  }
  const dir = mkdtempSync(join(tmpdir(), 'restimport-'))
  const file = join(dir, 'curated.json')
  writeFileSync(file, JSON.stringify(entry, null, 2))
  try {
    execFileSync(process.execPath, ['scripts/check-catalog.mjs', '--entry', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, errors: [] }
  } catch (e) {
    const out = String(e.stderr ?? '')
    return { code: e.status ?? 1, errors: out.split('\n').filter((l) => l.trim().startsWith('- ')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── (a) menu mode: 20 ops, read-first ────────────────────────────────────────
console.log('(a) the menu')
{
  const { code, stdout } = curate([])
  const rows = stdout.split('\n').filter((l) => /^\s+\[(read |WRITE)\]/.test(l))
  check('menu exits 0', code === 0)
  check('lists all 20 operations', rows.length === 20, `saw ${rows.length}`)
  const lastRead = rows.map((l, i) => (l.includes('[read ]') ? i : -1)).filter((i) => i >= 0).pop()
  const firstWrite = rows.findIndex((l) => l.includes('[WRITE]'))
  check('every read ranks before any write', firstWrite === -1 || (lastRead != null && lastRead < firstWrite), `lastRead ${lastRead}, firstWrite ${firstWrite}`)
  check('reads outnumber writes in the fixture (11/9)', rows.filter((l) => l.includes('[read ]')).length === 11)
}

// ── (b) picking 4: a draft that passes, markers forced ───────────────────────
console.log('(b) the 4-pick draft')
const PICK4 = 'listUsers,getUser,createUser,deleteWebhook'
{
  const { code, stdout } = curate(['--pick', PICK4])
  check('emit exits 0', code === 0)
  let block = null
  try {
    block = JSON.parse(stdout)
  } catch {
    /* checked below */
  }
  check('stdout is a paste-able JSON block', !!block && Array.isArray(block.restTools) && block.restTools.length === 4)
  if (block) {
    const tools = block.restTools
    check('every drafted description carries TODO-reword (the human pass is forced)', tools.every((t) => t.description.includes('TODO-reword')))
    const judged = judgeEntry(tools)
    check('the ONLY failures are the TODO-reword markers', judged.code === 1 && judged.errors.length > 0 && judged.errors.every((l) => l.includes('TODO-reword')), judged.errors.join(' | '))
    const reworded = tools.map((t) => ({ ...t, description: t.description.replace(/TODO-reword:\s*/g, '') }))
    check('reworded, the same block passes the shipped-row judge clean', judgeEntry(reworded).code === 0)
    // (d) provenance pointers
    check('(d) every source names the spec URL + the op pointer', tools.every((t) => t.source.startsWith(`${SPEC_URL}#/paths/`)))
    check('(d) the pointer names the op itself', tools.some((t) => t.source.endsWith('/get')) && tools.some((t) => t.source.endsWith('/post')))
    // (e) verb → readOnly
    const create = tools.find((t) => t.name === 'create_user')
    const del = tools.find((t) => t.name === 'delete_webhook')
    const read = tools.find((t) => t.name === 'get_user')
    check('(e) write ops emit readOnly:false', create?.readOnly === false && del?.readOnly === false)
    check('(e) read ops stay read (no explicit readOnly needed)', read != null && !('readOnly' in read))
    // typed params rode across
    check('typed params mapped (path required, body required honored)', read?.params?.some((p) => p.key === 'user_id' && p.in === 'path' && p.required === true) === true && create?.params?.some((p) => p.key === 'email' && p.in === 'body' && p.required === true) === true)
  }
}

// ── (c) the cap refusal ──────────────────────────────────────────────────────
console.log('(c) the cap')
const PICK13 = 'listUsers,getUser,listUserKeys,listProjects,getProject,listItems,getItem,getMetrics,getHealth,listWebhooks,searchEverything,createUser,createProject'
{
  const { code, stderr } = curate(['--pick', PICK13])
  check('picking 13 refuses', code !== 0)
  check('…with the Speakeasy sentence (fewer, better-worded tools beat coverage)', (stderr ?? '').includes('Fewer, better-worded tools beat coverage'))
}

// ── mutation-reds: the assertions bite ───────────────────────────────────────
console.log('(m) mutation-reds')
{
  const uncapped = curate(['--pick', PICK13, '--test-disable-cap'])
  check("mutation-red (c'): with the cap disabled the 13-pick SUCCEEDS — the refusal assertion bites", uncapped.code === 0 && JSON.parse(uncapped.stdout).restTools.length === 13)
  const unstamped = curate(['--pick', PICK4, '--test-no-todo'])
  check("mutation-red (b'): with stamping disabled NO marker is emitted — the marker assertion bites", unstamped.code === 0 && !unstamped.stdout.includes('TODO-reword'))
}

if (failures) {
  console.error(`RESTIMPORT: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('RESTIMPORT: the curator holds — read-first menu, forced TODO-reword drafts that pass the shipped-row judge once reworded, provenance pointers, verb-derived readOnly, the cap (mutation-reds proven live)')

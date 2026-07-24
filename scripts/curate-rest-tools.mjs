#!/usr/bin/env node
// The OpenAPI curator (ADR 0021, phase-restbridge/03): specs in, DRAFTS out,
// humans decide.
//
//   node scripts/curate-rest-tools.mjs <spec-path-or-url> --service <id> [--pick op1,op2…]
//
// Reads an OpenAPI 3.x document (JSON or YAML — the repo's own yaml dep) and:
//   · WITHOUT --pick: prints a MENU of candidate operations (method, path,
//     operationId, summary, param count, read/write guess), ranked read-first;
//   · WITH --pick: emits a DRAFT `restTools` JSON block to STDOUT — names
//     snake_cased from operationId and descriptions from summary, every one
//     stamped `TODO-reword` so the agent-UX naming pass can never be skipped
//     (RESTSCHEMA fails any shipped row still carrying the marker); typed
//     params mapped (path/query/body, required honored); `readOnly:false` from
//     the HTTP verb; per-tool `source` = the spec's own URL + the op's JSON
//     pointer; and the step-01 CAP enforced at emit.
//
// The curator NEVER writes into catalog/ — stdout only. The human pastes,
// rewords, dev-verifies, and CATSCHEMA/RESTSCHEMA judge the result. It runs
// OFFLINE against a file; fetching a URL is a convenience that must never run
// inside any gate (the RESTIMPORT fixture is a file).
//
// TEST-ONLY flags (the RESTIMPORT mutation-reds, the TOOLCRED _testDisableLock
// precedent): --test-disable-cap and --test-no-todo exist so the gate can prove
// the cap refusal and the TODO stamping are load-bearing. Never use them by hand.
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : ''
}
const has = (name) => argv.includes(name)
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--') || ['--test-disable-cap', '--test-no-todo'].includes(argv[i - 1])))

const specArg = positional[0]
const service = flag('--service')
const pick = flag('--pick')
const sourceOverride = flag('--source')
const CAP = 12

if (!specArg || !service) {
  console.error('usage: node scripts/curate-rest-tools.mjs <spec-path-or-url> --service <id> [--pick op1,op2…] [--source <url>]')
  process.exit(2)
}

async function loadSpec(arg) {
  if (/^https?:\/\//.test(arg)) {
    // Convenience only — never inside a gate.
    const res = await fetch(arg, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`fetching the spec answered ${res.status}`)
    return { text: await res.text(), url: arg }
  }
  return { text: readFileSync(arg, 'utf8'), url: null }
}

const toSnake = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/^[^a-z]+/, '') || 'unnamed_op'

const pointerEscape = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1')

const TYPE_MAP = { integer: 'integer', number: 'number', boolean: 'boolean' }
const mapType = (schema) => TYPE_MAP[schema?.type] ?? 'string'

/** Collect every operation: op-level parameters merged over path-level ones. */
function collectOps(spec) {
  const ops = []
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
    for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method]
      if (!op || typeof op !== 'object') continue
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
      const bodySchema = op.requestBody?.content?.['application/json']?.schema
      ops.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId ?? `${method}_${path}`,
        summary: op.summary ?? op.description?.split('\n')[0] ?? '',
        params,
        bodySchema,
        read: method === 'get' || method === 'head'
      })
    }
  }
  // Read-first, then by path — the menu leads with what an agent should mostly get.
  return ops.sort((a, b) => Number(b.read) - Number(a.read) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

function draftTool(op, spec, sourceBase, noTodo) {
  const server = spec.servers?.[0]?.url ?? ''
  if (!/^https:\/\//.test(server)) {
    throw new Error(`the spec's servers[0].url ("${server}") is not https — pass a spec that names its real base URL`)
  }
  const params = []
  for (const p of op.params) {
    if (p.in !== 'path' && p.in !== 'query') continue // header/cookie params never ride a curated tool
    params.push({
      key: p.name,
      in: p.in,
      type: mapType(p.schema),
      ...(p.required || p.in === 'path' ? { required: true } : {}),
      ...(p.description ? { description: p.description } : {})
    })
  }
  const bodyProps = op.bodySchema?.properties ?? {}
  const bodyRequired = new Set(Array.isArray(op.bodySchema?.required) ? op.bodySchema.required : [])
  for (const [key, prop] of Object.entries(bodyProps)) {
    if (prop && typeof prop === 'object' && (prop.type === 'object' || prop.type === 'array')) continue // primitives only — a complex body is a curation decision
    params.push({
      key,
      in: 'body',
      type: mapType(prop),
      ...(bodyRequired.has(key) ? { required: true } : {}),
      ...(prop?.description ? { description: prop.description } : {})
    })
  }
  const todo = noTodo ? '' : 'TODO-reword: '
  return {
    name: toSnake(op.operationId),
    description: `${todo}${op.summary || op.operationId}`,
    method: op.method,
    endpoint: `${server.replace(/\/+$/, '')}${op.path}`,
    ...(params.length ? { params } : {}),
    ...(op.read ? {} : { readOnly: false }),
    source: `${sourceBase}#/paths/${pointerEscape(op.path)}/${op.method.toLowerCase()}`
  }
}

async function main() {
  const { text, url } = await loadSpec(specArg)
  let spec
  try {
    spec = JSON.parse(text)
  } catch {
    spec = parseYaml(text)
  }
  if (!spec || typeof spec !== 'object' || !spec.paths) throw new Error('that is not an OpenAPI 3.x document (no paths)')
  const sourceBase = sourceOverride || url || spec.externalDocs?.url || ''
  const ops = collectOps(spec)

  if (!pick) {
    // The MENU — stderr-adjacent by intent? No: the menu IS the output here.
    console.log(`# ${spec.info?.title ?? 'OpenAPI'} — ${ops.length} operations for --service ${service} (read-first). Pick with --pick op1,op2…`)
    for (const op of ops) {
      const n = op.params.filter((p) => p.in === 'path' || p.in === 'query').length + Object.keys(op.bodySchema?.properties ?? {}).length
      console.log(`  [${op.read ? 'read ' : 'WRITE'}] ${op.method.padEnd(6)} ${op.path.padEnd(32)} ${String(op.operationId).padEnd(24)} ${String(n).padStart(2)} params${op.summary ? ` — ${op.summary}` : ''}`)
    }
    return
  }

  if (!/^https:\/\//.test(sourceBase)) {
    throw new Error('cannot stamp per-tool provenance: pass --source <https url of the spec> (or use a spec with externalDocs.url)')
  }
  const wanted = pick.split(',').map((s) => s.trim()).filter(Boolean)
  const byId = new Map(ops.map((o) => [o.operationId, o]))
  const missing = wanted.filter((w) => !byId.has(w))
  if (missing.length) {
    throw new Error(`unknown operation(s): ${missing.join(', ')} — run without --pick to see the menu`)
  }
  if (wanted.length > CAP && !has('--test-disable-cap')) {
    console.error(
      `Refused: ${wanted.length} tools exceeds the cap of ${CAP}. Fewer, better-worded tools beat coverage — ` +
        `curation is the load-bearing practice (docs/research/2026-07-rest-bridge-survey.md). Trim the pick.`
    )
    process.exit(1)
  }
  const tools = wanted.map((w) => draftTool(byId.get(w), spec, sourceBase, has('--test-no-todo')))
  // STDOUT only, paste-able. The human rewords every TODO-reword, drops what an
  // agent should not do unattended, dev-verifies, and the gates judge the rest.
  console.log(JSON.stringify({ restTools: tools }, null, 2))
  console.error(`# DRAFT for "${service}": ${tools.length} tool(s). Every name/description is TODO-reword — the block cannot ship until it is reworded (RESTSCHEMA bites the marker).`)
}

main().catch((e) => {
  console.error(`curate-rest-tools: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})

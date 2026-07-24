#!/usr/bin/env node
// CATSCHEMA — the provider-catalog gate (ADR 0020, phase-tools/01).
//
//   node scripts/check-catalog.mjs            # validate the live catalog
//   node scripts/check-catalog.mjs --selftest # bite proof: every rule must catch its fixture
//
// The catalog (src/contracts/integrations/catalog/*.json) is the single source of
// truth for every integration fact — so a malformed row is a product bug that would
// otherwise surface as a broken chooser, a silent identity blank, or a probe that
// never fires. This gate holds five promises:
//   1. every file validates against schema.json (structural, hand-rolled — no deps);
//   2. every entry carries `source:` provenance (the license-lane discipline: Nango/
//      Metorial content is ideas-only, so every fact must name the primary doc —
//      or the repo://presets.json row it was mechanically migrated from);
//   3. every OAuth method that declares scopes declares them HUMANIZED
//      ({scope,title}) — a raw scope string is not a sentence a user can consent to;
//   4. ids are unique and match their filename;
//   5. nothing secret-shaped hides in the data (known prefixes + entropy scan) —
//      the catalog is committed plaintext and must stay boring;
//   6. RESTSCHEMA (ADR 0021, phase-restbridge/01): a row's curated `restTools`
//      block obeys the curation law — ≤12 tools, ≥1 read-only, snake_case unique
//      names, typed params, per-tool provenance, pinned https endpoints whose only
//      interpolation is declared connectionConfig keys, restAuth + requiredPermissions
//      present. The data is DARK until the step-02 executor; the rules bite now.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DIR = join(ROOT, 'src', 'contracts', 'integrations', 'catalog')

// ── Minimal structural validator (draft-07 subset: the features schema.json uses) ──
function validate(schema, value, path, errors) {
  if (schema.enum) {
    if (!schema.enum.includes(value)) errors.push(`${path}: expected one of ${schema.enum.join('|')}, got ${JSON.stringify(value)}`)
    return
  }
  const type = schema.type
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`)
      return
    }
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`)
    }
    const props = schema.properties ?? {}
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown property "${k}"`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, `${path}.${k}`, errors)
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`)
      return
    }
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`)
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: exceeds the cap of ${schema.maxItems} item(s)`)
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors))
    return
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path}: expected string`)
      return
    }
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`)
    return
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`)
    else if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`)
    return
  }
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean`)
}

// ── Secret scan: the catalog must stay boring plaintext ──────────────────────
const SECRET_PREFIXES = /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9]{16,}|sk_live_|rk_live_|whsec_|glpat-|lin_api_|ntn_[A-Za-z0-9]{20,}|phx_[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/
function entropyish(s) {
  // long single-token base64/hex-ish runs; URLs and ${REFS} are exempt by shape
  if (s.length < 40 || /\s|:\/\/|\$\{/.test(s)) return false
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length
  return classes >= 3
}
function scanSecrets(value, path, errors) {
  if (typeof value === 'string') {
    if (SECRET_PREFIXES.test(value)) errors.push(`${path}: secret-shaped literal (known prefix)`)
    else if (entropyish(value)) errors.push(`${path}: secret-shaped literal (high-entropy token)`)
    return
  }
  if (Array.isArray(value)) value.forEach((v, i) => scanSecrets(v, `${path}[${i}]`, errors))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scanSecrets(v, `${path}.${k}`, errors)
}

function checkEntry(name, entry, schema) {
  const errors = []
  validate(schema, entry, name, errors)
  if (entry && typeof entry === 'object') {
    if (typeof entry.source !== 'string' || entry.source.length < 8) {
      errors.push(`${name}: missing source provenance`)
    }
    if (entry.id && name !== 'selftest' && `${entry.id}.json` !== name) {
      errors.push(`${name}: id "${entry.id}" does not match filename`)
    }
    for (const m of Array.isArray(entry.methods) ? entry.methods : []) {
      if (m?.kind === 'oauth' && Array.isArray(m.scopes)) {
        for (const s of m.scopes) {
          if (!s || typeof s.title !== 'string' || !s.title.trim()) {
            errors.push(`${name}: oauth scope "${s?.scope}" lacks a humanized title`)
          }
        }
      }
    }
    // Profile specs (phase-tools/04): the identity executor is only as honest as the
    // data. A rest/oidc spec that fetches must name where; a fetching spec must map
    // at least `id` plus one HUMAN identifier (email or name) — an identity that
    // names nobody renders nothing and hides a broken spec forever; and any fetching
    // or tool spec carries its own provenance (the license-lane discipline applies
    // to identity facts too). A `tool` spec must name its tool.
    const p = entry.profile
    if (p && typeof p === 'object') {
      if ((p.via === 'rest' || p.via === 'oidc') && p.url) {
        if (!p.paths || typeof p.paths.id !== 'string' || !p.paths.id.trim()) {
          errors.push(`${name}: profile (${p.via}) must map paths.id`)
        }
        if (!p.paths || (!p.paths.email && !p.paths.name)) {
          errors.push(`${name}: profile (${p.via}) must map paths.email or paths.name`)
        }
      }
      if (p.via === 'rest' && !p.url) errors.push(`${name}: profile (rest) must name its url`)
      if (p.via === 'tool' && (typeof p.tool !== 'string' || !p.tool.trim())) {
        errors.push(`${name}: profile (tool) must name its tool`)
      }
      if ((p.via === 'rest' || p.via === 'tool' || p.url) && (typeof p.source !== 'string' || p.source.length < 8)) {
        errors.push(`${name}: profile lacks source provenance`)
      }
    }
    // RESTSCHEMA (ADR 0021, phase-restbridge/01): curated restTools are DATA the
    // house bridge will execute — so the curation law is enforced here, before a
    // single request flows. The cap and read-floor kill tool explosion and
    // write-by-default; pinned interpolation kills arbitrary-URL execution;
    // per-tool provenance keeps the license lanes honest.
    const tools = entry.restTools
    if (Array.isArray(tools)) {
      const auth = entry.restAuth
      if (!auth || typeof auth !== 'object') {
        errors.push(`${name}: restTools requires restAuth (one key-carriage declaration every tool reuses)`)
      } else {
        if (auth.in === 'header' && (typeof auth.header !== 'string' || !auth.header.trim())) {
          errors.push(`${name}: restAuth (header) must name its header`)
        }
        if (auth.in === 'query' && (typeof auth.queryParam !== 'string' || !auth.queryParam.trim())) {
          errors.push(`${name}: restAuth (query) must name its query param`)
        }
      }
      if (!Array.isArray(entry.requiredPermissions) || entry.requiredPermissions.length === 0) {
        errors.push(`${name}: restTools requires requiredPermissions (least privilege as data)`)
      }
      const cfgKeys = new Set(
        (Array.isArray(entry.methods) ? entry.methods : []).flatMap((m) =>
          (Array.isArray(m?.connectionConfig) ? m.connectionConfig : []).map((c) => c?.key)
        )
      )
      const toolNames = new Set()
      let readTools = 0
      for (const t of tools) {
        if (!t || typeof t !== 'object') continue
        if (typeof t.name === 'string') {
          if (toolNames.has(t.name)) errors.push(`${name}: duplicate restTools name "${t.name}"`)
          toolNames.add(t.name)
        }
        if (t.readOnly !== false) readTools++
        if (t.method && t.method !== 'GET' && typeof t.readOnly !== 'boolean') {
          errors.push(`${name}: restTools "${t.name}" (${t.method}) must declare readOnly explicitly — a mutating method is never read-only by silence`)
        }
        if (typeof t.endpoint === 'string') {
          for (const m of t.endpoint.matchAll(/\$\{([^}]*)\}/g)) {
            if (!cfgKeys.has(m[1])) {
              errors.push(`${name}: restTools "${t.name}" endpoint interpolates \${${m[1]}} — not a declared connectionConfig key (endpoints are pinned; no free interpolation)`)
            }
          }
        }
        for (const p of Array.isArray(t.params) ? t.params : []) {
          if (p?.in === 'path' && typeof t.endpoint === 'string' && !t.endpoint.includes(`{${p.key}}`)) {
            errors.push(`${name}: restTools "${t.name}" path param "${p.key}" has no {${p.key}} slot in the pinned endpoint`)
          }
        }
        if (typeof t.source !== 'string' || t.source.length < 8) {
          errors.push(`${name}: restTools "${t.name}" lacks per-tool source provenance`)
        }
      }
      if (readTools === 0) {
        errors.push(`${name}: restTools has no read-only tool — a service whose only tools are writes is a curation smell`)
      }
    }
    scanSecrets(entry, name, errors)
  }
  return errors
}

function run() {
  const schema = JSON.parse(readFileSync(join(DIR, 'schema.json'), 'utf8'))
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'schema.json')
  const errors = []
  const ids = new Map()
  for (const f of files) {
    let entry
    try {
      entry = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
    } catch (e) {
      errors.push(`${f}: unparseable JSON (${e.message})`)
      continue
    }
    errors.push(...checkEntry(f, entry, schema))
    if (entry?.id) {
      if (ids.has(entry.id)) errors.push(`${f}: duplicate id "${entry.id}" (also ${ids.get(entry.id)})`)
      ids.set(entry.id, f)
    }
  }
  if (files.length === 0) errors.push('catalog is empty — nothing validated is not a pass')
  return { files: files.length, errors }
}

// ── Bite proof: every rule must catch a fixture built to violate it ───────────
function selftest() {
  const schema = JSON.parse(readFileSync(join(DIR, 'schema.json'), 'utf8'))
  const good = {
    id: 'selftest',
    label: 'Self Test',
    source: 'https://example.com/docs',
    mcp: { transport: 'http', url: 'https://example.com/mcp' },
    methods: [
      {
        key: 'browser',
        kind: 'oauth',
        name: 'Sign in with your browser',
        rank: 1,
        scopes: [{ scope: 'a', title: 'A thing' }],
        connectionConfig: [{ key: 'INSTANCE_URL', label: 'Instance URL' }]
      }
    ],
    profile: { via: 'rest', url: 'https://example.com/me', paths: { id: 'id', email: 'email' }, source: 'https://example.com/docs/me' },
    // RESTSCHEMA fixture (ADR 0021): one read tool with a path param + pagination,
    // one write tool riding a declared connectionConfig placeholder.
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Bearer', source: 'https://example.com/docs/auth' },
    requiredPermissions: ['thing:read', 'thing:write'],
    setupTokenUrl: 'https://example.com/settings/tokens/new?scopes=thing:read',
    restTools: [
      {
        name: 'list_things',
        description: 'List the things in a project.',
        method: 'GET',
        endpoint: 'https://example.com/api/projects/{project_id}/things',
        params: [{ key: 'project_id', in: 'path', type: 'string', required: true, description: 'Project id' }],
        pagination: { pageParam: 'offset', itemsPath: 'results' },
        source: 'https://example.com/docs/things'
      },
      {
        name: 'create_thing',
        description: 'Create a thing on your instance.',
        method: 'POST',
        endpoint: 'https://${INSTANCE_URL}/api/things',
        params: [{ key: 'name', in: 'body', type: 'string', required: true }],
        readOnly: false,
        source: 'https://example.com/docs/things#create'
      }
    ]
  }
  const mutations = [
    ['missing-source', (e) => delete e.source],
    ['missing-methods', (e) => delete e.methods],
    ['bad-kind', (e) => (e.methods[0].kind = 'wat')],
    ['unhumanized-scope', (e) => (e.methods[0].scopes = [{ scope: 'repo', title: '' }])],
    ['unknown-prop', (e) => (e.bogus = true)],
    ['secret-prefix', (e) => (e.grantCopy = 'token ghp_0123456789abcdefghij0123456789abcdef')],
    ['secret-entropy', (e) => (e.docsLinksNote = 'A'.repeat(0) + 'Qk3xLmP9vTzR7yWcH2dJ5nB8fKsG4aUe6oXiC1rMwqZt')],
    // phase-tools/04: the profile-spec rules must bite too.
    ['profile-no-id-path', (e) => delete e.profile.paths.id],
    ['profile-no-human-path', (e) => delete e.profile.paths.email],
    ['profile-rest-no-url', (e) => delete e.profile.url],
    ['profile-no-provenance', (e) => delete e.profile.source],
    ['profile-tool-unnamed', (e) => (e.profile = { via: 'tool' })],
    // phase-restbridge/01: the RESTSCHEMA rules must bite too.
    ['rest-cap-breach', (e) => (e.restTools = Array.from({ length: 13 }, (_, i) => ({ ...e.restTools[0], name: `tool_${i}` })))],
    ['rest-tool-unnamed-source', (e) => delete e.restTools[0].source],
    ['rest-loose-interpolation', (e) => (e.restTools[1].endpoint = 'https://example.com/api/${NOT_DECLARED}/things')],
    ['rest-all-writes', (e) => (e.restTools = [e.restTools[1]])],
    ['rest-dup-names', (e) => (e.restTools[1].name = e.restTools[0].name)],
    ['rest-bad-name', (e) => (e.restTools[0].name = 'ListThings')],
    ['rest-name-too-long', (e) => (e.restTools[0].name = 'a'.repeat(41))],
    ['rest-untyped-param', (e) => delete e.restTools[0].params[0].type],
    ['rest-no-auth', (e) => delete e.restAuth],
    ['rest-auth-headerless', (e) => delete e.restAuth.header],
    ['rest-no-permissions', (e) => delete e.requiredPermissions],
    ['rest-write-by-silence', (e) => delete e.restTools[1].readOnly],
    ['rest-path-param-unslotted', (e) => (e.restTools[0].endpoint = 'https://example.com/api/things')],
    ['rest-http-endpoint', (e) => (e.restTools[0].endpoint = 'http://example.com/api/{project_id}/things')]
  ]
  let failed = 0
  if (checkEntry('selftest', structuredClone(good), schema).length !== 0) {
    console.error('selftest: the clean fixture did not pass — validator broken')
    failed++
  }
  for (const [label, mutate] of mutations) {
    const e = structuredClone(good)
    mutate(e)
    if (label === 'unknown-prop') e.bogus = true
    const errs = checkEntry('selftest', e, schema)
    if (errs.length === 0) {
      console.error(`selftest: mutation "${label}" was NOT caught — the gate does not bite`)
      failed++
    }
  }
  return failed
}

if (process.argv.includes('--selftest')) {
  const failed = selftest()
  if (failed) process.exit(1)
  console.log('CATSCHEMA selftest: every mutation caught, RESTSCHEMA rules included (gate bites)')
  process.exit(0)
}

const { files, errors } = run()
if (errors.length) {
  console.error(`CATSCHEMA: ${errors.length} problem(s) across ${files} catalog file(s):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`CATSCHEMA: ${files} catalog entries valid (schema, provenance, humanized scopes, unique ids, no secret-shaped literals, restTools curation law)`)

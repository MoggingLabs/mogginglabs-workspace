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
//      the catalog is committed plaintext and must stay boring.
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
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors))
    return
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path}: expected string`)
      return
    }
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
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
    methods: [{ key: 'browser', kind: 'oauth', name: 'Sign in with your browser', rank: 1, scopes: [{ scope: 'a', title: 'A thing' }] }]
  }
  const mutations = [
    ['missing-source', (e) => delete e.source],
    ['missing-methods', (e) => delete e.methods],
    ['bad-kind', (e) => (e.methods[0].kind = 'wat')],
    ['unhumanized-scope', (e) => (e.methods[0].scopes = [{ scope: 'repo', title: '' }])],
    ['unknown-prop', (e) => (e.bogus = true)],
    ['secret-prefix', (e) => (e.grantCopy = 'token ghp_0123456789abcdefghij0123456789abcdef')],
    ['secret-entropy', (e) => (e.docsLinksNote = 'A'.repeat(0) + 'Qk3xLmP9vTzR7yWcH2dJ5nB8fKsG4aUe6oXiC1rMwqZt')]
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
  console.log('CATSCHEMA selftest: every mutation caught (gate bites)')
  process.exit(0)
}

const { files, errors } = run()
if (errors.length) {
  console.error(`CATSCHEMA: ${errors.length} problem(s) across ${files} catalog file(s):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`CATSCHEMA: ${files} catalog entries valid (schema, provenance, humanized scopes, unique ids, no secret-shaped literals)`)

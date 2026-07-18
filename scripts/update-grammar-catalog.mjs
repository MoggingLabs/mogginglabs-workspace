#!/usr/bin/env node
// The grammar-catalog UPDATER — the operator half of the pair (the agent-settings
// precedent: update-agent-settings-catalog.mjs writes, check-agent-settings-catalog.mjs
// gates).
//
//   npm run catalog:grammars:update           refresh every row from its pinned repo
//   npm run catalog:grammars:update -- --force  re-download even when the tag matches
//
// OPERATOR-RUN, NETWORK. This script is the ONLY writer of sha256/version/releaseTag in
// src/backend/features/brain/grammars.json, and the only thing that ever downloads a
// grammar. It never runs in CI or the sweep — the sweep runs the offline CHECK
// (scripts/check-grammar-catalog.mjs, the GRAMMARCAT gate), which holds the committed
// artifacts to the hashes this script pinned. Upstream drift therefore lands as a
// deliberate, verified, committed diff — never as a surprise at install or index time.
//
// Per row: query the pinned sourceRepo's latest GitHub release, find the asset named by
// the row's `wasm`, download it, and VERIFY before a single byte lands in the tree —
// the wasm must load under web-tree-sitter, parse a per-language probe snippet without
// syntax errors, and (when queries/<lang>.scm exists) still COMPILE the language's tag
// query, so a grammar that renamed its node types fails HERE, loudly, instead of inside
// the indexer at runtime. Only then are the artifact + hash + version + tag rewritten.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = join(ROOT, 'src/backend/features/brain/grammars.json')
const GRAMMARS_DIR = join(ROOT, 'assets/grammars')
const QUERIES_DIR = join(GRAMMARS_DIR, 'queries')
const FORCE = process.argv.includes('--force')

// One tiny known-good snippet per language: the load probe must parse it with ZERO
// syntax errors, or the artifact is refused. Deliberately boring code — the point is
// "this wasm is a working grammar", not coverage (BRAINPARSE owns behavior).
const PROBES = {
  typescript: 'const n: number = 1\nfunction f(): number { return n }\n',
  tsx: 'const el = <div a="b">hi</div>\n',
  javascript: 'function f() { return 1 }\nf()\n',
  python: 'def f():\n    return 1\n\nf()\n',
  go: 'package main\n\nfunc f() int { return 1 }\n',
  rust: 'fn f() -> i32 { 1 }\n',
  java: 'class A { int f() { return 1; } }\n',
  c: 'int f(void) { return 1; }\n',
  cpp: 'class A {};\nint f() { return 1; }\n',
  c_sharp: 'class A { int F() { return 1; } }\n',
  ruby: 'def f\n  1\nend\n',
  php: '<?php\nfunction f() { return 1; }\n',
  bash: 'f() {\n  echo hi\n}\n',
  json: '{ "a": 1 }\n',
  yaml: 'a: 1\nb: two\n',
  toml: 'a = 1\n\n[table]\nb = 2\n',
  html: '<html><body><p>hi</p></body></html>\n',
  css: 'body { color: red; }\n'
}

const die = (msg) => {
  console.error(`\nGRAMMAR UPDATE: ${msg}\n`)
  process.exit(1)
}

const gh = async (path) => {
  const headers = { 'User-Agent': 'mogging-grammar-catalog', Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) die(`GitHub ${path} answered ${res.status} ${res.statusText}`)
  return res.json()
}

const download = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'mogging-grammar-catalog' } })
  if (!res.ok) die(`download ${url} answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ── The verifier: load + probe-parse + query-compile, all in THIS process ─────────
const { Parser, Language, Query } = await import('web-tree-sitter')
await Parser.init({
  wasmBinary: readFileSync(join(ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'))
})

async function verify(lang, bytes) {
  const language = await Language.load(bytes)
  const parser = new Parser()
  parser.setLanguage(language)
  const probe = PROBES[lang]
  if (!probe) die(`${lang}: no probe snippet — add one to PROBES before updating`)
  const tree = parser.parse(probe)
  if (!tree) die(`${lang}: the downloaded wasm refused to parse its probe snippet`)
  if (tree.rootNode.hasError) die(`${lang}: probe snippet parses WITH ERRORS — wrong or broken grammar build`)
  const queryFile = join(QUERIES_DIR, `${lang}.scm`)
  if (existsSync(queryFile)) {
    try {
      new Query(language, readFileSync(queryFile, 'utf8'))
    } catch (e) {
      die(`${lang}: queries/${lang}.scm no longer compiles against the new grammar — ${e.message}\n  (the grammar renamed node types; update the query in the SAME commit)`)
    }
  }
  parser.delete()
  return true
}

// ── Main: one release query per repo, verify + pin per row ────────────────────────
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
mkdirSync(GRAMMARS_DIR, { recursive: true })

const byRepo = new Map()
for (const row of catalog.grammars) {
  if (!byRepo.has(row.sourceRepo)) byRepo.set(row.sourceRepo, [])
  byRepo.get(row.sourceRepo).push(row)
}

let updated = 0
let fresh = 0
for (const [repo, rows] of byRepo) {
  const release = await gh(`/repos/${repo}/releases/latest`)
  const tag = release.tag_name
  for (const row of rows) {
    const artifact = join(GRAMMARS_DIR, row.wasm)
    const current =
      existsSync(artifact) && row.sha256 && sha256(readFileSync(artifact)) === row.sha256
    if (!FORCE && current && row.releaseTag === tag) {
      fresh += 1
      console.log(`  ${row.lang.padEnd(12)} up to date (${tag})`)
      continue
    }
    const asset = (release.assets ?? []).find((a) => a.name === row.wasm)
    if (!asset) die(`${repo}@${tag} publishes no asset named ${row.wasm}`)
    const bytes = await download(asset.browser_download_url)
    await verify(row.lang, bytes)
    writeFileSync(artifact, bytes)
    row.sha256 = sha256(bytes)
    row.version = tag.replace(/^v/, '')
    row.releaseTag = tag
    updated += 1
    console.log(`  ${row.lang.padEnd(12)} ${tag}  ${(bytes.length / 1024).toFixed(0)} kB  ${row.sha256.slice(0, 12)}…`)
  }
}

writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n')
console.log(`\ngrammar catalog: ${updated} updated, ${fresh} already current.`)
console.log('Run `npm run catalog:grammars:check` (the GRAMMARCAT gate) before committing.')

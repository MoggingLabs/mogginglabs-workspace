#!/usr/bin/env node
// Every file the installed CLI imports must be installed WITH it, and must land BEFORE the
// file that imports it.
//
// src/main/cli-runtime.ts copies a hand-written list of files out of bin/ into the user's
// runtime directory. Nothing checked that the list covers what bin/ actually imports. Add a
// helper to bin/lib/, import it from mogging.mjs, forget the list, and:
//
//   - the repo keeps working, because there the file is simply on disk next to its importer;
//   - every INSTALLED copy dies with ERR_MODULE_NOT_FOUND on every invocation, including the
//     `mogging notify` hook that agents call on each turn.
//
// The divergence is the whole danger: the failure cannot be reproduced by running the thing
// you just edited. So this walks the real import graph from each installed entry and asserts
// the list covers it, rather than asking a human to remember.
//
// Order matters too. The list is copied top-down into a live directory, so a `mogging` run
// landing mid-copy must never find an entry whose import target has not arrived — the header
// in cli-runtime.ts already states this rule, and this gate is what holds it.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const BIN = join(REPO, 'bin')
const RUNTIME = join(REPO, 'src', 'main', 'cli-runtime.ts')

const fail = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}

// ---- the declared list -------------------------------------------------------------------
// SATELLITES entries are `join('lib','x.mjs')` or a bare 'x.mjs'. Read them in order.
const src = readFileSync(RUNTIME, 'utf8')
const block = src.match(/const SATELLITES = \[([\s\S]*?)\n\] as const/)
if (!block) {
  console.error('FAIL could not find `const SATELLITES = [ … ] as const` in src/main/cli-runtime.ts')
  console.error('     If it was renamed or restructured, update this gate — do not delete it.')
  process.exit(1)
}

const declared = []
for (const line of block[1].split('\n')) {
  if (line.trim().startsWith('//')) continue
  const j = line.match(/join\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/)
  if (j) {
    declared.push(`${j[1]}/${j[2]}`)
    continue
  }
  const bare = line.match(/^\s*'([^']+)'\s*,?\s*$/)
  if (bare) declared.push(bare[1])
}

// A gate that scans nothing prints OK forever. Pin the floor.
if (declared.length < 4) {
  console.error(`FAIL parsed only ${declared.length} SATELLITES entries — the parser has rotted, not the list`)
  process.exit(1)
}

const rank = new Map(declared.map((f, i) => [f, i]))

// ---- the real import graph ---------------------------------------------------------------
// Relative specifiers only: bare ones are node builtins or resolved from the app, never copied.
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*'(\.[^']*)'/g
const DYNAMIC_IMPORT = /\bimport\(\s*'(\.[^']*)'\s*\)/g

const posix = (p) => p.split(sep).join('/')

/** Every relative import target of `file`, as a bin/-relative posix path. */
const importsOf = (file) => {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const re of [RELATIVE_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) out.push(posix(relative(BIN, resolve(dirname(file), m[1]))))
  }
  return out
}

// Only the .mjs entries are code; .json entries are data with no imports of their own.
const entries = declared.filter((f) => f.endsWith('.mjs'))
const seen = new Set()
const queue = [...entries]
let edges = 0

while (queue.length) {
  const rel = queue.shift()
  if (seen.has(rel)) continue
  seen.add(rel)

  const abs = join(BIN, rel)
  if (!existsSync(abs)) {
    fail(`SATELLITES lists bin/${rel}, which does not exist`)
    continue
  }

  for (const dep of importsOf(abs)) {
    edges++
    if (dep.startsWith('..')) {
      fail(`bin/${rel} imports '${dep}' — outside bin/, so it can never be installed`)
      continue
    }
    if (!rank.has(dep)) {
      fail(
        `bin/${rel} imports bin/${dep}, which is NOT in SATELLITES.\n` +
          `     The repo works and every installed copy dies with ERR_MODULE_NOT_FOUND.\n` +
          `     Add join('${dirname(dep) === '.' ? '' : `${dirname(dep)}', '`}${dep.split('/').pop()}') to SATELLITES in src/main/cli-runtime.ts, ABOVE bin/${rel}.`
      )
      continue
    }
    if (rank.get(dep) > rank.get(rel)) {
      fail(
        `SATELLITES installs bin/${rel} (#${rank.get(rel)}) before its import bin/${dep} (#${rank.get(dep)}).\n` +
          `     A \`mogging\` run during the copy window resolves a missing module. Move the helper up.`
      )
    }
    queue.push(dep)
  }
}

// Blindness guard: no edges means the import regex stopped matching, not that bin/ became
// dependency-free. mogging.mjs has imported from lib/ since the runtime split.
if (edges === 0) {
  console.error('FAIL walked the graph and found ZERO relative imports — the scanner is blind, not the code clean')
  process.exit(1)
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`OK cli satellites: ${declared.length} declared, ${seen.size} reachable, ${edges} imports checked`)

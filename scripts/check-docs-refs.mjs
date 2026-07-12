#!/usr/bin/env node
// The docs-reference gate.
//
//   node scripts/check-docs-refs.mjs
//
// THE RULE: every relative link a doc makes is a file that exists.
//
// The docs are the product's memory: the roadmap points at ADRs, ADRs point at
// research, research points at prompt packs, and every phase points at the pack that
// shipped it. Nothing but a gate ever keeps a pointer honest. Rename `docs/09-swarm.md`
// or retire a `prompts/phase-N/` and the roadmap keeps CLAIMING the receipt exists —
// the link just quietly 404s in the reader's editor. That is the quiet kind of drift:
// the doc still reads as true.
//
// Same family as check-gates.mjs and check-protocol-version.mjs — a list that must agree
// with another list.
//
// Scope: markdown links `[text](path)` in docs/**, to RELATIVE paths (http(s):, mailto:,
// and bare #anchors are somebody else's problem). A #fragment on a real file is fine —
// we check the file, not the heading.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : []
  })

const docs = walk('docs')
if (!docs.length) {
  console.error('\nDOCS REFS: found no markdown under docs/ — the pattern is blind.\n')
  process.exit(1)
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const EXTERNAL = /^(https?:|mailto:|#)/

const broken = []
for (const doc of docs) {
  const body = readFileSync(doc, 'utf8')
  for (const [, href] of body.matchAll(LINK)) {
    if (EXTERNAL.test(href)) continue
    const target = resolve(dirname(doc), decodeURI(href.split('#')[0]))
    if (!target || existsSync(target)) continue
    broken.push({ doc, href, target: relative(process.cwd(), target) })
  }
}

if (broken.length) {
  console.error(`\nDOCS REFS: ${broken.length} link(s) point at files that do not exist.\n`)
  for (const { doc, href, target } of broken) {
    console.error(`  ${doc}\n    [..](${href})  ->  ${target}  MISSING`)
  }
  console.error('\nFix the link or restore the file. A doc that cites a receipt must have one.\n')
  process.exit(1)
}

console.log(`docs refs: ${docs.length} docs, every relative link resolves.`)

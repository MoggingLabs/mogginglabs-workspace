#!/usr/bin/env node
// The credential-custody wording gate (audit finding 27).
//
//   node scripts/check-credential-wording.mjs
//
// THE RULE: no user-facing string may claim the app stores NO keys or holds NO
// credential. That claim is false, and the true story is the better one anyway.
//
// WHAT IS ACTUALLY TRUE. The app never brokers or stores a provider CLI's LOGIN —
// codex, claude and gemini authenticate themselves against your own accounts, and
// nothing in this process ever sees that token (ADR 0002). That is the claim worth
// making. But integration service keys and webhook URLs ARE held: you paste them,
// they are encrypted through the OS-backed vault (DPAPI / Keychain / libsecret), and
// they materialize only into the pane environment that asked for them. "No keys
// stored" is therefore a lie about a feature we shipped on purpose — and it is the
// precise kind of lie that costs a security-minded reader their trust in every OTHER
// claim on the page, including the ones we got right.
//
// WHY A GATE AND NOT A STYLE NOTE. This copy is written a surface at a time, months
// apart, by whoever is in that file — and "the app never holds a credential" is a
// sentence that FEELS like the house voice. It was independently re-typed into the
// wizard footer, Settings § About, the integrations intro, the README's Phase 8
// bullet, and docs/12. Review does not catch it, because each instance reads as
// correct in isolation; only the vault code two directories away says otherwise. A
// list that must stay empty is the only thing that keeps a promise honest.
//
// SAY THE TRUE THING INSTEAD. Name what is NOT held ("never brokers, stores, or
// proxies your CLI login") and name what IS ("keys you paste here are vaulted, not
// brokered"). Narrow, scoped claims stay legal — see ALLOWED below, which suppresses
// a match only while the line still reads the way it read when it was reviewed.
//
// Scope: src/ui/**/*.ts (the strings a user actually reads), docs/**/*.md, and the
// root README.md. Feature-level README.md files under src/ui/** are dev notes that
// never render to a user — out of scope by construction, since we take only .ts there.
//
// Same family as check-docs-refs.mjs and check-pty-seam.mjs: a claim that must keep
// agreeing with the code that implements it.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

/**
 * One regex per lie, each separately named — a failure should say WHICH promise it is
 * breaking, not just that some regex somewhere matched. `\s+` gaps everywhere because
 * the phrase wraps across a markdown line break as often as not.
 */
const DENIED = [
  ['no-keys-stored', /\bno\s+keys?\s+stored\b/gi],
  ['no-credentials-stored', /\bno\s+credentials?\s+(?:are\s+)?stored\b/gi],
  ['never-holds-credential', /\bnever\s+holds?\s+(?:a|any|your)\s+credentials?\b/gi],
  ['never-stores-credential', /\bnever\s+stores?\s+(?:a|any|your)\s+credentials?\b/gi],
  ['never-brokers-stores-proxies', /\bnever\s+brokers?,?\s+stores?,?\s+or\s+proxies?\s+a\s+credential\b/gi],
  ['holds-no-credential', /\bholds?\s+no\s+credentials?\b/gi],
  ['ever-holding-storing-credential', /\bever\s+(?:holding|storing)\s+a\s+credential\b/gi],
  ['zero-credentials-keys-stored', /\bzero\s+(?:credentials?|keys?)\s+stored\b/gi],
  ['doesnt-store-credential', /\bdoes(?:n['’]?t|\s+not)\s+store\s+(?:a|any)\s+credentials?\b/gi]
]

/**
 * Scoped exceptions: a claim narrow enough to be TRUE. Suppressed only when file AND
 * line AND `contains` all still hold — so the moment someone rewrites the sentence, it
 * loses its exception and comes back here for review. An allowlist keyed on file alone
 * would quietly bless whatever that file said next.
 */
const ALLOWED = [
  {
    file: 'docs/14-integrations.md',
    line: 251,
    contains: 'The app holds',
    reason:
      'scoped to Direction 5 — the GitHub adapter rides your `gh` CLI and never captures a token. ' +
      'A true, narrow claim about ONE adapter, unlike the product-wide claim the README used to make.'
  }
]

const walk = (dir, ext) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry)
        return statSync(path).isDirectory() ? walk(path, ext) : path.endsWith(ext) ? [path] : []
      })

const files = [
  ...walk(join(ROOT, 'src', 'ui'), '.ts'),
  ...walk(join(ROOT, 'docs'), '.md'),
  join(ROOT, 'README.md')
].filter(existsSync)

if (files.length < 2) {
  console.error('\nCREDENTIAL WORDING: found almost nothing to scan — the pattern is blind.\n')
  process.exit(1)
}

/**
 * Emphasis and code markers only — NEVER newlines. Several of the accurate claims are
 * bolded, and `The app holds **no**\ncredential.` must still read as one sentence. Since
 * no newline is removed, the Nth newline in the stripped text is still the Nth newline in
 * the source, so counting them before match.index yields the real line number.
 */
const stripMarkers = (body) => body.replace(/[*_`]/g, '')
const lineAt = (text, index) => (text.slice(0, index).match(/\n/g)?.length ?? 0) + 1

const violations = []
let allowlisted = 0

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  // Whole-file, not line-by-line: the phrase wraps (docs/14-integrations.md:251-252 is
  // the live example). Markdown gets its markers stripped; a .ts string is already plain.
  const haystack = rel.endsWith('.md') ? stripMarkers(source) : source

  for (const [id, pattern] of DENIED) {
    for (const match of haystack.matchAll(pattern)) {
      const line = lineAt(haystack, match.index)
      const text = lines[line - 1] ?? ''
      const excused = ALLOWED.find((a) => a.file === rel && a.line === line && text.includes(a.contains))
      if (excused) {
        allowlisted += 1
        continue
      }
      violations.push({ rel, line, id, matched: match[0].replace(/\s+/g, ' '), text: text.trim() })
    }
  }
}

if (violations.length) {
  console.error(`\nCREDENTIAL WORDING: ${violations.length} claim(s) the vault contradicts.\n`)
  for (const { rel, line, id, matched, text } of violations) {
    console.error(`  ${rel}:${line}: [${id}] ${matched}`)
    console.error(`    | ${text}`)
  }
  console.error(
    '\nThe app DOES hold integration keys and webhook URLs you explicitly vault (encrypted by\n' +
      'your OS keychain, materialized only into a pane env). What it never holds is your CLI\n' +
      "login — the CLIs authenticate themselves (ADR 0002). Say that instead: name what isn't\n" +
      'held, and name what is. If a claim is narrow enough to be true, add it to ALLOWED in\n' +
      'this file with the reason it holds.\n'
  )
  process.exit(1)
}

console.log(
  `credential wording: ${files.length} files, ${DENIED.length} patterns, ${allowlisted} allowlisted — no claim the vault contradicts.`
)

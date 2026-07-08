#!/usr/bin/env node
// The spacing-drift gate (Phase-8.5/01, fixed in 02).
//
//   node scripts/check-spacing.mjs [--max N] [file]
//
// THE RULE: no spacing declaration may carry a px literal outside the sanctioned
// set {0, 1px, 2px, 3px, 6px}. 1-2px are hairlines/seams; 3px/6px are optical
// half-steps licensed ONLY inside dense terminal chrome (pane-header clusters,
// chips, icon tiles, kbd hints). Everything else takes a --sp-* stop. A wizard, a
// settings page, Home, and the board are NOT dense terminal chrome.
//
// Why a script and not the awk one-liner 8.5/01 shipped: that command used `\b`,
// which mawk (Git Bash's awk) silently does not support — so its gsub stripped
// nothing and it reported 94 violations where there were 33. Numbers you cannot
// reproduce are worse than no numbers. This is the reproducible one.
import { readFileSync } from 'node:fs'

const SANCTIONED = new Set([1, 2, 3, 6])
const SPACING = /^\s*(padding|margin|gap|row-gap|column-gap)[a-z-]*\s*:/
const PX = /\b(\d+)px\b/g
const SELECTOR = /^\s*[.#[a-zA-Z]/

/**
 * Which pack step owns a selector's burn-down. FIRST MATCH WINS, so order encodes
 * precedence — chrome sits above feedback because `.layout-menu-tile` matches both
 * (`layout-menu` here, `menu-` there). It is the titlebar's layout menu, owned by
 * step 08 (REMOVE #16). Bucketed as `feedback` it made 07b's "feedback bucket 0"
 * unreachable until 08 landed — a step's definition of done must not depend on a
 * later step.
 */
const BUCKETS = [
  ['wizard', /wizard|path-input|layout-tile|layout-picker|grid-preview/],
  ['settings', /settings|integux|trail|mgr-|cat-|toolplan|usage-|evbridge|ph-/],
  ['home', /home-|firstrun|checklist|update/],
  ['chrome', /pane-|titlebar|workspace-tab|rail-|brand|icon-btn|dock|shortcut|layout-menu|layout-grid/],
  ['feedback', /board|palette|toast|confirm|review|modal|menu-|pill|count-badge/]
]
const bucketOf = (sel) => BUCKETS.find(([, re]) => re.test(sel))?.[0] ?? 'shared'

const args = process.argv.slice(2)
const maxIdx = args.indexOf('--max')
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : null
const file = args.find((a) => !a.startsWith('--') && a !== String(max)) ?? 'src/ui/styles/global.css'

let selector = ''
const violations = []
readFileSync(file, 'utf8')
  .split('\n')
  .forEach((line, i) => {
    if (line.includes('{') && SELECTOR.test(line)) selector = line.split('{')[0].trim()
    if (!SPACING.test(line)) return
    const bad = [...line.matchAll(PX)].map((m) => Number(m[1])).filter((n) => !SANCTIONED.has(n))
    if (bad.length) violations.push({ line: i + 1, selector, text: line.trim(), bucket: bucketOf(selector) })
  })

const byBucket = {}
for (const v of violations) byBucket[v.bucket] = (byBucket[v.bucket] ?? 0) + 1

if (args.includes('--list')) for (const v of violations) console.log(`${file}:${v.line}: [${v.bucket}] ${v.selector} — ${v.text}`)
console.log(`spacing violations: ${violations.length}`)
for (const [k, n] of Object.entries(byBucket).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(9)} ${n}`)

if (max != null && violations.length > max) {
  console.error(`\n::error::spacing drift — ${violations.length} violations exceeds the agreed ceiling of ${max}`)
  process.exit(1)
}

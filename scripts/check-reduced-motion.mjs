#!/usr/bin/env node
// The reduced-motion gate (audit 36, MOTION-01).
//
//   node scripts/check-reduced-motion.mjs [file]
//
// THE RULE: inside a `@media (prefers-reduced-motion: reduce)` block, or under any
// selector carrying `.motion-calm` (the in-app Calm-motion switch — motion-port.ts),
// no `animation` or `animation-iteration-count` declaration may be `infinite`. A
// becalming rule may swap an animation for a gentler one, or stop it dead — it may
// never hand back something that runs forever.
//
// WHY a gate: global.css installs a blanket clamp (`*, *::before, *::after {
// animation-iteration-count: 1 !important }`) under both doors, so it LOOKS like
// nothing can survive. But a twin with real specificity — root class + element beats
// root class + * — plus !important outranks that clamp, and that escape hatch exists
// on purpose (a state must still read at a glance; cf. .layout-slot.attn-pulse::before,
// whose fade is bounded to a single pass). Audit 36 found the hatch used to reinstall
// `infinite` on five indicators: the reduced-motion rule was itself the thing animating
// forever. Nothing about that reads as wrong locally — the declaration is 40 lines from
// the clamp it beats, and `grep infinite global.css` returns a dozen hits that are all
// perfectly legitimate full-motion animations. Only SCOPE tells them apart, and scope
// means tracking brace depth. Hence a script, not a grep.
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

// Selectors exempt from the rule — i.e. motion so essential that stopping it would
// destroy the meaning (a genuinely indeterminate progress indicator with nothing else
// to say). EMPTY, and it should stay that way: the app's own policy already settled
// this — "under reduced-motion the ring stops (global rule) and the label carries the
// meaning" (src/ui/components/spinner.ts:5). Even the spinner doesn't claim an
// exemption. Adding an entry here means arguing the label CAN'T carry it.
const ALLOWLIST = []

const FILE = process.argv[2] ?? 'src/ui/styles/global.css'

// A prelude opens a becalming scope if it's the reduced-motion media query or a
// .motion-calm selector. `no-preference` is the FULL-motion branch, and :not(.motion-calm)
// is the full-motion side of the switch — infinite is legitimate in both, so neither counts.
const isGuard = (head) =>
  (/prefers-reduced-motion/.test(head) && !/prefers-reduced-motion\s*:\s*no-preference/.test(head)) ||
  (/\.motion-calm\b/.test(head) && !/:not\([^)]*\.motion-calm/.test(head))

const DECL = /^(animation(?:-iteration-count)?)\s*:\s*(.+)$/i
const INFINITE = /\binfinite\b/i

// Blank out comments, preserving newlines: a stray brace or the word "infinite" in
// prose must not move the depth counter or trip the check.
const code = readFileSync(FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const stack = [] // open blocks, innermost last: { head, guarded }
const violations = []
let scanned = 0
let buf = '' // the prelude/declaration accumulating since the last { } or ;
let bufLine = 1 // ...and the line it started on (declarations may wrap)
let line = 1

const flush = () => {
  const text = buf.trim().replace(/\s+/g, ' ')
  buf = ''
  if (!text || !stack.some((f) => f.guarded)) return
  const m = DECL.exec(text)
  if (!m) return
  scanned++
  if (!INFINITE.test(m[2])) return
  const chain = stack.map((f) => f.head)
  if (ALLOWLIST.some((sel) => chain.some((head) => head.includes(sel)))) return
  violations.push({ line: bufLine, scope: chain.filter(Boolean).join(' » '), decl: text })
}

for (const ch of code) {
  if (ch === '{') {
    const head = buf.trim().replace(/\s+/g, ' ')
    stack.push({ head, guarded: isGuard(head) || stack.some((f) => f.guarded) })
    buf = ''
  } else if (ch === '}') {
    flush() // the last declaration in a block may drop its semicolon
    stack.pop()
  } else if (ch === ';') {
    flush()
  } else {
    if (!buf.trim() && ch.trim()) bufLine = line
    buf += ch
  }
  if (ch === '\n') line++
}

// ── The JS half: a smooth scroll is neither an animation nor a transition ────────────────
// `.motion-calm`'s entire reach is the CSS clamps above, so a scroll driven by the
// `behavior: 'smooth'` OPTION is unreachable by any class — the in-app switch, documented as
// the twin of the OS reduce-motion preference, had no twin at all for scrolling. Every
// renderer scroll must go through `scrollBehavior()` (core/a11y/motion-port.ts), which answers
// 'auto' when calm motion or the OS preference is on. A literal is a hole this gate exists to
// keep shut, so it is checked here rather than left to review.
{
  const rawSmooth = []
  const walkSrc = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkSrc(full)
      else if (entry.name.endsWith('.ts')) {
        const posix = full.split(sep).join('/')
        if (posix.endsWith('core/a11y/motion-port.ts')) continue // the helper's own home
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (/behavior:\s*['"`]smooth['"`]/.test(text)) rawSmooth.push(posix + ':' + (i + 1))
          })
      }
    }
  }
  walkSrc('src/ui')
  if (rawSmooth.length) {
    console.error('\nreduced motion — ' + rawSmooth.length + " raw smooth scroll(s) bypassing scrollBehavior():\n")
    for (const r of rawSmooth) console.error('  ' + r)
    console.error(
      "\n::error::route these through scrollBehavior() (core/a11y/motion-port.ts) — no CSS class can " +
        "becalm a behavior:'smooth' option, so a literal ignores both Calm motion and the OS preference.\n"
    )
    process.exit(1)
  }
}

if (violations.length) {
  for (const v of violations) console.error(`${FILE}:${v.line}: ${v.scope}\n    ${v.decl}`)
  console.error(
    `\n::error::reduced motion — ${violations.length} infinite animation(s) survive the becalming clamp. ` +
      `Stop them (animation: none !important, plus the static end state) or bound them to a finite count.`
  )
  process.exit(1)
}

console.log(`reduced motion: 0 infinite animations (${scanned} animation declarations scanned in becalmed scopes)`)

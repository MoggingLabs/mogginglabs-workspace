#!/usr/bin/env node
// The pty-seam gate.
//
//   node scripts/check-pty-seam.mjs
//
// THE RULE: exactly one module may VALUE-import node-pty — src/backend/platform/pty-host.ts.
// Type-only imports (`import type { IPty } from 'node-pty'`) are free: types spawn nothing.
//
// WHY A GATE AND NOT A COMMENT. The "text going crazy" bug was three independent inferences of
// one fact. node-pty picks ConPTY vs winpty implicitly (`useConpty ??= build >= 18309`), and it
// did so at TWO spawn sites; the renderer then hardcoded `backend: 'conpty'` and hoped. They
// agreed by luck. A shared helper would not have prevented that — a helper is advice, and the
// third caller is always free to ignore it. What prevents it is that there is nowhere else to
// get a pty: pty-host.spawnPty() decides `useConpty` and returns the emulation descriptor in the
// same expression, so the description cannot drift from the process it describes.
//
// This gate is what keeps that true. Delete it and the seam decays back into a convention.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const OWNER = join('src', 'backend', 'platform', 'pty-host.ts')

/** `import ... from 'node-pty'` / `require('node-pty')` / `requireNative('node-pty')`
 *  (the host-aware seam, ADR 0017 — a second door unless it is gated like the first),
 *  minus the type-only forms. */
const VALUE_IMPORT =
  /(^|\n)\s*import\s+(?!type\s)[^\n]*from\s+['"]node-pty['"]|require(?:Native)?(?:<[^>\n]*>)?\(\s*['"]node-pty['"]\s*\)/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const offenders = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (rel.split(sep).join(sep) === OWNER) continue
  const src = readFileSync(file, 'utf8')
  if (VALUE_IMPORT.test(src)) offenders.push(rel)
}

if (offenders.length) {
  console.error('\nPTY SEAM VIOLATION — node-pty may only be spawned through the chokepoint.\n')
  for (const o of offenders) console.error(`  ${o}`)
  console.error(
    `\nImport { spawnPty } from '${OWNER.split(sep).join('/')}' instead. It decides useConpty and\n` +
      'returns the pty together with the PtyEmulation that describes it, so the renderer never guesses.\n' +
      "(Type-only `import type { IPty } from 'node-pty'` is allowed.)\n"
  )
  process.exit(1)
}

// ── RULE 2: a pty is torn down as a TREE, through the one function that knows how ──────
//
// The spawn seam had a gate; the KILL seam had only a habit, and the habit was not kept.
// The in-proc backend called killPtyTree; the daemon — which owns every pane in a normal
// install, and outlives the app — called a bare proc.kill() for eleven phases. That ends
// the pane's shell and leaves the agent running headless with no terminal attached and no
// surface in the app that can reach it, and it silently broke daemon-migrate's retire
// hand-off, which assumes a retired daemon's agents die with it.
//
// Same shape as rule 1: one owner, everyone else goes through it. Narrow on purpose —
// `.kill()` on a child_process (git, npm, an MCP bridge) is a different thing and stays
// legal; this only catches a kill on a handle NAMED like the pty it is.
const KILL_OWNER = join('src', 'backend', 'platform', 'process-tree.ts')
const PTY_KILL = /\b(?:this\.)?(?:proc|pty)\.kill\(\)/
const killOffenders = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (rel === KILL_OWNER) continue
  const src = readFileSync(file, 'utf8')
  // Strip comments first: this file's own prose quotes the banned call, and so does the
  // comment explaining the fix. A gate must not be tripped by a description of itself.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
  if (PTY_KILL.test(code)) killOffenders.push(`${rel}: ${code.match(PTY_KILL)[0]}`)
}

if (killOffenders.length) {
  console.error('\nPTY TEARDOWN VIOLATION — a pty is killed as a TREE, never as one process.\n')
  for (const o of killOffenders) console.error(`  ${o}`)
  console.error(
    `\nCall killPtyTree(proc) from '${KILL_OWNER.split(sep).join('/')}' instead. It signals the\n` +
      'process group on POSIX and taskkill /T /F on Windows, then runs proc.kill() itself as the\n' +
      'last step — strictly more teardown than a bare kill, never less. A bare kill leaves the\n' +
      'agent running headless with nothing left in the app that can find it.\n'
  )
  process.exit(1)
}

console.log(
  `  pty seam OK — node-pty spawned only from ${OWNER.split(sep).join('/')}, ` +
    `torn down only through ${KILL_OWNER.split(sep).join('/')}`
)

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

/** `import ... from 'node-pty'` / `require('node-pty')`, minus the type-only forms. */
const VALUE_IMPORT = /(^|\n)\s*import\s+(?!type\s)[^\n]*from\s+['"]node-pty['"]|require\(\s*['"]node-pty['"]\s*\)/

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
console.log(`  pty seam OK — node-pty spawned only from ${OWNER.split(sep).join('/')}`)

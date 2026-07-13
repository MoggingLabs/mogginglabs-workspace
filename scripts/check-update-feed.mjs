#!/usr/bin/env node
// The update-feed gate.
//
//   node scripts/check-update-feed.mjs
//
// THE RULE: every artifactName must be a literal with NO whitespace, and must not interpolate
// ${productName} or ${name}.
//
// This gate exists because auto-update was dead from v0.3.0 to v0.9.0 — every download, on every
// platform, 404'd — and NOTHING caught it. Not a type error, not a test, not a release. The app
// shipped nine times with an updater that could not update.
//
// The mechanism, because it is worth being able to recognise again:
//
//   productName is "MoggingLabs Workspace". It has a space. So `artifactName: ${productName}-...`
//   produced THREE different names for ONE file:
//
//     on disk (electron-builder writes it)   "MoggingLabs Workspace-0.9.0-win-x64.exe"
//     in latest.yml / what the updater GETs  "MoggingLabs-Workspace-0.9.0-win-x64.exe"   (space -> hyphen)
//     the asset GitHub actually stores       "MoggingLabs.Workspace-0.9.0-win-x64.exe"   (space -> dot)
//
//   electron-updater's GitHubProvider builds its download URL with `p.replace(/ /g, "-")` ("for
//   backward compatibility"), while GitHub's asset upload normalizes the space to a dot. They
//   disagree, so the URL in the manifest names a file that does not exist. The .exe.blockmap is
//   derived from that same URL, so differential download died the same death.
//
// It was INVISIBLE because a broken feed and a healthy-but-quiet feed produce identical output:
// silence. electron-updater ships a no-op logger, so nothing on disk even recorded which URL
// 404'd. (src/main/updater.ts now installs a real one, and Settings > About shows a last-checked
// timestamp, so the two states can never look alike again.)
//
// The release workflow ALSO cross-checks every url: in latest*.yml against the release's real
// asset list — but that only fires at release time, on a tag, after a 40-minute build. This gate
// is the same invariant asserted statically, in under a second, on every push. A space in
// artifactName can never reach a tag again.
//
// Related invariant, deliberately NOT gated but worth knowing: do not RENAME artifacts either.
// electron-updater finds the previous version's blockmap by string-substituting the version into
// the current name, so any rename silently downgrades that one update to a full download.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')

const failures = []

// Deliberately a line-wise regex rather than a YAML parse: this file must run with zero
// dependencies (it is the first thing CI does, before anything is installed beyond npm ci).
const lines = yml.split(/\r?\n/)
let found = 0

lines.forEach((line, i) => {
  const m = /^\s*artifactName:\s*(.+?)\s*$/.exec(line)
  if (!m) return
  found++
  const value = m[1].replace(/^['"]|['"]$/g, '')
  const at = `electron-builder.yml:${i + 1}`

  if (/\$\{(productName|name)\}/.test(value)) {
    failures.push(
      `${at}: artifactName interpolates \${productName}/\${name} — "${value}"\n` +
        `    productName contains a SPACE, and a space in an artifact name breaks the update feed\n` +
        `    in three directions at once (see the header of this file). Hard-code the literal:\n` +
        `      artifactName: MoggingLabs-Workspace-\${version}-win-\${arch}.\${ext}`
    )
    return
  }
  if (/\s/.test(value)) {
    failures.push(
      `${at}: artifactName contains whitespace — "${value}"\n` +
        `    GitHub rewrites a space to '.', electron-updater rewrites it to '-'. They will never\n` +
        `    agree, and every update download will 404.`
    )
  }
})

// A build with no artifactName at all falls back to electron-builder's default, which is
// "${productName}-${version}-${arch}.${ext}" — the exact bug, reintroduced by deletion.
if (found === 0) {
  failures.push(
    'electron-builder.yml declares no artifactName. The default is "${productName}-..." — which\n' +
      '    reintroduces the space. Declare an explicit, space-free name per platform.'
  )
}

if (failures.length) {
  console.error('update-feed gate FAILED:\n')
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  console.error('An update that 404s looks exactly like an app with no update. Do not ship it.\n')
  process.exit(1)
}

console.log(`update-feed gate: ${found} artifactName declaration(s), all space-free literals ✓`)

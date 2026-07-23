#!/usr/bin/env node
/**
 * FONTCOVER — the vendored terminal faces cover (and metrically fit) what terminals draw.
 *
 * The bug this pins: the previous @fontsource subsets shipped none of the glyphs
 * terminal TUIs draw structure with (no box drawing, no braille), so agent CLI frames
 * fell back to OS faces at foreign advance widths — glyphs overlapping neighbouring
 * cells, borders ragged. The fix vendors full JetBrains Mono plus a JuliaMono-backed
 * symbols face at the IDENTICAL 0.600em advance. This check re-verifies the actual
 * font BYTES in the repo (cmap coverage + hmtx advance parity), so a future "optimize
 * the fonts" swap that reintroduces subsets goes red here, not in a user's pane.
 *
 * No dependencies: a minimal TTF reader (table directory, cmap formats 4/12, hmtx/head).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fontsDir = join(root, 'src', 'ui', 'styles', 'fonts')

function tables(buf) {
  const out = {}
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const o = 12 + i * 16
    out[buf.toString('ascii', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) }
  }
  return out
}

function bestCmap(buf, cmapOff) {
  const n = buf.readUInt16BE(cmapOff + 2)
  let best = -1
  let bestScore = -1
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8
    const p = buf.readUInt16BE(rec)
    const e = buf.readUInt16BE(rec + 2)
    const score = (p === 3 && e === 10) || (p === 0 && e >= 4) ? 2 : (p === 3 && e === 1) || p === 0 ? 1 : 0
    if (score > bestScore) {
      bestScore = score
      best = cmapOff + buf.readUInt32BE(rec + 4)
    }
  }
  return best
}

/** codepoint -> glyph id (0 = absent). cmap formats 4 and 12 only — all we ship. */
function glyphId(buf, sub, cp) {
  const fmt = buf.readUInt16BE(sub)
  if (fmt === 12) {
    const nG = buf.readUInt32BE(sub + 12)
    for (let g = 0; g < nG; g++) {
      const o = sub + 16 + g * 12
      const start = buf.readUInt32BE(o)
      const end = buf.readUInt32BE(o + 4)
      if (cp >= start && cp <= end) return buf.readUInt32BE(o + 8) + (cp - start)
    }
    return 0
  }
  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(sub + 6)
    const endO = sub + 14
    const startO = endO + segX2 + 2
    const deltaO = startO + segX2
    const rangeO = deltaO + segX2
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(endO + s * 2)
      const start = buf.readUInt16BE(startO + s * 2)
      if (cp < start || cp > end) continue
      const delta = buf.readInt16BE(deltaO + s * 2)
      const ro = buf.readUInt16BE(rangeO + s * 2)
      if (ro === 0) return (cp + delta) & 0xffff
      const gi = buf.readUInt16BE(rangeO + s * 2 + ro + (cp - start) * 2)
      return gi === 0 ? 0 : (gi + delta) & 0xffff
    }
    return 0
  }
  throw new Error(`unhandled cmap format ${fmt}`)
}

function advanceEm(buf, t, gid) {
  const upem = buf.readUInt16BE(t.head.off + 18)
  const numH = buf.readUInt16BE(t.hhea.off + 34)
  const adv = buf.readUInt16BE(t.hmtx.off + Math.min(gid, numH - 1) * 4)
  return adv / upem
}

let failures = 0
const fail = (msg) => {
  failures++
  console.error(`FONTCOVER FAIL: ${msg}`)
}

function checkFace(file, { fullRanges, chars, advance }) {
  let buf, t, sub
  try {
    buf = readFileSync(join(fontsDir, file))
    t = tables(buf)
    sub = bestCmap(buf, t.cmap.off)
  } catch (err) {
    fail(`${file}: not a readable TTF (${err.message}) — woff2/subset swaps land here`)
    return
  }
  for (const [name, a, b] of fullRanges) {
    for (let cp = a; cp <= b; cp++) {
      if (!glyphId(buf, sub, cp)) {
        fail(`${file}: ${name} is not fully covered (first hole U+${cp.toString(16).toUpperCase()})`)
        break
      }
    }
  }
  for (const cp of chars) {
    const gid = glyphId(buf, sub, cp)
    if (!gid) {
      fail(`${file}: missing U+${cp.toString(16).toUpperCase()} (${String.fromCodePoint(cp)})`)
      continue
    }
    const em = advanceEm(buf, t, gid)
    if (Math.abs(em - advance) > 0.001) {
      fail(
        `${file}: U+${cp.toString(16).toUpperCase()} advance ${em.toFixed(3)}em != ${advance}em — ` +
          `a foreign advance is exactly the cell-overlap bug`
      )
    }
  }
}

// JBM: the text face must carry the box the TUIs are drawn with.
checkFace('jetbrains-mono-var.ttf', {
  fullRanges: [
    ['box drawing U+2500-257F', 0x2500, 0x257f],
    ['block elements U+2580-259F', 0x2580, 0x259f]
  ],
  chars: [0x41, 0x2500, 0x256d, 0x2588, 0x25cf, 0x2713, 0x276f],
  advance: 0.6
})

// The symbols face: everything JBM leaves open that agent CLIs draw — braille spinners
// (verified present in the installed codex/opencode binaries), Claude Code's dingbat
// spinner set, checks/crosses, misc technical — at JBM's exact advance.
checkFace('juliamono-regular.ttf', {
  fullRanges: [
    ['braille U+2800-28FF', 0x2800, 0x28ff],
    ['dingbats U+2700-27BF', 0x2700, 0x27bf],
    ['geometric shapes U+25A0-25FF', 0x25a0, 0x25ff],
    ['misc symbols U+2600-26FF', 0x2600, 0x26ff]
  ],
  chars: [0x2722, 0x2733, 0x2736, 0x273b, 0x273d, 0x25d0, 0x2714, 0x2718, 0x280b, 0x2819, 0x28ff, 0x23f5, 0x23bf, 0x29c9, 0x2699],
  advance: 0.6
})

// The faces must actually be declared, scoped, and imported — bytes nobody loads fix nothing.
const fontsCss = readFileSync(join(root, 'src', 'ui', 'styles', 'fonts.css'), 'utf8')
for (const needle of ['jetbrains-mono-var.ttf', 'juliamono-regular.ttf', 'MoggingLabs Symbols', 'unicode-range']) {
  if (!fontsCss.includes(needle)) fail(`fonts.css lost "${needle}"`)
}
const uiIndex = readFileSync(join(root, 'src', 'ui', 'index.ts'), 'utf8')
if (!uiIndex.includes("./styles/fonts.css")) fail('src/ui/index.ts no longer imports styles/fonts.css')
if (uiIndex.includes('@fontsource')) fail('src/ui/index.ts reimports a @fontsource subset build')

if (failures) {
  console.error(`FONTCOVER: ${failures} failure(s)`)
  process.exit(1)
}
console.log('FONTCOVER: vendored faces verified (coverage + 0.600em advance parity + wiring)')

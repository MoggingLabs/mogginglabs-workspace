#!/usr/bin/env node
/**
 * Deterministic regression gate for terminal split geometry.
 *
 * Executes the authoritative TypeScript module in memory, then proves the contracts
 * that are easy to regress while changing compact chrome or gutter math:
 *   - persisted fractions describe the whole split until a 132px minimum clamps them;
 *   - every allocated/nested leaf keeps the hard width floor;
 *   - dragging a seam changes only its two adjacent subtrees;
 *   - persisted post-drag geometry remains valid and within the existing 4-decimal
 *     serialization tolerance.
 *
 * Usage: node scripts/check-layout-invariants.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const file = resolve('src/ui/features/layout/layout-tree.ts')
const source = readFileSync(file, 'utf8')
const transpiled = ts.transpileModule(source, {
  fileName: file,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
})
const errors = (transpiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
if (errors.length) {
  for (const error of errors) console.error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  process.exit(1)
}

const loaded = { exports: {} }
new Function('module', 'exports', 'require', transpiled.outputText)(
  loaded,
  loaded.exports,
  (name) => {
    throw new Error(`layout-tree unexpectedly required ${name}`)
  }
)
const {
  MIN_PANE_WIDTH_PX,
  allocateSpans,
  computeLayout,
  minimumLayoutWidth,
  parseTree,
  resizeSplitWeights,
  serializeTree
} = loaded.exports

const fail = (message) => {
  throw new Error(message)
}
const assert = (condition, message) => {
  if (!condition) fail(message)
}
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])

assert(MIN_PANE_WIDTH_PX === 132, `pane floor drifted to ${MIN_PANE_WIDTH_PX}`)
assert(
  same(allocateSpans(1198, [0.6, 0.4], [132, 132]), [719, 479]),
  'an unconstrained persisted 60/40 split no longer restores as 60/40'
)
assert(
  same(allocateSpans(1198, [0.9, 0.1], [132, 132]), [1066, 132]),
  'a constrained persisted 90/10 split no longer clamps only the undersized child'
)
const latentResize = resizeSplitWeights(564, [0.1, 0.45, 0.45], [132, 132, 132], 2, 10)
assert(
  same(allocateSpans(564, latentResize, [132, 132, 132]), [132, 226, 206]),
  'a constrained gutter drag no longer moves exactly its two visible neighbors'
)
assert(
  same(allocateSpans(1000, latentResize, [132, 132, 132]), [132, 454, 414]),
  'a gutter drag rewrote an untouched clamped sibling\'s latent persisted ratio'
)

let seed = 0x132c0de
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 0x100000000)
const int = (max) => Math.floor(random() * max)
const normalized = (count) => {
  const values = Array.from({ length: count }, () => 0.001 + random())
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => value / total)
}
const legacySpans = (total, sizes) => {
  const weightTotal = sizes.reduce((sum, size) => sum + size, 0)
  let target = 0
  let previous = 0
  return sizes.map((size, i) => {
    target += (total * size) / weightTotal
    const cut = i === sizes.length - 1 ? total : Math.round(target)
    const span = cut - previous
    previous = cut
    return span
  })
}

for (let run = 0; run < 20000; run++) {
  const count = 2 + int(8)
  const minimums = Array.from({ length: count }, () => 132)
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0)
  const total = minimumTotal + int(2401)
  const sizes = normalized(count)
  const spans = allocateSpans(total, sizes, minimums)
  assert(spans.reduce((sum, span) => sum + span, 0) === total, `allocation ${run} lost pixels`)
  spans.forEach((span, i) => assert(span >= minimums[i], `allocation ${run}/${i} crossed its minimum`))

  const legacy = legacySpans(total, sizes)
  const weightTotal = sizes.reduce((sum, size) => sum + size, 0)
  if (sizes.every((size, i) => (total * size) / weightTotal + 1e-9 >= minimums[i])) {
    assert(same(spans, legacy), `allocation ${run} changed an unconstrained persisted fraction`)
  }

  const index = 1 + int(count - 1)
  const pair = spans[index - 1] + spans[index]
  const lower = minimums[index - 1]
  const upper = pair - minimums[index]
  const desiredLeft = lower + int(upper - lower + 1)
  const resizedSizes = resizeSplitWeights(total, sizes, minimums, index, desiredLeft - spans[index - 1])
  const resized = allocateSpans(total, resizedSizes, minimums)
  assert(resized[index - 1] === desiredLeft, `gutter ${run} missed the requested pixel`)
  assert(resized[index] === pair - desiredLeft, `gutter ${run} moved the pair boundary`)
  resized.forEach((span, i) => {
    assert(span >= minimums[i], `gutter ${run}/${i} crossed its minimum`)
    if (i !== index - 1 && i !== index) assert(span === spans[i], `gutter ${run} moved sibling ${i}`)
  })
  const untouched = sizes.map((_, i) => i).filter((i) => i !== index - 1 && i !== index)
  if (untouched.length > 1) {
    const scale = resizedSizes[untouched[0]] / sizes[untouched[0]]
    for (const i of untouched.slice(1)) {
      assert(
        Math.abs(resizedSizes[i] - sizes[i] * scale) < 1e-10,
        `gutter ${run} rewrote sibling ${i}'s latent weight`
      )
    }
  }

  if (run < 2000) {
    const tree = {
      dir: 'h',
      sizes: resizedSizes,
      children: resized.map((_, i) => ({ id: i + 1 }))
    }
    const parsed = parseTree(serializeTree(tree), count)
    assert(parsed, `persistence ${run} failed to parse its own layout`)
    const roundTrip = computeLayout(parsed, { x: 0, y: 0, w: total + 2 * (count - 1), h: 600 }, 2, 132)
    const widths = Array.from(roundTrip.leaves.values(), (rect) => rect.w)
    widths.forEach((width, i) => {
      assert(width >= 132 || minimums[i] < 132, `persistence ${run}/${i} crossed the pane floor`)
      assert(Math.abs(width - resized[i]) <= 2, `persistence ${run}/${i} drifted ${Math.abs(width - resized[i])}px`)
    })
  }
}

let nextId = 1
const randomTree = (depth = 0) => {
  if (depth >= 3 || random() < 0.38) return { id: nextId++ }
  const count = 2 + int(3)
  return {
    dir: random() < 0.58 ? 'h' : 'v',
    sizes: normalized(count),
    children: Array.from({ length: count }, () => randomTree(depth + 1))
  }
}
for (let run = 0; run < 5000; run++) {
  nextId = 1
  const tree = randomTree()
  const requested = int(1801)
  const required = minimumLayoutWidth(tree, 2, 132)
  const layout = computeLayout(tree, { x: 0, y: 0, w: requested, h: 700 }, 2, 132)
  for (const [id, rect] of layout.leaves) {
    assert(rect.w >= 132, `nested layout ${run}, leaf ${id} rendered at ${rect.w}px (required ${required}px)`)
  }
}

console.log('layout-invariants: PASS (20,000 allocations/gutters, 2,000 persistence round-trips, 5,000 nested trees)')

#!/usr/bin/env node
/**
 * Deterministic regression gate for terminal split geometry.
 *
 * Executes the authoritative TypeScript module in memory, then proves the contracts
 * that are easy to regress while changing compact chrome or gutter math:
 *   - persisted fractions describe the whole split until a 132px minimum clamps them;
 *   - every allocated/nested leaf keeps the hard width floor — AND the 110px height
 *     floor (the capacity model's row count is a physical promise: computeLayout
 *     grows the canvas and the host scrolls rather than crush a terminal);
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
  MAX_LEAVES,
  MIN_PANE_HEIGHT_PX,
  MIN_PANE_WIDTH_PX,
  allocateSpans,
  computeLayout,
  equalizeAllLines,
  equalizeLineAt,
  lineOfLeaf,
  minimumLayoutHeight,
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

assert(MIN_PANE_WIDTH_PX === 132, `pane width floor drifted to ${MIN_PANE_WIDTH_PX}`)
assert(MIN_PANE_HEIGHT_PX === 110, `pane height floor drifted to ${MIN_PANE_HEIGHT_PX}`)
// The dependency-free twin of the contract's ABS_MAX_PANES (see layout-tree.ts's
// MAX_LEAVES note) — pinned here so the two numbers cannot drift apart silently.
assert(MAX_LEAVES === 32, `MAX_LEAVES drifted to ${MAX_LEAVES}`)

// The height requirement mirrors the width one: stacked children sum (+ seams),
// side-by-side children share. A 3-stack needs 3×110 + 2 seams; a 3-line needs 110.
const stack3 = { dir: 'v', sizes: [1 / 3, 1 / 3, 1 / 3], children: [{ id: 1 }, { id: 2 }, { id: 3 }] }
const line3 = { dir: 'h', sizes: [1 / 3, 1 / 3, 1 / 3], children: [{ id: 1 }, { id: 2 }, { id: 3 }] }
assert(minimumLayoutHeight(stack3, 2, 110) === 334, 'a 3-stack no longer sums its height minima')
assert(minimumLayoutHeight(line3, 2, 110) === 110, 'a 3-line no longer shares its height minimum')
assert(minimumLayoutWidth(stack3, 2, 132) === 132, 'a 3-stack no longer shares its width minimum')
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

// ── Equalize: per-line, per-member, and provably scoped ─────────────────────────
// The user contract behind the seam double-click / ⋯ menu / Balance layout: an
// equalize touches ONE line's sizes and nothing else — a pane that spans the line's
// cross-axis (a sibling in an outer line) is structurally unreachable.
{
  // h[ A, v[B, C, D] ]: A spans the three "rows" formed by the stack.
  const spanner = {
    dir: 'h',
    sizes: [0.7, 0.3],
    children: [{ id: 1 }, { dir: 'v', sizes: [0.5, 0.3, 0.2], children: [{ id: 2 }, { id: 3 }, { id: 4 }] }]
  }
  assert(equalizeLineAt(spanner, '1'), 'equalizeLineAt refused a valid line path')
  assert(
    same(spanner.children[1].sizes, [1 / 3, 1 / 3, 1 / 3]),
    'equalizing a column did not hand every member an equal share'
  )
  assert(same(spanner.sizes, [0.7, 0.3]), 'equalizing an inner line leaked into its outer line (the spanning pane moved)')
  assert(!equalizeLineAt(spanner, '0'), 'equalizeLineAt accepted a leaf path')
  assert(!equalizeLineAt(spanner, '9.9'), 'equalizeLineAt accepted a path into nothing')

  // lineOfLeaf is the ⋯ menu's honesty: B/C/D live in a column ('v') inside the root
  // row ('h'); the SPANNING pane A has a row but no column — so it must get no
  // "equal heights" entry rather than a dead one.
  assert(lineOfLeaf(spanner, 2, 'v') === '1', 'a stacked pane lost its column line')
  assert(lineOfLeaf(spanner, 2, 'h') === '', 'a stacked pane lost its enclosing row line')
  assert(lineOfLeaf(spanner, 1, 'h') === '', 'the spanning pane lost its row line')
  assert(lineOfLeaf(spanner, 1, 'v') === null, 'the spanning pane claims a column no line gives it')
  assert(lineOfLeaf(spanner, 99, 'h') === null, 'a leaf id not in the tree resolved to a line')

  // Deepest-line preference: in v[ h[A, B], C ] pane A's row is the INNER h-line.
  const nested = {
    dir: 'v',
    sizes: [0.5, 0.5],
    children: [{ dir: 'h', sizes: [0.4, 0.6], children: [{ id: 1 }, { id: 2 }] }, { id: 3 }]
  }
  assert(lineOfLeaf(nested, 1, 'h') === '0', 'a nested pane resolved its row to the wrong line')
  assert(lineOfLeaf(nested, 1, 'v') === '', 'a nested pane lost its enclosing column line')

  // Balance: every line equal, the SHAPE byte-identical (sizes aside), the result
  // parseable — and a lone leaf survives untouched.
  const shapeOf = (node) =>
    node.children
      ? { dir: node.dir, children: node.children.map(shapeOf) }
      : { id: node.id }
  for (let run = 0; run < 2000; run++) {
    nextId = 1
    const tree = randomTree()
    const before = JSON.stringify(shapeOf(tree))
    const leafTotal = nextId - 1
    equalizeAllLines(tree)
    assert(JSON.stringify(shapeOf(tree)) === before, `balance ${run} changed the tree's shape`)
    const verify = (node) => {
      if (!node.children) return
      node.children.forEach((child) => verify(child))
      assert(
        node.sizes.every((size) => Math.abs(size - 1 / node.children.length) < 1e-12),
        `balance ${run} left a line unequal`
      )
    }
    verify(tree)
    // parseTree's own MAX_LEAVES bound applies — random trees can exceed 32 leaves,
    // and refusing those is ITS contract, not a balance regression.
    if (tree.children && leafTotal <= MAX_LEAVES) {
      assert(parseTree(serializeTree(tree), leafTotal), `balance ${run} produced an unparseable layout`)
    }
  }
  const lone = { id: 7 }
  equalizeAllLines(lone)
  assert(lone.id === 7 && !lone.children, 'balancing a lone pane mutated it')
}

console.log('layout-invariants: equalize contracts hold (scoped lines, spanning panes untouched, 2,000 balanced trees)')

for (let run = 0; run < 5000; run++) {
  nextId = 1
  const tree = randomTree()
  const requestedW = int(1801)
  const requestedH = int(1201)
  const requiredW = minimumLayoutWidth(tree, 2, 132)
  const requiredH = minimumLayoutHeight(tree, 2, 110)
  const layout = computeLayout(tree, { x: 0, y: 0, w: requestedW, h: requestedH }, 2, 132, 110)
  for (const [id, rect] of layout.leaves) {
    assert(rect.w >= 132, `nested layout ${run}, leaf ${id} rendered at ${rect.w}px wide (required ${requiredW}px)`)
    assert(rect.h >= 110, `nested layout ${run}, leaf ${id} rendered at ${rect.h}px tall (required ${requiredH}px)`)
  }
}

console.log('layout-invariants: PASS (20,000 allocations/gutters, 2,000 persistence round-trips, 5,000 nested trees, both axes floored)')

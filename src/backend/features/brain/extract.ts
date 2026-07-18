import * as path from 'node:path'
import type { Node, Query, Tree } from 'web-tree-sitter'
import {
  brainNodeId,
  type BrainEdgeRow,
  type BrainNodeKind,
  type BrainNodeRow,
  type PortableDef,
  type PortableExtraction,
  type PortableHeritage,
  type PortableImport,
  type PortableRef
} from './schema'

// Extraction (ADR 0018, step 03), in two DELIBERATE halves:
//
//   extractPortable   bytes-determined ONLY — defs, import statements, reference
//                     candidates, heritage. This is what parse_cache stores, and
//                     why one cache row serves every worktree with those bytes.
//   resolveProjectGraph  per-PARTITION — mints stable ids, resolves imports
//                     (relative specifiers; tsconfig `paths` for TS; package
//                     specifiers become one module node each) and references
//                     (name + import-scope, BEST-EFFORT: resolved is an edge,
//                     ambiguous is DROPPED AND COUNTED — fidelity reported,
//                     never faked).
//
// Everything here is deterministic on purpose: sorted files in, capture order
// preserved, first-match candidate lists — the BRAINGRAPH gate byte-compares the
// dump of two runs.

const KIND_BY_CAPTURE: Record<string, BrainNodeKind> = {
  'definition.function': 'function',
  'definition.class': 'class',
  'definition.interface': 'interface',
  'definition.type': 'type',
  'definition.method': 'method',
  'definition.enum': 'enum'
}

/** Data-language defs (keys, tables, selectors, elements) all land as `const`. */
const kindFor = (capture: string): BrainNodeKind => KIND_BY_CAPTURE[capture] ?? 'const'

/** The enclosing DECLARATION of a name capture: climb until the node type reads
 *  like one. Bounded; falls back to the capture node itself. */
function declarationOf(node: Node): Node {
  let cur: Node = node
  for (let i = 0; i < 4; i++) {
    const parent = cur.parent
    if (!parent) return cur
    cur = parent
    if (/(_definition|_declaration|_item|_specifier|_spec|method_definition|^table$|^pair$|^rule_set$)/.test(cur.type)) {
      return cur
    }
  }
  return node
}

const firstLineOf = (node: Node): string => {
  const nl = node.text.indexOf('\n')
  return (nl === -1 ? node.text : node.text.slice(0, nl)).trim().slice(0, 200)
}

/** TS/TSX/JS import statement → specifier + locally bound names. */
function tsImport(stmt: Node): PortableImport | null {
  let specifier = ''
  const names: string[] = []
  const dig = (n: Node): void => {
    if (n.type === 'string') {
      const frag = n.namedChildren.find((c) => c !== null && c.type === 'string_fragment')
      specifier = frag?.text ?? n.text.replace(/^['"]|['"]$/g, '')
    } else if (n.type === 'import_specifier' || n.type === 'namespace_import') {
      const ids = n.namedChildren.filter((c) => c !== null && c.type === 'identifier')
      const local = ids[ids.length - 1] // `x as y` binds y; plain `x` binds x
      if (local) names.push(local.text)
    } else {
      for (const c of n.namedChildren) if (c) dig(c)
    }
  }
  dig(stmt)
  return specifier ? { specifier, names } : null
}

/** Python `import a.b` / `from m import x, y` → one PortableImport per module. */
function pyImports(stmt: Node): PortableImport[] {
  const dotted = stmt.namedChildren.filter((c) => c !== null && c.type === 'dotted_name')
  if (stmt.type === 'import_from_statement') {
    const relative = stmt.namedChildren.find((c) => c !== null && c.type === 'relative_import')
    const module = relative ? relative.text : (dotted[0]?.text ?? '')
    const names = (relative ? dotted : dotted.slice(1)).map((d) => d!.text)
    return module ? [{ specifier: module, names }] : []
  }
  return dotted.map((d) => ({ specifier: d!.text, names: [] }))
}

/** The bytes-determined half. Runs in the worker over 02's compiled tag query. */
export function extractPortable(query: Query, tree: Tree, lang: string): PortableExtraction {
  const defs: PortableDef[] = []
  const imports: PortableImport[] = []
  const refs: PortableRef[] = []
  const rawHeritage: { name: string; kind: 'extends' | 'implements'; line: number }[] = []

  for (const capture of query.captures(tree.rootNode)) {
    const name = capture.name
    const node = capture.node
    if (name.startsWith('definition')) {
      const decl = declarationOf(node)
      defs.push({
        kind: kindFor(name),
        name: node.text.slice(0, 200),
        startLine: decl.startPosition.row + 1,
        endLine: decl.endPosition.row + 1,
        sig: firstLineOf(decl)
      })
    } else if (name === 'reference.extends' || name === 'reference.implements') {
      rawHeritage.push({
        name: node.text,
        kind: name === 'reference.extends' ? 'extends' : 'implements',
        line: node.startPosition.row + 1
      })
    } else if (name.startsWith('reference')) {
      refs.push({ name: node.text, line: node.startPosition.row + 1 })
    } else if (name.startsWith('import')) {
      if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
        const imp = tsImport(node)
        if (imp) imports.push(imp)
      } else if (lang === 'python') {
        imports.push(...pyImports(node))
      }
      // Other languages: no specifier extractor yet — their imports stay tag
      // counts (BRAINPARSE) and enter the graph when a resolver earns its keep.
    }
  }

  // Heritage owners: the innermost class def whose span contains the clause.
  const heritage: PortableHeritage[] = rawHeritage.map((h) => {
    let ownerIndex = -1
    let ownerSpan = Number.MAX_SAFE_INTEGER
    defs.forEach((d, i) => {
      if (d.kind !== 'class') return
      if (d.startLine <= h.line && h.line <= d.endLine && d.endLine - d.startLine < ownerSpan) {
        ownerIndex = i
        ownerSpan = d.endLine - d.startLine
      }
    })
    return { name: h.name, kind: h.kind, ownerIndex }
  })

  return { defs, imports, refs, heritage }
}

// ── The per-partition half ───────────────────────────────────────────────────────

export interface ResolveContext {
  /** tsconfig `paths` at the root, pattern → target templates (already parsed). */
  tsPaths: Record<string, string[]>
}

export interface ResolvedGraph {
  nodes: BrainNodeRow[]
  edges: BrainEdgeRow[]
  resolvedRefs: number
  droppedRefs: number
}

const TS_LANGS = new Set(['typescript', 'tsx', 'javascript'])
const TS_CANDIDATES = ['', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']

const normalizeRel = (p: string): string => {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * Resolve one import specifier to a project file path, or null (→ package module).
 * Deterministic: fixed candidate lists, first hit wins.
 */
function resolveSpecifier(
  fromPath: string,
  specifier: string,
  lang: string,
  fileSet: Set<string>,
  ctx: ResolveContext
): string | null {
  const dir = path.posix.dirname(fromPath)
  if (TS_LANGS.has(lang)) {
    const tryBases = (bases: string[]): string | null => {
      for (const base of bases) {
        for (const suffix of TS_CANDIDATES) {
          const candidate = normalizeRel(base + suffix)
          if (fileSet.has(candidate)) return candidate
        }
      }
      return null
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return tryBases([`${dir === '.' ? '' : dir + '/'}${specifier}`])
    }
    for (const pattern of Object.keys(ctx.tsPaths).sort()) {
      const star = pattern.indexOf('*')
      const matches =
        star === -1 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star))
      if (!matches) continue
      const tail = star === -1 ? '' : specifier.slice(star)
      const hit = tryBases(ctx.tsPaths[pattern].map((t) => t.replace('*', tail)))
      if (hit) return hit
    }
    return null
  }
  if (lang === 'python') {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0
    const rest = specifier.slice(dots).replace(/\./g, '/')
    let base = dots ? dir : dir // relative and bare both try the file's dir first
    for (let up = 1; up < dots; up++) base = path.posix.dirname(base)
    const bases = dots ? [base] : [dir, ''] // bare imports also try the root
    for (const b of bases) {
      for (const candidate of [`${rest}.py`, `${rest}/__init__.py`]) {
        const rel = normalizeRel(`${b === '.' || b === '' ? '' : b + '/'}${candidate}`)
        if (fileSet.has(rel)) return rel
      }
    }
    return null
  }
  return null
}

/**
 * Mint the partition's rows from the portable extractions. Sorted input, stable
 * ids, counted drops — the whole thing re-runs to the same bytes or the gate is red.
 */
export function resolveProjectGraph(
  root: string,
  files: { path: string; lang: string }[],
  extractions: Map<string, PortableExtraction>,
  ctx: ResolveContext
): ResolvedGraph {
  const nodes: BrainNodeRow[] = []
  const edges: BrainEdgeRow[] = []
  const nodeIds = new Set<string>()
  const addNode = (n: BrainNodeRow): void => {
    if (nodeIds.has(n.id)) return
    nodeIds.add(n.id)
    nodes.push(n)
  }
  const addEdge = (src: string, dst: string, kind: BrainEdgeRow['kind']): void => {
    edges.push({ src, dst, kind, root })
  }

  const fileSet = new Set(files.map((f) => f.path))
  const moduleId = new Map<string, string>() // file path → module node id
  const defIdsByName = new Map<string, string[]>() // name → def node ids (global index)
  const defIdsByFile = new Map<string, Map<string, string[]>>() // file → name → def ids
  const packageId = new Map<string, string>() // specifier → package module node id

  // 1. Module + def nodes, defines edges — file order is the walk's sorted order.
  for (const f of files) {
    const mid = brainNodeId(root, f.path, 1, f.path, 'module')
    moduleId.set(f.path, mid)
    addNode({ id: mid, root, kind: 'module', name: f.path, file: f.path, startLine: 1, endLine: 1, sig: '' })
    const ex = extractions.get(f.path)
    if (!ex) continue
    const byName = new Map<string, string[]>()
    defIdsByFile.set(f.path, byName)
    for (const d of ex.defs) {
      const id = brainNodeId(root, f.path, d.startLine, d.name, d.kind)
      addNode({ id, root, kind: d.kind, name: d.name, file: f.path, startLine: d.startLine, endLine: d.endLine, sig: d.sig })
      addEdge(mid, id, 'defines')
      if (d.kind !== 'const') {
        defIdsByName.set(d.name, [...(defIdsByName.get(d.name) ?? []), id])
        byName.set(d.name, [...(byName.get(d.name) ?? []), id])
      }
    }
  }

  const ensurePackage = (specifier: string): string => {
    let id = packageId.get(specifier)
    if (!id) {
      id = brainNodeId(root, '', 0, specifier, 'module')
      packageId.set(specifier, id)
      addNode({ id, root, kind: 'module', name: specifier, file: '', startLine: 0, endLine: 0, sig: '' })
    }
    return id
  }

  // 2. Imports: edges + each file's import scope (name → target file | package).
  const importScope = new Map<string, Map<string, { file: string | null; pkg: string | null }>>()
  for (const f of files) {
    const ex = extractions.get(f.path)
    if (!ex) continue
    const mid = moduleId.get(f.path)!
    const scope = new Map<string, { file: string | null; pkg: string | null }>()
    importScope.set(f.path, scope)
    for (const imp of ex.imports) {
      const target = resolveSpecifier(f.path, imp.specifier, f.lang, fileSet, ctx)
      const dst = target ? moduleId.get(target)! : ensurePackage(imp.specifier)
      addEdge(mid, dst, 'imports')
      for (const name of imp.names) {
        scope.set(name, target ? { file: target, pkg: null } : { file: null, pkg: imp.specifier })
      }
    }
  }

  // 3. References + heritage: import-scope first, unique global name second,
  //    everything else DROPPED AND COUNTED. Never a guess presented as a fact.
  let resolvedRefs = 0
  let droppedRefs = 0
  const resolveName = (fromFile: string, name: string): string | null => {
    const scoped = importScope.get(fromFile)?.get(name)
    if (scoped?.pkg) return packageId.get(scoped.pkg) ?? null
    if (scoped?.file) {
      const defs = defIdsByFile.get(scoped.file)?.get(name) ?? []
      return defs.length === 1 ? defs[0] : null
    }
    const global = defIdsByName.get(name) ?? []
    return global.length === 1 ? global[0] : null
  }
  for (const f of files) {
    const ex = extractions.get(f.path)
    if (!ex) continue
    const mid = moduleId.get(f.path)!
    for (const ref of ex.refs) {
      const dst = resolveName(f.path, ref.name)
      if (dst) {
        addEdge(mid, dst, 'references')
        resolvedRefs += 1
      } else {
        droppedRefs += 1
      }
    }
    for (const h of ex.heritage) {
      const owner = h.ownerIndex >= 0 ? ex.defs[h.ownerIndex] : undefined
      const src = owner
        ? brainNodeId(root, f.path, owner.startLine, owner.name, owner.kind)
        : mid
      const dst = resolveName(f.path, h.name)
      if (dst) {
        addEdge(src, dst, h.kind)
        resolvedRefs += 1
      } else {
        droppedRefs += 1
      }
    }
  }

  return { nodes, edges, resolvedRefs, droppedRefs }
}

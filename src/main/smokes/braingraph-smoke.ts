import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BrainService } from '@backend/features/brain'
import { brainDebug, handleBrainRebuild } from '../brain'

// Env-gated brain-graph smoke (MOGGING_BRAINGRAPH, ADR 0018 step 03) — WINDOWLESS,
// zero UI, zero network, no daemon. The graph's laws on a fixture TS+py repo with
// HAND-DERIVED truth:
//   (a) node/edge counts exact; a class, its method, an import chain (relative +
//       tsconfig-paths + package), and a cross-file reference present with correct
//       kinds and lines;
//   (b) determinism — rebuild again: the canonical dump byte-identical, the second
//       build all cache hits, the generation moved by exactly one;
//   (c) partitions — the SAME repo as a second worktree indexes into the same db
//       with a disjoint root partition, 100% cache hits, equal per-root counts;
//   (d) a gitignored file is absent; node_modules is absent in the folder fixture;
//   (e) the ambiguous reference is DROPPED AND COUNTED (fidelity, never faked);
//   (f) over-cap refuses `too-large` CARRYING counts, db untouched; and a second
//       rebuild during one in flight refuses `busy`.
// Verdict: out/braingraph-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

// ── The fixture, and its hand-derived truth ──────────────────────────────────────
// 9 indexed files → 9 module nodes + 1 package node ('fs') + 15 defs = 25 nodes.
// 15 defines + 4 imports + 4 references + 1 extends + 1 implements = 25 edges.
// resolvedRefs 6 (readFileSync→fs, tally, compute, greet, Base, Zeta), dropped 1 (dup).
const TRUTH = {
  files: 9,
  nodes: 25,
  edges: 25,
  languages: ['json', 'python', 'typescript'],
  resolvedRefs: 6,
  droppedRefs: 1
}

const FIXTURE: Record<string, string> = {
  'tsconfig.json': `{\n  "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"] } }\n}\n`,
  '.gitignore': `secret.ts\n`,
  'src/lib/util.ts': `export function tally(): number {\n  return 1\n}\n`,
  'src/alpha.ts': `import { tally } from '@lib/util'\nimport { readFileSync } from 'fs'\n\nexport class Base {}\nexport interface Zeta {}\n\nexport function alpha(): number {\n  readFileSync('x')\n  return tally()\n}\n`,
  'src/gamma.ts': `import { Base, Zeta } from './alpha'\n\nexport class Gamma extends Base implements Zeta {\n  run(): number {\n    return compute()\n  }\n}\n\nfunction compute(): number {\n  return 2\n}\n`,
  'py/main.py': `from helper import greet\n\ndef top():\n    return greet()\n`,
  'py/helper.py': `def greet():\n    return 1\n`,
  'dup_a.ts': `export function dup(): number {\n  return 1\n}\n`,
  'dup_b.ts': `export function dup(): number {\n  return 2\n}\n`,
  'caller.ts': `export function caller(): number {\n  return dup()\n}\n`
}

interface DumpNode { id: string; root: string; kind: string; name: string; file: string; startLine: number; endLine: number }
interface DumpEdge { src: string; dst: string; kind: string; root: string }

function parseDump(dump: string): { files: { root: string; path: string }[]; nodes: DumpNode[]; edges: DumpEdge[] } {
  const files: { root: string; path: string }[] = []
  const nodes: DumpNode[] = []
  const edges: DumpEdge[] = []
  for (const line of dump.split('\n')) {
    if (line.startsWith('F ')) files.push(JSON.parse(line.slice(2)))
    else if (line.startsWith('N ')) nodes.push(JSON.parse(line.slice(2)))
    else if (line.startsWith('E ')) edges.push(JSON.parse(line.slice(2)))
  }
  return { files, nodes, edges }
}

export async function runBrainGraphSmoke(): Promise<void> {
  const resultFile = join(app.getAppPath(), 'out', 'braingraph-result.json')
  // RE-ENTRY guard (electron-vite dev respawns electron after app.exit).
  if (existsSync(resultFile)) {
    app.exit(0)
    return
  }
  const write = (o: object): void => {
    try {
      mkdirSync(dirname(resultFile), { recursive: true })
      writeFileSync(resultFile, JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: braingraph smoke did not complete' })
    app.exit(1)
  }, 120000)

  const scratch: string[] = []
  const tmp = (prefix: string): string => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    scratch.push(dir)
    return dir
  }
  const cleanup = (): void => {
    for (const dir of scratch) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }

  try {
    // The repo fixture, committed (a worktree checkout carries only commits).
    const repo = tmp('mog-braingraph-')
    for (const [rel, src] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true })
      writeFileSync(join(repo, rel), src)
    }
    git(repo, ['init'])
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    // autocrlf OFF: a Windows checkout would otherwise rewrite LF→CRLF in the
    // worktree — genuinely different bytes, an HONEST cache miss, but this arm
    // exists to prove the cache on identical bytes, so the fixture pins them.
    git(repo, ['config', 'core.autocrlf', 'false'])
    git(repo, ['config', 'user.email', 'smoke@mogging.test'])
    git(repo, ['config', 'user.name', 'Mogging Smoke'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'fixture'])
    writeFileSync(join(repo, 'secret.ts'), 'export function hidden(): number {\n  return 0\n}\n') // gitignored, uncommitted

    // ── (a) the first build: exact counts, exact shapes ──────────────────────────
    const b1 = await handleBrainRebuild({ root: repo })
    const countsOk =
      b1.ok &&
      b1.files === TRUTH.files && b1.nodes === TRUTH.nodes && b1.edges === TRUTH.edges &&
      b1.languages.join(',') === TRUTH.languages.join(',') &&
      b1.resolvedRefs === TRUTH.resolvedRefs && b1.droppedRefs === TRUTH.droppedRefs &&
      b1.cacheMisses === TRUTH.files && b1.cacheHits === 0
    const dump1 = brainDebug().dump(repo) ?? ''
    const g1 = parseDump(dump1)
    const node = (pred: (n: DumpNode) => boolean): DumpNode | undefined => g1.nodes.find(pred)
    const gamma = node((n) => n.kind === 'class' && n.name === 'Gamma')
    const run = node((n) => n.kind === 'method' && n.name === 'run')
    const base = node((n) => n.kind === 'class' && n.name === 'Base')
    const zeta = node((n) => n.kind === 'interface' && n.name === 'Zeta')
    const tally = node((n) => n.kind === 'function' && n.name === 'tally')
    const greet = node((n) => n.kind === 'function' && n.name === 'greet')
    const mod = (path: string): DumpNode | undefined => node((n) => n.kind === 'module' && n.file === path)
    const gammaMod = mod('src/gamma.ts')
    const alphaMod = mod('src/alpha.ts')
    const utilMod = mod('src/lib/util.ts')
    const mainPyMod = mod('py/main.py')
    const fsPkg = node((n) => n.kind === 'module' && n.name === 'fs' && n.file === '')
    const edge = (src?: DumpNode, dst?: DumpNode, kind?: string): boolean =>
      !!src && !!dst && g1.edges.some((e) => e.src === src.id && e.dst === dst.id && e.kind === kind)
    const shapesOk =
      !!gamma && gamma.startLine === 3 && gamma.endLine === 7 &&
      !!run && run.startLine === 4 && run.endLine === 6 &&
      edge(gammaMod, alphaMod, 'imports') && // the import chain: relative…
      edge(alphaMod, utilMod, 'imports') && // …tsconfig paths…
      edge(alphaMod, fsPkg, 'imports') && // …and a package module node
      edge(mainPyMod, greet, 'references') && // the cross-file reference
      edge(gamma, base, 'extends') &&
      edge(gamma, zeta, 'implements') &&
      edge(alphaMod, tally, 'references')

    // ── (e) fidelity: the ambiguous dup() was dropped AND counted ────────────────
    const droppedOk =
      b1.ok && b1.droppedRefs === 1 &&
      !g1.edges.some((e) => e.kind === 'references' && g1.nodes.find((n) => n.id === e.dst)?.name === 'dup')

    // ── (b) determinism: rebuild → byte-identical dump, all hits, one bump ───────
    const b2 = await handleBrainRebuild({ root: repo })
    const dump2 = brainDebug().dump(repo) ?? ''
    const determinismOk =
      b1.ok && b2.ok &&
      dump2 === dump1 &&
      b2.generation === b1.generation + 1 &&
      b2.cacheHits === TRUTH.files && b2.cacheMisses === 0

    // ── (c) partitions: a second worktree, same bytes, disjoint root, all hits ───
    mkdirSync(join(repo, '.mogging'), { recursive: true })
    writeFileSync(join(repo, '.mogging', '.gitignore'), '*\n')
    const wt = join(repo, '.mogging', 'worktrees', 'wt1')
    git(repo, ['worktree', 'add', wt, '-b', 'mogging/wt1'])
    const b3 = await handleBrainRebuild({ root: wt })
    const dump3 = brainDebug().dump(repo) ?? ''
    const g3 = parseDump(dump3)
    const roots = [...new Set(g3.files.map((f) => f.root))]
    const perRoot = (root: string): { f: number; n: number; e: number } => ({
      f: g3.files.filter((x) => x.root === root).length,
      n: g3.nodes.filter((x) => x.root === root).length,
      e: g3.edges.filter((x) => x.root === root).length
    })
    const partitionsOk =
      b3.ok &&
      b3.cacheHits === TRUTH.files && b3.cacheMisses === 0 && // identical bytes: paid for ONCE
      roots.length === 2 &&
      roots.every((r) => {
        const c = perRoot(r)
        return c.f === TRUTH.files && c.n === TRUTH.nodes && c.e === TRUTH.edges
      }) &&
      b3.files === TRUTH.files * 2 && b3.nodes === TRUTH.nodes * 2 && b3.edges === TRUTH.edges * 2

    // ── (d) ignore truth: gitignored absent; node_modules absent in a folder ─────
    const gitignoredOk = !dump3.includes('secret.ts')
    const folder = tmp('mog-braingraph-f-')
    mkdirSync(join(folder, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(folder, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(folder, 'a.py'), 'def solo():\n    return 1\n')
    const bf = await handleBrainRebuild({ root: folder })
    const folderDump = brainDebug().dump(folder) ?? ''
    const folderOk = bf.ok && bf.files === 1 && !folderDump.includes('node_modules') && folderDump.includes('a.py')

    // ── (f) the caps + busy walls, on a service of our own ───────────────────────
    const svc = new BrainService({
      baseDir: tmp('mog-braingraph-db-'),
      workerFile: join(app.getAppPath(), 'out', 'main', 'brain-worker.js'),
      grammarsDir: join(app.getAppPath(), 'assets', 'grammars')
    })
    const many = tmp('mog-braingraph-cap-')
    for (let i = 0; i < 6; i++) writeFileSync(join(many, `f${i}.txt`), 'x\n')
    const capped = await svc.rebuild(many, { maxFiles: 5 })
    const cappedStatus = svc.status(many)
    const tooLargeOk =
      !capped.ok && capped.reason === 'too-large' &&
      /6/.test(capped.detail ?? '') && /5/.test(capped.detail ?? '') &&
      cappedStatus.ok && cappedStatus.files === 0 // db untouched

    const inFlight = svc.rebuild(many) // no await: the build is now in flight
    const second = await svc.rebuild(many)
    const busyOk = !second.ok && second.reason === 'busy'
    const first = await inFlight
    const busyClearsOk = first.ok && (await svc.rebuild(many)).ok // and the wall lifts
    svc.dispose()

    const pass =
      countsOk && !!shapesOk && droppedOk && determinismOk &&
      partitionsOk && gitignoredOk && folderOk && tooLargeOk && busyOk && busyClearsOk
    write({
      pass,
      countsOk, shapesOk: !!shapesOk, droppedOk, determinismOk,
      partitionsOk, gitignoredOk, folderOk, tooLargeOk, busyOk, busyClearsOk,
      status1: b1.ok ? { files: b1.files, nodes: b1.nodes, edges: b1.edges, languages: b1.languages, resolvedRefs: b1.resolvedRefs, droppedRefs: b1.droppedRefs, cacheHits: b1.cacheHits, cacheMisses: b1.cacheMisses } : b1,
      status3: b3.ok ? { files: b3.files, nodes: b3.nodes, edges: b3.edges, cacheHits: b3.cacheHits, cacheMisses: b3.cacheMisses } : b3,
      perRootCounts: roots.map((r) => ({ root: r, ...perRoot(r) })),
      truth: TRUTH,
      roots,
      dumpBytes: dump1.length,
      platform: process.platform
    })
    brainDebug().dispose()
    cleanup()
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    brainDebug().dispose()
    cleanup()
    app.exit(1)
  }
}

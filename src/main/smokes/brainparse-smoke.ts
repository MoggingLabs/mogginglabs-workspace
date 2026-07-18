import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BRAIN_MAX_FILE_BYTES } from '@contracts'

// Env-gated brain-parse smoke (MOGGING_BRAINPARSE, ADR 0018.g) — WINDOWLESS, zero
// UI, zero network, no daemon, no graph. Proves the parser layer + the catalog
// DISCIPLINE, through the real worker file the indexer will use:
//   (a) every roster language parses its fixture; def/ref/import counts match the
//       pinned fixture truth; no fixture parses with syntax errors;
//   (b) an unknown extension is a COUNTED skip, never an error;
//   (c) a file over BRAIN_MAX_FILE_BYTES is a COUNTED skip (stat-first, bytes unread);
//       a missing path is a COUNTED skip (the parse-failed bucket — never a crash);
//   (d) the CHECK script (GRAMMARCAT) goes RED on a corrupted temp copy of a wasm
//       and GREEN on the pristine tree — run as a child, both directions asserted;
//   (e) lazy load — after one parse, pool status names ONLY that language; after all
//       18, live parsers sit at the LRU cap;
//   (f) all parsing happened IN THE WORKER: the instrumentation counter is absent on
//       the main thread and equals the work in the worker.
// (The per-parse timeout ships in the pool; a deterministic hung-grammar fixture
// does not exist at these sizes, so the counted-skip path is proven via the missing
// file — same bucket, same ledger.)
// Verdict: out/brainparse-result.json.

// The fixture truth: source per language + hand-counted defs/refs/imports, pinned.
// These strings are the SAME shapes scripts/update-grammar-catalog.mjs probes with —
// boring on purpose; behavior coverage grows with 03's extraction, not here.
const FIXTURES: Record<string, { file: string; src: string; defs: number; refs: number; imports: number }> = {
  typescript: {
    file: 'fixture.ts',
    src: `import { x } from './x'\n\nfunction alpha(): number {\n  return beta()\n}\n\nclass Gamma {\n  delta(): void {\n    this.epsilon()\n  }\n}\n\ninterface Zeta {}\n`,
    defs: 4, refs: 2, imports: 1
  },
  tsx: {
    file: 'fixture.tsx',
    src: `import { W } from './w'\n\nfunction view(): unknown {\n  return <W title={label()} />\n}\n`,
    defs: 1, refs: 1, imports: 1
  },
  javascript: {
    file: 'fixture.js',
    src: `import { x } from './x'\n\nfunction alpha() {\n  return beta()\n}\n\nclass Gamma {\n  delta() {\n    this.epsilon()\n  }\n}\n`,
    defs: 3, refs: 2, imports: 1
  },
  python: {
    file: 'fixture.py',
    src: `import os\nfrom sys import path\n\ndef alpha():\n    return beta()\n\nclass Gamma:\n    def delta(self):\n        self.epsilon()\n`,
    defs: 3, refs: 2, imports: 2
  },
  go: {
    file: 'fixture.go',
    src: `package main\n\nimport "fmt"\n\ntype Zeta struct{}\n\nfunc alpha() {\n\tbeta()\n}\n\nfunc (z Zeta) delta() {\n\tz.epsilon()\n\tfmt.Println("hi")\n}\n`,
    defs: 3, refs: 3, imports: 1
  },
  rust: {
    file: 'fixture.rs',
    src: `use std::fmt;\n\nstruct Zeta;\n\nfn alpha() {\n    beta();\n    zeta.epsilon();\n}\n`,
    defs: 2, refs: 2, imports: 1
  },
  java: {
    file: 'fixture.java',
    src: `import java.util.List;\n\nclass Gamma {\n    void delta() {\n        epsilon();\n    }\n}\n\ninterface Zeta {}\n`,
    defs: 3, refs: 1, imports: 1
  },
  c: {
    file: 'fixture.c',
    src: `#include <stdio.h>\n\nstruct zeta { int x; };\n\nint alpha(void) {\n    return beta();\n}\n`,
    defs: 2, refs: 1, imports: 1
  },
  cpp: {
    file: 'fixture.cpp',
    src: `#include <vector>\n\nclass Gamma {};\nstruct Zeta {};\n\nint alpha() {\n    beta();\n    obj.epsilon();\n    return 0;\n}\n`,
    defs: 3, refs: 2, imports: 1
  },
  c_sharp: {
    file: 'fixture.cs',
    src: `using System;\n\nclass Gamma {\n    void Delta() {\n        Epsilon();\n        obj.Zeta();\n    }\n}\n\ninterface IZeta {}\n`,
    defs: 3, refs: 2, imports: 1
  },
  ruby: {
    file: 'fixture.rb',
    src: `class Gamma\n  def delta\n    epsilon()\n  end\nend\n\nmodule Zeta\nend\n`,
    defs: 3, refs: 1, imports: 0
  },
  php: {
    file: 'fixture.php',
    src: `<?php\nuse Foo\\Bar;\n\nfunction alpha() {\n    return beta();\n}\n\nclass Gamma {\n    function delta() {\n        $this->epsilon();\n    }\n}\n`,
    defs: 3, refs: 2, imports: 1
  },
  bash: {
    file: 'fixture.sh',
    src: `greet() {\n  echo hello\n}\n\ngreet\ndate\n`,
    defs: 1, refs: 3, imports: 0
  },
  json: { file: 'fixture.json', src: `{ "alpha": 1, "beta": { "gamma": 2 } }\n`, defs: 3, refs: 0, imports: 0 },
  yaml: { file: 'fixture.yml', src: `alpha: 1\nbeta:\n  gamma: 2\n`, defs: 3, refs: 0, imports: 0 },
  toml: { file: 'fixture.toml', src: `alpha = 1\n\n[table]\nbeta = 2\n`, defs: 3, refs: 0, imports: 0 },
  html: { file: 'fixture.html', src: `<html><body class="x"><p>hi</p></body></html>\n`, defs: 3, refs: 1, imports: 0 },
  css: { file: 'fixture.css', src: `body { color: red; }\n.card { margin: 0; }\n`, defs: 2, refs: 2, imports: 0 }
}

interface WorkerClient {
  worker: Worker
  ask: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>
  dispose: () => Promise<void>
}

function connect(workerFile: string, grammarsDir: string): WorkerClient {
  const worker = new Worker(workerFile, { workerData: { grammarsDir } })
  let nextId = 1
  const pending = new Map<number, (reply: Record<string, unknown>) => void>()
  worker.on('message', (reply: { id: number }) => {
    const resolve = pending.get(reply.id)
    if (resolve) {
      pending.delete(reply.id)
      resolve(reply as unknown as Record<string, unknown>)
    }
  })
  const ask = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`worker request ${JSON.stringify(msg)} timed out`))
      }, 30000)
      worker.postMessage({ id, ...msg })
    })
  return { worker, ask, dispose: async () => void (await worker.terminate()) }
}

export async function runBrainParseSmoke(): Promise<void> {
  const resultFile = join(app.getAppPath(), 'out', 'brainparse-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainparse smoke did not complete' })
    app.exit(1)
  }, 120000)

  const appPath = app.getAppPath()
  const workerFile = join(appPath, 'out', 'main', 'brain-worker.js')
  const grammarsDir = join(appPath, 'assets', 'grammars')
  const fixDir = mkdtempSync(join(tmpdir(), 'mog-brainparse-'))
  let client: WorkerClient | null = null
  const cleanup = (): void => {
    try {
      rmSync(fixDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  try {
    for (const f of Object.values(FIXTURES)) writeFileSync(join(fixDir, f.file), f.src)
    client = connect(workerFile, grammarsDir)

    // ── (a) first language + (e) lazy load: only the touched language appears ────
    const langs = Object.keys(FIXTURES)
    const perLang: Record<string, string> = {}
    const first = langs[0] // typescript
    const parseOne = async (lang: string): Promise<void> => {
      const f = FIXTURES[lang]
      const r = (await client!.ask({ op: 'parse', path: join(fixDir, f.file) })) as {
        ok?: boolean
        lang?: string
        hasError?: boolean
        tagCounts?: { defs: number; refs: number; imports: number }
        skipped?: string
      }
      if (!r.ok) perLang[lang] = `SKIPPED ${r.skipped}`
      else if (r.lang !== lang) perLang[lang] = `routed to ${r.lang}`
      else if (r.hasError) perLang[lang] = 'fixture parsed WITH ERRORS'
      else if (r.tagCounts?.defs !== f.defs || r.tagCounts?.refs !== f.refs || r.tagCounts?.imports !== f.imports)
        perLang[lang] = `counts ${JSON.stringify(r.tagCounts)} wanted ${f.defs}/${f.refs}/${f.imports}`
      else perLang[lang] = 'ok'
    }
    await parseOne(first)
    const statusAfterOne = ((await client.ask({ op: 'status' })) as { status: { loaded: string[] } }).status
    const lazyOk = statusAfterOne.loaded.length === 1 && statusAfterOne.loaded[0] === first
    for (const lang of langs.slice(1)) await parseOne(lang)
    const parseOk = langs.every((l) => perLang[l] === 'ok')

    // ── (b) unknown extension: counted skip ──────────────────────────────────────
    writeFileSync(join(fixDir, 'mystery.xyz'), 'what am i\n')
    const unknown = (await client.ask({ op: 'parse', path: join(fixDir, 'mystery.xyz') })) as { ok?: boolean; skipped?: string }
    const unknownOk = unknown.ok === false && unknown.skipped === 'unknown-extension'

    // ── (c) oversized file: counted skip, bytes never read; missing: parse-failed ─
    writeFileSync(join(fixDir, 'huge.js'), Buffer.alloc(BRAIN_MAX_FILE_BYTES + 1, 0x2f))
    const oversize = (await client.ask({ op: 'parse', path: join(fixDir, 'huge.js') })) as { ok?: boolean; skipped?: string }
    const oversizeOk = oversize.ok === false && oversize.skipped === 'too-large'
    const missing = (await client.ask({ op: 'parse', path: join(fixDir, 'gone.py') })) as { ok?: boolean; skipped?: string }
    const missingOk = missing.ok === false && missing.skipped === 'parse-failed'

    // ── (e) LRU cap + ledger, (f) the thread proof ───────────────────────────────
    const finalStatus = (
      (await client.ask({ op: 'status' })) as {
        status: { loaded: string[]; liveParsers: number; parses: number; skips: Record<string, number>; workerParses: number }
      }
    ).status
    const lruOk = finalStatus.loaded.length === langs.length && finalStatus.liveParsers === 8
    const ledgerOk =
      finalStatus.parses === langs.length &&
      finalStatus.skips['unknown-extension'] === 1 &&
      finalStatus.skips['too-large'] === 1 &&
      finalStatus.skips['parse-failed'] === 1
    const threadOk =
      (globalThis.__moggingBrainParses ?? 0) === 0 && finalStatus.workerParses === langs.length

    const disposed = (await client.ask({ op: 'dispose' })) as { done?: boolean }
    const disposeOk = disposed.done === true

    // ── (d) the discipline: pristine catalog GREEN, corrupted temp copy RED ──────
    // 'node' from PATH, NEVER process.execPath: in Electron main that is the Electron
    // binary, which boots a whole app off the script and never exits — and spawnSync
    // then blocks the main loop so hard even the smoke's own timeout timer dies.
    const checkScript = join(appPath, 'scripts', 'check-grammar-catalog.mjs')
    const pristine = spawnSync('node', [checkScript], { cwd: appPath, encoding: 'utf8', windowsHide: true })
    const checkPristineOk = pristine.status === 0
    const tamperDir = join(fixDir, 'grammars-copy')
    cpSync(grammarsDir, tamperDir, { recursive: true })
    const victim = join(tamperDir, 'tree-sitter-json.wasm')
    const bytes = readFileSync(victim)
    bytes[64] = bytes[64] ^ 0xff // one flipped byte, deep enough to keep the magic intact
    writeFileSync(victim, bytes)
    const tampered = spawnSync('node', [checkScript, '--grammars-dir', tamperDir], { cwd: appPath, encoding: 'utf8', windowsHide: true })
    const checkTamperOk = tampered.status !== 0 && /sha256/.test(tampered.stderr)

    const pass =
      parseOk && lazyOk && unknownOk && oversizeOk && missingOk &&
      lruOk && ledgerOk && threadOk && disposeOk && checkPristineOk && checkTamperOk
    write({
      pass,
      parseOk, lazyOk, unknownOk, oversizeOk, missingOk,
      lruOk, ledgerOk, threadOk, disposeOk, checkPristineOk, checkTamperOk,
      perLang, finalStatus,
      mainThreadParses: globalThis.__moggingBrainParses ?? 0,
      tamperStderr: checkTamperOk ? undefined : tampered.stderr?.slice(0, 400),
      platform: process.platform
    })
    await client.dispose()
    cleanup()
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    await client?.dispose().catch(() => undefined)
    cleanup()
    app.exit(1)
  }
}

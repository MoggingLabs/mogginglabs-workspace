import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTelemetry } from '@backend'
import { MCP_BRAIN_WRITE_TOOL_NAMES, type Telemetry } from '@contracts'
import { brainDebug, handleBrainRebuild } from '../brain'
import { setIntegrationsGrant } from '../integrations'
import { flushTrailForSmoke, readTrail } from '../trail'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated symbol-write smoke (MOGGING_BRAINWRITE, ADR 0018 step 07): panes
// edit BY SYMBOL, custody first. The REAL `bin/mogging-mcp.mjs` drives the
// three write tools from inside a REAL pane against the 03 fixture:
//   (a) no grant: the write tools are ABSENT from tools/list AND a forced call
//       refuses naming the grant (the board precedent, verbatim);
//   (b) grant on: tools/list_changed observed; replace_symbol_body lands —
//       bytes EXACT (fixture-known before/after), generation bumped by exactly
//       one, and the landed node is queryable immediately, no wait;
//   (c) stale: a real pane shell mutates the file first → the write refuses
//       carrying the FRESH hash, and the refused write left the disk untouched
//       (byte-compare) — the board's refuse-with-fresh-card shape, for files;
//   (d) wrong-checkout: a worktree-B node id from a worktree-A session refuses
//       — reads may see the sibling under scope:'project'; writes never touch it;
//   (e) insert_after_symbol on a NESTED method preserves its indentation;
//   (f) hostile body ($(rm -rf), backticks, CRLF mix) lands as INERT BYTES —
//       nothing executes, the file round-trips exactly;
//   (g) exactly N trail events (verb + outcome, counts only), zero fixture
//       paths or symbol names in the trail OR in any telemetry call (a
//       recording adapter sits on the port for the whole run);
//   (h) SIGKILL a real write-file-atomic storm mid-flight → every stormed file
//       is wholly old or wholly new, never mixed — and the brain still rebuilds.
// Verdict: out/brainwrite-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const fold = (p: string): string => p.replace(/\//g, '\\').toLocaleLowerCase('en-US')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ── Fixture-known before/after bytes (the write rules, spelled out) ──────────

const TARGET_BEFORE = 'export function alpha(): number {\n  return 1\n}\n\nexport function omega(): number {\n  return 2\n}\n'
const ALPHA_BODY = 'export function alpha(): number {\n  const x = 40\n  return x + 2\n}\n'
const TARGET_AFTER = ALPHA_BODY + '\nexport function omega(): number {\n  return 2\n}\n'

const BOX_BEFORE = 'export class Box {\n  value(): number {\n    return 1\n  }\n}\n'
const INSERT_TEXT = 'twice(): number {\n  return this.value() * 2\n}'
const BOX_AFTER =
  'export class Box {\n  value(): number {\n    return 1\n  }\n  twice(): number {\n    return this.value() * 2\n  }\n}\n'

const HOSTILE_BEFORE = 'export function victim(): number {\n  return 3\n}\n'
const HOSTILE_BODY =
  'export function victim(): string {\r\n  const cmd = "$(rm -rf ~/nope) `whoami`; echo pwned"\r\n  return cmd\r\n}'
// No trailing newline on the body: the file's own LF gets appended (whole-line law).
const HOSTILE_AFTER = HOSTILE_BODY + '\n'

const STALE_BEFORE = 'export function stale_fn(): number {\n  return 9\n}\n'
const STALE_APPEND = '\nexport function stale_extra(): number {\n  return 10\n}\n'

const FIXTURE: Record<string, string> = {
  'src/target.ts': TARGET_BEFORE,
  'src/box.ts': BOX_BEFORE,
  'src/hostile.ts': HOSTILE_BEFORE,
  'src/stale.ts': STALE_BEFORE,
  'KEEP.txt': 'sentinel: still being here means the hostile body never executed\n'
}

interface Fixture {
  base: string
  repo: string
  wt: string
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainwrite-')))
  const repo = join(base, 'repo')
  for (const [rel, src] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), src)
  }
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixture'])
  mkdirSync(join(repo, '.mogging'), { recursive: true })
  writeFileSync(join(repo, '.mogging', '.gitignore'), '*\n')
  const wt = join(repo, '.mogging', 'worktrees', 'wt1')
  git(repo, ['worktree', 'add', wt, '-b', 'mogging/wt1'])
  // The REAL pane's out-of-band mutation tool, OUTSIDE both checkouts.
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'append') appendFileSync(${JSON.stringify(join(repo, 'src', 'stale.ts'))}, ${JSON.stringify(STALE_APPEND)})\n`
  )
  return { base, repo, wt }
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

type NodeHit = { id: string; kind: string; name: string; file: string; startLine: number; endLine: number; root?: string }

export function runBrainWriteSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainwrite-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainwrite smoke did not complete' })
    app.exit(1)
  }, 280000)

  // (g)'s telemetry witness: a recorder on the PORT for the whole run — every
  // event/breadcrumb/context any code path emits lands here for the path scan.
  const telemetryCalls: string[] = []
  const recorder: Telemetry = {
    init: () => undefined,
    captureError: (error, context) => void telemetryCalls.push(JSON.stringify({ error: String(error), context })),
    captureEvent: (event) => void telemetryCalls.push(JSON.stringify(event)),
    addBreadcrumb: (crumb) => void telemetryCalls.push(JSON.stringify(crumb)),
    setContext: (key, value) => void telemetryCalls.push(JSON.stringify({ key, value })),
    flush: () => Promise.resolve()
  }
  setTelemetry(recorder)

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  const runStart = Date.now()

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) => res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

  const call = async (c: PaneMcpSmokeClient, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const m = await c.rpc('tools/call', { name, arguments: args })
    if (m.error) return { ok: false, isError: false, rpcError: m.error.message ?? 'error', text: '', data: {} }
    const r = (m.result ?? {}) as { content?: { text?: string }[]; isError?: boolean }
    const text = r.content?.[0]?.text ?? ''
    let data: Record<string, unknown> = {}
    if (r.isError !== true) {
      try {
        data = JSON.parse(text) as Record<string, unknown>
      } catch {
        /* non-JSON success payloads keep data empty */
      }
    }
    return { ok: r.isError !== true, isError: r.isError === true, rpcError: null, text, data }
  }

  const listNames = async (c: PaneMcpSmokeClient): Promise<string[]> =>
    (((await c.rpc('tools/list')).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)

  const waitFor = async (probe: () => Promise<boolean> | boolean, tries = 25, gapMs = 400): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const hits = (a: ToolAnswer, key: string): NodeHit[] => (Array.isArray(a.data[key]) ? (a.data[key] as NodeHit[]) : [])
  const WRITE3 = [...MCP_BRAIN_WRITE_TOOL_NAMES] as string[]

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The world: ONE workspace on the repo (pane 1 = MCP bridge, pane 2 =
      //    the out-of-band mutation shell); the worktree partition is built but
      //    paneless — its nodes exist to be refused. ─────────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'BrainW', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)
      const paneA2 = String(wsA.ordinal * 100 + 2)

      const bA = await handleBrainRebuild({ root: F.repo })
      const bB = await handleBrainRebuild({ root: F.wt })
      if (!bA.ok || !bB.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify({ bA, bB }))

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (a) no grant: absent from tools/list AND a forced call refuses ─────
      const namesNone = await listNames(c1)
      const forcedNone = await call(c1, 'replace_symbol_body', {
        id: 'f'.repeat(40),
        expectedFileHash: 'a'.repeat(64),
        body: 'nope'
      })
      const noGrantOk =
        namesNone.every((n) => !WRITE3.includes(n)) &&
        namesNone.includes('find_symbol') && // reads stay free
        !!forcedNone.rpcError && /grant/.test(forcedNone.rpcError)

      // ── (b) grant ON via the ONE existing toggle: list_changed + landing ───
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const listChangedOk = await waitFor(() => c1.notifications.includes('notifications/tools/list_changed'))
      const namesAll = await listNames(c1)
      const visibleOk = WRITE3.every((n) => namesAll.includes(n))

      const symAlpha = await call(c1, 'find_symbol', { name: 'alpha' })
      const alpha = hits(symAlpha, 'matches')[0]
      const nodeAlpha = await call(c1, 'get_node', { id: alpha?.id ?? '' })
      const genBefore = nodeAlpha.data.generation as number
      const alphaHash = String(nodeAlpha.data.fileHash ?? '')
      // The CAS handshake's source of truth: get_node's fileHash IS the disk hash.
      const casHandshakeOk = alphaHash === sha256(readFileSync(join(F.repo, 'src', 'target.ts')))

      const replaced = await call(c1, 'replace_symbol_body', {
        id: alpha?.id ?? '',
        expectedFileHash: alphaHash,
        body: ALPHA_BODY
      })
      const targetDisk = readFileSync(join(F.repo, 'src', 'target.ts'))
      const replacedNode = (replaced.data.node ?? null) as NodeHit | null
      const replaceOk =
        replaced.ok &&
        targetDisk.equals(Buffer.from(TARGET_AFTER, 'utf8')) &&
        replaced.data.generation === genBefore + 1 &&
        replaced.data.newFileHash === sha256(TARGET_AFTER) &&
        !!replacedNode && replacedNode.name === 'alpha' && replacedNode.startLine === 1 && replacedNode.endLine === 4

      // Queryable IMMEDIATELY — no sleep between the landing and these reads.
      const omegaNow = await call(c1, 'find_symbol', { name: 'omega' })
      const nodeBack = await call(c1, 'get_node', { id: replacedNode?.id ?? '' })
      const statusNow = await call(c1, 'brain_status')
      const immediateOk =
        omegaNow.ok && hits(omegaNow, 'matches')[0]?.startLine === 6 && // the shifted truth, already served
        nodeBack.ok && (nodeBack.data.node as NodeHit | undefined)?.name === 'alpha' &&
        statusNow.ok && (statusNow.data.generation as number) === genBefore + 1

      // ── (e) insert_after on a NESTED method: indentation from the anchor ───
      const symValue = await call(c1, 'find_symbol', { name: 'value', kind: 'method' })
      const valueNode = hits(symValue, 'matches')[0]
      const nodeValue = await call(c1, 'get_node', { id: valueNode?.id ?? '' })
      const inserted = await call(c1, 'insert_after_symbol', {
        id: valueNode?.id ?? '',
        expectedFileHash: String(nodeValue.data.fileHash ?? ''),
        text: INSERT_TEXT
      })
      const boxDisk = readFileSync(join(F.repo, 'src', 'box.ts'))
      const twiceNow = await call(c1, 'find_symbol', { name: 'twice' })
      const insertOk =
        inserted.ok &&
        boxDisk.equals(Buffer.from(BOX_AFTER, 'utf8')) &&
        ((inserted.data.node ?? null) as NodeHit | null)?.name === 'value' && // the anchor, unmoved
        twiceNow.ok && hits(twiceNow, 'matches')[0]?.startLine === 5 // the landed method, already queryable

      // ── (f) hostile body lands as INERT BYTES, round-trips exactly ─────────
      const symVictim = await call(c1, 'find_symbol', { name: 'victim' })
      const victimNode = hits(symVictim, 'matches')[0]
      const nodeVictim = await call(c1, 'get_node', { id: victimNode?.id ?? '' })
      const hostile = await call(c1, 'replace_symbol_body', {
        id: victimNode?.id ?? '',
        expectedFileHash: String(nodeVictim.data.fileHash ?? ''),
        body: HOSTILE_BODY
      })
      const hostileDisk = readFileSync(join(F.repo, 'src', 'hostile.ts'))
      const hostileOk =
        hostile.ok &&
        hostileDisk.equals(Buffer.from(HOSTILE_AFTER, 'utf8')) && // CRLF mix verbatim, LF appended
        existsSync(join(F.repo, 'KEEP.txt')) // nothing executed

      // ── Junk in → typed refusals out (still granted; the session survives) ─
      const badHash = await call(c1, 'replace_symbol_body', {
        id: replacedNode?.id ?? '',
        expectedFileHash: 'not-a-hash',
        body: 'x'
      })
      const badNode = await call(c1, 'replace_symbol_body', {
        id: 'f'.repeat(40),
        expectedFileHash: 'a'.repeat(64),
        body: 'x'
      })
      const junkOk =
        badHash.isError && /expectedFileHash|sha256/.test(badHash.text) &&
        badNode.isError && /unknown node/.test(badNode.text) &&
        (await call(c1, 'brain_status')).ok

      // ── (d) wrong-checkout: worktree-B's node refuses from A's session ─────
      const projOmega = await call(c1, 'find_symbol', { name: 'omega', scope: 'project' })
      const omegaB = hits(projOmega, 'matches').find((n) => fold(String(n.root ?? '')) === fold(F.wt))
      const nodeB = await call(c1, 'get_node', { id: omegaB?.id ?? '', scope: 'project' })
      const wtTargetBefore = readFileSync(join(F.wt, 'src', 'target.ts'))
      const crossWrite = await call(c1, 'replace_symbol_body', {
        id: omegaB?.id ?? '',
        expectedFileHash: String(nodeB.data.fileHash ?? ''),
        body: 'export function omega(): number {\n  return 666\n}\n'
      })
      const wrongCheckoutOk =
        !!omegaB &&
        crossWrite.isError && /checkout/.test(crossWrite.text) &&
        readFileSync(join(F.wt, 'src', 'target.ts')).equals(wtTargetBefore) // untouched

      // ── (c) stale: a REAL shell mutates first; the refusal carries the
      //    fresh hash and the refused write leaves the disk alone ────────────
      const symStale = await call(c1, 'find_symbol', { name: 'stale_fn' })
      const staleNode = hits(symStale, 'matches')[0]
      const nodeStale = await call(c1, 'get_node', { id: staleNode?.id ?? '' })
      const hash0 = String(nodeStale.data.fileHash ?? '')
      const sent = await cli(['send', paneA2, 'node ../ops.mjs append'])
      if (sent.code !== 0) throw new Error('could not drive the mutation pane')
      const mutated = await waitFor(
        () => readFileSync(join(F.repo, 'src', 'stale.ts'), 'utf8') !== STALE_BEFORE,
        50,
        400
      )
      const diskAfterShell = readFileSync(join(F.repo, 'src', 'stale.ts'))
      const freshHash = sha256(diskAfterShell)
      const staleWrite = await call(c1, 'replace_symbol_body', {
        id: staleNode?.id ?? '',
        expectedFileHash: hash0, // the OLD hash — a stale claim, on purpose
        body: 'export function stale_fn(): number {\n  return 90\n}\n'
      })
      const staleOk =
        mutated &&
        staleWrite.isError &&
        /stale|changed/.test(staleWrite.text) &&
        staleWrite.text.includes(freshHash) && // the fresh-card shape: the truth rides the refusal
        readFileSync(join(F.repo, 'src', 'stale.ts')).equals(diskAfterShell) // refused = untouched

      // ── (g) the trail: exactly N events, counts only, zero paths/symbols ───
      flushTrailForSmoke()
      const trailRows = readTrail(wsA.id).filter((e) => e.ts >= runStart && WRITE3.includes(e.verb))
      const trailJson = JSON.stringify(trailRows)
      const trailMarkers = ['mog-brainwrite', 'target.ts', 'box.ts', 'stale.ts', 'hostile.ts', 'alpha', 'victim', 'twice']
      const trailOk =
        trailRows.length === 7 && // replace + insert + hostile landed; badHash + badNode + cross + stale refused
        trailRows.filter((e) => e.outcome === 'ok').length === 3 &&
        trailRows.filter((e) => e.outcome === 'refused').length === 4 &&
        trailRows.every((e) => e.target === '1 symbol') &&
        !trailMarkers.some((m) => trailJson.includes(m))
      const telemetryJson = telemetryCalls.join('\n')
      const telemetryOk = !trailMarkers.some((m) => telemetryJson.includes(m))

      // ── (h) the torn-file arm: SIGKILL a real write-file-atomic storm ──────
      const stormDir = join(F.base, 'storm')
      mkdirSync(stormDir, { recursive: true })
      const SEED = 'SEED\n'
      const STORM_A = ('A'.repeat(120) + '\n').repeat(900)
      const STORM_B = ('B'.repeat(120) + '\n').repeat(900)
      for (let i = 0; i < 20; i++) writeFileSync(join(stormDir, `f${String(i).padStart(2, '0')}.txt`), SEED)
      const stormPath = join(F.base, 'storm.mjs')
      writeFileSync(
        stormPath,
        `import { createRequire } from 'node:module'\n` +
          `const req = createRequire(process.argv[2])\n` +
          `const wfa = req('write-file-atomic')\n` +
          `const dir = process.argv[3]\n` +
          `const A = ('A'.repeat(120) + '\\n').repeat(900)\n` +
          `const B = ('B'.repeat(120) + '\\n').repeat(900)\n` +
          `let i = 0\n` +
          `for (;;) {\n` +
          `  wfa.sync(dir + '/f' + String(i % 20).padStart(2, '0') + '.txt', i % 2 ? A : B)\n` +
          `  i++\n` +
          `}\n`
      )
      const storm = spawn(process.execPath, [stormPath, join(root, 'package.json'), stormDir], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true
      })
      await sleep(600)
      storm.kill('SIGKILL')
      await new Promise<void>((r) => {
        storm.once('exit', () => r())
        setTimeout(r, 3000)
      })
      let stormProgressed = false
      let tornFiles = 0
      for (let i = 0; i < 20; i++) {
        const bytes = readFileSync(join(stormDir, `f${String(i).padStart(2, '0')}.txt`), 'utf8')
        if (bytes !== SEED) stormProgressed = true
        if (bytes !== SEED && bytes !== STORM_A && bytes !== STORM_B) tornFiles++
      }
      // …and the world still stands: the brain rebuilds over the fixture whole.
      const rebuildAfter = await handleBrainRebuild({ root: F.repo })
      const stormOk = stormProgressed && tornFiles === 0 && rebuildAfter.ok

      const pass =
        noGrantOk && listChangedOk && visibleOk && casHandshakeOk && replaceOk && immediateOk &&
        insertOk && hostileOk && junkOk && wrongCheckoutOk && staleOk && trailOk && telemetryOk && stormOk
      result = {
        pass,
        noGrantOk,
        forcedNoneMsg: forcedNone.rpcError,
        listChangedOk,
        visibleOk,
        casHandshakeOk,
        replaceOk,
        replacedGen: replaced.data.generation ?? null,
        immediateOk,
        insertOk,
        insertDiag: {
          valueHit: valueNode ?? null,
          isError: inserted.isError,
          msg: inserted.text.slice(0, 300),
          node: inserted.data.node ?? null,
          boxDisk: boxDisk.toString('latin1'),
          twiceHit: hits(twiceNow, 'matches')[0] ?? null
        },
        hostileOk,
        hostileDiag: {
          victimHit: victimNode ?? null,
          isError: hostile.isError,
          msg: hostile.text.slice(0, 300),
          diskMatches: hostileDisk.equals(Buffer.from(HOSTILE_AFTER, 'utf8')),
          disk: hostileDisk.toString('latin1')
        },
        trailOutcomes: trailRows.map((e) => `${e.verb}:${e.outcome}:${e.reason ?? ''}`),
        junkOk,
        wrongCheckoutOk,
        crossMsg: crossWrite.text,
        staleOk,
        staleMsg: staleWrite.text.slice(0, 300),
        trailOk,
        trailCount: trailRows.length,
        telemetryOk,
        telemetryCallCount: telemetryCalls.length,
        stormOk,
        stormProgressed,
        tornFiles,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: fx ? 'assertions' : 'fixture' }
    }
    for (const c of clients) c.kill()
    brainDebug().dispose()
    try {
      if (fx) rmSync(fx.base, { recursive: true, force: true })
    } catch {
      /* a live shell may hold the cwd — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

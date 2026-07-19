import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { armEmbedFailureForSmoke, embedHttpAttemptsForSmoke, serializeMemory } from '@backend/features/brain'
import {
  brainDebug,
  embedKeySlot,
  embedKeySetPlaintext,
  handleBrainRebuild,
  resolveEmbedKey,
  setEmbedTarget,
  setSemanticAllowed
} from '../brain'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated semantic-lens smoke (MOGGING_BRAINSEM, ADR 0018 revision A — the
// LENS LAW), through the REAL `bin/mogging-mcp.mjs` from inside a REAL pane,
// FAKE embedder only (`fake:` — seeded-hash trigrams, zero network):
//   (a) consent OFF: semantic and hybrid refuse TYPED (the consent register)
//       while exact answers; a junk mode is a spec error at the server;
//   (b) consent ON + the fake target: a fixture whose vocabulary is DISJOINT
//       from the query under FTS5's unstemmed tokenizer ("colours parsed
//       hues" vs "color parse hue") is FOUND by semantic and MISSED by exact
//       — the lens's value, proven;
//   (c) every fuzzy hit is labeled probabilistic:true with provider+model;
//       hybrid hits carry the RRF breakdown and its components SUM to the
//       score;
//   (d) an unchanged re-drain embeds NOTHING (the content-hash law, counted);
//       one edited memory re-embeds EXACTLY one;
//   (e) a model swap invalidates: the next drain re-embeds every row and the
//       hits re-label under the new model's name;
//   (f) the key: pasted once, vault ciphertext at rest, resolves in process
//       for the embed path — and its plaintext greps to ZERO files under
//       userData afterwards (ADR 0007.a);
//   (g) the lens changes NOTHING deterministic: exact search, get_memory, and
//       suggest_connections answer BYTE-IDENTICALLY across the consent flip;
//   plus the failure story: an armed embed fault fails two drains, fires ONE
//   toast (the single-fire latch), and the disarmed drain heals; and the FAKE
//   run's HTTP-attempt counter stays ZERO (no real net, ever).
// Verdict: out/brainsem-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

// ── The seeds. colour-hues is the semantic fixture: every content word is a
// near-spelling of the probe query's words (shared trigrams), yet NO token
// equals a query token — FTS5 does not stem, so exact search finds nothing.
const COLOUR = serializeMemory({
  slug: 'colour-hues',
  description: 'Colour parsing gotchas',
  tags: ['ui'],
  body: 'Colours parsed as hues. Saturations shift subtly.\n'
})
const ALPHA = serializeMemory({
  slug: 'alpha-notes',
  description: 'How the alpha subsystem is wired',
  tags: ['ops'],
  body: 'Alpha wiring notes. See [[beta-notes]]. The quicksilver seam sits here.\n'
})
const BETA = serializeMemory({
  slug: 'beta-notes',
  description: 'Beta subsystem gotchas',
  tags: ['ops'],
  body: 'Beta gotchas. Related: [[alpha-notes]]. Term: zanzibar.\n'
})
const SEM_QUERY = 'color parse hue saturation'
const SECRET = 'sk-brainsem-vault-witness-77413'

const FIXTURE: Record<string, string> = {
  'src/keep.ts': 'export function keeper(): number {\n  return 1\n}\n',
  '.memory/colour-hues.md': COLOUR,
  '.memory/alpha-notes.md': ALPHA,
  '.memory/beta-notes.md': BETA
}

function makeFixture(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainsem-')))
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
  return repo
}

interface ToolAnswer {
  ok: boolean
  isError: boolean
  rpcError: string | null
  text: string
  data: Record<string, unknown>
}

type SemHit = {
  slug: string
  root: string
  probabilistic?: boolean
  provider?: string
  model?: string
  score?: number
  breakdown?: {
    ftsRank: number | null
    semRank: number | null
    ftsComponent: number
    semComponent: number
    weights: Record<string, number>
    k: number
  }
}

export function runBrainSemSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainsem-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainsem smoke did not complete' })
    app.exit(1)
  }, 280000)

  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()

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

  const waitFor = async (probe: () => Promise<boolean> | boolean, tries = 60, gapMs = 500): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gapMs)
    }
    return false
  }

  const hits = (a: ToolAnswer): SemHit[] => (Array.isArray(a.data.memories) ? (a.data.memories as SemHit[]) : [])
  const stats = (): { performed: number; skipped: number; failures: number; passes: number } => brainDebug().embedStats()
  const labeled = (h: SemHit, model: string): boolean =>
    h.probabilistic === true && h.provider === 'fake' && h.model === model && typeof h.score === 'number'

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let repo: string | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      repo = makeFixture()
      const F = repo
      await sleep(1500)

      await ES(`window.__mogging.workspace.create({ name: 'SemA', cwd: ${JSON.stringify(F)}, paneCount: 1 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)

      const built = await handleBrainRebuild({ root: F })
      if (!built.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(built))

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (a) consent OFF: fuzzy refuses TYPED, exact answers, junk mode is a
      //    spec error — and NOTHING has embedded (the planner answered null). ──
      const semOff = await call(c1, 'search_memories', { query: SEM_QUERY, mode: 'semantic' })
      const hybOff = await call(c1, 'search_memories', { query: 'zanzibar', mode: 'hybrid' })
      const junkMode = await call(c1, 'search_memories', { query: 'zanzibar', mode: 'fuzzy' })
      const exact1 = await call(c1, 'search_memories', { query: 'zanzibar' })
      const memGetA = await call(c1, 'get_memory', { slug: 'alpha-notes' })
      const suggestA = await call(c1, 'suggest_connections', { slug: 'alpha-notes' })
      const consentOffOk =
        semOff.isError && /semantic memory recall/.test(semOff.text) && /Settings/.test(semOff.text) &&
        hybOff.isError && /semantic memory recall/.test(hybOff.text) &&
        !!junkMode.rpcError && /must be one of/.test(junkMode.rpcError) &&
        exact1.ok && hits(exact1).length === 1 && hits(exact1)[0].slug === 'beta-notes' &&
        stats().performed === 0 && stats().passes === 0

      // ── consent ON, target still empty: a TEACHING refusal, not a guess ────
      if (!setSemanticAllowed(wsA.id, true)) throw new Error('consent flip refused')
      const semNoCfg = await call(c1, 'search_memories', { query: SEM_QUERY, mode: 'semantic' })
      const noCfgOk = semNoCfg.isError && /endpoint/.test(semNoCfg.text)

      // ── (g-half) the deterministic surface across the flip: byte-identical ─
      const exact2 = await call(c1, 'search_memories', { query: 'zanzibar' })
      const exact3 = await call(c1, 'search_memories', { query: 'zanzibar', mode: 'exact' })
      const exactBytesOk = exact1.ok && exact1.text === exact2.text && exact1.text === exact3.text

      // ── (f-first) the key: pasted once, vaulted, resolving in process ──────
      const keySet = embedKeySetPlaintext(wsA.id, SECRET)
      const keyOk = keySet.ok && embedKeySlot(wsA.id).kind === 'keychain' && resolveEmbedKey(wsA.id) === SECRET

      // ── the FAKE target lands; the poke embeds all three, no drain needed ──
      const cfgSet = setEmbedTarget(wsA.id, 'fake:', 'fake-embed')
      const firstEmbeds = await waitFor(() => stats().performed === 3 && stats().passes >= 1)

      // ── (b) the value: semantic finds the disjoint-vocabulary memory ───────
      const semHit = await call(c1, 'search_memories', { query: SEM_QUERY, mode: 'semantic' })
      const exactMiss = await call(c1, 'search_memories', { query: SEM_QUERY })
      const semList = hits(semHit)
      const valueOk =
        semHit.ok && semList.length > 0 && semList[0].slug === 'colour-hues' &&
        exactMiss.ok && hits(exactMiss).length === 0

      // ── (c) labels + the hybrid breakdown's arithmetic ─────────────────────
      const labelsOk = semList.every((h) => labeled(h, 'fake-embed'))
      const hyb = await call(c1, 'search_memories', { query: 'zanzibar', mode: 'hybrid' })
      const hybList = hits(hyb)
      const top = hybList[0]
      const sums = hybList.every(
        (h) => !!h.breakdown && Math.abs(h.breakdown.ftsComponent + h.breakdown.semComponent - (h.score ?? NaN)) < 1e-12
      )
      const hybridOk =
        hyb.ok && hybList.length > 0 && hybList.every((h) => labeled(h, 'fake-embed')) && sums &&
        !!top && top.slug === 'beta-notes' && top.breakdown?.ftsRank === 1 && (top.breakdown?.semRank ?? 0) >= 1 &&
        top.breakdown?.weights.fts === 1 && top.breakdown?.weights.semantic === 1 && top.breakdown?.k === 60

      // ── (g-rest) get_memory + suggest, byte-identical with the lens LIVE ───
      const memGetB = await call(c1, 'get_memory', { slug: 'alpha-notes' })
      const suggestB = await call(c1, 'suggest_connections', { slug: 'alpha-notes' })
      const detBytesOk =
        memGetA.ok && memGetA.text === memGetB.text && suggestA.ok && suggestA.text === suggestB.text

      // ── (d) unchanged re-drain: ZERO re-embeds; one edit: EXACTLY one ──────
      const p0 = stats().passes
      const skipped0 = stats().skipped
      await handleBrainRebuild({ root: F })
      const idleDrain = await waitFor(() => stats().passes > p0)
      const unchangedOk = idleDrain && stats().performed === 3 && stats().skipped >= skipped0 + 3
      appendFileSync(join(F, '.memory', 'colour-hues.md'), 'More colour lore appended.\n')
      await handleBrainRebuild({ root: F })
      const oneReembed = await waitFor(() => stats().performed === 4)

      // ── (e) model swap: everything re-embeds, hits re-label ────────────────
      const swapSet = setEmbedTarget(wsA.id, 'fake:', 'fake-embed-2')
      const swapped = await waitFor(() => stats().performed === 7)
      const semSwapped = await call(c1, 'search_memories', { query: SEM_QUERY, mode: 'semantic' })
      const swapLabelOk = semSwapped.ok && hits(semSwapped).length > 0 && hits(semSwapped).every((h) => labeled(h, 'fake-embed-2'))

      // ── the failure latch: two armed faults, ONE toast, then the heal ──────
      armEmbedFailureForSmoke(2)
      appendFileSync(join(F, '.memory', 'beta-notes.md'), 'More beta lore appended.\n')
      await handleBrainRebuild({ root: F })
      const failed1 = await waitFor(() => stats().failures === 1)
      await handleBrainRebuild({ root: F })
      const failed2 = await waitFor(() => stats().failures === 2)
      const singleToast = brainDebug().semToasts() === 1
      await handleBrainRebuild({ root: F })
      const healed = await waitFor(() => stats().performed === 8)

      // ── zero network, ever: the FAKE run never opened a socket ─────────────
      const zeroNetOk = embedHttpAttemptsForSmoke() === 0

      // ── (f-rest) the plaintext greps to ZERO files under userData ──────────
      const leaks: string[] = []
      const scan = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const abs = join(dir, entry)
          let st
          try {
            st = statSync(abs)
          } catch {
            continue
          }
          if (st.isDirectory()) scan(abs)
          else if (st.isFile() && st.size < 64 * 1024 * 1024) {
            try {
              if (readFileSync(abs).includes(SECRET)) leaks.push(abs)
            } catch {
              /* a locked file cannot hold our paste anyway — it never left this process */
            }
          }
        }
      }
      scan(app.getPath('userData'))
      const vaultOk = leaks.length === 0 && embedKeySlot(wsA.id).kind === 'keychain'

      // ── `.memory/` still holds ONLY .md files ──────────────────────────────
      const onlyMdOk = readdirSync(join(F, '.memory')).every((e) => e.endsWith('.md'))

      const pass =
        consentOffOk && noCfgOk && exactBytesOk && keyOk && cfgSet.ok && firstEmbeds &&
        valueOk && labelsOk && hybridOk && detBytesOk && unchangedOk && oneReembed &&
        swapSet.ok && swapped && swapLabelOk && failed1 && failed2 && singleToast && healed &&
        zeroNetOk && vaultOk && onlyMdOk
      result = {
        pass,
        consentOffOk,
        consentOffDiag: { semOff: semOff.text.slice(0, 200), junkMode: junkMode.rpcError },
        noCfgOk,
        noCfgMsg: semNoCfg.text.slice(0, 200),
        exactBytesOk,
        keyOk,
        cfgSetOk: cfgSet.ok,
        firstEmbeds,
        valueOk,
        semTop: semList[0] ?? null,
        exactMissCount: hits(exactMiss).length,
        labelsOk,
        hybridOk,
        hybridTop: top ?? null,
        detBytesOk,
        unchangedOk,
        oneReembed,
        swapped,
        swapLabelOk,
        failed1,
        failed2,
        singleToast,
        toasts: brainDebug().semToasts(),
        healed,
        zeroNetOk,
        vaultOk,
        leaks,
        onlyMdOk,
        embedStats: stats(),
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: String(e), stage: repo ? 'assertions' : 'fixture' }
    }
    armEmbedFailureForSmoke(0)
    for (const c of clients) c.kill()
    brainDebug().dispose()
    try {
      if (repo) rmSync(dirname(repo), { recursive: true, force: true })
    } catch {
      /* a live shell may hold the cwd — best effort */
    }
    write(result)
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

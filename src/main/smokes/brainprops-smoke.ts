import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTelemetry } from '@backend'
import { embedHttpAttemptsForSmoke } from '@backend/features/brain'
import type { Telemetry } from '@contracts'
import { brainDebug, handleBrainOverview, handleBrainRebuild, setEmbedTarget, setSemanticAllowed } from '../brain'
import { probeContrastAcrossThemes } from './aa-probe'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'

// Env-gated properties + vault-stance smoke (MOGGING_BRAINPROPS, ADR 0018
// revision B — the Obsidian alignment), through the REAL `bin/mogging-mcp.mjs`
// from inside a REAL pane, on a fixture whose `.memory/` is a chain
// mem-a → mem-b → mem-c → mem-d plus a 40-property flood, a hostile-VALUE
// memory, one foreign `.txt`, and one non-slug `.md`:
//   (a) properties parse under the fixed law: a 40-key head serves EXACTLY the
//       first 32 SORTED keys, the duplicated key last-wins, the oversized
//       value lands capped at 500 — and get_memory's `properties` is exact;
//   (b) the whole filter matrix: `key=value`, bare-`key` presence, `#tag`,
//       comma-AND — each answering the fixture-known slug; a miss answers
//       ok:true + []; reserved keys, junk, and a 9-clause filter refuse TYPED;
//   (c) a filter-absent hit carries NOT ONE new field (byte law, field-level);
//   (d) the filter composes with semantic AND hybrid (FAKE embedder, zero
//       network): filtered fuzzy hits keep their probabilistic labels and the
//       hybrid breakdown still sums; a junk filter refuses BEFORE any embed;
//   (e) memorySkips counts the seeded invalid + foreign file, and a
//       runtime-ADDED foreign file lands through the skips-aware rescan
//       fingerprint (rows unchanged — only the counts moved);
//   (f) the UI: the reader's properties panel rows are exact and a hostile
//       property VALUE renders inert; the wikilink hover preview shows after
//       its dwell, hides on leave, dismisses on Escape (staying in the view),
//       answers keyboard focus/blur the same, and NEVER shows for a dangling
//       target; graph depth 1|2|3 renders 2|3|4 nodes on the chain; the
//       "Memory files skipped" row is visible and follows the counts;
//   plus AA on every new ink across all four themes, and a telemetry recorder
//   on the port for the whole run — no slug, no key, no value in any of it.
// Verdict: out/brainprops-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/** Hand-rolled memory file: the house head plus EXTRA property lines. */
const memFile = (slug: string, description: string, extra: string[], body: string, tags?: string): string =>
  ['---', `name: ${slug}`, `description: ${description}`, ...(tags ? [`tags: [${tags}]`] : []), ...extra, '---', '', body, ''].join('\n')

const pad2 = (n: number): string => String(n).padStart(2, '0')

// The flood: keys p40..p02 in REVERSE file order (served sorted proves the
// sort), p02 oversized (cap proves), p01 duplicated (last wins proves).
const FLOOD_LINES = [
  ...Array.from({ length: 39 }, (_, i) => {
    const n = 40 - i
    return n === 2 ? `p02: ${'X'.repeat(600)}` : `p${pad2(n)}: v${pad2(n)}`
  }),
  'p01: loser',
  'p01: winner'
]

const HOSTILE_VALUE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'

const FIXTURE: Record<string, string> = {
  'src/keep.ts': 'export function keeper(): number {\n  return 1\n}\n',
  '.memory/mem-a.md': memFile('mem-a', 'Chain head with props', ['status: active', 'priority: high'], 'chainlore head. See [[mem-b]].', 'ops'),
  '.memory/mem-b.md': memFile('mem-b', 'Chain second', ['status: done'], 'chainlore second. See [[mem-c]].'),
  '.memory/mem-c.md': memFile('mem-c', 'Chain third', [], 'chainlore third. See [[mem-d]].'),
  '.memory/mem-d.md': memFile('mem-d', 'Chain tail', [], 'chainlore tail. Wants [[wanted-x]].'),
  '.memory/props-flood.md': memFile('props-flood', 'Forty properties flood', FLOOD_LINES, 'flood body.'),
  '.memory/hostile-value.md': memFile('hostile-value', 'Hostile property value', [`payload: ${HOSTILE_VALUE}`, 'zz-bell: a\u0007b'], 'hostile body.'),
  '.memory/note.txt': 'not a memory\n',
  '.memory/My Note.md': '---\nname: My Note\n---\n\nnot a slug filename\n'
}

function makeFixture(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mog-brainprops-')))
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

type Hit = Record<string, unknown> & { slug: string }

export function runBrainPropsSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainprops-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainprops smoke did not complete' })
    app.exit(1)
  }, 280000)

  // The telemetry witness: a recorder on the PORT for the whole run — no
  // memory key, value, slug, or body may appear in any of it.
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
  wc.setBackgroundThrottling(false) // the graph settle rides rAF — an occluded runner window must not starve it
  // The OS pointer on a CI desktop is REAL: when a re-render (openReader) lays a
  // non-dangling wikilink under the stationary cursor, Chromium synthesizes a genuine
  // mouseenter and pops a preview no step asked for — which read as danglingNoPreview:false
  // on the windows runner. Chromium tracks hover from the LAST input event, so parking the
  // pointer in the window chrome once makes every later hover recomputation target nothing.
  wc.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
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
  const waitTrue = async (js: string, tries = 40, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const hits = (a: ToolAnswer): Hit[] => (Array.isArray(a.data.memories) ? (a.data.memories as Hit[]) : [])
  const slugs = (a: ToolAnswer): string[] => hits(a).map((h) => h.slug).sort()
  const stats = (): { performed: number; skipped: number; failures: number; passes: number } => brainDebug().embedStats()
  const overview = (r: string): { invalid: number; tooLarge: number; foreign: number; capped: boolean } | null => {
    const o = handleBrainOverview({ root: r })
    return o.ok ? o.memorySkips : null
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let repo: string | null = null
    const clients: PaneMcpSmokeClient[] = []
    try {
      repo = makeFixture()
      const F = repo
      await sleep(1500)

      await ES(`window.__mogging.workspace.create({ name: 'PropsA', cwd: ${JSON.stringify(F)}, paneCount: 1 })`)
      await sleep(3500)
      const wsA = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneA1 = String(wsA.ordinal * 100 + 1)

      const built = await handleBrainRebuild({ root: F })
      if (!built.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(built))

      const c1 = await spawnPaneMcpSmokeClient({ cli, paneId: paneA1, mcpPath: join(root, 'bin', 'mogging-mcp.mjs') })
      clients.push(c1)
      await c1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

      // ── (a) properties: sorted, capped at 32, last-wins, value cap 500 ─────
      const flood = await call(c1, 'get_memory', { slug: 'props-flood' })
      const floodProps = ((flood.data.memory as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, string>
      const expectKeys = Array.from({ length: 32 }, (_, i) => `p${pad2(i + 1)}`)
      const propsOk =
        flood.ok &&
        JSON.stringify(Object.keys(floodProps)) === JSON.stringify(expectKeys) &&
        floodProps.p01 === 'winner' &&
        floodProps.p02 === 'X'.repeat(500) &&
        floodProps.p03 === 'v03' &&
        floodProps.p32 === 'v32'
      const memA = await call(c1, 'get_memory', { slug: 'mem-a' })
      const memAProps = ((memA.data.memory as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, string>
      const memAPropsOk = memA.ok && JSON.stringify(memAProps) === JSON.stringify({ priority: 'high', status: 'active' })
      // A hostile VALUE indexes as inert text — control chars cleaned, markup kept as bytes.
      const hostile = await call(c1, 'get_memory', { slug: 'hostile-value' })
      const hostileProps = ((hostile.data.memory as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, string>
      const hostilePropsOk = hostile.ok && hostileProps.payload === HOSTILE_VALUE && hostileProps['zz-bell'] === 'a b'

      // ── (b) the filter matrix, exact mode ──────────────────────────────────
      const fEq = await call(c1, 'search_memories', { query: 'chainlore', filter: 'status=done' })
      const fHas = await call(c1, 'search_memories', { query: 'chainlore', filter: 'priority' })
      const fTag = await call(c1, 'search_memories', { query: 'chainlore', filter: '#ops' })
      const fAnd = await call(c1, 'search_memories', { query: 'chainlore', filter: 'status=active,#ops' })
      const fMiss = await call(c1, 'search_memories', { query: 'chainlore', filter: 'status=nope' })
      const fReserved = await call(c1, 'search_memories', { query: 'chainlore', filter: 'name=x' })
      const fJunk = await call(c1, 'search_memories', { query: 'chainlore', filter: '???' })
      const fNine = await call(c1, 'search_memories', { query: 'chainlore', filter: 'a,b,c,d,e,f,g,h,i' })
      const filterOk =
        fEq.ok && JSON.stringify(slugs(fEq)) === JSON.stringify(['mem-b']) &&
        fHas.ok && JSON.stringify(slugs(fHas)) === JSON.stringify(['mem-a']) &&
        fTag.ok && JSON.stringify(slugs(fTag)) === JSON.stringify(['mem-a']) &&
        fAnd.ok && JSON.stringify(slugs(fAnd)) === JSON.stringify(['mem-a']) &&
        fMiss.ok && hits(fMiss).length === 0 && fMiss.data.truncated === false &&
        fReserved.isError && /frontmatter/.test(fReserved.text) && /#tag/.test(fReserved.text) &&
        fJunk.isError && /#tag, key, or key=value/.test(fJunk.text) &&
        fNine.isError && /at most 8/.test(fNine.text)

      // ── (c) filter-absent hits carry NOT ONE new field ─────────────────────
      const plain = await call(c1, 'search_memories', { query: 'chainlore' })
      const plainFields = hits(plain).map((h) => Object.keys(h).sort())
      const noNewFieldsOk =
        plain.ok &&
        JSON.stringify(slugs(plain)) === JSON.stringify(['mem-a', 'mem-b', 'mem-c', 'mem-d']) &&
        plainFields.every((keys) => JSON.stringify(keys) === JSON.stringify(['description', 'name', 'root', 'slug', 'tags']))

      // ── (e-first) the seeded skips: 1 invalid (non-slug .md) + 1 foreign ───
      const skips0 = overview(F)
      const skipsSeededOk = !!skips0 && skips0.invalid === 1 && skips0.foreign === 1 && skips0.tooLarge === 0 && !skips0.capped

      // ── (d) the filter composes with the FAKE semantic lens ────────────────
      if (!setSemanticAllowed(wsA.id, true)) throw new Error('consent flip refused')
      const cfgSet = setEmbedTarget(wsA.id, 'fake:', 'fake-embed')
      const embedsDone = await waitFor(() => stats().performed === 6 && stats().passes >= 1)
      const semJunkFilter = await call(c1, 'search_memories', { query: 'chainlore', mode: 'semantic', filter: 'name=x' })
      const sem = await call(c1, 'search_memories', { query: 'chainlore head', mode: 'semantic', filter: 'status=done' })
      const semHits = hits(sem)
      const labeled = (h: Hit): boolean => h.probabilistic === true && h.provider === 'fake' && h.model === 'fake-embed' && typeof h.score === 'number'
      const hyb = await call(c1, 'search_memories', { query: 'chainlore', mode: 'hybrid', filter: '#ops' })
      const hybHits = hits(hyb)
      const hybTop = hybHits[0] as (Hit & { breakdown?: { ftsComponent: number; semComponent: number } }) | undefined
      const semComposeOk =
        semJunkFilter.isError && /frontmatter/.test(semJunkFilter.text) &&
        sem.ok && semHits.length === 1 && semHits[0].slug === 'mem-b' && labeled(semHits[0]) &&
        hyb.ok && hybHits.length === 1 && hybHits[0].slug === 'mem-a' && labeled(hybHits[0]) &&
        !!hybTop?.breakdown &&
        Math.abs(hybTop.breakdown.ftsComponent + hybTop.breakdown.semComponent - (hybTop.score as number)) < 1e-12
      const zeroNetOk = embedHttpAttemptsForSmoke() === 0

      // ── (f) the UI: panel, hostile value, preview, depth, skipped row ──────
      await ES(`window.__mogging.brain.open()`)
      const viewOpen = await waitTrue(`!!document.querySelector('#content.view-brain')`)
      const skipRowSel = `document.querySelector('.brain-stat-memskips .brain-stat-value')`
      const skipRow1 = await waitTrue(`(${skipRowSel}?.textContent ?? '') === '1 invalid · 1 foreign'`)

      // The panel: rows exact, sorted, textContent only.
      await ES(`window.__mogging.brain.openReader('mem-a')`)
      await waitTrue(`window.__mogging.brain.state().reader === 'mem-a' && !!document.querySelector('.brain-props')`)
      const panelA = (await ES(`window.__mogging.brain.propsProbe()`)) as { keys: string[]; values: string[]; activeContent: number }
      const panelOk =
        JSON.stringify(panelA.keys) === JSON.stringify(['priority', 'status']) &&
        JSON.stringify(panelA.values) === JSON.stringify(['high', 'active']) &&
        panelA.activeContent === 0

      await ES(`window.__mogging.brain.openReader('hostile-value')`)
      await waitTrue(`window.__mogging.brain.state().reader === 'hostile-value' && !!document.querySelector('.brain-props')`)
      const panelH = (await ES(`window.__mogging.brain.propsProbe()`)) as { keys: string[]; values: string[]; activeContent: number }
      const pwned = await ES<boolean>(`window.__pwned === 1`)
      const hostileInertOk =
        panelH.activeContent === 0 &&
        !pwned &&
        panelH.values.some((v) => v.includes('<script>window.__pwned=1</script>'))

      // The hover preview: dwell → show; leave → hide; Escape → hide IN PLACE;
      // focus/blur parity; never for a dangling target.
      await ES(`window.__mogging.brain.openReader('mem-a')`)
      await waitTrue(`window.__mogging.brain.state().reader === 'mem-a' && !!document.querySelector('.brain-wikilink')`)
      const hoverLink = (needle: string, event: string): Promise<boolean> =>
        ES<boolean>(`(() => {
          const b = [...document.querySelectorAll('.brain-wikilink')].find((x) => (x.textContent || '').includes(${JSON.stringify(needle)}))
          if (!b) return false
          b.dispatchEvent(${event === 'focus' || event === 'blur' ? `new FocusEvent(${JSON.stringify(event)})` : `new MouseEvent(${JSON.stringify(event)})`})
          return true
        })()`)
      const hovered = await hoverLink('mem-b', 'mouseenter')
      const previewShown = await waitTrue(`window.__mogging.brain.previewProbe().visible`)
      const preview1 = (await ES(`window.__mogging.brain.previewProbe()`)) as { visible: boolean; text: string }
      await hoverLink('mem-b', 'mouseleave')
      const previewHidOnLeave = await waitTrue(`!window.__mogging.brain.previewProbe().visible`, 10, 100)
      await hoverLink('mem-b', 'mouseenter')
      await waitTrue(`window.__mogging.brain.previewProbe().visible`)
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const previewHidOnEscape = await waitTrue(`!window.__mogging.brain.previewProbe().visible`, 10, 100)
      const stillInView = await ES<boolean>(`!!document.querySelector('#content.view-brain')`)
      const focused = await hoverLink('mem-b', 'focus')
      const previewOnFocus = await waitTrue(`window.__mogging.brain.previewProbe().visible`)
      await hoverLink('mem-b', 'blur')
      const previewHidOnBlur = await waitTrue(`!window.__mogging.brain.previewProbe().visible`, 10, 100)
      // AA rides here, while the reader + a LIVE preview are both on screen.
      await hoverLink('mem-b', 'mouseenter')
      await waitTrue(`window.__mogging.brain.previewProbe().visible`)
      const aaReader = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.brain-prop-key', '.brain-prop-value', '.brain-preview-name', '.brain-preview-desc', '.brain-preview-snippet']
      })
      await ES(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      // The AA hover's preview must be PROVEN gone before the dangling probe — an
      // unverified hide left the dangling claim reading someone else's card.
      const escapeHid2 = await waitTrue(`!window.__mogging.brain.previewProbe().visible`, 10, 100)
      await ES(`window.__mogging.brain.openReader('mem-d')`)
      await waitTrue(`window.__mogging.brain.state().reader === 'mem-d' && !!document.querySelector('.brain-wikilink.is-dangling')`)
      await hoverLink('wanted-x', 'mouseenter')
      await sleep(700) // past the dwell — a dangling target must never show
      const danglingProbe = (await ES(`window.__mogging.brain.previewProbe()`)) as { visible: boolean; text: string }
      const danglingHoverState = (await ES(`(() => {
        const hov = [...document.querySelectorAll(':hover')].map((n) => n.className && String(n.className).slice(0, 60)).slice(-4)
        return { hover: hov, active: document.activeElement ? String(document.activeElement.className).slice(0, 60) : '' }
      })()`)) as { hover: string[]; active: string }
      const danglingNoPreview = !danglingProbe.visible
      const previewOk =
        hovered && previewShown &&
        preview1.text.includes('mem-b') && preview1.text.includes('Chain second') &&
        previewHidOnLeave && previewHidOnEscape && stillInView &&
        focused && previewOnFocus && previewHidOnBlur && danglingNoPreview

      // Depth 1|2|3 → 2|3|4 nodes on the chain (default 2 = today's fetch).
      const depthDefault = (await ES(`window.__mogging.brain.state().depth`)) as number
      await ES(`window.__mogging.brain.setDepth(1)`)
      await ES(`window.__mogging.brain.focusMemory('mem-a')`)
      const d1 = await waitTrue(`window.__mogging.brain.state().mode === 'graph' && window.__mogging.brain.state().nodes === 2`)
      await ES(`window.__mogging.brain.setDepth(2)`)
      const d2 = await waitTrue(`window.__mogging.brain.state().nodes === 3`)
      await ES(`window.__mogging.brain.setDepth(3)`)
      const d3 = await waitTrue(`window.__mogging.brain.state().nodes === 4`)
      const depthNavVisible = await ES<boolean>(`!document.querySelector('.brain-depth').hidden`)
      const aaGraph = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: ['.brain-depth-label', '.brain-depth-btn', '.brain-depth-btn.is-active']
      })
      await ES(`window.__mogging.brain.setDepth(2)`)
      const depthOk = depthDefault === 2 && d1 && d2 && d3 && depthNavVisible

      // ── (e-rest) a runtime-ADDED foreign file lands (skips fingerprint) ────
      writeFileSync(join(F, '.memory', 'added-later.txt'), 'foreign, added at runtime\n')
      const runtimeSkip = await waitFor(() => overview(F)?.foreign === 2)
      await ES(`window.__mogging.brain.refresh()`)
      const skipRow2 = await waitTrue(`(${skipRowSel}?.textContent ?? '') === '1 invalid · 2 foreign'`)

      const aaOk =
        aaReader.failures.length === 0 && aaReader.missing.length === 0 &&
        aaGraph.failures.length === 0 && aaGraph.missing.length === 0
      const markers = ['mem-a', 'mem-b', 'mem-c', 'mem-d', 'props-flood', 'hostile-value', 'wanted-x', 'chainlore', 'mog-brainprops', 'p01', 'winner']
      const telemetryJson = telemetryCalls.join('\n')
      const telemetryOk = !markers.some((m) => telemetryJson.includes(m))

      const pass =
        propsOk && memAPropsOk && hostilePropsOk && filterOk && noNewFieldsOk && skipsSeededOk &&
        cfgSet.ok && embedsDone && semComposeOk && zeroNetOk &&
        viewOpen && skipRow1 && panelOk && hostileInertOk && previewOk && depthOk &&
        runtimeSkip && skipRow2 && aaOk && telemetryOk
      result = {
        pass,
        propsOk,
        floodKeys: Object.keys(floodProps).length,
        memAPropsOk,
        hostilePropsOk,
        filterOk,
        filterDiag: {
          eq: slugs(fEq), has: slugs(fHas), tag: slugs(fTag), and: slugs(fAnd),
          miss: hits(fMiss).length, reserved: fReserved.text.slice(0, 160), junk: fJunk.text.slice(0, 160), nine: fNine.text.slice(0, 160)
        },
        noNewFieldsOk,
        plainFields: plainFields[0] ?? [],
        skipsSeededOk,
        skips0,
        embedsDone,
        semComposeOk,
        semDiag: { junk: semJunkFilter.text.slice(0, 160), sem: semHits[0] ?? null, hyb: hybTop ?? null },
        zeroNetOk,
        viewOpen,
        skipRow1,
        panelOk,
        panelA,
        hostileInertOk,
        previewOk,
        previewDiag: {
          previewShown, previewHidOnLeave, previewHidOnEscape, stillInView, previewOnFocus, previewHidOnBlur,
          escapeHid2, danglingNoPreview,
          danglingText: danglingProbe.text.slice(0, 200),
          danglingHoverState,
          text: preview1.text.slice(0, 200)
        },
        depthOk,
        depthDiag: { depthDefault, d1, d2, d3, depthNavVisible },
        runtimeSkip,
        skipRow2,
        aaOk,
        aaReaderFailures: aaReader.failures,
        aaReaderMissing: aaReader.missing,
        aaGraphFailures: aaGraph.failures,
        aaGraphMissing: aaGraph.missing,
        telemetryOk,
        telemetryCallCount: telemetryCalls.length,
        embedStats: stats(),
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e), stage: repo ? 'assertions' : 'fixture' }
    }
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

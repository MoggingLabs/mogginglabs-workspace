import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTelemetry } from '@backend'
import { serializeMemory } from '@backend/features/brain'
import type { Telemetry } from '@contracts'
import { handleBrainRebuild, handleBrainStatus } from '../brain'
import { AA_PROBE_JS, probeContrastAcrossThemes } from './aa-probe'

// Env-gated Brain-VIEW smoke (MOGGING_BRAINUX, ADR 0018/10). Fixture repo
// indexed, REAL window:
//   (a) the palette verb AND Ctrl+Shift+M open the view (Esc goes back);
//   (b) the status card equals `brain:status` truth, and a REAL shell-pane edit
//       moves the freshness chip live on screen — generation bumps, dirty
//       returns to fresh, no button pressed (polled through the DOM);
//   (c) searching the fixture hub focuses the lens: ≤ 150 nodes, the hub
//       present at ring 0, the canvas painting exactly the focus set (probed
//       via the __mogging handle — positions match the node count);
//   (d) the inspector shows the hub's sig + file:line; DOUBLE-CLICKING the hub
//       on the canvas delegates to the explorer (the reveal-port seam is spied,
//       the dock opens, the row is selected) — never an embedded editor;
//   (e) the reader renders the HOSTILE-bytes memory INERT (textContent equals
//       the raw body; zero script/img/style elements; no window.__pwned),
//       a wikilink click navigates the reader, and a dangling target renders
//       dimmed + "wanted"-affixed;
//   (f) becalmed (the Calm-motion class), a refocus settles INSTANTLY: two
//       frames captured apart are byte-identical — zero animation frames;
//   (g) opening the view never steals focus into its search box;
//   (h) telemetry over the whole run carries booleans/counts only — no symbol
//       name, no slug, no path (the ADR 0005 recorder witness).
// Verdict: out/brainux-result.json.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

const HUB = 'hubOfTheGraph'

const HOSTILE_BODY =
  'Hostile bytes ahead: <script>window.__pwned = 1</script> and ' +
  '<img src=x onerror="window.__pwned=1"> plus <style>body{display:none}</style>.\n' +
  'Linked knowledge: [[alpha-notes]].\n'

const FIXTURE: Record<string, string> = {
  'src/hub.ts': `export function ${HUB}(): number {\n  return 40\n}\n`,
  'src/extra.ts': 'export function extraSeed(): number {\n  return 1\n}\n',
  ...Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((s) => [
      `src/${s}.ts`,
      `import { ${HUB} } from './hub'\nexport function caller${s.toUpperCase()}(): number {\n  return ${HUB}() + 1\n}\n`
    ])
  ),
  '.memory/hostile-bytes.md': serializeMemory({
    slug: 'hostile-bytes',
    description: 'Agent-written markup that must render inert',
    tags: ['ops'],
    body: HOSTILE_BODY
  }),
  '.memory/alpha-notes.md': serializeMemory({
    slug: 'alpha-notes',
    description: 'Alpha wiring notes',
    tags: ['ops'],
    body: 'Alpha notes. See [[beta-notes]].\n'
  }),
  '.memory/beta-notes.md': serializeMemory({
    slug: 'beta-notes',
    description: 'Beta notes with a wanted link',
    tags: ['ops'],
    body: 'Beta notes. See [[alpha-notes]]. Still unwritten: [[wanted-topic]].\n'
  })
}

interface Fixture {
  base: string
  repo: string
}

function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'mog-brainux-'))
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
  // The REAL pane's out-of-band mutation tool, OUTSIDE the repo: appends a new
  // definition to a tracked file, so the git tick has a delta to drain.
  writeFileSync(
    join(base, 'ops.mjs'),
    `import { appendFileSync } from 'node:fs'\n` +
      `if (process.argv[2] === 'edit') appendFileSync(${JSON.stringify(join(repo, 'src', 'extra.ts'))}, '\\nexport function addedBySmoke(): number {\\n  return 2\\n}\\n')\n`
  )
  return { base, repo }
}

export function runBrainUxSmoke(win: BrowserWindow): void {
  const resultFile = join(app.getAppPath(), 'out', 'brainux-result.json')
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
    write({ pass: false, error: 'TIMEOUT: brainux smoke did not complete' })
    app.exit(1)
  }, 280000)

  // The telemetry witness (h): a recorder on the PORT for the whole run.
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
  wc.setBackgroundThrottling(false) // the settle animation rides rAF — an occluded runner window must not starve it
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()

  const cli = (args: string[]): Promise<{ code: number; stdout: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
        (err, stdout) => res({ code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })
      )
    })

  const waitTrue = async (js: string, tries = 40, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let fx: Fixture | null = null
    try {
      fx = makeFixture()
      const F = fx
      await sleep(1500)

      // ── The world: one workspace on the repo; pane 2 is the mutation shell ─
      await ES(`window.__mogging.workspace.create({ name: 'BrainUX', cwd: ${JSON.stringify(F.repo)}, paneCount: 2 })`)
      await sleep(3500)
      const ws = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const paneShell = String(ws.ordinal * 100 + 2)

      const built = await handleBrainRebuild({ root: F.repo })
      if (!built.ok) throw new Error('fixture rebuild refused: ' + JSON.stringify(built))

      // ── (g)+(a) the palette door, no focus steal, Esc back, the shortcut ───
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
      await waitTrue(`document.querySelector('.palette-overlay') && !document.querySelector('.palette-overlay').hidden`)
      await ES(`(() => { const i = document.querySelector('.palette-input'); i.value = 'brain'; i.dispatchEvent(new Event('input')) })()`)
      await sleep(250)
      const paletteRow = await ES<boolean>(
        `[...document.querySelectorAll('.palette-item-title')].some((t) => (t.textContent || '').trim() === 'Brain')`
      )
      await ES(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
      const openedByPalette = await waitTrue(`!!document.querySelector('#content.view-brain')`)
      await sleep(400)
      const focusAfterOpen = await ES<{ steal: boolean; active: string }>(`(() => {
        const a = document.activeElement
        return { steal: !!(a && a.closest && a.closest('#view-brain')), active: a ? (a.className || a.tagName) : 'none' }
      })()`)
      const noFocusSteal = openedByPalette && !focusAfterOpen.steal

      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      const escBack = await waitTrue(`!document.querySelector('#content.view-brain')`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true }))`)
      const openedByShortcut = await waitTrue(`!!document.querySelector('#content.view-brain')`)
      const doorsOk = paletteRow && openedByPalette && escBack && openedByShortcut

      // ── (b) the status card equals brain:status truth ──────────────────────
      const statusSynced = await waitTrue(`window.__mogging.brain.chip().gen === 'gen ${(handleBrainStatus({ root: F.repo }) as { generation: number }).generation}'`)
      const truth = handleBrainStatus({ root: F.repo }) as {
        generation: number
        dirty: boolean
        files: number
        nodes: number
        edges: number
      }
      const card = await ES<Record<string, string>>(`(() => {
        const v = (cls) => document.querySelector('.brain-stat-' + cls + ' .brain-stat-value')?.textContent ?? ''
        return { generation: v('generation'), dirty: v('dirty'), files: v('files'), nodes: v('nodes'), edges: v('edges'), memories: v('memories'), dangling: v('dangling') }
      })()`)
      const statusOk =
        statusSynced &&
        truth.generation > 0 &&
        card.generation === String(truth.generation) &&
        card.dirty === (truth.dirty ? 'dirty' : 'fresh') &&
        card.files === String(truth.files) &&
        card.nodes === String(truth.nodes) &&
        card.edges === String(truth.edges) &&
        card.memories === '3' &&
        card.dangling === '1'

      // The LIVE half: a REAL pane edits a tracked file; the tick drains it and
      // the chips move on screen with no button pressed.
      const genBefore = truth.generation
      const sent = await cli(['send', paneShell, 'node ../ops.mjs edit'])
      if (sent.code !== 0) throw new Error('could not drive the mutation pane')
      const liveDirtyOk = await waitTrue(
        `(() => { const c = window.__mogging.brain.chip(); return c.dirty === 'fresh' && parseInt((c.gen || '').replace('gen ', ''), 10) > ${genBefore} })()`,
        160,
        500
      )
      const liveCard = await ES<string>(`document.querySelector('.brain-stat-generation .brain-stat-value')?.textContent ?? ''`)
      const liveTruth = handleBrainStatus({ root: F.repo }) as { generation: number }
      const liveSyncOk = liveDirtyOk && liveCard === String(liveTruth.generation)

      // ── (c) search the hub → a capped, hub-centered focus on the canvas ────
      await ES(`window.__mogging.brain.search('${HUB}')`)
      const gotResults = await waitTrue(`window.__mogging.brain.results().some((r) => r === 'code:${HUB}')`)
      await ES(`window.__mogging.brain.choose(window.__mogging.brain.results().findIndex((r) => r === 'code:${HUB}'))`)
      const focused = await waitTrue(`window.__mogging.brain.state().nodes > 0`, 60, 400)
      await sleep(2200) // the settle animation runs out (motion still on here)
      const focusState = (await ES(`window.__mogging.brain.state()`)) as Record<string, unknown>
      const nodes = (await ES(`window.__mogging.brain.nodes()`)) as { id: string; name: string; ring: number; kind: string }[]
      const positions = (await ES(`window.__mogging.brain.positions().length`)) as number
      const canvasVisible = await ES<boolean>(`!document.querySelector('.brain-canvas-host').hidden`)
      const hub = nodes.find((n) => n.name === HUB && n.ring === 0)
      const focusOk =
        gotResults &&
        focused &&
        canvasVisible &&
        !!hub &&
        nodes.length >= 6 &&
        nodes.length <= 150 &&
        (focusState.nodes as number) === nodes.length &&
        positions === nodes.length

      // ── (d) the inspector speaks the hub; double-click delegates ───────────
      const inspector = await ES<string>(`document.querySelector('.brain-inspector')?.textContent ?? ''`)
      const inspectorOk = inspector.includes(HUB) && inspector.includes('src/hub.ts') && /function/.test(inspector)
      const dbl = await ES<boolean>(`(() => {
        const hub = window.__mogging.brain.positions().find((p) => p.id === ${JSON.stringify(hub?.id ?? '')})
        if (!hub) return false
        const c = document.querySelector('.brain-canvas')
        const r = c.getBoundingClientRect()
        c.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + hub.sx, clientY: r.top + hub.sy, bubbles: true }))
        return true
      })()`)
      const hubAbs = join(F.repo, 'src', 'hub.ts')
      const revealSeamOk =
        dbl &&
        (await waitTrue(
          `window.__mogging.brain.revealLog().some((p) => p.toLowerCase() === ${JSON.stringify(hubAbs.toLowerCase())}) && window.__mogging.explorer.isOpen()`
        )) &&
        (await waitTrue(`(window.__mogging.explorer.selection() || '').toLowerCase() === ${JSON.stringify(hubAbs.toLowerCase())}`, 30, 300))

      // ── (e) the reader renders hostile bytes INERT; wikilinks navigate ─────
      await ES(`window.__mogging.brain.search('hostile')`)
      await waitTrue(`window.__mogging.brain.results().some((r) => r === 'memory:hostile-bytes')`)
      await ES(`window.__mogging.brain.choose(window.__mogging.brain.results().findIndex((r) => r === 'memory:hostile-bytes'))`)
      await waitTrue(`window.__mogging.brain.state().reader === 'hostile-bytes' && !!document.querySelector('.brain-reader-body')`)
      const probe = (await ES(`window.__mogging.brain.readerProbe()`)) as {
        text: string
        activeContent: number
        wikilinks: { text: string; dangling: boolean }[]
      }
      const pwned = await ES<boolean>(`window.__pwned === 1`)
      const inertOk =
        probe.activeContent === 0 &&
        !pwned &&
        probe.text.includes('<script>window.__pwned = 1</script>') &&
        probe.text.includes('onerror') &&
        probe.wikilinks.some((w) => w.text.includes('alpha-notes') && !w.dangling)
      await ES(`[...document.querySelectorAll('.brain-wikilink')].find((b) => (b.textContent || '').includes('alpha-notes'))?.click()`)
      const navOk = await waitTrue(`window.__mogging.brain.state().reader === 'alpha-notes'`)
      await ES(`[...document.querySelectorAll('.brain-wikilink')].find((b) => (b.textContent || '').includes('beta-notes'))?.click()`)
      await waitTrue(`window.__mogging.brain.state().reader === 'beta-notes'`)
      const dangling = (await ES(`window.__mogging.brain.readerProbe()`)) as { wikilinks: { text: string; dangling: boolean }[] }
      const danglingRow = dangling.wikilinks.find((w) => w.text.includes('wanted-topic'))
      const danglingDim = await ES<boolean>(`(() => {
        const b = [...document.querySelectorAll('.brain-wikilink.is-dangling')].find((x) => (x.textContent || '').includes('wanted-topic'))
        return !!b && (b.textContent || '').includes('wanted')
      })()`)
      const readerOk = inertOk && navOk && !!danglingRow?.dangling && danglingDim

      // ── AA, reader mode: every new ink measured on the composed surface ────
      // beta-notes is on screen and carries BOTH wikilink variants.
      const aaReader = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: [
          '.brain-title',
          '.brain-sub',
          '.brain-chip-gen',
          '.brain-chip-dirty',
          '.brain-lens-btn',
          '.brain-lens-btn.is-active',
          '.brain-stat-label',
          '.brain-stat-value',
          '.brain-reader-title',
          '.brain-reader-sub',
          '.brain-reader-root',
          '.brain-reader-body',
          '.brain-wikilink',
          '.brain-wikilink.is-dangling',
          '.brain-wanted',
          '.brain-reader-rail-title'
        ]
      })

      // ── (f) becalmed: a refocus settles instantly — two identical frames ───
      await ES(`document.documentElement.classList.add('motion-calm')`)
      await ES(`window.__mogging.brain.focusCode(${JSON.stringify(hub?.id ?? '')})`)
      await waitTrue(`window.__mogging.brain.state().mode === 'graph' && window.__mogging.brain.state().nodes > 0`, 60, 300)
      await sleep(400)
      const frameA = await ES<string>(`window.__mogging.brain.frame()`)
      await sleep(350)
      const frameB = await ES<string>(`window.__mogging.brain.frame()`)
      const calmOk = frameA.length > 100 && frameA === frameB

      // ── (f2) the camera: a zoom CHANGES the frame; refit restores it byte-for-byte ──
      // Still becalmed, so paints are deterministic. frameA is the settled DEFAULT frame:
      // a real wheel zoom must move it, and resetView() must land back on it exactly —
      // proof the camera is a pure view transform whose default is stable (the BRAINGRAPH
      // determinism + the pre-camera frame both ride on that default being untouched).
      await ES(`window.__mogging.brain.zoom()`)
      await sleep(200)
      const frameZoomed = await ES<string>(`window.__mogging.brain.frame()`)
      await ES(`window.__mogging.brain.resetView()`)
      await sleep(200)
      const frameRefit = await ES<string>(`window.__mogging.brain.frame()`)
      const cameraOk = frameZoomed.length > 100 && frameZoomed !== frameA && frameRefit === frameA

      await ES(`document.documentElement.classList.remove('motion-calm')`)

      // ── AA, graph mode: inspector/search inks + the CANVAS token pairs ─────
      // Elements first (the canvas is not an element with text — its inks are
      // measured as RESOLVED token colors against --bg-inset, the color-mix
      // caveat handled by the shared parser: labels ≥ 4.5, edge strokes ≥ 3).
      await ES(`window.__mogging.brain.search('caller')`)
      await waitTrue(`window.__mogging.brain.results().length > 0`)
      const aaGraph = await probeContrastAcrossThemes({
        es: ES,
        sleep,
        selectors: [
          '.brain-search-input',
          '.brain-search-item.is-selected .brain-search-name',
          '.brain-search-item.is-selected .brain-search-file',
          '.brain-inspect-name',
          '.brain-inspect-sig',
          '.brain-inspect-file',
          '.brain-inspect-sub',
          '.brain-inspect-neighbor',
          '.brain-edge-chip',
          '.brain-legend-label'
        ]
      })
      const canvasInks = await ES<{ theme: string; token: string; ratio: number; floor: number }[]>(`(async () => {${AA_PROBE_JS}
        const out = []
        const resolve = (token) => {
          const d = document.createElement('div')
          d.style.color = 'var(' + token + ')'
          document.body.append(d)
          const c = parse(getComputedStyle(d).color)
          d.remove()
          return c
        }
        for (const theme of ['midnight', 'light', 'nord', 'solarized']) {
          window.__mogging.setTheme(theme)
          await new Promise((r) => setTimeout(r, 250))
          const inset = resolve('--bg-inset')
          for (const [token, floor] of [
            ['--text-hi', 4.5], ['--text-mid', 4.5], ['--text-lo', 4.5],
            ['--info', 3], ['--success', 3], ['--warning', 3], ['--accent-ink', 3]
          ]) {
            const fg = resolve(token)
            out.push({ theme, token: token + '/inset', ratio: Math.round(ratio(over(fg, inset), inset) * 100) / 100, floor })
          }
          // The dirty/capped chips ink --warning as TEXT on the head (bg-app) and
          // the truncated note on the reader (bg-surface) — text floors apply.
          for (const surface of ['--bg-app', '--bg-surface']) {
            const bg = resolve(surface)
            for (const token of ['--warning', '--danger-ink', '--accent-ink']) {
              const fg = resolve(token)
              out.push({ theme, token: token + '/' + surface, ratio: Math.round(ratio(over(fg, bg), bg) * 100) / 100, floor: 4.5 })
            }
          }
        }
        window.__mogging.setTheme('midnight')
        return out
      })()`)
      const canvasInkFailures = canvasInks.filter((r) => r.ratio < r.floor)
      const aaOk =
        aaReader.failures.length === 0 &&
        aaReader.missing.length === 0 &&
        aaGraph.failures.length === 0 &&
        aaGraph.missing.length === 0 &&
        canvasInkFailures.length === 0

      // ── (h) telemetry: booleans/counts only, never content ─────────────────
      const markers = [HUB, 'hostile-bytes', 'alpha-notes', 'beta-notes', 'wanted-topic', 'mog-brainux', 'hub.ts']
      const telemetryJson = telemetryCalls.join('\n')
      const telemetryOk = !markers.some((m) => telemetryJson.includes(m))

      const pass =
        doorsOk && noFocusSteal && statusOk && liveSyncOk && focusOk && inspectorOk && revealSeamOk && readerOk && calmOk && cameraOk && aaOk && telemetryOk
      result = {
        aaOk,
        aaReaderFailures: aaReader.failures,
        aaReaderMissing: aaReader.missing,
        aaGraphFailures: aaGraph.failures,
        aaGraphMissing: aaGraph.missing,
        aaWorst: { reader: aaReader.worst, graph: aaGraph.worst },
        canvasInkFailures,
        pass,
        doorsOk,
        paletteRow,
        openedByPalette,
        escBack,
        openedByShortcut,
        noFocusSteal,
        focusAfterOpen,
        statusOk,
        card,
        truth,
        liveSyncOk,
        liveDirtyOk,
        liveGen: { before: genBefore, card: liveCard, truth: liveTruth.generation },
        focusOk,
        focusState,
        nodeCount: nodes.length,
        positions,
        inspectorOk,
        inspectorHead: inspector.slice(0, 200),
        revealSeamOk,
        readerOk,
        inertOk,
        probeActiveContent: probe.activeContent,
        navOk,
        danglingDim,
        calmOk,
        cameraOk,
        frameBytes: frameA?.length ?? 0,
        telemetryOk,
        telemetryCallCount: telemetryCalls.length,
        platform: process.platform
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
    }
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

import type { BrainAnswer, BrainOverviewAnswer } from '@contracts'
import { Button, Card, EmptyState, Pill, SectionHeader, Spinner, clear, createToggleRow, el, loadingRow, showToast } from '../../components'
import { getWorkspaces } from '../../core/workspace/workspace-info-port'
import { requestExplorerReveal } from '../../core/shell/explorer-reveal-port'
import { getTelemetry } from '../../core/telemetry'
import {
  brainOverview,
  brainRead,
  brainRebuild,
  brainStatus,
  libFetchGet,
  libFetchSet,
  orientGet,
  orientSet,
  semGet,
  semSet,
  type BrainBacklinkOut,
  type BrainMemoryHit,
  type BrainMemoryLinkOut,
  type BrainMemoryOut,
  type BrainNeighborOut,
  type BrainNodeOut
} from './client'
import {
  EDGE_KIND_TOKENS,
  FOCUS_DEFAULT_DEPTH,
  FOCUS_NODE_CAP,
  createGraphCanvas,
  fetchCodeFocus,
  fetchMemoryFocus,
  memSlugOf,
  type FocusDepth,
  type FocusGraph,
  type FocusNode
} from './graph'
import { renderInspector, type InspectorModel } from './inspector'
import { hideMemoryPreview, renderReader, renderWanted, type MemoryPreview } from './reader'

/**
 * The Brain view (ADR 0018/10): the workspace index made VISIBLE — status, the
 * graph lens, the memory reader, every consent in one place. Full-app view on
 * the board/settings precedent; house primitives and tokens only. The lens is a
 * WINDOW (focus + cap), never a 50k-node render; index content and memory text
 * are UNTRUSTED and land via textContent throughout; nothing here writes a user
 * file — writes belong to the granted agent tools and the user's own editor.
 * Telemetry carries booleans and counts only (ADR 0005).
 */

const LISTBOX_ID = 'brain-search-listbox'
const optionId = (i: number): string => `brain-option-${i}`

type SearchHit =
  | { type: 'code'; node: BrainNodeOut }
  | { type: 'memory'; hit: BrainMemoryHit }

type Focus = { kind: 'code'; id: string } | { kind: 'memory'; slug: string }

export interface BrainView {
  root: HTMLElement
  /** Entering the view (or the workspace changing under it) re-derives everything. */
  refresh(): void
  /** The view is on/off screen — hidden it costs zero and marks pushes stale. */
  setActive(on: boolean): void
  onChangedPush(projectKey: string): void
  /** DEV probes — the BRAINUX smoke's window into real state. */
  dev: Record<string, unknown>
}

export function createBrainView(): BrainView {
  const root = el('div', {})
  root.id = 'view-brain'

  // ── state ─────────────────────────────────────────────────────────────────
  let projectRoot = '' // the active workspace's folder ('' = none)
  let status: BrainAnswer | null = null
  let overview: BrainOverviewAnswer | null = null
  let rebuildBusy = false
  let mode: 'graph' | 'reader' = 'graph'
  let depth: FocusDepth = FOCUS_DEFAULT_DEPTH
  let focus: Focus | null = null
  let focusGraph: FocusGraph | null = null
  let focusRefused: string | null = null
  let reader: { slug: string } | null = null
  let inspector: InspectorModel | null = null
  let searchHits: SearchHit[] = []
  let searchSelected = 0
  let searchSeq = 0
  let pollTimer = 0
  let active = false // the view is on screen (index.ts drives this)
  let staleWhileHidden = false

  const wsId = (): string | null => getWorkspaces().activeId
  const activeWs = () => {
    const s = getWorkspaces()
    return s.workspaces.find((w) => w.id === s.activeId) ?? null
  }

  /** file (root-relative, '/'-separated) → absolute in the root's own spelling. */
  const absOf = (rel: string): string => {
    const sep = projectRoot.includes('\\') ? '\\' : '/'
    return (projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep) + rel.split('/').join(sep)
  }

  // ── head ──────────────────────────────────────────────────────────────────
  const sub = el('span', { class: 'brain-sub' })
  const genChip = el('span', { class: 'brain-chip brain-chip-gen', hidden: true })
  const dirtyChip = el('span', { class: 'brain-chip brain-chip-dirty', hidden: true })
  const indexingChip = el('span', { class: 'brain-chip brain-chip-indexing', hidden: true }, [
    Spinner(),
    el('span', { text: 'indexing' })
  ])
  const rebuildBtn = Button({
    label: 'Rebuild',
    variant: 'outline',
    size: 'sm',
    title: 'Re-index this project from its bytes (answers stay served meanwhile)',
    onClick: () => void runRebuild()
  })
  const head = el('div', { class: 'brain-head' }, [
    el('h1', { class: 'brain-title', text: 'Brain' }),
    sub,
    genChip,
    dirtyChip,
    indexingChip,
    el('span', { class: 'brain-head-spacer' }),
    rebuildBtn
  ])

  // ── rail: status card + consents + lenses ────────────────────────────────
  const statHost = el('div', { class: 'brain-stats' })
  const statusCard = Card(
    { header: SectionHeader({ title: 'Status', caption: 'What the index knows, and how honestly.' }), class: 'brain-status-card' },
    [statHost]
  )

  const orientToggle = createToggleRow({
    label: 'New board-launched agents start with a map of this project',
    hint: 'The ranked repomap, prepended to a card’s task — the same setting Settings › Terminal owns.',
    onChange: () => void applyConsent(orientToggle, orientSet, pullConsents)
  })
  const libFetchToggle = createToggleRow({
    label: 'Agents may fetch library docs from package registries',
    hint: 'Off by default. Exact pinned versions only, size-capped, HTTPS to the registry — the same permission Settings › Privacy owns.',
    onChange: () => void applyConsent(libFetchToggle, libFetchSet, pullConsents)
  })
  const semToggle = createToggleRow({
    label: 'Agents may search memories semantically',
    hint: 'Off by default. Fuzzy recall through YOUR OWN embedding endpoint (set in Settings › Privacy) — every fuzzy hit is labeled probabilistic; exact search never changes.',
    onChange: () => void applyConsent(semToggle, semSet, pullConsents)
  })
  const consentCard = Card(
    {
      header: SectionHeader({ title: 'Consents', caption: 'Per-workspace. Two-way with Settings — one stored truth.' }),
      class: 'brain-consent-card'
    },
    [orientToggle.el, libFetchToggle.el, semToggle.el]
  )

  const lensBtn = (lens: 'graph' | 'reader', label: string, hint: string): HTMLButtonElement =>
    el(
      'button',
      {
        class: 'brain-lens-btn',
        type: 'button',
        title: hint,
        dataset: { lens },
        onClick: () => {
          mode = lens
          renderLensNav()
          renderMain()
        }
      },
      [el('span', { text: label })]
    )
  const graphLensBtn = lensBtn('graph', 'Graph', 'The focused neighborhood lens')
  const readerLensBtn = lensBtn('reader', 'Memory', 'The memory reader')
  const lensNav = el('nav', { class: 'brain-lenses', ariaLabel: 'Lenses' }, [graphLensBtn, readerLensBtn])
  const renderLensNav = (): void => {
    graphLensBtn.setAttribute('aria-pressed', String(mode === 'graph'))
    readerLensBtn.setAttribute('aria-pressed', String(mode === 'reader'))
    graphLensBtn.classList.toggle('is-active', mode === 'graph')
    readerLensBtn.classList.toggle('is-active', mode === 'reader')
  }
  renderLensNav()

  const rail = el('div', { class: 'brain-rail' }, [lensNav, statusCard, consentCard])

  // ── main: search + lens surface ──────────────────────────────────────────
  const searchInput = el('input', {
    class: 'brain-search-input',
    type: 'text',
    placeholder: 'Find a symbol or a memory…',
    ariaLabel: 'Search definitions and memories',
    role: 'combobox',
    attrs: { 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': LISTBOX_ID }
  })
  const searchList = el('div', { class: 'brain-search-list', role: 'listbox', hidden: true, attrs: { id: LISTBOX_ID } })
  const capChip = el('span', { class: 'brain-chip brain-chip-capped', hidden: true, title: `The lens caps at ${FOCUS_NODE_CAP} nodes — it is a window, not the graph` })
  // Graph depth (revision B): rings around the focus. 2 is the default fetch;
  // 1 is direct neighbors; 3 buys one more voted expansion, same node cap.
  const depthBtns = ([1, 2, 3] as const).map((d) =>
    el('button', {
      class: 'brain-depth-btn',
      type: 'button',
      text: String(d),
      title: d === 1 ? 'Direct neighbors only' : d === 2 ? 'Two rings — the default window' : `Three rings, still capped at ${FOCUS_NODE_CAP} nodes`,
      onClick: () => setDepth(d)
    })
  )
  const depthNav = el('div', { class: 'brain-depth', role: 'group', ariaLabel: 'Graph depth' }, [
    el('span', { class: 'brain-depth-label', text: 'Depth' }),
    ...depthBtns
  ])
  const renderDepth = (): void =>
    depthBtns.forEach((b, i) => {
      const on = i + 1 === depth
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-pressed', String(on))
    })
  renderDepth()
  function setDepth(d: FocusDepth): void {
    if (d === depth) return
    depth = d
    renderDepth()
    if (focus) void focusOn(focus)
  }
  const searchRow = el('div', { class: 'brain-search' }, [searchInput, depthNav, capChip, searchList])
  // Contextual: only the kinds actually on screen earn a row (rebuilt per focus).
  const legend = el('div', { class: 'brain-legend', ariaLabel: 'Edge kinds', hidden: true })
  function renderLegend(graph: FocusGraph | null): void {
    clear(legend)
    const kinds = graph ? [...new Set(graph.edges.map((e) => e.kind))].sort() : []
    legend.hidden = !kinds.length
    for (const kind of kinds) {
      if (!(kind in EDGE_KIND_TOKENS)) continue
      legend.append(
        el('span', { class: 'brain-legend-item' }, [
          el('span', { class: `brain-legend-swatch is-${kind}`, attrs: { 'aria-hidden': 'true' } }),
          el('span', { class: 'brain-legend-label', text: kind })
        ])
      )
    }
  }

  const canvas = createGraphCanvas({
    onSelect: (n) => void selectNode(n),
    onOpen: (n) => openNode(n)
  })
  const readerHost = el('div', { class: 'brain-reader' })
  const stateHost = el('div', { class: 'brain-main-state' })
  const lensHost = el('div', { class: 'brain-lens-host' }, [searchRow, legend, canvas.el, readerHost, stateHost])

  const inspectorHost = el('aside', { class: 'brain-inspector', ariaLabel: 'Inspector' })

  const body = el('div', { class: 'brain-body' }, [rail, el('div', { class: 'brain-main' }, [lensHost]), inspectorHost])
  const emptyHost = el('div', { class: 'brain-empty-host', hidden: true })
  root.append(head, body, emptyHost)

  // ── consent plumbing (the Settings cards' discipline, verbatim) ──────────
  function syncConsentAvailability(): void {
    const id = wsId()
    orientToggle.setDisabled(!id)
    libFetchToggle.setDisabled(!id)
    semToggle.setDisabled(!id)
    if (!id) {
      orientToggle.setChecked(false)
      libFetchToggle.setChecked(false)
      semToggle.setChecked(false)
    }
  }
  async function pullConsents(): Promise<void> {
    const id = wsId()
    try {
      orientToggle.setChecked(!!id && (await orientGet(id)))
      libFetchToggle.setChecked(!!id && (await libFetchGet(id)))
      semToggle.setChecked(!!id && (await semGet(id)))
    } catch {
      /* bridge unavailable — leave as-is */
    }
    syncConsentAvailability()
  }
  async function applyConsent(
    toggle: { checked(): boolean; setChecked(v: boolean): void; setDisabled(v: boolean): void },
    save: (workspaceId: string, on: boolean) => Promise<boolean>,
    resync: () => Promise<void>
  ): Promise<void> {
    const next = toggle.checked()
    const id = wsId()
    if (!id) {
      syncConsentAvailability()
      return
    }
    toggle.setDisabled(true)
    try {
      if (!(await save(id, next))) {
        toggle.setChecked(!next)
        showToast({ tone: 'danger', title: 'Setting was not saved', body: 'The settings store did not accept the change — nothing was switched. Try again.' })
      }
    } catch (error) {
      toggle.setChecked(!next)
      showToast({ tone: 'danger', title: 'Setting was not saved', body: String(error) })
    } finally {
      await resync()
    }
  }

  // ── status card ───────────────────────────────────────────────────────────
  const statRow = (cls: string, label: string, value: string, title?: string): HTMLElement =>
    el('div', { class: `brain-stat ${cls}`, title }, [
      el('span', { class: 'brain-stat-label', text: label }),
      el('span', { class: 'brain-stat-value', text: value })
    ])

  function renderStatus(): void {
    clear(statHost)
    const s = status
    if (!s) {
      statHost.append(loadingRow('Asking the brain…'))
      return
    }
    if (!s.ok) {
      statHost.append(el('p', { class: 'brain-stat-refusal', text: refusalCopy(s.reason) }))
      return
    }
    const hitRate = s.cacheHits + s.cacheMisses ? Math.round((100 * s.cacheHits) / (s.cacheHits + s.cacheMisses)) : null
    statHost.append(
      statRow('brain-stat-generation', 'Generation', String(s.generation), 'Moves on every accepted rebuild — staleness is visible, never silent'),
      statRow('brain-stat-dirty', 'Freshness', s.dirty ? 'dirty' : 'fresh', 'Dirty = changes landed since the last index; the git tick drains them'),
      statRow('brain-stat-files', 'Files', String(s.files)),
      statRow('brain-stat-nodes', 'Nodes', String(s.nodes)),
      statRow('brain-stat-edges', 'Edges', String(s.edges)),
      statRow('brain-stat-languages', 'Languages', s.languages.length ? s.languages.join(' · ') : '—'),
      statRow(
        'brain-stat-refs',
        'Ref fidelity',
        `${s.resolvedRefs} resolved · ${s.droppedRefs} dropped`,
        'Ambiguous references are DROPPED and counted — reported, never faked'
      ),
      statRow('brain-stat-cache', 'Parse cache', hitRate === null ? '—' : `${hitRate}% hits`, 'Last build’s parse-cache economics')
    )
    const o = overview
    if (o?.ok) {
      statHost.append(
        statRow(
          'brain-stat-ecosystems',
          'Libraries',
          o.ecosystems.length ? o.ecosystems.map((e) => `${e.ecosystem} ${e.deps}`).join(' · ') : '—',
          'Lockfile-truth dependency counts for this checkout'
        ),
        statRow('brain-stat-memories', 'Memories', String(o.memories)),
        statRow(
          'brain-stat-dangling',
          'Wanted links',
          String(o.danglingLinks),
          'Wikilink targets no memory is written for — wanted knowledge, not an error'
        )
      )
      // Revision B: what the .memory/ scan refused to index — a row only when
      // there is something to say, and never silence when there is.
      const sk = o.memorySkips
      const skParts = [
        sk.invalid ? `${sk.invalid} invalid` : '',
        sk.tooLarge ? `${sk.tooLarge} too large` : '',
        sk.foreign ? `${sk.foreign} foreign` : '',
        sk.capped ? 'capped' : ''
      ].filter(Boolean)
      if (skParts.length) {
        statHost.append(
          statRow(
            'brain-stat-memskips',
            'Memory files skipped',
            skParts.join(' · '),
            'Files in .memory/ the scan refused to index — non-slug names, foreign extensions, unreadable frontmatter — counted, never silent'
          )
        )
      }
    }
    const dirty = s.dirty
    genChip.hidden = false
    genChip.textContent = `gen ${s.generation}`
    dirtyChip.hidden = false
    dirtyChip.textContent = dirty ? 'dirty' : 'fresh'
    dirtyChip.classList.toggle('is-dirty', dirty)
    indexingChip.hidden = !s.indexing
  }

  const refusalCopy = (reason: string): string =>
    reason === 'too-large'
      ? 'This project exceeds the index cap — the brain refuses to half-index it in silence.'
      : reason === 'busy'
        ? 'The index store is busy or locked right now. Try again in a moment.'
        : 'This folder cannot be indexed — it is missing, or not a directory.'

  // ── the main region's states ─────────────────────────────────────────────
  function showState(node: HTMLElement | null): void {
    clear(stateHost)
    const lens = !node
    canvas.el.hidden = !lens || mode !== 'graph'
    readerHost.hidden = !lens || mode !== 'reader'
    legend.hidden = !lens || mode !== 'graph' || !legend.childElementCount
    depthNav.hidden = !lens || mode !== 'graph'
    searchRow.hidden = !lens
    searchList.hidden = searchList.hidden || !lens
    stateHost.hidden = lens
    if (node) stateHost.append(node)
  }

  function renderMain(): void {
    emptyHost.hidden = true
    body.hidden = false
    if (!projectRoot) {
      body.hidden = true
      emptyHost.hidden = false
      clear(emptyHost)
      emptyHost.append(
        EmptyState({
          icon: 'folder',
          title: activeWs() ? 'This workspace has no folder' : 'No workspace open',
          body: 'The brain indexes a project folder. Open a workspace with one, and this view fills in.'
        })
      )
      genChip.hidden = dirtyChip.hidden = indexingChip.hidden = true
      rebuildBtn.disabled = true
      return
    }
    rebuildBtn.disabled = rebuildBusy
    const s = status
    if (s && !s.ok) {
      showState(
        EmptyState({
          icon: 'shield',
          title: 'The brain refused this folder',
          body: refusalCopy(s.reason),
          action: s.reason === 'busy' ? Button({ label: 'Retry', variant: 'outline', onClick: () => void refreshData() }) : undefined
        })
      )
      return
    }
    if (rebuildBusy || (s?.ok && s.indexing)) {
      showState(
        el('div', { class: 'brain-progress' }, [
          loadingRow(s?.ok && s.generation === 0 ? 'First index — reading the project…' : 'Re-indexing — answers stay served from the old bytes…'),
          el('p', { class: 'brain-progress-note', text: 'The window stays live; the worker owns the build.' })
        ])
      )
      return
    }
    if (s?.ok && s.generation === 0) {
      showState(
        EmptyState({
          icon: 'activity',
          title: 'No index yet',
          body: 'This project has never been indexed here. One build, then every lens answers.',
          action: Button({ label: 'Build the index', variant: 'primary', onClick: () => void runRebuild() })
        })
      )
      return
    }
    // The lens itself.
    showState(null)
    if (mode === 'graph') {
      if (!focus) {
        canvas.el.hidden = true
        legend.hidden = true
        stateHost.hidden = false
        clear(stateHost)
        stateHost.append(
          EmptyState({
            icon: 'search',
            title: 'Pick a focus',
            body: `Search a symbol or a memory — the lens renders its neighborhood, up to ${FOCUS_NODE_CAP} nodes by rank. Never the whole graph.`
          })
        )
      }
    } else {
      void renderReaderPane()
    }
  }

  async function renderReaderPane(): Promise<void> {
    clear(readerHost)
    if (!reader) {
      readerHost.append(
        EmptyState({
          icon: 'bookmark',
          title: 'No memory open',
          body: 'Search a memory by name, or double-click a memory node in the graph lens.'
        })
      )
      return
    }
    const slug = reader.slug
    const got = await brainRead(projectRoot, 'brain.memGet', { slug })
    if (reader?.slug !== slug) return // navigated away while loading
    if (got.ok) {
      renderReader(
        readerHost,
        {
          memory: got.memory as BrainMemoryOut,
          links: (got.links as BrainMemoryLinkOut[] | undefined) ?? [],
          backlinks: (got.backlinks as BrainBacklinkOut[] | undefined) ?? [],
          truncated: got.truncated === true
        },
        readerDeps
      )
    } else if (got.reason === 'unknown-memory') {
      const back = await brainRead(projectRoot, 'brain.memBacklinks', { slug })
      if (reader?.slug !== slug) return
      renderWanted(readerHost, slug, back.ok ? ((back.backlinks as BrainBacklinkOut[] | undefined) ?? []) : [], readerDeps)
    } else {
      clear(readerHost)
      readerHost.append(EmptyState({ icon: 'shield', title: 'This memory did not answer', body: refusalCopy(String(got.reason)) }))
    }
  }

  // The hover preview's material, cached per slug and cleared per GENERATION —
  // a stale preview would quietly contradict the reader beside it.
  const previewCache = new Map<string, MemoryPreview | null>()
  let previewCacheGen = -1
  const syncPreviewCache = (generation: number): void => {
    if (generation !== previewCacheGen) {
      previewCacheGen = generation
      previewCache.clear()
    }
  }

  const readerDeps = {
    onNavigate: (slug: string): void => {
      reader = { slug }
      mode = 'reader'
      renderLensNav()
      renderMain()
    },
    onFocusGraph: (slug: string): void => {
      void focusOn({ kind: 'memory', slug })
    },
    getPreview: async (slug: string): Promise<MemoryPreview | null> => {
      if (previewCache.has(slug)) return previewCache.get(slug) ?? null
      const got = await brainRead(projectRoot, 'brain.memGet', { slug })
      let p: MemoryPreview | null = null
      if (got.ok) {
        const m = got.memory as BrainMemoryOut
        p = { name: m.name, description: m.description, snippet: m.body.replace(/\s+/g, ' ').trim().slice(0, 240) }
      }
      previewCache.set(slug, p)
      return p
    }
  }

  // ── focus + selection ────────────────────────────────────────────────────
  async function focusOn(next: Focus): Promise<void> {
    focus = next
    mode = 'graph'
    renderLensNav()
    focusRefused = null
    focusGraph = null
    renderMain()
    const result =
      next.kind === 'code'
        ? await fetchCodeFocus(projectRoot, next.id, depth)
        : await fetchMemoryFocus(projectRoot, next.slug, depth)
    // A slower older fetch must not clobber a newer focus (async-state law).
    if (focus !== next) return
    if ('refused' in result) {
      focusRefused = result.refused
      canvas.setGraph(null)
      renderLegend(null)
      showState(EmptyState({ icon: 'shield', title: 'The lens could not focus there', body: `The index answered: ${result.refused}.` }))
      return
    }
    focusGraph = result
    capChip.hidden = !result.capped
    capChip.textContent = `window · ${result.nodes.length} shown, more exists`
    renderLegend(result)
    legend.hidden = !legend.childElementCount
    canvas.setGraph(result)
    canvas.setSelected(result.focusId)
    const focusNode = result.nodes.find((n) => n.id === result.focusId) ?? null
    if (focusNode) await selectNode(focusNode)
    getTelemetry().captureEvent({
      name: 'brain.focus',
      props: { nodes: result.nodes.length, edges: result.edges.length, capped: result.capped, memory: result.memory }
    })
  }

  async function selectNode(n: FocusNode): Promise<void> {
    canvas.setSelected(n.id)
    let neighbors: BrainNeighborOut[] = []
    let truncated = false
    if (n.kind !== 'memory') {
      const reply = await brainRead(projectRoot, 'brain.neighbors', { id: n.id, direction: 'both', limit: 12 })
      if (reply.ok) {
        neighbors = (reply.neighbors as BrainNeighborOut[] | undefined) ?? []
        truncated = reply.truncated === true
      }
    }
    inspector = { node: n, neighbors, neighborsTruncated: truncated }
    renderInspector(inspectorHost, inspector, inspectorDeps)
  }

  /** The DEEP action: code → the explorer (delegate, never an embedded editor);
   *  memory → the reader. */
  function openNode(n: FocusNode): void {
    const slug = memSlugOf(n.id)
    if (slug) {
      readerDeps.onNavigate(slug)
    } else if (n.file) {
      requestExplorerReveal(absOf(n.file))
    }
  }

  const inspectorDeps = {
    onFocus: (n: FocusNode): void => {
      const slug = memSlugOf(n.id)
      void focusOn(slug ? { kind: 'memory', slug } : { kind: 'code', id: n.id })
    },
    onReveal: (n: FocusNode): void => {
      if (n.file) requestExplorerReveal(absOf(n.file))
    },
    onRead: (slug: string): void => readerDeps.onNavigate(slug)
  }

  // ── search (combobox over defs + memory slugs) ───────────────────────────
  let searchTimer = 0
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => void runSearch(searchInput.value.trim()), 140)
  })
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation() // typing here must not trip global chords
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!searchHits.length) return
      searchSelected = (searchSelected + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length
      renderSearchList()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = searchHits[searchSelected]
      if (hit) chooseHit(hit)
    } else if (e.key === 'Escape' && !searchList.hidden) {
      e.preventDefault()
      closeSearchList()
    }
  })

  async function runSearch(q: string): Promise<void> {
    const seq = ++searchSeq
    if (q.length < 2) {
      searchHits = []
      closeSearchList()
      return
    }
    const [symbols, memories] = await Promise.all([
      brainRead(projectRoot, 'brain.symbol', { name: `${q}*` }),
      brainRead(projectRoot, 'brain.memSearch', { query: q, limit: 4 })
    ])
    if (seq !== searchSeq) return // a newer query owns the listbox
    const codeHits: SearchHit[] = symbols.ok
      ? ((symbols.matches as BrainNodeOut[] | undefined) ?? []).slice(0, 8).map((node) => ({ type: 'code' as const, node }))
      : []
    const memHits: SearchHit[] = memories.ok
      ? ((memories.memories as BrainMemoryHit[] | undefined) ?? []).map((hit) => ({ type: 'memory' as const, hit }))
      : []
    searchHits = [...codeHits, ...memHits]
    searchSelected = 0
    renderSearchList()
  }

  function renderSearchList(): void {
    clear(searchList)
    if (!searchHits.length) {
      searchList.hidden = false
      searchInput.setAttribute('aria-expanded', 'true')
      searchList.append(el('div', { class: 'brain-search-empty', text: 'No matches in this project’s brain' }))
      searchInput.setAttribute('aria-activedescendant', '')
      return
    }
    searchHits.forEach((hit, i) => {
      const row = el(
        'button',
        {
          class: `brain-search-item${i === searchSelected ? ' is-selected' : ''}`,
          type: 'button',
          role: 'option',
          tabIndex: -1,
          attrs: { id: optionId(i) },
          onClick: () => chooseHit(hit)
        },
        hit.type === 'code'
          ? [
              Pill({ text: hit.node.kind }),
              el('span', { class: 'brain-search-name', text: hit.node.name }),
              el('span', { class: 'brain-search-file', text: `${hit.node.file}:${hit.node.startLine}` })
            ]
          : [
              Pill({ text: 'memory', tone: 'accent' }),
              el('span', { class: 'brain-search-name', text: hit.hit.name }),
              el('span', { class: 'brain-search-file', text: hit.hit.slug })
            ]
      )
      row.setAttribute('aria-selected', String(i === searchSelected))
      searchList.append(row)
    })
    searchList.hidden = false
    searchInput.setAttribute('aria-expanded', 'true')
    searchInput.setAttribute('aria-activedescendant', optionId(searchSelected))
  }

  function closeSearchList(): void {
    searchList.hidden = true
    searchInput.setAttribute('aria-expanded', 'false')
    searchInput.setAttribute('aria-activedescendant', '')
  }

  function chooseHit(hit: SearchHit): void {
    closeSearchList()
    if (hit.type === 'code') void focusOn({ kind: 'code', id: hit.node.id })
    else readerDeps.onNavigate(hit.hit.slug)
  }

  // ── data refresh ─────────────────────────────────────────────────────────
  async function refreshData(): Promise<void> {
    if (!projectRoot) {
      status = null
      overview = null
      renderMain()
      return
    }
    status = null
    renderStatus()
    const [s, o] = await Promise.all([brainStatus(projectRoot), brainOverview(projectRoot)])
    status = s
    overview = o
    if (s.ok) syncPreviewCache(s.generation)
    renderStatus()
    renderMain()
    if (s.ok && s.indexing) schedulePoll()
  }

  function schedulePoll(): void {
    window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(() => {
      if (!active || !projectRoot) return
      void (async () => {
        const s = await brainStatus(projectRoot)
        status = s
        renderStatus()
        renderMain()
        if (s.ok && s.indexing) schedulePoll()
      })()
    }, 600)
  }

  async function runRebuild(): Promise<void> {
    if (rebuildBusy || !projectRoot) return
    rebuildBusy = true
    rebuildBtn.disabled = true
    const label = rebuildBtn.querySelector('span')
    if (label) label.textContent = 'Rebuilding…'
    renderMain()
    try {
      const answer = await brainRebuild(projectRoot)
      getTelemetry().captureEvent({ name: 'brain.rebuild', props: { ok: answer.ok } })
      if (!answer.ok) {
        showToast({ tone: 'danger', title: 'The rebuild was refused', body: refusalCopy(answer.reason) })
      }
      status = answer
    } catch (error) {
      showToast({ tone: 'danger', title: 'The rebuild failed', body: String(error) })
    } finally {
      rebuildBusy = false
      rebuildBtn.disabled = false
      if (label) label.textContent = 'Rebuild'
    }
    await refreshData()
    if (focus) await focusOn(focus)
  }

  // ── the public surface ───────────────────────────────────────────────────
  function refresh(): void {
    const ws = activeWs()
    const nextRoot = ws?.cwd ?? ''
    if (nextRoot !== projectRoot) {
      projectRoot = nextRoot
      focus = null
      focusGraph = null
      focusRefused = null
      reader = null
      inspector = null
      searchHits = []
      searchInput.value = ''
      previewCache.clear()
      previewCacheGen = -1
      hideMemoryPreview()
      closeSearchList()
      canvas.setGraph(null)
      renderLegend(null)
      renderInspector(inspectorHost, null, inspectorDeps)
      capChip.hidden = true
    }
    sub.textContent = projectRoot ? projectRoot.split(/[\\/]/).slice(-2).join('/') : ''
    sub.title = projectRoot
    staleWhileHidden = false
    void pullConsents()
    void refreshData()
    renderInspector(inspectorHost, inspector, inspectorDeps)
  }

  function onChangedPush(projectKey: string): void {
    if (!active) {
      staleWhileHidden = true
      return
    }
    const s = status
    if (s?.ok && s.projectKey !== projectKey) return
    void (async () => {
      const [ns, no] = await Promise.all([brainStatus(projectRoot), brainOverview(projectRoot)])
      const oldGen = s?.ok ? s.generation : -1
      status = ns
      overview = no
      if (ns.ok) syncPreviewCache(ns.generation)
      renderStatus()
      renderMain()
      // A new generation redraws the lens — the layout is deterministic PER
      // generation, so the refetch is the honest repaint, not a nicety.
      if (focus && ns.ok && ns.generation !== oldGen) void focusOn(focus)
    })()
  }

  const dev: Record<string, unknown> = {
    state: () => ({
      root: projectRoot,
      mode,
      active,
      focus,
      depth,
      refused: focusRefused,
      capped: focusGraph?.capped ?? false,
      nodes: focusGraph?.nodes.length ?? 0,
      edges: focusGraph?.edges.length ?? 0,
      generation: focusGraph?.generation ?? null,
      reader: reader?.slug ?? null,
      selected: inspector?.node.id ?? null,
      rebuildBusy
    }),
    nodes: () => (focusGraph?.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, name: n.name, ring: n.ring, x: n.x, y: n.y, dangling: !!n.dangling })),
    frame: () => canvas.frame(),
    positions: () => canvas.positions(),
    search: (q: string) => {
      searchInput.value = q
      searchInput.dispatchEvent(new Event('input'))
      return true
    },
    results: () => searchHits.map((h) => (h.type === 'code' ? `code:${h.node.name}` : `memory:${h.hit.slug}`)),
    choose: (i: number) => {
      const hit = searchHits[i]
      if (hit) chooseHit(hit)
      return !!hit
    },
    focusCode: (id: string) => void focusOn({ kind: 'code', id }),
    focusMemory: (slug: string) => void focusOn({ kind: 'memory', slug }),
    openReader: (slug: string) => readerDeps.onNavigate(slug),
    readerProbe: () => {
      const bodyEl = readerHost.querySelector('.brain-reader-body')
      return {
        text: bodyEl?.textContent ?? '',
        activeContent: bodyEl ? bodyEl.querySelectorAll('script, img, style, iframe, object, embed, svg').length : -1,
        wikilinks: bodyEl
          ? [...bodyEl.querySelectorAll('.brain-wikilink')].map((b) => ({
              text: b.textContent ?? '',
              dangling: b.classList.contains('is-dangling')
            }))
          : []
      }
    },
    statusText: () => statHost.textContent ?? '',
    chip: () => ({ gen: genChip.textContent, dirty: dirtyChip.textContent, indexing: !indexingChip.hidden }),
    rebuild: () => void runRebuild(),
    refresh: () => {
      refresh()
      return true
    },
    setDepth: (d: number) => {
      if (d === 1 || d === 2 || d === 3) setDepth(d)
      return depth
    },
    propsProbe: () => {
      const panel = readerHost.querySelector('.brain-props')
      return {
        keys: panel ? [...panel.querySelectorAll('.brain-prop-key')].map((n) => n.textContent ?? '') : [],
        values: panel ? [...panel.querySelectorAll('.brain-prop-value')].map((n) => n.textContent ?? '') : [],
        activeContent: panel ? panel.querySelectorAll('script, img, style, iframe, object, embed, svg').length : -1
      }
    },
    previewProbe: () => {
      const p = document.querySelector('.brain-preview') as HTMLElement | null
      return { visible: !!p && !p.hidden, text: p?.textContent ?? '' }
    },
    stageProgress: (on: boolean) => {
      rebuildBusy = on
      renderMain()
      return true
    },
    consents: () => ({ orient: orientToggle.checked(), libFetch: libFetchToggle.checked(), semantic: semToggle.checked() })
  }

  return {
    root,
    refresh,
    setActive: (on: boolean): void => {
      active = on
      if (on && staleWhileHidden) refresh()
      if (!on) {
        window.clearTimeout(pollTimer)
        hideMemoryPreview() // the card floats on document.body — never outlive the view
      }
    },
    onChangedPush,
    dev
  }
}

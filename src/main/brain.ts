import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  BrainService,
  EMBED_QUERY_MAX_CHARS,
  embedProviderLabel,
  embedTexts,
  isBrainWriteVerb,
  isEmbedEndpoint,
  isMemoryWriteVerb,
  parseMemoryFilter,
  partitionOf,
  serveBrainRead,
  serveBrainWrite,
  serveMemorySearchSemantic,
  serveMemoryWrite,
  type BrainFreshnessStats,
  type BrainServeReply,
  type BrainTickSource,
  type MemorySemanticLens
} from '@backend/features/brain'
import { redactSecrets } from '@backend/features/review'
import {
  BrainChannels,
  locatePane,
  type BrainAnswer,
  type BrainChangedEvent,
  type BrainEcosystemCount,
  type BrainLibEcosystem,
  type BrainMemorySkips,
  type BrainOverviewAnswer,
  type BrainSemConfig
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { resolveGrantedWriteTools, workspaceIdForPane } from './integrations'
import { fetchLibraryDocs } from './libfetch'
import { recordTrail } from './trail'
import { vaultAvailable, vaultClearKey, vaultHas, vaultLoad, vaultStore } from './vault'

// App-wiring for the workspace brain (ADR 0018). The logic lives in @backend
// (Electron-free, testable); main derives the ONE path Electron owns — the db dir
// under the userData layout — refuses malformed input before the backend ever sees
// it (the explorer.ts posture: junk in → an `invalid` refusal out, never a throw),
// and pushes `brain:changed` after any accepted rebuild AND after every landed
// incremental drain (step 04: the freshness law, riding registerGit's one monitor
// tick — never a poller of its own). Nothing here (or in the backend it binds)
// forwards a path, a symbol, or memory text to telemetry (ADR 0005).

let service: BrainService | null = null
/** The one GitMonitor, handed over by boot after registerGit — survives a service
 *  dispose/reopen cycle (the smoke's cold-start arm) because it belongs to the app. */
let boundTickSource: BrainTickSource | null = null
let boundWin: (() => BrowserWindow | null) | null = null

/** Lazy: userData is re-pointed by MOGGING_USERDATA in every gate, so the paths
 *  resolve at first use, never at import. Main's whole contribution is the three
 *  paths Electron owns; the engine is @backend's. */
function ensureService(): BrainService {
  if (!service) {
    service = new BrainService({
      baseDir: join(app.getPath('userData'), 'brain'),
      workerFile: join(app.getAppPath(), 'out', 'main', 'brain-worker.js'),
      grammarsDir: join(app.getAppPath(), 'assets', 'grammars')
    })
    if (boundTickSource) service.bindTickSource(boundTickSource)
    service.onChanged((event) => {
      try {
        boundWin?.()?.webContents.send(BrainChannels.changed, event)
      } catch {
        /* window gone */
      }
    })
    // Revision A: the embed planner — resolved PER PASS, so a consent or config
    // flip lands on the very next drain without any rewiring. Null everywhere
    // until a consenting, configured workspace stands in the project.
    service.setMemoryEmbedPlanner((projectRoots) => {
      const ws = semWorkspaceForRoots(projectRoots)
      if (!ws) return null
      const cfg = embedTargetOf(ws.id)
      if (!cfg.endpoint || !cfg.model || !isEmbedEndpoint(cfg.endpoint)) return null
      return {
        endpoint: cfg.endpoint,
        model: cfg.model,
        key: resolveEmbedKey(ws.id),
        onFailure: (detail) => fireSemFailure(ws.id, detail)
      }
    })
  }
  return service
}

/** The exact function `brain:status` runs, exported so the BRAINCORE smoke
 *  exercises the validation seam with zero UI. */
export function handleBrainStatus(req: unknown): BrainAnswer {
  const root = (req as { root?: unknown } | null | undefined)?.root
  if (typeof root !== 'string' || !root) return { ok: false, reason: 'invalid' }
  return ensureService().status(root)
}

/** The exact function `brain:rebuild` runs — same seam, same refusals. Awaits the
 *  worker's ONE transactional commit and answers the fresh status. */
export function handleBrainRebuild(req: unknown): Promise<BrainAnswer> {
  const root = (req as { root?: unknown } | null | undefined)?.root
  if (typeof root !== 'string' || !root) {
    return Promise.resolve({ ok: false, reason: 'invalid' })
  }
  return ensureService().rebuild(root)
}

/** Where a project's db lives — exported for the BRAINCORE smoke's "under
 *  userData, never under a root" assertion. */
export function brainBaseDir(): string {
  return join(app.getPath('userData'), 'brain')
}

/** The calling PANE's checkout root — pane → workspace → cwd, the exact
 *  board-read path (locatePane over the same workspaces list boardForPane
 *  walks). Null when the pane resolves nowhere: the serve layer then requires
 *  an explicit `root`, exactly like a bare human session. */
export function brainRootForPane(pane: string): string | null {
  const paneNum = Number(pane)
  if (!Number.isInteger(paneNum) || paneNum <= 0) return null
  const workspaces = getSettingsStore()?.load()?.workspaces
  if (!workspaces) return null
  const cwd = locatePane(workspaces, paneNum)?.ws.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

/**
 * The `brain.*` read family over the agent wire (ADR 0018 step 05): the
 * mcp-endpoint forwards every brain verb here. Reads are FREE (ADR 0008) —
 * no grant, no gate — but never unscoped: a pane session reads its own
 * checkout (scope 'project' widens to labeled sibling worktrees); a paneless
 *  session must name a root. Symbol names and paths flow back to the calling
 * model only — never telemetry (ADR 0005).
 */
export function handleBrainMcp(name: string, args: Record<string, unknown>, boundPane: string | undefined): BrainServeReply {
  const callerRoot = boundPane ? brainRootForPane(boundPane) : null
  return serveBrainRead(ensureService(), name, args, callerRoot)
}

/** brain.<write verb> -> the write-tool name whose grant covers it — the board
 *  map's shape, one row per closed-set verb. */
const BRAIN_WRITE_TOOL: Record<string, string> = {
  'brain.replaceBody': 'replace_symbol_body',
  'brain.insertAfter': 'insert_after_symbol',
  'brain.insertBefore': 'insert_before_symbol'
}

/** brain.<memory verb> -> the write-tool name whose grant covers it (09). */
const MEMORY_WRITE_TOOL: Record<string, string> = {
  'brain.memCreate': 'create_memory',
  'brain.memUpdate': 'update_memory'
}

export { isBrainWriteVerb, isMemoryWriteVerb }

/**
 * The `brain.*` WRITE family over the agent wire (ADR 0018 step 07). Custody
 * first: the server already filters by grant; this endpoint re-derives it and
 * fails closed (the board-write posture, verbatim) — no pane, no grant, no
 * write. The engine's own locks follow (own-checkout scope, file CAS, sanity).
 * Every call — landed or refused — leaves ONE trail event: verb and outcome
 * only, never a path, a symbol, or a byte of content (ADR 0005).
 */
export async function handleBrainWriteMcp(
  name: string,
  args: Record<string, unknown>,
  boundPane: string | undefined
): Promise<BrainServeReply> {
  const tool = BRAIN_WRITE_TOOL[name]
  if (!tool) return { ok: false, reason: 'invalid', detail: `unroutable brain write verb: ${name}` }
  const resolved = boundPane ? resolveGrantedWriteTools(boundPane) : { workspaceId: undefined, writeTools: [] as string[] }
  if (!boundPane || !resolved.writeTools.includes(tool)) {
    return { ok: false, reason: 'forbidden' }
  }
  const reply = await serveBrainWrite(ensureService(), name, args, brainRootForPane(boundPane))
  recordTrail({
    ts: Date.now(),
    source: 'mcp',
    workspaceId: resolved.workspaceId ?? '',
    pane: boundPane,
    verb: tool,
    target: '1 symbol',
    outcome: reply.ok ? 'ok' : 'refused',
    ...(reply.ok ? {} : { reason: String(reply.reason ?? 'refused') })
  })
  return reply
}

/**
 * The MEMORY write family over the agent wire (ADR 0018 step 09) — the symbol
 * writes' custody, verbatim: the server already filters by grant; this endpoint
 * re-derives it and fails closed. The engine's own locks follow (own-checkout
 * `.memory/`, slug law, create-collision, update CAS). One trail event per
 * call — verb and outcome only, never a slug, a name, or a byte of memory
 * text (ADR 0005).
 */
export async function handleMemoryWriteMcp(
  name: string,
  args: Record<string, unknown>,
  boundPane: string | undefined
): Promise<BrainServeReply> {
  const tool = MEMORY_WRITE_TOOL[name]
  if (!tool) return { ok: false, reason: 'invalid', detail: `unroutable memory write verb: ${name}` }
  const resolved = boundPane ? resolveGrantedWriteTools(boundPane) : { workspaceId: undefined, writeTools: [] as string[] }
  if (!boundPane || !resolved.writeTools.includes(tool)) {
    return { ok: false, reason: 'forbidden' }
  }
  const reply = await serveMemoryWrite(ensureService(), name, args, brainRootForPane(boundPane))
  recordTrail({
    ts: Date.now(),
    source: 'mcp',
    workspaceId: resolved.workspaceId ?? '',
    pane: boundPane,
    verb: tool,
    target: '1 memory',
    outcome: reply.ok ? 'ok' : 'refused',
    ...(reply.ok ? {} : { reason: String(reply.reason ?? 'refused') })
  })
  return reply
}

// ── The launch-orientation knob (06): per-workspace, default ON ───────────────
// One KV map in the settings store — the grant/plan precedent, minus the
// ceremony a boolean does not need. Absent = TRUE: cold panes start oriented
// unless this workspace said otherwise; OFF is zero injection bytes.

const ORIENT_KV = 'brain.orientAtLaunch'

function orientMap(): Record<string, boolean> {
  try {
    const raw = getSettingsStore()?.getSetting(ORIENT_KV)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true
      return out
    }
  } catch {
    /* unreadable map reads as all-default */
  }
  return {}
}

export function orientAtLaunch(workspaceId: string): boolean {
  const map = orientMap()
  return workspaceId in map ? map[workspaceId] : true
}

export function setOrientAtLaunch(workspaceId: string, on: boolean): boolean {
  const store = getSettingsStore()
  if (!store || !workspaceId) return false
  const map = orientMap()
  map[workspaceId] = on
  try {
    store.setSetting(ORIENT_KV, JSON.stringify(map))
    return true
  } catch {
    return false
  }
}

// ── The library-docs fetch consent (08): per-workspace, default OFF ───────────
// The orient knob's storage shape with CONSENT semantics: absent = FALSE — no
// network unless this workspace's human said so, and the smokes never say so.

const LIBFETCH_KV = 'brain.fetchLibraryDocs'

function libFetchMap(): Record<string, boolean> {
  try {
    const raw = getSettingsStore()?.getSetting(LIBFETCH_KV)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true
      return out
    }
  } catch {
    /* unreadable map reads as all-default (closed) */
  }
  return {}
}

export function libFetchAllowed(workspaceId: string): boolean {
  return libFetchMap()[workspaceId] === true
}

export function setLibFetchAllowed(workspaceId: string, on: boolean): boolean {
  const store = getSettingsStore()
  if (!store || !workspaceId) return false
  const map = libFetchMap()
  map[workspaceId] = on
  try {
    store.setSetting(LIBFETCH_KV, JSON.stringify(map))
    return true
  } catch {
    return false
  }
}

// ── The semantic lens (ADR 0018 revision A): consent, target, key, latch ─────
// Consent is the libFetch card's storage shape with the SAME semantics: absent
// = FALSE, per workspace, the human flips it. The target (endpoint + model) is
// BYO only — both empty until set, no default to fall back to — and the key at
// rest rides the ADR 0007.a vault pointer grammar verbatim (ciphertext or an
// env-ref NAME; never a plaintext in any config file, never a getter channel).

const SEM_KV = 'brain.semanticMemory'
const SEMCFG_KV = 'brain.embedTarget'
const SEM_KEY_CIPHER = (wsId: string): string => `brain.embedkeycipher.${wsId}`
const SEM_KEY_ENVREF = (wsId: string): string => `brain.embedkeyenv.${wsId}`
const SEM_ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/
const SEM_MODEL_MAX = 200
const SEM_ENDPOINT_MAX = 2000

function semMap(): Record<string, boolean> {
  try {
    const raw = getSettingsStore()?.getSetting(SEM_KV)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true
      return out
    }
  } catch {
    /* unreadable map reads as all-default (closed) */
  }
  return {}
}

export function semanticAllowed(workspaceId: string): boolean {
  return semMap()[workspaceId] === true
}

function semTargetMap(): Record<string, { endpoint: string; model: string }> {
  try {
    const raw = getSettingsStore()?.getSetting(SEMCFG_KV)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, { endpoint: string; model: string }> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const row = v as { endpoint?: unknown; model?: unknown }
        out[k] = {
          endpoint: typeof row?.endpoint === 'string' ? row.endpoint : '',
          model: typeof row?.model === 'string' ? row.model : ''
        }
      }
      return out
    }
  } catch {
    /* unreadable map reads as unconfigured */
  }
  return {}
}

export function embedTargetOf(workspaceId: string): { endpoint: string; model: string } {
  return semTargetMap()[workspaceId] ?? { endpoint: '', model: '' }
}

/** The workspace's cwd, for the consent/config flip's embed nudge. */
function wsCwd(workspaceId: string): string | null {
  const workspaces = getSettingsStore()?.load()?.workspaces
  if (!Array.isArray(workspaces)) return null
  for (const ws of workspaces as { id?: unknown; cwd?: unknown }[]) {
    if (ws?.id === workspaceId) return typeof ws.cwd === 'string' && ws.cwd ? ws.cwd : null
  }
  return null
}

/** The FIRST consenting workspace standing in this project (settings order —
 *  fixed, so the same roots always elect the same lens config). Null = the
 *  lens is off for this project and the embed pass is a no-op. */
function semWorkspaceForRoots(projectRoots: string[]): { id: string; cwd: string } | null {
  const workspaces = getSettingsStore()?.load()?.workspaces
  if (!Array.isArray(workspaces)) return null
  for (const ws of workspaces as { id?: unknown; cwd?: unknown }[]) {
    const id = typeof ws?.id === 'string' ? ws.id : ''
    const cwd = typeof ws?.cwd === 'string' ? ws.cwd : ''
    if (!id || !cwd) continue
    if (partitionOf(projectRoots, cwd) && semanticAllowed(id)) return { id, cwd }
  }
  return null
}

/** Nudge the workspace's project to run an embed pass (consent/config flips
 *  should index now, not on the next edit). Quietly nothing without a cwd. */
function pokeSemEmbed(workspaceId: string): void {
  const cwd = wsCwd(workspaceId)
  if (cwd) ensureService().pokeMemoryEmbed(cwd)
}

export function setSemanticAllowed(workspaceId: string, on: boolean): boolean {
  const store = getSettingsStore()
  if (!store || !workspaceId) return false
  const map = semMap()
  map[workspaceId] = on
  try {
    store.setSetting(SEM_KV, JSON.stringify(map))
  } catch {
    return false
  }
  semFailureFired.delete(workspaceId) // a flip re-arms the single-fire toast
  if (on) pokeSemEmbed(workspaceId)
  return true
}

export function setEmbedTarget(workspaceId: string, endpoint: string, model: string): { ok: boolean; reason?: string } {
  const store = getSettingsStore()
  if (!store || !workspaceId) return { ok: false, reason: 'no settings store' }
  const ep = endpoint.trim().slice(0, SEM_ENDPOINT_MAX)
  const mdl = model.trim().replace(/[\r\n]+/g, ' ').slice(0, SEM_MODEL_MAX)
  if (ep && !isEmbedEndpoint(ep)) {
    return { ok: false, reason: 'the endpoint must be an absolute http(s) base URL (…/v1) — a local one is fine' }
  }
  const map = semTargetMap()
  map[workspaceId] = { endpoint: ep, model: mdl }
  try {
    store.setSetting(SEMCFG_KV, JSON.stringify(map))
  } catch {
    return { ok: false, reason: 'the settings store did not accept the change' }
  }
  semFailureFired.delete(workspaceId) // new target, new chance to fail loudly once
  if (ep && mdl) pokeSemEmbed(workspaceId)
  return { ok: true }
}

/** ADR 0007.a presence: keychain / env-ref / none — never a key byte. */
export function embedKeySlot(workspaceId: string): BrainSemConfig['keySlot'] {
  const envRef = getSettingsStore()?.getSetting(SEM_KEY_ENVREF(workspaceId))
  if (envRef) return { kind: 'env-ref', envRef }
  if (vaultHas(SEM_KEY_CIPHER(workspaceId))) return { kind: 'keychain' }
  return { kind: 'none' }
}

/** Paste path: encrypt immediately; the plaintext argument is never stored,
 *  logged, or echoed — the return carries ok/reason only (usage-keys, verbatim). */
export function embedKeySetPlaintext(workspaceId: string, plaintext: string): { ok: boolean; reason?: string } {
  if (typeof plaintext !== 'string' || !plaintext.trim() || plaintext.length > 4096) {
    return { ok: false, reason: 'paste a non-empty key (max 4096 chars)' }
  }
  if (!vaultAvailable()) {
    return {
      ok: false,
      reason: 'OS keychain encryption is unavailable on this system — use an env-ref instead (e.g. ${OLLAMA_KEY})'
    }
  }
  if (!vaultStore(SEM_KEY_CIPHER(workspaceId), plaintext.trim())) {
    return { ok: false, reason: 'the settings store is not available right now — the key was not saved; try again' }
  }
  getSettingsStore()?.setSetting(SEM_KEY_ENVREF(workspaceId), '') // keychain replaces any env-ref
  semFailureFired.delete(workspaceId)
  return { ok: true }
}

/** Env-ref path: the NAME persists, never a value; a secret-shaped literal is
 *  refused with the same deny-list heuristic every pointer slot uses. */
export function embedKeySetEnvRef(workspaceId: string, envRefRaw: string): { ok: boolean; reason?: string } {
  const envRef = String(envRefRaw ?? '')
    .trim()
    .replace(/^\$\{?/, '')
    .replace(/\}$/, '')
  if (!SEM_ENV_NAME.test(envRef)) return { ok: false, reason: 'env-ref must be a VARIABLE NAME like ${OLLAMA_KEY}' }
  if (redactSecrets(envRef).redactions > 0) {
    return { ok: false, reason: 'that looks like a key VALUE — paste it in the key field, or give a variable NAME' }
  }
  const kv = getSettingsStore()
  kv?.setSetting(SEM_KEY_ENVREF(workspaceId), envRef)
  kv?.setSetting(SEM_KEY_CIPHER(workspaceId), '')
  semFailureFired.delete(workspaceId)
  return { ok: true }
}

export function embedKeyClear(workspaceId: string): void {
  vaultClearKey(SEM_KEY_CIPHER(workspaceId))
  getSettingsStore()?.setSetting(SEM_KEY_ENVREF(workspaceId), '')
}

/** The embed path ONLY (in memory, per request) — never exposed over any
 *  channel. Null when no usable key exists (keyless local endpoints are fine). */
export function resolveEmbedKey(workspaceId: string): string | null {
  const slot = embedKeySlot(workspaceId)
  if (slot.kind === 'env-ref') return process.env[slot.envRef] ?? null
  if (slot.kind === 'keychain') return vaultLoad(SEM_KEY_CIPHER(workspaceId)) // null if the vault changed (re-paste)
  return null
}

// The single-fire failure surface: ONE toast per workspace per latch — the
// latch re-arms when consent, target, or key changes (a fixed config that
// still fails deserves to fail loudly again). Detail is local color (ADR
// 0005): an endpoint host or an HTTP status, never memory text, never a key.
const semFailureFired = new Set<string>()
let semToastCount = 0

function fireSemFailure(workspaceId: string, detail: string): void {
  if (semFailureFired.has(workspaceId)) return
  semFailureFired.add(workspaceId)
  semToastCount += 1
  try {
    boundWin?.()?.webContents.send(BrainChannels.semFailure, { workspaceId, detail: detail.slice(0, 300) })
  } catch {
    /* window gone */
  }
}

/**
 * `brain.memSearch` over the agent wire, mode-aware (ADR 0018 revision A) —
 * async because semantic/hybrid embed the query per call. The lens law is the
 * whole structure here: `exact` (or no mode) short-circuits into 09's sync
 * dispatch BYTE-IDENTICALLY — consent, config, and the embedder are never even
 * read; semantic/hybrid answer only for a consenting workspace with its own
 * endpoint, and every fuzzy hit comes back labeled probabilistic with the
 * provider and model that produced it.
 */
export async function handleBrainMemSearchMcp(
  args: Record<string, unknown>,
  boundPane: string | undefined
): Promise<BrainServeReply> {
  const callerRoot = boundPane ? brainRootForPane(boundPane) : null
  const mode = args.mode
  if (mode !== undefined && mode !== 'exact' && mode !== 'semantic' && mode !== 'hybrid') {
    return { ok: false, reason: 'invalid', detail: 'mode must be "exact", "semantic", or "hybrid"' }
  }
  if (mode === undefined || mode === 'exact') {
    return serveBrainRead(ensureService(), 'brain.memSearch', args, callerRoot)
  }
  const wsId = boundPane ? workspaceIdForPane(boundPane) : undefined
  if (!wsId) {
    return {
      ok: false,
      reason: 'consent',
      detail:
        'semantic recall needs a pane session in a workspace — and that workspace\'s permission (Settings › Privacy). Exact search stays free: retry with mode "exact".'
    }
  }
  if (!semanticAllowed(wsId)) {
    return {
      ok: false,
      reason: 'consent',
      detail:
        'this workspace has not allowed semantic memory recall (default off) — the human enables it in Settings › Privacy. Exact search still answers: retry with mode "exact".'
    }
  }
  const cfg = embedTargetOf(wsId)
  if (!cfg.endpoint || !cfg.model || !isEmbedEndpoint(cfg.endpoint)) {
    return {
      ok: false,
      reason: 'invalid',
      detail:
        'the semantic lens has no embedding endpoint/model configured for this workspace — the human sets both in Settings › Privacy. Exact search still answers: retry with mode "exact".'
    }
  }
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query) return { ok: false, reason: 'invalid', detail: 'query is required' }
  // Revision B: a junk filter refuses BEFORE the query embeds — no request
  // leaves the machine for a call that could never answer.
  if (args.filter !== undefined) {
    const f =
      typeof args.filter === 'string' && args.filter
        ? parseMemoryFilter(args.filter)
        : { error: 'filter must be a non-empty string — clauses are #tag, key, or key=value (comma-joined AND, max 8)' }
    if ('error' in f) return { ok: false, reason: 'invalid', detail: f.error }
  }
  // The query embeds per call, capped — one bounded request to the USER'S OWN
  // endpoint and nowhere else (the BYO guardrail is the absence of any other
  // URL in this file).
  const embedded = await embedTexts(
    { endpoint: cfg.endpoint, model: cfg.model, key: resolveEmbedKey(wsId) },
    [query.slice(0, EMBED_QUERY_MAX_CHARS)]
  )
  if (!embedded.ok) {
    return { ok: false, reason: 'embed-failed', detail: embedded.detail }
  }
  const lens: MemorySemanticLens = {
    mode,
    queryVec: embedded.vectors[0],
    provider: embedProviderLabel(cfg.endpoint),
    model: cfg.model
  }
  return serveMemorySearchSemantic(ensureService(), args, callerRoot, lens)
}

/**
 * `brain.libdocs` over the agent wire (08) — async because of its ONE optional
 * network path. The cache read itself is the serve layer's; this handler only
 * fronts it with the fetch: consent first (per workspace, fail-closed, checked
 * BEFORE any socket exists), then the registry-pinned bounded fetch, then the
 * landing — and the final answer always comes from the cache it landed in.
 */
export async function handleBrainLibDocsMcp(
  args: Record<string, unknown>,
  boundPane: string | undefined
): Promise<BrainServeReply> {
  const callerRoot = boundPane ? brainRootForPane(boundPane) : null
  if (args.fetch === true) {
    const wsId = boundPane ? workspaceIdForPane(boundPane) : undefined
    if (!wsId) {
      return {
        ok: false,
        reason: 'consent',
        detail: 'registry doc fetches need a pane session in a workspace — and that workspace\'s permission (Settings › Privacy)'
      }
    }
    if (!libFetchAllowed(wsId)) {
      return {
        ok: false,
        reason: 'consent',
        detail: 'this workspace has not allowed library-doc fetches from package registries (default off) — the human enables it in Settings › Privacy'
      }
    }
    const service = ensureService()
    const name = typeof args.name === 'string' ? args.name : ''
    const h = callerRoot ? service.readHandle(callerRoot) : null
    if (h && !('reason' in h) && name) {
      const caller = partitionOf([...h.project.roots], callerRoot as string) ?? h.project.projectKey
      const eco = typeof args.ecosystem === 'string' ? args.ecosystem : undefined
      const dep = h.store.libDep(caller, name, eco)
      // Unknown names fall through to the serve layer's typed refusal — no
      // socket is ever opened for a name no lockfile knows.
      if (dep) {
        if (!dep.pinned) {
          return {
            ok: false,
            reason: 'invalid',
            detail: 'nothing pins this dependency to an exact version — a range cannot be fetched without guessing. Pin it first.'
          }
        }
        const cached = h.store.libDoc(dep.ecosystem, dep.name, dep.version)
        if (!cached) {
          const fetched = await fetchLibraryDocs(dep.ecosystem as BrainLibEcosystem, dep.name, dep.version)
          if (!fetched.ok) return { ok: false, reason: fetched.reason, detail: fetched.detail }
          service.landLibraryDoc(caller, {
            ecosystem: dep.ecosystem,
            name: dep.name,
            version: dep.version,
            source: 'registry',
            readme: fetched.readme,
            signatures: JSON.stringify({ exports: [], sigs: [], readmeTruncated: fetched.readmeTruncated })
          })
        }
      }
    }
  }
  return serveBrainRead(ensureService(), 'brain.libdocs', args, callerRoot)
}

/**
 * The Brain VIEW's read door (10): the serve layer's dispatch, verbatim — same
 * caps, same `{ generation, dirty, root }` envelopes, same typed refusals the
 * agent wire gets. The window is the human's own reader (ADR 0008: reads are
 * free), and it still goes through the ONE validation seam rather than growing
 * a second, softer one. Writes have no channel here at all — serveBrainRead
 * dispatches nothing that mutates. Exported for the BRAINUX smoke.
 */
export function handleBrainUiRead(req: unknown): BrainServeReply {
  const r = (req ?? {}) as { root?: unknown; verb?: unknown; args?: unknown }
  if (typeof r.root !== 'string' || !r.root || typeof r.verb !== 'string' || !r.verb) {
    return { ok: false, reason: 'invalid' }
  }
  const args =
    r.args && typeof r.args === 'object' && !Array.isArray(r.args) ? (r.args as Record<string, unknown>) : {}
  return serveBrainRead(ensureService(), r.verb, args, r.root)
}

/**
 * The status card's extras (10): numbers the store already holds that
 * BrainStatus does not carry — distinct written memory slugs, dangling wikilink
 * targets (wanted knowledge), and the caller partition's per-ecosystem lockfile
 * truth. Derived HERE from the same handle every read uses; no new serve verb
 * (the MCP verb sets stay closed). Exported for the BRAINUX smoke.
 */
export function handleBrainOverview(req: unknown): BrainOverviewAnswer {
  const root = (req as { root?: unknown } | null | undefined)?.root
  if (typeof root !== 'string' || !root) return { ok: false, reason: 'invalid' }
  const h = ensureService().readHandle(root)
  if ('reason' in h) return { ok: false, reason: h.reason, ...(h.detail ? { detail: h.detail } : {}) }
  const roots = [...h.project.roots]
  const written = new Set(h.store.memoriesForRoots(roots).map((m) => m.slug))
  const dangling = new Set(
    h.store
      .memoryLinks(roots)
      .map((l) => l.dst)
      .filter((dst) => !written.has(dst))
  )
  const caller = partitionOf(roots, root) ?? h.project.projectKey
  const perEco = new Map<string, number>()
  for (const dep of h.store.libRows(caller)) perEco.set(dep.ecosystem, (perEco.get(dep.ecosystem) ?? 0) + 1)
  const ecosystems: BrainEcosystemCount[] = [...perEco.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([ecosystem, deps]) => ({ ecosystem: ecosystem as BrainLibEcosystem, deps }))
  // Revision B: what the `.memory/` scans refused to index, summed across the
  // project's roots — the "Memory files skipped" row's truth, never hidden.
  const memorySkips: BrainMemorySkips = { invalid: 0, tooLarge: 0, foreign: 0, capped: false }
  for (const r of roots) {
    const scan = h.store.memoryScan(r)
    if (!scan) continue
    memorySkips.invalid += scan.invalid
    memorySkips.tooLarge += scan.tooLarge
    memorySkips.foreign += scan.foreign
    memorySkips.capped = memorySkips.capped || scan.capped
  }
  return { ok: true, memories: written.size, danglingLinks: dangling.size, ecosystems, memorySkips }
}

/** The launch seam's map fetch (06), exported for the BRAINMAP smoke: the same
 *  serve verb the MCP tool answers with, keyed by the pane's actual cwd. */
export function handleBrainMap(req: unknown): BrainServeReply {
  const r = (req ?? {}) as { root?: unknown; budget?: unknown }
  if (typeof r.root !== 'string' || !r.root) return { ok: false, reason: 'invalid' }
  const args: Record<string, unknown> = {}
  if (r.budget !== undefined) args.budget = r.budget
  return serveBrainRead(ensureService(), 'brain.map', args, r.root)
}

/** Smoke-only introspection: the LRU's live handle count, a full close (the next
 *  call reopens lazily — dispose is a lifecycle law, not a shutdown-only path), the
 *  canonical dump (the BRAINGRAPH gate's determinism spine), and 04's freshness
 *  counters + drain-emission count (the BRAINFRESH gate's witnesses). */
export function brainDebug(): {
  openCount: () => number
  dispose: () => void
  dump: (root: string) => string | null
  freshness: (root: string) => BrainFreshnessStats | null
  drainEmits: () => number
  memoryRescans: () => number
  embedStats: () => { performed: number; skipped: number; failures: number; passes: number }
  semToasts: () => number
} {
  return {
    openCount: () => service?.openCount() ?? 0,
    dispose: () => disposeBrain(),
    dump: (root: string) => ensureService().dump(root),
    freshness: (root: string) => ensureService().freshnessStats(root),
    drainEmits: () => service?.drainEmits() ?? 0,
    memoryRescans: () => service?.memoryRescans() ?? 0,
    embedStats: () => service?.memoryEmbedStats() ?? { performed: 0, skipped: 0, failures: 0, passes: 0 },
    semToasts: () => semToastCount
  }
}

export function disposeBrain(): void {
  service?.dispose()
  service = null
}

export function registerBrain(getWin: () => BrowserWindow | null, tickSource?: BrainTickSource): void {
  boundWin = getWin
  boundTickSource = tickSource ?? null
  ipcMain.handle(BrainChannels.status, (_e, req: unknown) => handleBrainStatus(req))
  ipcMain.handle(BrainChannels.map, (_e, req: unknown) => handleBrainMap(req))
  ipcMain.handle(BrainChannels.read, (_e, req: unknown) => handleBrainUiRead(req))
  ipcMain.handle(BrainChannels.overview, (_e, req: unknown) => handleBrainOverview(req))
  ipcMain.handle(BrainChannels.orientGet, (_e, wsId: unknown) =>
    typeof wsId === 'string' && wsId ? orientAtLaunch(wsId) : true
  )
  ipcMain.handle(BrainChannels.orientSet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; on?: unknown }
    const ok = typeof r.workspaceId === 'string' && !!r.workspaceId && setOrientAtLaunch(r.workspaceId, r.on === true)
    return { ok }
  })
  ipcMain.handle(BrainChannels.libFetchGet, (_e, wsId: unknown) =>
    typeof wsId === 'string' && wsId ? libFetchAllowed(wsId) : false
  )
  ipcMain.handle(BrainChannels.libFetchSet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; on?: unknown }
    const ok = typeof r.workspaceId === 'string' && !!r.workspaceId && setLibFetchAllowed(r.workspaceId, r.on === true)
    return { ok }
  })
  // Revision A: the semantic lens's knobs — consent (the libFetch discipline),
  // the BYO target, and the ADR 0007.a key pointer (set/clear/presence; no
  // getter channel exists, which is the guarantee).
  ipcMain.handle(BrainChannels.semGet, (_e, wsId: unknown) =>
    typeof wsId === 'string' && wsId ? semanticAllowed(wsId) : false
  )
  ipcMain.handle(BrainChannels.semSet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; on?: unknown }
    const ok = typeof r.workspaceId === 'string' && !!r.workspaceId && setSemanticAllowed(r.workspaceId, r.on === true)
    return { ok }
  })
  ipcMain.handle(BrainChannels.semCfgGet, (_e, wsId: unknown): BrainSemConfig => {
    const id = typeof wsId === 'string' ? wsId : ''
    const target = id ? embedTargetOf(id) : { endpoint: '', model: '' }
    return { ...target, keySlot: id ? embedKeySlot(id) : { kind: 'none' } }
  })
  ipcMain.handle(BrainChannels.semCfgSet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; endpoint?: unknown; model?: unknown }
    if (typeof r.workspaceId !== 'string' || !r.workspaceId) return { ok: false, reason: 'no workspace' }
    return setEmbedTarget(r.workspaceId, typeof r.endpoint === 'string' ? r.endpoint : '', typeof r.model === 'string' ? r.model : '')
  })
  ipcMain.handle(BrainChannels.semKeySet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; plaintext?: unknown; envRef?: unknown }
    if (typeof r.workspaceId !== 'string' || !r.workspaceId) return { ok: false, reason: 'no workspace' }
    if (typeof r.envRef === 'string' && r.envRef) return embedKeySetEnvRef(r.workspaceId, r.envRef)
    return embedKeySetPlaintext(r.workspaceId, typeof r.plaintext === 'string' ? r.plaintext : '')
  })
  ipcMain.handle(BrainChannels.semKeyClear, (_e, wsId: unknown) => {
    if (typeof wsId !== 'string' || !wsId) return { ok: false }
    embedKeyClear(wsId)
    return { ok: true }
  })
  ipcMain.handle(BrainChannels.rebuild, async (_e, req: unknown) => {
    const answer = await handleBrainRebuild(req)
    if (answer.ok) {
      const event: BrainChangedEvent = {
        projectKey: answer.projectKey,
        generation: answer.generation,
        dirty: answer.dirty
      }
      try {
        getWin()?.webContents.send(BrainChannels.changed, event)
      } catch {
        /* window gone */
      }
    }
    return answer
  })
}

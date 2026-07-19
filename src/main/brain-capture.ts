import { ipcMain } from 'electron'
import {
  buildCardDraft,
  buildMergeDraft,
  buildSessionDraft,
  CAPTURE_MAX_FILES,
  CAPTURE_MAX_SYMBOLS,
  distillDraft,
  embedProviderLabel,
  globToLike,
  isEmbedEndpoint,
  isMemorySlug,
  partitionOf,
  type CaptureBlock,
  type CaptureDraft,
  type DraftDistillation
} from '@backend/features/brain'
import { foldProjectKey, projectKeyForCwd } from '@backend/features/workspace'
import {
  BrainChannels,
  UNFILED_PROJECT_KEY,
  type BoardCard,
  type BrainDistillConfig,
  type BrainDraftRow,
  type BrainDraftSource,
  type BrainDraftsAnswer
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { onCardLaneChange } from './board'
import { brainRootForPane, brainServiceForCapture, embedTargetOf, resolveEmbedKey } from './brain'
import { workspaceIdForPane } from './integrations'

// Dual memory, auto-captured (ADR 0018 revision C) — the app-wiring of
// brain/capture.ts. The triggers RIDE EXISTING EMITTERS, zero new watchers:
//   session  the renderer's block tracker already models a pane's OSC 133
//            command ladder; at session end (process exit / pane close) it
//            hands the ladder over ONE fire-and-forget channel, and main
//            builds a reasoning draft from those signals;
//   card     the board's lane-change listener registry (github-board's seam);
//            a card reaching Done becomes a knowledge draft;
//   merge    review.ts calls captureMerge after a merge LANDS — the branch,
//            the diff's files, and the symbols the graph knew in them.
// Every draft is STRUCTURED (lists from signals — capture.ts owns the shape),
// redacted before landing, quarantined under `.memory/drafts/`, and counted
// by retention. Draft text is USER CONTENT: it lands in the user's own repo
// and rides IPC to the user's own window — never telemetry (ADR 0005).
//
// The OPTIONAL distillation lens: consent `brain.captureDistill` (per
// workspace, default OFF — the libFetch discipline) + a chat MODEL, riding
// revision A's BYO endpoint and key. Output is ADDITIVE and labeled
// (distilled/provider/model in the head; the structured body stays below);
// a distill failure lands the structured draft unchanged, typed and quiet.

const DISTILL_KV = 'brain.captureDistill'
const DISTILL_MODEL_KV = 'brain.distillModel'
const DISTILL_MODEL_MAX = 200
/** Raw ladder cap at the door — capture.ts caps again to its own window. */
const CAPTURE_REQUEST_MAX_BLOCKS = 300

function kvMap(key: string): Record<string, unknown> {
  try {
    const raw = getSettingsStore()?.getSetting(key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* unreadable map reads as all-default (closed) */
  }
  return {}
}

function kvSet(key: string, map: Record<string, unknown>): boolean {
  const store = getSettingsStore()
  if (!store) return false
  try {
    store.setSetting(key, JSON.stringify(map))
    return true
  } catch {
    return false
  }
}

export function distillAllowed(workspaceId: string): boolean {
  return kvMap(DISTILL_KV)[workspaceId] === true
}

export function setDistillAllowed(workspaceId: string, on: boolean): boolean {
  if (!workspaceId) return false
  const map = kvMap(DISTILL_KV)
  map[workspaceId] = on
  return kvSet(DISTILL_KV, map)
}

export function distillModelOf(workspaceId: string): string {
  const v = kvMap(DISTILL_MODEL_KV)[workspaceId]
  return typeof v === 'string' ? v : ''
}

export function setDistillModel(workspaceId: string, model: string): boolean {
  if (!workspaceId) return false
  const map = kvMap(DISTILL_MODEL_KV)
  map[workspaceId] = model.trim().replace(/[\r\n]+/g, ' ').slice(0, DISTILL_MODEL_MAX)
  return kvSet(DISTILL_MODEL_KV, map)
}

/** The capture counters — the BRAINCAP smoke's witnesses (counts only). */
const stats = { session: 0, card: 0, merge: 0, landed: 0, distilled: 0 }
export function captureStatsForSmoke(): { session: number; card: number; merge: number; landed: number; distilled: number } {
  return { ...stats }
}

/** The workspace whose consent + config distills for this draft — null means
 *  structured-only (no consent, no endpoint, or no chat model: same result,
 *  zero provider calls). */
function distillTargetFor(workspaceId: string | null): { endpoint: string; model: string; key: string | null } | null {
  if (!workspaceId || !distillAllowed(workspaceId)) return null
  const cfg = embedTargetOf(workspaceId)
  const model = distillModelOf(workspaceId)
  if (!cfg.endpoint || !model || !isEmbedEndpoint(cfg.endpoint)) return null
  return { endpoint: cfg.endpoint, model, key: resolveEmbedKey(workspaceId) }
}

/** The FIRST consenting workspace standing in `root`'s project (the semantic
 *  lens's election rule: settings order, fixed) — the fallback when a trigger
 *  carries no workspace of its own (a card moved by a human, a merge). */
function consentingWorkspaceFor(root: string): string | null {
  try {
    const h = brainServiceForCapture().readHandle(root)
    const roots = 'reason' in h ? [root] : [...h.project.roots]
    for (const ws of (getSettingsStore()?.load().workspaces ?? []) as { id?: unknown; cwd?: unknown }[]) {
      const id = typeof ws?.id === 'string' ? ws.id : ''
      const cwd = typeof ws?.cwd === 'string' ? ws.cwd : ''
      if (id && cwd && partitionOf(roots, cwd) && distillAllowed(id)) return id
    }
  } catch {
    /* no settings store / no handle — structured-only */
  }
  return null
}

/** Distill (when the workspace said so) and land — the ONE landing path every
 *  trigger funnels through. Best-effort end to end: a refusal is a lost draft,
 *  never a blocked action. */
async function landDraft(root: string, workspaceId: string | null, draft: CaptureDraft): Promise<void> {
  let distilled: DraftDistillation | undefined
  const wsId = workspaceId && distillAllowed(workspaceId) ? workspaceId : consentingWorkspaceFor(root)
  const target = distillTargetFor(wsId)
  if (target) {
    const r = await distillDraft(target, { name: draft.slugBase, description: draft.description, body: draft.body })
    if (r.ok) {
      distilled = { prose: r.prose, provider: embedProviderLabel(target.endpoint), model: target.model }
      stats.distilled += 1
    }
    // A distill failure is typed and quiet: the structured draft still lands.
  }
  const landed = await brainServiceForCapture().landMemoryDraft(root, draft, distilled)
  if (landed.ok) stats.landed += 1
}

/** The session trigger's handler (exported for the BRAINCAP smoke): the
 *  renderer's ladder in, a reasoning draft (or an honest nothing) out. */
export async function handleCaptureSession(req: unknown): Promise<{ ok: boolean; landed: boolean }> {
  const r = (req ?? {}) as { pane?: unknown; blocks?: unknown }
  if (typeof r.pane !== 'string' || !r.pane || !Array.isArray(r.blocks)) return { ok: false, landed: false }
  const root = brainRootForPane(r.pane)
  if (!root) return { ok: false, landed: false }
  stats.session += 1
  const blocks: CaptureBlock[] = (r.blocks as unknown[]).slice(0, CAPTURE_REQUEST_MAX_BLOCKS).map((b) => {
    const row = (b ?? {}) as { command?: unknown; exitCode?: unknown; durationMs?: unknown }
    return {
      command: typeof row.command === 'string' ? row.command : '',
      ...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
      ...(typeof row.durationMs === 'number' ? { durationMs: row.durationMs } : {})
    }
  })
  const draft = buildSessionDraft(r.pane, blocks)
  if (!draft) return { ok: true, landed: false } // below signal — an ls is not a memory
  await landDraft(root, workspaceIdForPane(r.pane) ?? null, draft)
  return { ok: true, landed: true }
}

/** The card trigger: a card reaching Done becomes a knowledge draft in its
 *  board's project root. Rides board.ts's EXISTING lane-change registry. */
function onLaneChange(card: BoardCard, from: string): void {
  if (card.lane !== 'done' || from === 'done' || card.archivedAt) return
  const board = getSettingsStore()?.getBoard(card.boardId)
  if (!board || board.projectKey === UNFILED_PROJECT_KEY) return
  const draft = buildCardDraft({
    title: card.title,
    notes: card.notes,
    labels: card.labels,
    priority: card.priority,
    branch: card.branch ?? null
  })
  if (!draft) return
  stats.card += 1
  void landDraft(board.projectKey, card.workspaceId ?? null, draft).catch(() => undefined)
}

/**
 * The merge trigger — review.ts calls this AFTER a merge landed. Touched
 * symbols come via the graph (the store's own nodes for each changed file in
 * the repo's partition); the card is the one bound to the merged branch on
 * the repo's board, when one is. Fire-and-forget; a refusal loses a draft,
 * never a merge.
 */
export async function captureMerge(repo: string, branch: string, files: string[]): Promise<void> {
  try {
    const service = brainServiceForCapture()
    const h = service.readHandle(repo)
    const symbols: string[] = []
    if (!('reason' in h)) {
      const caller = partitionOf([...h.project.roots], repo) ?? h.project.projectKey
      for (const file of files.slice(0, CAPTURE_MAX_FILES)) {
        if (symbols.length >= CAPTURE_MAX_SYMBOLS) break
        const rel = file.replace(/\\/g, '/')
        for (const n of h.store.nodesPage([caller], { fileLike: globToLike(rel) }, 10, 0).rows) {
          symbols.push(`${n.name} (${n.kind}) — ${n.file}`)
          if (symbols.length >= CAPTURE_MAX_SYMBOLS) break
        }
      }
    }
    const store = getSettingsStore()
    const projectKey = projectKeyForCwd(repo)
    const board = store?.listBoards().find((b) => foldProjectKey(b.projectKey) === foldProjectKey(projectKey)) ?? null
    const cardTitle: string | null =
      (board ? store?.listCards(board.id).find((c) => c.branch === branch && !c.archivedAt)?.title : null) ?? null
    const draft = buildMergeDraft({ branch, files, symbols, cardTitle })
    if (!draft) return
    stats.merge += 1
    await landDraft(repo, null, draft) // consent elects from the project's workspaces
  } catch {
    /* capture is evidence, never enforcement — a merge must not feel this */
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const rowOf = (d: { root: string; slug: string; name: string; description: string; tags: string; source: string; distilled: number; mtime: number }): BrainDraftRow => ({
  slug: d.slug,
  name: d.name,
  description: d.description,
  tags: ((): string[] => {
    try {
      const v = JSON.parse(d.tags) as unknown
      return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
    } catch {
      return []
    }
  })(),
  source: (d.source === 'session' || d.source === 'merge' || d.source === 'card' ? d.source : '') as BrainDraftSource | '',
  distilled: !!d.distilled,
  mtime: d.mtime,
  root: d.root
})

/** `brain:drafts` — project-wide draft rows + the eviction count. Exported
 *  for the BRAINCAP smoke. */
export function handleBrainDrafts(req: unknown): BrainDraftsAnswer {
  const root = str((req as { root?: unknown } | null | undefined)?.root)
  if (!root) return { ok: false, reason: 'invalid' }
  const h = brainServiceForCapture().readHandle(root)
  if ('reason' in h) return { ok: false, reason: h.reason, ...(h.detail ? { detail: h.detail } : {}) }
  const roots = [...h.project.roots]
  return {
    ok: true,
    drafts: h.store.memoryDraftsForRoots(roots).map(rowOf),
    evicted: h.store.draftEvictionsForRoots(roots)
  }
}

export function registerBrainCapture(): void {
  onCardLaneChange(onLaneChange)

  ipcMain.handle(BrainChannels.captureSession, (_e, req: unknown) => handleCaptureSession(req))
  ipcMain.handle(BrainChannels.drafts, (_e, req: unknown) => handleBrainDrafts(req))
  ipcMain.handle(BrainChannels.draftGet, (_e, req: unknown) => {
    const r = (req ?? {}) as { root?: unknown; slug?: unknown }
    const root = str(r.root)
    const slug = str(r.slug)
    if (!root || !slug || !isMemorySlug(slug)) return { ok: false, reason: 'invalid' }
    const h = brainServiceForCapture().readHandle(root)
    if ('reason' in h) return { ok: false, reason: h.reason }
    const copies = h.store.memoryDraftCopies([...h.project.roots], slug)
    if (!copies.length) return { ok: false, reason: 'unknown-memory' }
    const freshest = [...copies].sort((a, b) => b.mtime - a.mtime)[0]
    return { ok: true, draft: { ...rowOf(freshest), body: freshest.body } }
  })
  const draftVerb = (kind: 'promote' | 'discard') => async (req: unknown) => {
    const r = (req ?? {}) as { root?: unknown; slug?: unknown }
    const root = str(r.root)
    const slug = str(r.slug)
    if (!root || !slug || !isMemorySlug(slug)) return { ok: false, reason: 'invalid' }
    // The human's own promote/discard — the SAME engine locks the granted
    // tools run behind (draftness, collision, atomic move); the grant wall is
    // for agents, and this window is the human.
    return brainServiceForCapture().landMemoryWrite(root, { kind, slug })
  }
  ipcMain.handle(BrainChannels.draftPromote, (_e, req: unknown) => draftVerb('promote')(req))
  ipcMain.handle(BrainChannels.draftDiscard, (_e, req: unknown) => draftVerb('discard')(req))
  ipcMain.handle(BrainChannels.distillGet, (_e, wsId: unknown): BrainDistillConfig => {
    const id = typeof wsId === 'string' ? wsId : ''
    return { on: id ? distillAllowed(id) : false, model: id ? distillModelOf(id) : '' }
  })
  ipcMain.handle(BrainChannels.distillSet, (_e, req: unknown) => {
    const r = (req ?? {}) as { workspaceId?: unknown; on?: unknown; model?: unknown }
    const id = str(r.workspaceId)
    if (!id) return { ok: false }
    let ok = true
    if (r.on !== undefined) ok = setDistillAllowed(id, r.on === true) && ok
    if (typeof r.model === 'string') ok = setDistillModel(id, r.model) && ok
    return { ok }
  })
}

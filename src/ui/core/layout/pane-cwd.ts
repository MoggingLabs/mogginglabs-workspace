import type { CwdEvent, PaneCwdLocality, PaneCwdSource, PaneId } from '@contracts'

/** The renderer's current projection of one pane's effective working directory. */
export interface PaneCwdProjection {
  readonly cwd: string
  readonly revision: number
  readonly source: PaneCwdSource
  readonly locality: PaneCwdLocality
}

interface StoredProjection {
  value: PaneCwdProjection
  /** Backend ordering is independent from renderer-authored spawn/launch seeds. */
  backend?: {
    revision: number
    generation: string
    source: PaneCwdSource
    retiredGenerations: Set<string>
  }
}

const MAX_RETIRED_GENERATIONS = 8

/**
 * Per-pane working-directory projection. Workspace and launch paths provide an immediate seed;
 * terminal events then replace it with the backend's source-aware truth. Backend revisions are
 * compared only with other backend revisions, so a renderer seed cannot accidentally make a
 * legitimate replay look stale. Pane disposal clears the ordering state before an id is reused.
 *
 * The string API remains for consumers that only need a path. Authority-sensitive consumers
 * (Git, workspace persistence, failover) use the structured projection API below.
 */
const projections = new Map<PaneId, StoredProjection>()
const pathSubscribers = new Set<(paneId: PaneId, cwd: string | null) => void>()
const projectionSubscribers = new Set<(paneId: PaneId, projection: PaneCwdProjection | null) => void>()

const sameProjection = (a: PaneCwdProjection | undefined, b: PaneCwdProjection): boolean =>
  !!a && a.cwd === b.cwd && a.source === b.source && a.locality === b.locality

function publish(paneId: PaneId, previous: PaneCwdProjection | undefined, next: PaneCwdProjection): void {
  for (const cb of projectionSubscribers) cb(paneId, next)
  if (previous?.cwd !== next.cwd) for (const cb of pathSubscribers) cb(paneId, next.cwd)
}

/** Project a renderer-known spawn/launch cwd immediately. Backend ordering is preserved. */
export function setPaneCwd(
  paneId: PaneId,
  cwd: string,
  opts: { source?: PaneCwdSource; locality?: PaneCwdLocality } = {}
): boolean {
  if (!cwd) return false
  const stored = projections.get(paneId)
  // A managed launch may optimistically replace a lower shell/spawn lane, but an active
  // agent/process lane is backend authority until the detector or a prompt releases it.
  if (stored?.backend?.source === 'agent' || stored?.backend?.source === 'process') return false
  const next: PaneCwdProjection = {
    cwd,
    revision: stored?.value.revision ?? 0,
    source: opts.source ?? 'spawn',
    locality: opts.locality ?? 'local'
  }
  if (sameProjection(stored?.value, next)) return false
  projections.set(paneId, { value: next, backend: stored?.backend })
  publish(paneId, stored?.value, next)
  return true
}

/** Apply backend truth. A late event from the same pane generation cannot roll it back. */
export function applyPaneCwdEvent(raw: CwdEvent): boolean {
  const event = raw
  if (
    !event.cwd ||
    !event.generation ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 0
  ) {
    return false
  }
  const stored = projections.get(event.id)
  const prior = stored?.backend
  if (prior?.generation === event.generation && event.revision <= prior.revision) return false
  if (prior?.retiredGenerations.has(event.generation)) return false

  const retiredGenerations = new Set(prior?.retiredGenerations)
  if (prior && prior.generation !== event.generation) retiredGenerations.add(prior.generation)
  while (retiredGenerations.size > MAX_RETIRED_GENERATIONS) {
    const oldest = retiredGenerations.values().next().value
    if (oldest === undefined) break
    retiredGenerations.delete(oldest)
  }

  const next: PaneCwdProjection = {
    cwd: event.cwd,
    revision: event.revision,
    source: event.source,
    locality: event.locality
  }
  projections.set(event.id, {
    value: next,
    backend: {
      revision: event.revision,
      generation: event.generation,
      source: event.source,
      retiredGenerations
    }
  })
  if (!sameProjection(stored?.value, next)) publish(event.id, stored?.value, next)
  return true
}

export function clearPaneCwd(paneId: PaneId): void {
  if (!projections.delete(paneId)) return
  for (const cb of projectionSubscribers) cb(paneId, null)
  for (const cb of pathSubscribers) cb(paneId, null)
}

export function getPaneCwd(paneId: PaneId): string | undefined {
  return projections.get(paneId)?.value.cwd
}

export function getPaneCwdProjection(paneId: PaneId): PaneCwdProjection | undefined {
  return projections.get(paneId)?.value
}

/** Subscribe to path-only changes. Current values are replayed immediately. */
export function onPaneCwd(cb: (paneId: PaneId, cwd: string | null) => void): () => void {
  pathSubscribers.add(cb)
  for (const [id, state] of projections) cb(id, state.value.cwd)
  return () => pathSubscribers.delete(cb)
}

/** Subscribe to source/locality-aware changes. Current values are replayed immediately. */
export function onPaneCwdProjection(
  cb: (paneId: PaneId, projection: PaneCwdProjection | null) => void
): () => void {
  projectionSubscribers.add(cb)
  for (const [id, state] of projections) cb(id, state.value)
  return () => projectionSubscribers.delete(cb)
}

import {
  BrainChannels,
  type BrainAnswer,
  type BrainChangedEvent,
  type BrainOverviewAnswer
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Typed wrappers over the brain channels (ADR 0018/10) — the ONE place this
 * feature touches raw channel strings, per the bridge's own rule. Every read
 * goes through `brain:read`, which is the serve layer's dispatch verbatim:
 * the same caps, envelopes, and typed refusals the agent wire gets.
 */

/** A serve-layer reply: `ok` plus whatever the verb answers. Callers narrow. */
export type BrainReadReply = { ok: boolean; reason?: string; detail?: string; generation?: number; dirty?: boolean; truncated?: boolean } & Record<
  string,
  unknown
>

export interface BrainNodeOut {
  id: string
  kind: string
  name: string
  file: string
  startLine: number
  endLine: number
  sig: string
  root?: string
}

export interface BrainNeighborOut {
  node: BrainNodeOut
  edge: { kind: string; direction: 'in' | 'out' }
}

export interface BrainMemoryHit {
  slug: string
  name: string
  description: string
  tags: string[]
  root: string
}

export interface BrainMemoryOut {
  slug: string
  name: string
  description: string
  tags: string[]
  body: string
  root: string
  fileHash: string
  mtime: number
}

export interface BrainMemoryLinkOut {
  slug: string
  dangling: boolean
}

export interface BrainBacklinkOut {
  slug: string
  root: string
}

export const brainStatus = (root: string): Promise<BrainAnswer> =>
  getBridge().invoke(BrainChannels.status, { root }) as Promise<BrainAnswer>

export const brainRebuild = (root: string): Promise<BrainAnswer> =>
  getBridge().invoke(BrainChannels.rebuild, { root }) as Promise<BrainAnswer>

export const brainOverview = (root: string): Promise<BrainOverviewAnswer> =>
  getBridge().invoke(BrainChannels.overview, { root }) as Promise<BrainOverviewAnswer>

export const brainRead = (root: string, verb: string, args: Record<string, unknown> = {}): Promise<BrainReadReply> =>
  getBridge().invoke(BrainChannels.read, { root, verb, args }) as Promise<BrainReadReply>

export const orientGet = (workspaceId: string): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.orientGet, workspaceId)
    .then((v) => v === true)

export const orientSet = (workspaceId: string, on: boolean): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.orientSet, { workspaceId, on })
    .then((v) => (v as { ok?: boolean } | undefined)?.ok === true)

export const libFetchGet = (workspaceId: string): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.libFetchGet, workspaceId)
    .then((v) => v === true)

export const libFetchSet = (workspaceId: string, on: boolean): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.libFetchSet, { workspaceId, on })
    .then((v) => (v as { ok?: boolean } | undefined)?.ok === true)

/** Subscribe to `brain:changed` pushes. App-lifetime — the unsubscriber may be dropped. */
export const onBrainChanged = (cb: (event: BrainChangedEvent) => void): (() => void) =>
  getBridge().on(BrainChannels.changed, (payload) => cb(payload as BrainChangedEvent))

import {
  BrainChannels,
  type BrainAnswer,
  type BrainChangedEvent,
  type BrainOverviewAnswer,
  type BrainSemConfig
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

// ── The semantic lens (ADR 0018 revision A): consent, target, key pointer ────
// The key is WRITE-ONLY end to end (ADR 0007.a): set / clear / presence — no
// wrapper here can read a key back, because no channel answering one exists.

export const semGet = (workspaceId: string): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.semGet, workspaceId)
    .then((v) => v === true)

export const semSet = (workspaceId: string, on: boolean): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.semSet, { workspaceId, on })
    .then((v) => (v as { ok?: boolean } | undefined)?.ok === true)

export const semCfgGet = (workspaceId: string): Promise<BrainSemConfig> =>
  getBridge().invoke(BrainChannels.semCfgGet, workspaceId) as Promise<BrainSemConfig>

export const semCfgSet = (workspaceId: string, endpoint: string, model: string): Promise<{ ok: boolean; reason?: string }> =>
  getBridge().invoke(BrainChannels.semCfgSet, { workspaceId, endpoint, model }) as Promise<{ ok: boolean; reason?: string }>

export const semKeySet = (workspaceId: string, key: { plaintext?: string; envRef?: string }): Promise<{ ok: boolean; reason?: string }> =>
  getBridge().invoke(BrainChannels.semKeySet, { workspaceId, ...key }) as Promise<{ ok: boolean; reason?: string }>

export const semKeyClear = (workspaceId: string): Promise<boolean> =>
  getBridge()
    .invoke(BrainChannels.semKeyClear, workspaceId)
    .then((v) => (v as { ok?: boolean } | undefined)?.ok === true)

/** Subscribe to `brain:semFailure` pushes (the embed pass's single-fire toast). */
export const onSemFailure = (cb: (event: { workspaceId: string; detail: string }) => void): (() => void) =>
  getBridge().on(BrainChannels.semFailure, (payload) => cb(payload as { workspaceId: string; detail: string }))

/** Subscribe to `brain:changed` pushes. App-lifetime — the unsubscriber may be dropped. */
export const onBrainChanged = (cb: (event: BrainChangedEvent) => void): (() => void) =>
  getBridge().on(BrainChannels.changed, (payload) => cb(payload as BrainChangedEvent))

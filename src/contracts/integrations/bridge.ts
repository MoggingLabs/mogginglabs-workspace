// The outbound event bridge (Phase-8/01 shapes; 10 implements delivery,
// ADR 0008.g). POST only — nothing listens, ever. Webhook URLs are SECRETS
// (Slack/Make embed tokens in the path): stored as pointers, shown masked.
// The payload is versioned and documented verbatim in docs/14 — ids and the
// user's own short note text, never scrollback/diffs/page content/origins.

import type { KeySlot } from '../usage'

/** The v1 event vocabulary (closed): `needs-you` (a pane wants the human) ·
 *  `notify` (the CLI verb — the site's exact promise) · `card-moved` ·
 *  `review-changed` (12 emits on a linked card's review transition). */
export const BRIDGE_EVENTS = ['needs-you', 'notify', 'card-moved', 'review-changed'] as const
export type BridgeEventName = (typeof BRIDGE_EVENTS)[number]

export const BRIDGE_PAYLOAD_VERSION = 1

/** THE documented wire payload, verbatim: ids + the note text the user's own
 *  notify carried. Growing it means bumping `v` and the docs together. */
export interface BridgeEvent {
  v: typeof BRIDGE_PAYLOAD_VERSION
  event: BridgeEventName
  /** Epoch ms. */
  ts: number
  /** Workspace id — an id, never a path or repo name. */
  workspace: string
  pane?: string
  card?: string
  /** The short label the caller's own `mogging notify --message` carried. */
  note?: string
}

/** One user-configured webhook. `urlRef` is a POINTER (0007.a grammar): the
 *  URL literal rests as OS-vault ciphertext or rides an env-ref — never the
 *  KV, never a log, never the trail (the trail records `label`). */
export interface IntegrationWebhook {
  id: string
  /** Human name — also the ref the trail records for deliveries. */
  label: string
  urlRef: KeySlot
  /** Which events this webhook receives. */
  events: readonly BridgeEventName[]
  /** Scope to one workspace; absent = all workspaces. */
  workspaceId?: string
}

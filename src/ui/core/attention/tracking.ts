import type { PaneAgentSession } from '../agents/agent-session-port'
import { onPaneAgentSession } from '../agents/agent-session-port'
import { setPaneTracked } from './attention-port'

/**
 * The ONE writer of the attention port's tracked gate (ALERTAGREE, 2026-07-18): a pane is
 * tracked exactly while its agent-session port entry names a provider the app wired end-to-end.
 * This predicate used to live inline in TerminalPane's dot-visibility handler, which meant the
 * dot obeyed it while the toast layer (reading the raw relay) did not — the surfaces disagreed
 * about the same pane. Session → tracked is now declared once, here; TerminalPane imports the
 * same predicate for the dot so availability and the gate cannot drift apart.
 */

/** A session the app can speak for: launched by any app path, or typed and adopted by
 *  detection. `custom:<cmd>` panes stay untracked — a dot (or a toast) that cannot know
 *  would sit on a yellow lie. */
export function isTrackedSession(session: PaneAgentSession | null | undefined): boolean {
  return !!session && !session.provider.startsWith('custom:')
}

let wired = false

/** Wire the agent-session port into the attention port's tracked gate. Called once at UI boot
 *  (ui/index.ts) — before features mount, so the session replay a mounting feature triggers
 *  can never race an unwired gate. Idempotent. */
export function wireAttentionTracking(): void {
  if (wired) return
  wired = true
  onPaneAgentSession((paneId, session) => setPaneTracked(paneId, isTrackedSession(session)))
}

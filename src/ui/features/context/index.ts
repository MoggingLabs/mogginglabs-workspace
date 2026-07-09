import type { UiFeature } from '../../core/registry/feature-registry'
import { isContextProvider, type PaneId } from '@contracts'
import { onPaneAgentSession } from '../../core/agents/agent-session-port'
import { onPaneCwd } from '../../core/layout/pane-cwd'
import { getPaneRemote } from '../../core/layout/pane-meta'
import { clearPaneContext, getPaneContext, setPaneContext } from '../../core/terminal/context-port'
import { contextClient } from './context.client'

/**
 * Per-pane agent context bar (the plumbing half; TerminalPane renders). Wholly
 * decoupled + DOM-free, the git feature's twin: it reads each pane's agent session
 * from the agent-session port (written by `agents` on every launch path), asks the
 * backend to tail that session's log, and republishes usage on the context port —
 * where each `TerminalPane` picks it up. It imports no other feature.
 *
 * The watch is keyed on the LAUNCH cwd (the session log is named for where the CLI
 * started), so it deliberately does NOT retarget on live OSC-7 cwd changes — the
 * agent doesn't move; the shell around it does. The cwd port is used only for its
 * `null` (pane disposed) signal, the same teardown hook the git feature uses.
 *
 * LIFECYCLE — the bar exists only while its agent does: it appears when the agent's
 * session produces a reading, and every teardown path clears it — a new launch in
 * the pane resets it, the PTY exiting or the pane closing clears the session
 * (TerminalPane), and the agent quitting back to a shell prompt clears it where
 * shell integration marks that (OSC 133, also TerminalPane).
 */

/** Providers whose CLI paints its OWN context gauge in the terminal — codex and
 *  gemini both render "% context left" in their footers (dev-verified: the string
 *  ships in codex.exe, and gemini's footer shows it live). A header bar beside a
 *  footer gauge states the same number twice, so those panes get none. Claude Code
 *  shows nothing until context runs LOW — it gets ours. */
const NATIVE_GAUGE = new Set(['codex', 'gemini'])

export const contextFeature: UiFeature = {
  name: 'context',
  mount() {
    /** Panes with a live log watch — the set that renders a gauge (real or pending). */
    const watched = new Set<PaneId>()

    // Backend usage updates (session-log tails) -> context port -> pane bars. A null
    // from the backend (locked log deleted) on a still-watched pane re-pends the
    // gauge rather than hiding it — the agent is alive, only its number is gone.
    contextClient.onChange((e) => setPaneContext(e.paneId, e.usage ?? (watched.has(e.paneId) ? 'pending' : null)))

    const drop = (paneId: PaneId): void => {
      watched.delete(paneId)
      contextClient.unwatch(paneId)
      clearPaneContext(paneId)
    }

    // Agent launches -> start (or retarget) the pane's log watch; agent/session
    // teardown (null) -> drop it. Any previous launch's bar is stale the moment a
    // new agent owns the pane, so every branch starts from a cleared state.
    onPaneAgentSession((paneId, session) => {
      if (!session) return drop(paneId)
      // Remote panes: the session log lives on the far machine — no bar (the same
      // "local repo tools are off" stance as the worktree menu).
      if (getPaneRemote(paneId)) return drop(paneId)
      // The CLI already shows its own gauge, or there is no readable source at all
      // (custom commands): no bar either way.
      if (NATIVE_GAUGE.has(session.provider) || !isContextProvider(session.provider)) return drop(paneId)
      watched.add(paneId)
      // The gauge exists from the moment the agent does: pending ("–", empty disc)
      // until the session's FIRST response writes a usage line — never a made-up 0%.
      setPaneContext(paneId, 'pending')
      contextClient.watch({
        paneId,
        provider: session.provider,
        cwd: session.cwd,
        profileId: session.profileId,
        adopted: session.adopted
      })
    })

    // Pane disposed (cwd cleared) -> stop the tail, drop the bar.
    onPaneCwd((paneId, cwd) => {
      if (cwd === null) drop(paneId)
    })

    exposeForDev()
  }
}

/** Dev-only handles for smokes/tooling. Tree-shaken in production. */
function exposeForDev(): void {
  if (!import.meta.env.DEV) return
  const w = window as unknown as { __mogging?: Record<string, unknown> }
  w.__mogging = w.__mogging ?? {}
  w.__mogging.context = {
    usage: (paneId: number) => getPaneContext(paneId),
    set: (paneId: number, usedPct: number) =>
      setPaneContext(paneId, {
        provider: 'claude',
        usedTokens: usedPct * 2000,
        windowTokens: 200_000,
        usedPct,
        model: 'claude-opus-4-8',
        at: Date.now()
      })
  }
}

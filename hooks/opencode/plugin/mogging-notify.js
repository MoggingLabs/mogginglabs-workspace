// MoggingLabs Workspace notify plugin for OpenCode.
//
// Drop this file in ~/.config/opencode/plugin/ (it is auto-loaded from there), or reference it
// from your opencode.json:  { "plugin": ["file:///absolute/path/to/mogging-notify.js"] }
// A BARE PATH will not work — OpenCode treats it as an npm package and hangs fetching it.
//
// Also turn the attention chime on, in ~/.config/opencode/tui.json:
//     { "attention": { "enabled": true, "notifications": true } }
//
// WHY BOTH. OpenCode's attention chime rings for its whole event vocabulary —
// question / permission / error / done / subagent_done — so on its own it cannot say WHICH,
// and read as "needs you" it paints every COMPLETED pane red. This plugin supplies the
// verdicts that let the app read the chime against something:
//
//   the ROOT session goes idle   -> `done`           -> the chime is a completion  -> GREEN
//   a CHILD session goes idle    -> `subagent-stop`  -> authors no state; it exists only to
//                                                       cancel the `subagent_done` chime, which
//                                                       would otherwise ring RED for a subagent
//   permission.asked / .replied  -> `needs-input` / `busy` — the EXPLICIT block channel, a named
//                                   red the instant the dialog opens (sharper than the chime)
//   session.error                -> `turn-failed` — the turn died; without it the pane would
//                                   wear "busy" forever (no done and no idle will ever arrive)
//   tool.execute.after           -> `busy`, throttled — proof-of-work that re-lights a
//                                   continued turn without a process spawn per tool
//
// Root vs child is `parentID` — OpenCode's own idiom. Subagents must stay invisible: a pane's
// colour is the MAIN agent's story.
//
// Event labels only — no prompt text, no credentials (ADR 0002). Never throws (an exception here
// would surface inside your agent); outside a MoggingLabs pane it silently no-ops.
import { spawn } from 'node:child_process'

const fire = (event) => {
  if (!process.env.MOGGING_PANE_ID || !process.env.MOGGING_DAEMON_ENDPOINT) return
  try {
    // `mogging` must be on PATH (same requirement as the other snippets).
    const p = spawn('mogging', ['notify', '--event', event], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: true
    })
    p.on('error', () => {})
    p.unref?.()
  } catch {}
}

// One busy re-assert per window: the dot only needs re-lighting, not a spawn per tool.
const BUSY_THROTTLE_MS = 15000

export const MoggingNotify = async ({ client }) => {
  let lastBusyAt = 0
  return {
    event: async ({ event }) => {
      try {
        const type = event?.type
        if (type === 'session.idle') {
          const id = event.properties?.sessionID ?? event.properties?.sessionId
          let isChild = false
          try {
            const sessions = (await client.session.list())?.data ?? []
            isChild = !!sessions.find((s) => s.id === id)?.parentID
          } catch {}
          fire(isChild ? 'subagent-stop' : 'done')
        } else if (type === 'session.error') {
          lastBusyAt = 0 // a recovering turn's next tool must re-light busy instantly
          fire('turn-failed')
        } else if (type === 'permission.asked') {
          fire('needs-input')
        } else if (type === 'permission.replied') {
          fire('busy')
        }
      } catch {}
    },
    'tool.execute.after': async () => {
      try {
        const now = Date.now()
        if (now - lastBusyAt < BUSY_THROTTLE_MS) return
        lastBusyAt = now
        fire('busy')
      } catch {}
    }
  }
}

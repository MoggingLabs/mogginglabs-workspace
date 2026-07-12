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
//   a question / permission      -> chime alone, uncontradicted                    -> RED
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

export const MoggingNotify = async ({ client }) => ({
  event: async ({ event }) => {
    try {
      if (event?.type !== 'session.idle') return
      const id = event.properties?.sessionID ?? event.properties?.sessionId
      let isChild = false
      try {
        const sessions = (await client.session.list())?.data ?? []
        isChild = !!sessions.find((s) => s.id === id)?.parentID
      } catch {}
      fire(isChild ? 'subagent-stop' : 'done')
    } catch {}
  }
})

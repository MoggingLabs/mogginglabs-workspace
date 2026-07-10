import { app, ipcMain, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContextMonitor, RELAY_SOURCE } from '@backend/features/context'
import { claudeNotifyHooks } from '@backend/features/agents'
import { resolveHome } from '@backend/features/usage'
import {
  ContextChannels,
  isContextProvider,
  type ContextUnwatchRequest,
  type ContextWatchRequest
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { notifyHookInvocation } from './notify-hook'

// App-wiring: expose the per-pane context-usage monitor to the renderer. The monitor
// lives in @backend (Electron-free, tails the CLIs' own session logs read-only); this
// file binds it to IPC and resolves the ONE thing the renderer must not: the
// provider's config home. A launch profile can relocate it (CLAUDE_CONFIG_DIR et al.),
// so the watch carries the profile ID and the home is resolved HERE from the settings
// store — env values never transit the wire (ADR 0002). Carries a provider id + cwd
// (in) and token counts (out) — never prompt text, file content, or credentials.
//
// THE STATUSLINE RELAY (the "always the /context number" channel). Claude Code feeds
// a user-configurable statusline command a JSON payload on every update, and that
// payload carries `context_window.used_percentage` — the SAME pre-calculated value
// /context prints — plus `context_window_size`, the true window no transcript ever
// states. So claude launches get `--settings <generated file>` whose statusLine is a
// tiny relay script: it drops those numbers into a per-pane sink file the monitor
// polls (rendezvous: tmpdir + username + MOGGING_PANE_ID, which the daemon injects
// into every pane's env), then EXECS the user's own statusline command with the same
// stdin so their configured line still renders. Both files are GENERATED here into
// userData on demand — nothing to package, dev and installed builds identical. The
// relay needs `node` on PATH; without it claude just renders no statusline and the
// monitor's transcript tail keeps the bar honest (its numbers use the same formula).

let statuslineSettingsFile: string | null = null

/** Write (idempotently) the relay script + the settings file that points claude at
 *  it, and return the `--settings` args a claude launch should carry. Since the
 *  bell work, the same generated file also carries the notify HOOKS (Notification/
 *  Stop -> the generated notify script) and forces `preferredNotifChannel:
 *  terminal_bell` — so an app-launched claude always rings its pane, with the raw
 *  BEL as the fallback when `node` is missing and the hook can't run. The overlay
 *  MERGES with the user's own settings and never touches their files. Empty on any
 *  filesystem failure — the launch must never break over a nicety. */
export function claudeStatuslineArgs(): string[] {
  try {
    if (!statuslineSettingsFile) {
      const dir = join(app.getPath('userData'), 'context-relay')
      mkdirSync(dir, { recursive: true })
      const relay = join(dir, 'context-relay.mjs')
      writeFileSync(relay, RELAY_SOURCE)
      const settings = join(dir, 'claude-launch.settings.json')
      const overlay: Record<string, unknown> = {
        statusLine: { type: 'command', command: `node "${relay}"`, padding: 0 }
      }
      const notify = notifyHookInvocation()
      if (notify) {
        overlay.hooks = claudeNotifyHooks(notify)
        overlay.preferredNotifChannel = 'terminal_bell'
      }
      writeFileSync(settings, JSON.stringify(overlay))
      statuslineSettingsFile = settings
    }
    return ['--settings', statuslineSettingsFile]
  } catch {
    return []
  }
}

export function registerContext(getWebContents: () => WebContents | null): () => void {
  const monitor = new ContextMonitor({
    change: (paneId, usage) => getWebContents()?.send(ContextChannels.change, { paneId, usage })
  })
  ipcMain.on(ContextChannels.watch, (_e, req: ContextWatchRequest) => {
    if (!req || typeof req.cwd !== 'string' || !req.cwd || !isContextProvider(req.provider)) return
    const profile = req.profileId
      ? ((getSettingsStore()?.listProfiles() ?? []).find((p) => p.id === req.profileId) ?? null)
      : null
    monitor.setPane(req.paneId as number, {
      provider: req.provider,
      cwd: req.cwd,
      home: resolveHome(req.provider, profile),
      adopted: req.adopted === true
    })
  })
  ipcMain.on(ContextChannels.unwatch, (_e, req: ContextUnwatchRequest) => {
    if (req && Number.isFinite(req.paneId as number)) monitor.remove(req.paneId as number)
  })
  return () => monitor.dispose()
}

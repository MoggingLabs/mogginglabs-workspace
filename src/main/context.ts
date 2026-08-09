import { app, ipcMain, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ContextMonitor, RELAY_SOURCE } from '@backend/features/context'
// Subpath, not the barrel — the barrel's install.ts re-export reaches node-pty, which
// POSIX loads at import; context.ts sits in app-settings' unit-tested graph.
import { claudeNotifyHooks } from '@backend/features/agents/notify-hook'
// Subpath for the same reason as notify-hook below: the usage barrel re-exports
// claude-adapter, whose claude-refresh pulls node-pty at module load.
import { resolveHome } from '@backend/features/usage/homes'
import {
  ContextChannels,
  isContextProvider,
  type ContextUnwatchRequest,
  type ContextWatchRequest
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { forgetAssignedSession, rememberAssignedSession, SESSION_ID_RE } from './assigned-sessions'
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

let statuslineRelayFile: string | null = null
/** The relay's bytes were CONTENT-verified this app run (see the launch path below). */
let relayVerified = false
/** userData/context-relay exists this run — one mkdir instead of one per launch. */
let relayDirReady = false
/** Settings digests this run has already written. With content-addressed names, a
 *  digest hit + the file on disk IS the invalidation proof: different content is a
 *  different name, so a hit can never serve stale bytes. */
const writtenSettingsDigests = new Set<string>()

/** The relay file's current bytes, or null when absent/unreadable (either answer
 *  means "write it"). */
function readRelay(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Write (idempotently) the relay script + the settings file that points claude at
 *  it, and return the `--settings` args a claude launch should carry. Since the
 *  bell work, the same generated file also carries the notify HOOKS (Notification/
 *  Stop -> the generated notify script) and forces `preferredNotifChannel:
 *  terminal_bell` — so an app-launched claude always rings its pane, with the raw
 *  BEL as the fallback when `node` is missing and the hook can't run. The overlay
 *  MERGES with the user's own settings and never touches their files. Empty on any
 *  filesystem failure — the launch must never break over a nicety. */
export function claudeStatuslineArgs(session: Record<string, unknown> = {}): string[] {
  try {
    const dir = join(app.getPath('userData'), 'context-relay')
    if (!relayDirReady) {
      mkdirSync(dir, { recursive: true })
      relayDirReady = true
    }
    // CONTENT-checked ONCE PER RUN, then existence-checked. Existence alone rotted
    // across releases: the sink dir's channel segment is BAKED into the generated
    // script (DAEMON_PROTOCOL_VERSION interpolation, relay.ts), so a relay written by a
    // previous protocol kept pushing every claude's numbers into the OLD channel's dir
    // while this app's monitor read the new one — the statusline push silently dead for
    // every pane, the gauge degraded to the 2.5s transcript-tail poll for good (and the
    // running sessions re-read this file per statusline fire, so rewriting heals them
    // live). The FIRST launch of each run still pays that full compare, which is what
    // heals the rot; the app cannot rewrite its own RELAY_SOURCE mid-run, so re-reading
    // it per launch could only ever confirm what the first read established. The
    // existence check still covers userData cleared mid-run, and a miss re-arms the
    // content verify so the next launch re-establishes the truth rather than assuming it.
    statuslineRelayFile ??= join(dir, 'context-relay.mjs')
    if (!relayVerified || !existsSync(statuslineRelayFile)) {
      if (readRelay(statuslineRelayFile) !== RELAY_SOURCE) writeFileSync(statuslineRelayFile, RELAY_SOURCE)
      relayVerified = true
    }
    // Catalog ownership makes these app-owned keys read-only. Internal values
    // still land last here as defense in depth against stale persisted intent.
    const overlay: Record<string, unknown> = {
      ...session,
      statusLine: { type: 'command', command: `node "${statuslineRelayFile}"`, padding: 0 }
    }
    const notify = notifyHookInvocation()
    if (notify) {
      overlay.hooks = claudeNotifyHooks(notify)
      overlay.preferredNotifChannel = 'terminal_bell'
    }
    const content = JSON.stringify(overlay)
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
    // One file per distinct overlay CONTENT. Old digests are deliberately never
    // GC'd here: the daemon's PTYs outlive app runs by days, a long-lived claude
    // may re-read a watched settings file, and deleting one out from under it
    // would silently drop its hooks — a few orphaned ~1KB files are the cheaper
    // residual (content varies only with the per-workspace session overlay).
    const settings = join(dir, `claude-launch-${digest}.settings.json`)
    // The NAME is the content, so "this run already wrote this digest and the file is
    // still there" proves the bytes are right — skip the write. Every launch of a
    // steady workspace hits this; a changed overlay lands on a new name and writes.
    if (!writtenSettingsDigests.has(digest) || !existsSync(settings)) {
      writeFileSync(settings, content)
      writtenSettingsDigests.add(digest)
    }
    return ['--settings', settings]
  } catch {
    // A failed write must not leave a lie behind: re-verify both generated files next
    // launch (the digest set is only allowed to remember successful writes).
    relayDirReady = false
    relayVerified = false
    return []
  }
}

/**
 * Gate seam: forget that this RUN already content-verified the generated files, so the
 * next `claudeStatuslineArgs()` performs the full compare again.
 *
 * The verification is once-per-run by design (see above) — the app cannot rewrite its own
 * RELAY_SOURCE mid-run, so re-reading per launch could only confirm the first read. But
 * the guarantee that protects users is precisely about a run's FIRST build: a relay left
 * by a previous release, whose baked-in channel segment would otherwise push every
 * claude's numbers into a dead directory. Reproducing that needs a fresh run, and this is
 * how the NOTIFYHOOK gate gets one without restarting the app. Inert in production.
 */
export function resetRelayVerificationForSmoke(): void {
  relayVerified = false
  writtenSettingsDigests.clear()
}

let activeMonitor: ContextMonitor | null = null

/** The session log a pane is locked on (provider + file), or undefined before the
 *  matcher locks. Read by the launch path (src/main/agents.ts) so a cross-profile
 *  resume can name the pane's EXACT session (ADR 0013). Read-only peek — ids and a
 *  path that never leave main. */
export function paneSessionLog(paneId: number): { provider: string; file: string } | undefined {
  return activeMonitor?.sessionFor(paneId)
}

// Identity by DECLARATION (monitor.ts, the `declare` rule): a resume-by-id launch KNOWS
// the exact session file its command continues — knowledge the launch path (agents.ts)
// derives and would otherwise throw away, leaving the monitor to re-guess an identity
// the app already decided (a resumed transcript predates the watch, so the matcher's
// birth gate rightly refuses to guess it). The declaration is held HERE, main-side —
// the renderer's watch request never carries a path it never knew. Sticky within its
// TTL, not consumed on first read: detection confirming the launch re-issues the watch
// (a sharper `since`), and the re-watch must re-pin, not find the shelf bare.

const expectedSessions = new Map<number, { provider: string; file: string; at: number }>()
/** Long enough for launch -> typed command -> detection -> watch (seconds); short enough
 *  that a command the renderer never typed cannot pin some later, unrelated launch. */
const EXPECT_TTL_MS = 60_000

/** Declare (or, with null, clear) the session file the NEXT watch of this pane should
 *  start pinned to. Every local launch calls this: a launch with a KNOWN id (assigned or
 *  resumed) declares, anything else clears — a fresh launch must never inherit a previous
 *  declaration, and it drops the pane's assigned id too (a NEW session is a new identity;
 *  resuming the old one from this pane id would splice a dead conversation under a fresh
 *  launch). */
export function expectPaneSession(paneId: number, provider: string, file: string | null): void {
  if (file) expectedSessions.set(paneId, { provider, file, at: Date.now() })
  else {
    expectedSessions.delete(paneId)
    forgetAssignedSession(paneId)
  }
}

export function registerContext(getWebContents: () => WebContents | null): () => void {
  const monitor = new ContextMonitor({
    change: (paneId, usage) => getWebContents()?.send(ContextChannels.change, { paneId, usage })
  })
  activeMonitor = monitor
  ipcMain.on(ContextChannels.watch, (_e, req: ContextWatchRequest) => {
    if (!req || typeof req.cwd !== 'string' || !req.cwd || !isContextProvider(req.provider)) return
    const profile = req.profileId
      ? ((getSettingsStore()?.listProfiles() ?? []).find((p) => p.id === req.profileId) ?? null)
      : null
    const expected = expectedSessions.get(req.paneId as number)
    monitor.setPane(req.paneId as number, {
      provider: req.provider,
      cwd: req.cwd,
      home: resolveHome(req.provider, profile),
      adopted: req.adopted === true,
      // Typed-launch detection saw the agent's process start, so the matcher gets a TRUE floor
      // for how far back this pane's session log may lie, instead of a guess.
      since: typeof req.since === 'number' && req.since > 0 ? req.since : undefined,
      // The launcher declared the exact session this pane resumes (see above) — the watch
      // starts pinned to it instead of re-guessing what the app already knows.
      expectedFile:
        expected && expected.provider === req.provider && Date.now() - expected.at < EXPECT_TTL_MS
          ? expected.file
          : undefined
    })
  })
  ipcMain.on(ContextChannels.unwatch, (_e, req: ContextUnwatchRequest) => {
    if (req && Number.isFinite(req.paneId as number)) {
      // THE CORRECTION CHANNEL, banked. A pane's assigned id is the app's own choice, but
      // claude abandons it on `/clear` and `--fork-session` — and the statusline pin is
      // what notices, by locking the transcript claude actually moved to. So before the
      // watch releases that lock, write its id back over the assignment: whatever resumes
      // this pane next continues the conversation the user was IN, not the one we named at
      // birth. (This is why the old 5-minute retained lock is gone — an assigned id
      // survives the agent's death by construction, so nothing needs to outlive the watch.)
      const live = monitor.sessionFor(req.paneId as number)
      if (live?.provider === 'claude') {
        const id = basename(live.file, '.jsonl')
        if (SESSION_ID_RE.test(id)) rememberAssignedSession(req.paneId as number, id)
      }
      monitor.remove(req.paneId as number)
      expectedSessions.delete(req.paneId as number)
    }
  })
  return () => {
    monitor.dispose()
    expectedSessions.clear()
    if (activeMonitor === monitor) activeMonitor = null
  }
}

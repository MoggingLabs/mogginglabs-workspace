import { homedir } from 'node:os'
import type { AgentInstallStart, AgentInstallState } from '@contracts'
import { spawnPty, type IPty } from '../../platform/pty-host'
import { defaultShell, shellArgs } from '../../platform/shell'
import { killPtyTree } from '../../platform/process-tree'
import { getTelemetry } from '../../core/telemetry'
import { findAdapter } from './adapters'
import { isOnPath } from './detect'

// Background provider installs (Settings § Providers). The install runs in an
// EPHEMERAL pty — the user's own login shell, never shown as a pane — with the
// provider's documented one-liner injected as typed input, then `exit`. Injecting
// (rather than `sh -c`) means the user's rc files load, so npm/pip resolve exactly
// as they would in a terminal the user opened themselves.
//
// The VERDICT is a re-detect (is the bin on PATH now?), not the shell's exit
// code: PATH presence is the same truth detectAgents() reports, so the tab and
// the wizard can never disagree about what "installed" means. ADR 0002 holds —
// an install one-liner is public provider documentation, not a credential; it is
// run verbatim on an explicit user click, never parsed, edited, or elevated.

/** Keep this much terminal output per install — enough to read why npm failed. */
const TAIL_MAX = 16_384
/** A stuck installer (dead registry, hung prompt) must not spin forever unseen. */
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** Batch data pushes so npm's progress bar doesn't become an IPC firehose. */
const PUSH_EVERY_MS = 150

// CSI / OSC / single-char escapes -> out, so the tail reads as plain text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g

interface LiveInstall {
  proc: IPty
  state: AgentInstallState
  watchdog: ReturnType<typeof setTimeout>
  pushTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Owns the ephemeral install ptys. Electron-free: give it a push sink and it
 * reports every state change; main relays those to the renderer.
 */
export class InstallService {
  private readonly live = new Map<string, LiveInstall>()
  /** Last known state per provider — running or finished — for late-mounted UIs. */
  private readonly states_ = new Map<string, AgentInstallState>()

  constructor(private readonly push: (state: AgentInstallState) => void) {}

  states(): AgentInstallState[] {
    return [...this.states_.values()]
  }

  start(agentId: string): AgentInstallStart {
    const adapter = findAdapter(agentId)
    if (!adapter) return { ok: false, reason: `unknown provider “${agentId}”` }
    if (!adapter.installHint) return { ok: false, reason: `${adapter.name} has no install command` }
    if (this.live.has(agentId)) return { ok: false, reason: `${adapter.name} is already installing` }
    if (isOnPath(adapter.bin)) return { ok: false, reason: `${adapter.name} is already installed` }

    const state: AgentInstallState = { agentId, phase: 'running', tail: '', startedAt: Date.now() }
    let proc: IPty
    try {
      // spawnPty is the only door to node-pty (the pty seam). Size is nominal —
      // nothing renders this terminal; 120 cols just keeps installer output sane.
      ;({ proc } = spawnPty(defaultShell(), shellArgs(), {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: homedir(),
        env: process.env as Record<string, string>
      }))
    } catch (err) {
      getTelemetry().captureError(err, { feature: 'agents', op: 'install-spawn', platform: process.platform })
      const why = err instanceof Error ? err.message : String(err)
      this.finish(state, { tailNote: `could not start a terminal: ${why}` })
      return { ok: false, reason: 'could not start a terminal for the install' }
    }

    const entry: LiveInstall = {
      proc,
      state,
      watchdog: setTimeout(() => {
        // Still running after the deadline: kill the tree and let onExit settle it.
        this.appendTail(entry, `\n[gave up after ${INSTALL_TIMEOUT_MS / 60_000} minutes — the installer looked stuck]\n`)
        killPtyTree(proc)
      }, INSTALL_TIMEOUT_MS),
      pushTimer: null
    }
    this.live.set(agentId, entry)
    this.states_.set(agentId, state)

    proc.onData((data) => this.appendTail(entry, data.replace(ANSI, '')))
    proc.onExit(({ exitCode }) => {
      clearTimeout(entry.watchdog)
      if (entry.pushTimer) clearTimeout(entry.pushTimer)
      this.live.delete(agentId)
      const installed = isOnPath(adapter.bin)
      const tailNote =
        !installed && exitCode === 0
          ? `\n[the installer finished, but “${adapter.bin}” is not on PATH yet — a fresh login shell or app restart may be needed]`
          : undefined
      this.finish(state, { exitCode, installed, tailNote })
    })

    // The injection: the provider's one-liner, verbatim, then `exit` so the shell
    // (and with it the pty) ends when the install does. Typed-ahead input is
    // buffered by the line discipline, so both lines run in order once the
    // prompt is up. These installers are non-interactive by design.
    proc.write(`${adapter.installHint}\r`)
    proc.write('exit\r')

    this.push(state)
    return { ok: true }
  }

  /** App quitting: ephemeral terminals must not outlive it. */
  dispose(): void {
    for (const entry of this.live.values()) {
      clearTimeout(entry.watchdog)
      if (entry.pushTimer) clearTimeout(entry.pushTimer)
      killPtyTree(entry.proc)
    }
    this.live.clear()
  }

  private appendTail(entry: LiveInstall, text: string): void {
    const s = entry.state
    s.tail = (s.tail + text).slice(-TAIL_MAX)
    // Trailing throttle: one push per window, always carrying the latest tail.
    entry.pushTimer ??= setTimeout(() => {
      entry.pushTimer = null
      if (s.phase === 'running') this.push(s)
    }, PUSH_EVERY_MS)
  }

  private finish(
    state: AgentInstallState,
    v: { exitCode?: number; installed?: boolean; tailNote?: string }
  ): void {
    if (v.tailNote) state.tail = (state.tail + v.tailNote).slice(-TAIL_MAX)
    state.phase = v.installed ? 'succeeded' : 'failed'
    state.exitCode = v.exitCode
    state.endedAt = Date.now()
    this.states_.set(state.agentId, state)
    getTelemetry().captureEvent({
      name: 'provider.install',
      // Structured primitives only — never the tail (terminal output stays local, ADR 0005).
      props: { provider: state.agentId, ok: state.phase === 'succeeded', ms: state.endedAt - state.startedAt }
    })
    this.push(state)
  }
}

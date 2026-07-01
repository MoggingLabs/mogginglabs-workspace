// Protocol between the Electron app (client) and the detached PTY daemon (server).
// This is a versioned CONTRACT: the socket/pipe name embeds the version, so an app
// update never speaks an incompatible protocol to an old daemon (ADR 0006 — the
// tmux "kill-server on upgrade" pitfall). Depends on nothing (pure types + helpers).

import type { AgentState } from '../domain/agent'
import type { PersistedWorkspace } from '../ipc/workspace.ipc'

export const DAEMON_PROTOCOL_VERSION = 1

/** Discovery record the daemon writes and the client reads (mode 0600). */
export interface DaemonEndpoint {
  version: number
  address: string // named pipe path (Windows) or unix socket path (macOS/Linux)
  token: string // random per-daemon auth token; the client must present it in `hello`
  pid: number
}

export interface SpawnSpec {
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  /** A line typed into the pane right after spawn (e.g. to launch an agent CLI). */
  run?: string
}

export interface PaneInfo {
  id: string
  cols: number
  rows: number
}

/** client -> daemon */
export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | { t: 'spawn'; id: string; spec?: SpawnSpec }
  | { t: 'attach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  | { t: 'list' }
  | { t: 'ping' }
  | { t: 'shutdown' }

/** daemon -> client */
export type ServerMessage =
  | { t: 'welcome'; v: number; panes: PaneInfo[]; workspaces: PersistedWorkspace[] }
  | { t: 'error'; reason: string }
  | { t: 'spawned'; id: string; existing: boolean; scrollback: string }
  | { t: 'attached'; id: string; scrollback: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'state'; id: string; state: AgentState }
  | { t: 'panes'; panes: PaneInfo[] }
  | { t: 'pong' }

/** Newline-delimited JSON framing (JSON escapes any embedded newline, so this is safe). */
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n'
}

/** Stateful decoder for partial socket chunks. Returns a fn to feed chunks into. */
export function createLineFramer(onMessage: (obj: unknown) => void): (chunk: string) => void {
  let buf = ''
  return (chunk: string): void => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      onMessage(obj)
    }
  }
}

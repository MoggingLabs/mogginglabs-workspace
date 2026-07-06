import net from 'node:net'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { agentAct, agentControlDebug } from './browser-dock'
import { handleUsageCall } from './usage'
import type { BrowserAgentVerb, BrowserAgentVerbName } from '@contracts'

/**
 * The agent-control transport (Phase-6/05b). Main opens a token-authed LOCAL
 * IPC endpoint (unix socket / named pipe — same class as the daemon's, ADR
 * 0006; nothing new on TCP) and writes a 0600 endpoint file. The first-party
 * MCP server (`bin/mogging-mcp.mjs`) connects here and forwards `tools/call`
 * to `agentAct` — so an agent CLI in a pane reaches the browser tools without
 * any daemon-protocol change (the daemon stays at v3, untouched).
 *
 * Wire: newline-delimited JSON. `{ t:'hello', token }` -> `{ t:'welcome' }` or
 * an auth error; then `{ t:'call', id, name, args }` -> `{ t:'result', id, ... }`.
 * Consent is enforced downstream by agentAct (per-workspace, default OFF).
 */

const APP = 'MoggingLabs'
const PROTOCOL = 3

function runtimeDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  const dir = path.join(base, APP, 'run', 'v' + PROTOCOL)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const endpointFile = (): string => path.join(runtimeDir(), 'browser-control.json')
const socketAddress = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\mogging-browser-${process.pid}`
    : path.join(runtimeDir(), `browser-${process.pid}.sock`)

/** MCP tool name -> agentAct verb + arg mapping. The ONE place the two shapes meet. */
function toVerb(name: string, args: Record<string, unknown>): BrowserAgentVerb | null {
  const s = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const n = (k: string): number | undefined => (typeof args[k] === 'number' ? (args[k] as number) : undefined)
  switch (name) {
    case 'browser_navigate':
      return { verb: 'navigate', target: s('url') }
    case 'browser_back':
      return { verb: 'back' }
    case 'browser_forward':
      return { verb: 'forward' }
    case 'browser_reload':
      return { verb: 'reload' }
    case 'browser_snapshot':
      return { verb: 'snapshot' }
    case 'browser_screenshot':
      return { verb: 'screenshot' }
    case 'browser_click':
      return { verb: 'click', target: s('ref') }
    case 'browser_type':
      return { verb: 'type', target: s('ref'), value: s('text') }
    case 'browser_scroll':
      return { verb: 'scroll', dy: n('dy') }
    case 'browser_select':
      return { verb: 'select', target: s('ref'), value: s('value') }
    case 'browser_eval':
      return { verb: 'eval', target: s('js') }
    case 'browser_console':
      return { verb: 'console', n: n('tail') }
    case 'browser_network_failures':
      return { verb: 'network_failures', n: n('tail') }
    case 'browser_wait_for':
      return { verb: 'wait_for', target: s('selector'), n: n('timeoutMs') }
    default:
      return null
  }
}

export const MCP_TOOL_NAMES: string[] = [
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_select', 'browser_eval', 'browser_console',
  'browser_network_failures', 'browser_wait_for'
]

let server: net.Server | null = null
let token = ''

export function startMcpEndpoint(): void {
  if (server) return
  token = randomBytes(24).toString('hex')
  const address = socketAddress()
  try {
    if (process.platform !== 'win32' && fs.existsSync(address)) fs.unlinkSync(address)
  } catch {
    /* ignore */
  }

  server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let buf = ''
    let authed = false
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg: { t?: string; token?: string; id?: number; name?: string; args?: Record<string, unknown> }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.t === 'hello') {
          authed = msg.token === token
          sock.write(JSON.stringify(authed ? { t: 'welcome', tools: MCP_TOOL_NAMES } : { t: 'error', reason: 'auth' }) + '\n')
          if (!authed) sock.destroy()
          continue
        }
        if (!authed) {
          sock.destroy()
          return
        }
        if (msg.t === 'call' && typeof msg.id === 'number' && typeof msg.name === 'string') {
          const id = msg.id
          // 7/11: `usage.*` request types for the mogging CLI — SAME frame,
          // SAME handshake, no new listener (daemon stays v3, untouched).
          // Deliberately NOT in the welcome tools list: usage verbs are for
          // the CLI, never advertised to agents through the MCP server.
          if (msg.name.startsWith('usage.')) {
            void handleUsageCall(msg.name, msg.args ?? {}).then((r) => {
              sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n')
            })
            continue
          }
          const verb = toVerb(msg.name, msg.args ?? {})
          if (!verb) {
            sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'unknown-tool' }) + '\n')
            continue
          }
          void agentAct(verb).then((r) => {
            sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n')
          })
        }
      }
    })
    sock.on('error', () => sock.destroy())
  })

  server.on('error', () => {
    /* endpoint best-effort; the dock chrome still works without agent control */
  })
  server.listen(address, () => {
    try {
      fs.writeFileSync(endpointFile(), JSON.stringify({ version: PROTOCOL, address, token }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  })
}

export function stopMcpEndpoint(): void {
  try {
    server?.close()
  } catch {
    /* ignore */
  }
  server = null
  try {
    fs.unlinkSync(endpointFile())
  } catch {
    /* already gone */
  }
}

/** Smoke-only: the endpoint file path + whether it's live. */
export function mcpEndpointDebug(): { file: string; live: boolean; consent: boolean } {
  return { file: endpointFile(), live: !!server, consent: agentControlDebug().allowed }
}

// Keep the verb-name type referenced so the tool map can't silently drift.
export type { BrowserAgentVerbName }

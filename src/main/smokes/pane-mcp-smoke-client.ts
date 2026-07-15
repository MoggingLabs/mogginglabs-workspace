import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The MCP identity gates must launch the real server from inside a real pane.
// That is the only production path that inherits the daemon-minted
// MOGGING_PANE_TOKEN. These helpers bridge the pane child's stdio back to the
// trusted main-process smoke without ever reading or copying that token.

export type SmokeRpc = {
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

export interface PaneMcpSmokeClient {
  rpc(method: string, params?: unknown): Promise<SmokeRpc>
  notifications: string[]
  kill(): void
}

interface SmokeCliResult {
  code: number
  stdout: string
  stderr?: string
}

type SmokeCli = (args: string[], extraEnv?: Record<string, string>) => Promise<SmokeCliResult>

interface ClientOptions {
  mcpPath: string
  onFrame?: (frame: string) => void
}

interface PaneClientOptions extends ClientOptions {
  cli: SmokeCli
  paneId: string
  childEnv?: Record<string, string>
}

const shellQuote = (value: string): string =>
  process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'"'"'`)}'`

const BRIDGE_SOURCE = String.raw`import { spawn } from 'node:child_process'
import net from 'node:net'

const [entry, address, encodedEnv] = process.argv.slice(2)
const extraEnv = JSON.parse(Buffer.from(encodedEnv, 'base64url').toString('utf8'))
const socket = net.connect(address)
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, ...extraEnv },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

socket.pipe(child.stdin)
child.stdout.pipe(socket, { end: false })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (text) => {
  socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'smoke/stderr', params: { text } }) + '\n')
})

const stop = () => {
  try { child.kill() } catch {}
  try { socket.destroy() } catch {}
}
socket.on('close', stop)
socket.on('error', stop)
child.on('exit', () => {
  try { socket.end() } catch {}
  process.exit(0)
})
child.on('error', () => {
  try { socket.end() } catch {}
  process.exit(1)
})
`

function attachLineRpc(
  write: (line: string) => boolean,
  onData: (handler: (chunk: string) => void) => void,
  close: () => void,
  onFrame?: (frame: string) => void,
  onStderr?: (handler: (chunk: string) => void) => void
): PaneMcpSmokeClient {
  let out = ''
  let id = 0
  let closed = false
  const notifications: string[] = []
  const waiters = new Map<number, { resolve: (value: SmokeRpc) => void; timer: NodeJS.Timeout }>()

  const consume = (chunk: string): void => {
    out += chunk
    let newline = out.indexOf('\n')
    while (newline >= 0) {
      const line = out.slice(0, newline)
      out = out.slice(newline + 1)
      newline = out.indexOf('\n')
      if (!line.trim()) continue
      onFrame?.(line)
      try {
        const message = JSON.parse(line) as { id?: number; method?: string } & SmokeRpc
        if (typeof message.id === 'number' && waiters.has(message.id)) {
          const waiter = waiters.get(message.id)!
          clearTimeout(waiter.timer)
          waiters.delete(message.id)
          waiter.resolve({ result: message.result, error: message.error })
        } else if (message.id === undefined && typeof message.method === 'string') {
          notifications.push(message.method)
        }
      } catch {
        // Non-JSON diagnostics are still recorded by onFrame for token-hygiene
        // assertions, but are not MCP responses.
      }
    }
  }

  onData(consume)
  onStderr?.((chunk) => onFrame?.(chunk))

  return {
    notifications,
    rpc: (method, params) =>
      new Promise((resolve) => {
        if (closed) {
          resolve({ error: { message: 'MCP smoke client is closed' } })
          return
        }
        const requestId = ++id
        const timer = setTimeout(() => {
          waiters.delete(requestId)
          resolve({ error: { message: `MCP smoke RPC timed out: ${method}` } })
        }, 15_000)
        waiters.set(requestId, { resolve, timer })
        if (!write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')) {
          clearTimeout(timer)
          waiters.delete(requestId)
          resolve({ error: { message: 'MCP smoke client write failed' } })
        }
      }),
    kill: () => {
      if (closed) return
      closed = true
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer)
        waiter.resolve({ error: { message: 'MCP smoke client closed' } })
      }
      waiters.clear()
      close()
    }
  }
}

/** Launch an unbound, outside-pane MCP session (used to prove fail-closed). */
export function spawnLocalMcpSmokeClient(
  options: ClientOptions & { childEnv?: Record<string, string> }
): PaneMcpSmokeClient {
  const child = spawn(
    process.execPath,
    [options.mcpPath],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(options.childEnv ?? {}) },
      windowsHide: true
    }
  ) as ChildProcessWithoutNullStreams
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return attachLineRpc(
    (line) => child.stdin.write(line),
    (handler) => child.stdout.on('data', handler),
    () => child.kill(),
    options.onFrame,
    (handler) => child.stderr.on('data', handler)
  )
}

/**
 * Launch the official MCP server inside `paneId` and bridge its stdio through a
 * private local socket. The pane token never crosses the bridge.
 *
 * ONE LIVE SESSION PER PANE. The bridge is a real process typed at a real shell, and it
 * HOLDS that pane's foreground until `kill()`. A second `mogging send` into the same pane
 * hands its bytes to the bridge's own (unread) stdin — the shell never runs them, and this
 * call simply times out waiting for a connection that was never launched. A smoke that
 * needs N concurrent pane-bound sessions needs N panes.
 */
export async function spawnPaneMcpSmokeClient(options: PaneClientOptions): Promise<PaneMcpSmokeClient> {
  const nonce = `${process.pid}-${randomBytes(8).toString('hex')}`
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\mogging-mcp-smoke-${nonce}`
    : join(tmpdir(), `mogging-mcp-${nonce}.sock`)
  const bridgePath = join(tmpdir(), `mogging-mcp-bridge-${nonce}.mjs`)
  writeFileSync(bridgePath, BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 })

  let socket: Socket | null = null
  const server = createServer()
  const accepted = new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pane ${options.paneId} MCP bridge timed out`)), 15_000)
    server.once('connection', (connected) => {
      clearTimeout(timer)
      socket = connected
      server.close()
      resolve(connected)
    })
    server.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  // A failed `mogging send` can return before this accept promise's watchdog.
  // Attach a handler immediately so that later rejection is cleanup, not an
  // unhandled process-level failure; the awaited path below still receives it.
  void accepted.catch(() => undefined)

  await new Promise<void>((resolve, reject) => {
    server.listen(address, resolve)
    server.once('error', reject)
  })

  const encodedEnv = Buffer.from(JSON.stringify(options.childEnv ?? {}), 'utf8').toString('base64url')
  const command = [
    'node',
    shellQuote(bridgePath),
    shellQuote(options.mcpPath),
    shellQuote(address),
    shellQuote(encodedEnv)
  ].join(' ')
  const sent = await options.cli(['send', options.paneId, command])
  if (sent.code !== 0) {
    server.close()
    try { unlinkSync(bridgePath) } catch { /* best effort */ }
    throw new Error(`could not launch MCP bridge in pane ${options.paneId}: ${sent.stderr || sent.stdout || sent.code}`)
  }

  try {
    const connected = await accepted
    connected.setEncoding('utf8')
    return attachLineRpc(
      (line) => connected.write(line),
      (handler) => connected.on('data', handler),
      () => {
        connected.destroy()
        try { unlinkSync(bridgePath) } catch { /* best effort */ }
      },
      options.onFrame
    )
  } catch (error) {
    ;(socket as Socket | null)?.destroy()
    server.close()
    try { unlinkSync(bridgePath) } catch { /* best effort */ }
    throw error
  }
}

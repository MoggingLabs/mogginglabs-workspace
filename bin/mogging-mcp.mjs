#!/usr/bin/env node
// The first-party MCP server (Phase-6/05b): exposes the browser dock's tools to
// any agent CLI that speaks MCP (Claude Code, Codex, Gemini, ...). Stdio
// JSON-RPC 2.0. It forwards each tools/call to the app's browser-control
// endpoint (main writes browser-control.json into the per-user runtime dir);
// consent is enforced app-side (per-workspace, default OFF — ADR 0002). The
// server holds NO auth of its own and reads no cookies: it is a thin bridge
// from the agent's MCP client to the ONE visible dock.
//
// Register (until the phase-8 MCP manager automates it):
//   claude mcp add mogging-browser -- node <path>/bin/mogging-mcp.mjs
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROTOCOL = 3

function endpointFile() {
  if (process.env.MOGGING_BROWSER_ENDPOINT) return process.env.MOGGING_BROWSER_ENDPOINT
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
  return join(base, 'MoggingLabs', 'run', 'v' + PROTOCOL, 'browser-control.json')
}

// ── The tool catalog (schemas the agent sees) ────────────────────────────────
const TOOLS = [
  { name: 'browser_navigate', description: 'Open a URL (http/https) in the dock.', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_back', description: 'Go back.', schema: { type: 'object', properties: {} } },
  { name: 'browser_forward', description: 'Go forward.', schema: { type: 'object', properties: {} } },
  { name: 'browser_reload', description: 'Reload the page.', schema: { type: 'object', properties: {} } },
  { name: 'browser_snapshot', description: 'Read the page: interactive elements (with stable refs to click by) + visible text + url/title.', schema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'PNG screenshot of the dock (data URL).', schema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click an element by its snapshot ref (or a CSS selector).', schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
  { name: 'browser_type', description: 'Type text into an input by ref/selector.', schema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] } },
  { name: 'browser_scroll', description: 'Scroll the page vertically by dy pixels.', schema: { type: 'object', properties: { dy: { type: 'number' } } } },
  { name: 'browser_select', description: 'Set a <select> value by ref/selector.', schema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' } }, required: ['ref', 'value'] } },
  { name: 'browser_eval', description: 'Evaluate a JS expression in the page and return its JSON result.', schema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
  { name: 'browser_console', description: 'Recent console lines (tail).', schema: { type: 'object', properties: { tail: { type: 'number' } } } },
  { name: 'browser_network_failures', description: 'Recent failed network requests (tail).', schema: { type: 'object', properties: { tail: { type: 'number' } } } },
  { name: 'browser_wait_for', description: 'Wait until a selector appears (or timeout).', schema: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] } }
]

// ── App endpoint connection (one authed socket, lazily opened) ───────────────
let sock = null
let epBuf = ''
let nextId = 1
const pending = new Map()

function connectApp() {
  return new Promise((resolve, reject) => {
    let ep
    try {
      ep = JSON.parse(readFileSync(endpointFile(), 'utf8'))
    } catch {
      reject(new Error('the MoggingLabs app is not running (no browser-control endpoint)'))
      return
    }
    const s = net.connect(ep.address)
    s.setEncoding('utf8')
    let welcomed = false
    const timer = setTimeout(() => reject(new Error('app did not respond')), 5000)
    s.on('connect', () => s.write(JSON.stringify({ t: 'hello', token: ep.token }) + '\n'))
    s.on('data', (chunk) => {
      epBuf += chunk
      let i
      while ((i = epBuf.indexOf('\n')) >= 0) {
        const line = epBuf.slice(0, i)
        epBuf = epBuf.slice(i + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.t === 'welcome') {
          welcomed = true
          clearTimeout(timer)
          sock = s
          resolve(s)
        } else if (m.t === 'error') {
          clearTimeout(timer)
          reject(new Error('app refused (' + (m.reason || 'error') + ')'))
        } else if (m.t === 'result' && pending.has(m.id)) {
          const { resolve: r } = pending.get(m.id)
          pending.delete(m.id)
          r(m)
        }
      }
    })
    s.on('error', (e) => {
      clearTimeout(timer)
      if (!welcomed) reject(e)
    })
    s.on('close', () => {
      sock = null
    })
  })
}

async function callApp(name, args) {
  if (!sock) await connectApp()
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    sock.write(JSON.stringify({ t: 'call', id, name, args }) + '\n')
  })
}

// ── MCP stdio JSON-RPC 2.0 ───────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function replyErr(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  try {
    const r = await callApp(name, args)
    if (!r.ok) {
      const hint =
        r.reason === 'disabled'
          ? 'Agent browser control is OFF for this workspace. The human enables it in Settings > Browser.'
          : `browser tool failed: ${r.reason || 'unknown'}`
      reply(id, { content: [{ type: 'text', text: hint }], isError: true })
      return
    }
    // Shape the result as MCP text content (screenshots return the data URL).
    const payload = {}
    for (const k of ['url', 'title', 'text', 'value', 'png']) if (r[k] !== undefined) payload[k] = r[k]
    if (r.nodes) payload.nodes = r.nodes
    if (r.lines) payload.lines = r.lines
    const text = Object.keys(payload).length ? JSON.stringify(payload) : 'ok'
    reply(id, { content: [{ type: 'text', text }] })
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params } = msg
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mogging-browser', version: '1.0.0' }
      })
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) })
    } else if (method === 'tools/call') {
      void handleToolCall(id, params)
    } else if (method === 'ping') {
      reply(id, {})
    } else if (id !== undefined) {
      replyErr(id, -32601, 'method not found: ' + method)
    }
    // notifications (no id) are acknowledged by silence
  }
})

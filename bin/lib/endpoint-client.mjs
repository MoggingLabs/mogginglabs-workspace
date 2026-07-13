// Shared authed-endpoint client (Phase-8/02). BOTH local endpoints the house
// MCP server speaks — the app's browser-control endpoint and the PTY daemon —
// share one wire shape: a 0600 JSON endpoint file naming { version, address,
// token }, then newline-delimited JSON over the socket with a
// `{ t:'hello', v, token }` -> `{ t:'welcome' }` handshake (the app endpoint
// ignores `v`; the daemon requires it). This module owns that framing ONCE.
//
// The token exists only inside the hello frame: it is never logged, never
// echoed, and never rides an error — rejections carry a `code`, not secrets.
import net from 'node:net'
import { readFileSync } from 'node:fs'

/** Parse an endpoint file; null when absent/unreadable (the caller words the fix). */
export function readEndpoint(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Open one authed session against an endpoint file. Resolves AFTER welcome with
 * `{ welcome, send, onMessage, close }`; post-welcome frames flow to the
 * onMessage handler (including the daemon's `{t:'error'}` TOOL errors — only a
 * pre-welcome error is a connection failure). Rejects with err.code:
 * 'no-endpoint' | 'auth' | 'timeout' | 'conn'.
 */
export function connectEndpoint(file, { timeoutMs = 5000, hello = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ep = readEndpoint(file)
    if (!ep) {
      const e = new Error('no endpoint file')
      e.code = 'no-endpoint'
      reject(e)
      return
    }
    const sock = net.connect(ep.address)
    sock.setEncoding('utf8')
    let buf = ''
    let welcomed = false
    let handler = null
    let dead = false
    let closeHandler = null
    const makeSession = (welcome) => ({
      welcome,
      /** Best-effort write; false once the socket is gone (never throws). */
      send: (obj) => {
        if (dead) return false
        try {
          sock.write(JSON.stringify(obj) + '\n')
          return true
        } catch {
          return false
        }
      },
      onMessage: (fn) => {
        handler = fn
      },
      /** Fires once when an ESTABLISHED session's socket dies. */
      onClose: (fn) => {
        closeHandler = fn
      },
      close: () => {
        dead = true
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
      }
    })
    const fail = (code) => {
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      const e = new Error(code)
      e.code = code
      reject(e)
    }
    const timer = setTimeout(() => {
      if (!welcomed) fail('timeout')
    }, timeoutMs)
    sock.on('connect', () => {
      sock.write(JSON.stringify({ t: 'hello', v: ep.version, token: ep.token, ...hello }) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (!welcomed) {
          if (m.t === 'welcome') {
            welcomed = true
            clearTimeout(timer)
            resolve(makeSession(m))
          } else if (m.t === 'error') {
            fail('auth')
          }
          continue
        }
        if (handler) handler(m)
      }
    })
    sock.on('error', () => {
      if (!welcomed) fail('conn')
    })
    sock.on('close', () => {
      if (!welcomed) {
        fail('conn')
        return
      }
      dead = true
      if (closeHandler) {
        const fn = closeHandler
        closeHandler = null
        fn()
      }
    })
  })
}

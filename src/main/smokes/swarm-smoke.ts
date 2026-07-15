import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { createLineFramer, encodeMessage, DAEMON_PROTOCOL_VERSION } from '@contracts'
import type { DaemonEndpoint, MailMessage } from '@contracts'

// Env-gated swarm-substrate smoke (MOGGING_SWARM, Phase-4/01):
//  1. a 2-pane workspace opens with a role manifest -> .pane-role chips render
//  2. `mogging mail send --to all` FROM INSIDE pane 1 (implicit MOGGING_PANE_ID)
//     -> `mogging mail read --json` AS pane 2 returns it with from + role attached
//  3. `mogging role` sets/validates roles over the CLI (bogus role -> exit 1)
//  4. a fake-token endpoint gets exit 4; a v2 hello on the v3 daemon is refused
//  5. the ring buffer caps at 500 (a 502-message flood evicts the earliest)
const MARKER = 'PING_4242 handshake'

export function runSwarmSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout) =>
          resolveCli({
            code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout)
          })
      )
    })

  const endpointPath = (): string =>
    join(process.env.LOCALAPPDATA ?? '', 'MoggingLabs', 'run', `v${DAEMON_PROTOCOL_VERSION}`, 'endpoint.json')

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)

      // ── 1. Manifested workspace: 2 shell panes, worker + reviewer ───────────
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}], ['worker','reviewer'])`)
      await sleep(3500) // panes spawn + the delayed daemon set-role fires (1.2s)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const chip = async (id: number): Promise<string> =>
        String(
          await ES(
            `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${id}"] .pane-role');return el&&!el.hidden?el.textContent:'';})()`
          )
        )
      const chipsOk = (await chip(base + 1)) === 'worker' && (await chip(base + 2)) === 'reviewer'

      // ── 2. In-pane send -> as-pane-2 read (implicit identities) ─────────────
      const sendInPane = await cli(['send', String(base + 1), `node "${cliPath}" mail send --to all ${MARKER}`])
      await sleep(2500)
      const readAs2 = await cli(['mail', 'read', '--json'], { MOGGING_PANE_ID: String(base + 2) })
      let mailOk = false
      let msg: MailMessage | undefined
      try {
        const messages = JSON.parse(readAs2.stdout) as MailMessage[]
        msg = messages.find((m) => m.body.includes('PING_4242'))
        mailOk =
          readAs2.code === 0 &&
          !!msg &&
          msg.from === String(base + 1) &&
          msg.role === 'worker' &&
          msg.to === 'all'
      } catch {
        mailOk = false
      }

      // ── 3. Role verb over the CLI (idempotent set + bogus rejection) ────────
      const roleOk = (await cli(['role', String(base + 2), 'reviewer'])).code === 0
      const roleBad = (await cli(['role', String(base + 2), 'overlord'])).code === 1

      // ── 4. Auth: fake token -> exit 4; old-version hello -> refused ─────────
      const ep = JSON.parse(readFileSync(endpointPath(), 'utf8')) as DaemonEndpoint
      const fakeDir = mkdtempSync(join(tmpdir(), 'mogging-swarm-auth-'))
      const fakeEp = join(fakeDir, 'endpoint.json')
      copyFileSync(endpointPath(), fakeEp)
      writeFileSync(fakeEp, JSON.stringify({ ...ep, token: 'not-the-token' }))
      const authRefused = (await cli(['mail', 'read'], { MOGGING_DAEMON_ENDPOINT: fakeEp })).code === 4

      const oldVersionRefused = await new Promise<boolean>((resolveOld) => {
        const sock = net.connect(ep.address)
        sock.setEncoding('utf8')
        const done = (v: boolean): void => {
          try {
            sock.destroy()
          } catch {
            /* closed */
          }
          resolveOld(v)
        }
        const timer = setTimeout(() => done(false), 5000)
        sock.on('connect', () => sock.write(encodeMessage({ t: 'hello', v: 2, token: ep.token })))
        sock.on(
          'data',
          createLineFramer((obj) => {
            const m = obj as { t: string; reason?: string }
            clearTimeout(timer)
            done(m.t === 'error' && m.reason === 'auth')
          })
        )
        sock.on('error', () => done(false))
      })

      // ── 5. Ring cap: flood 502 -> exactly 500 retained, earliest evicted ────
      const capOk = await new Promise<boolean>((resolveCap) => {
        const sock = net.connect(ep.address)
        sock.setEncoding('utf8')
        const done = (v: boolean): void => {
          try {
            sock.destroy()
          } catch {
            /* closed */
          }
          resolveCap(v)
        }
        const timer = setTimeout(() => done(false), 20000)
        let sentAll = false
        sock.on('connect', () => sock.write(encodeMessage({ t: 'hello', v: DAEMON_PROTOCOL_VERSION, token: ep.token })))
        sock.on(
          'data',
          createLineFramer((obj) => {
            const m = obj as { t: string; messages?: MailMessage[] }
            if (m.t === 'welcome') {
              let payload = ''
              for (let i = 1; i <= 502; i++) {
                payload += encodeMessage({ t: 'mail-send', from: '0', to: 'all', body: `cap-${i}` })
              }
              sock.write(payload)
              sentAll = true
              sock.write(encodeMessage({ t: 'mail-read', since: 0 }))
            } else if (m.t === 'mail' && sentAll && m.messages) {
              clearTimeout(timer)
              const ids = m.messages.map((x) => x.id)
              const span = Math.max(...ids) - Math.min(...ids)
              const pingGone = !m.messages.some((x) => x.body.includes('PING_4242'))
              done(m.messages.length === 500 && span === 499 && pingGone)
            }
          })
        )
        sock.on('error', () => done(false))
      })

      const pass = chipsOk && mailOk && roleOk && roleBad && authRefused && oldVersionRefused && capOk
      result = {
        pass,
        chipsOk,
        sendExit: sendInPane.code,
        mailOk,
        msg,
        roleOk,
        roleBad,
        authRefused,
        oldVersionRefused,
        capOk
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'swarm-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

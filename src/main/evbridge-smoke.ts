import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from './app-settings'
import { emitBridgeEvent, saveWebhook } from './event-bridge'
import { readTrail, flushTrailForSmoke } from './trail'

// Env-gated event-bridge smoke (MOGGING_EVBRIDGE, Phase-8/10). An in-process
// loopback receiver proves the doorbell: (a) a notify lands with the exact v1
// schema; (b) an unchecked kind never arrives; (c) workspace scope; (d) a 500
// receiver retries then drops with a LABEL trail entry (never the URL); (e)
// the URL rests as vault ciphertext (KV grep free of the literal); (f) plain
// http to a public host is refused; (g) a dead receiver never stalls emit;
// (h) no URL in the trail, no secret in logs. Zero external network.

const SECRET_URL_PATH = '/webhook/tok_9f3a2b7c1d4e' // a token in the path (Slack/Make-shaped)

export async function runEvBridgeSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  const received: { path: string; body: string }[] = []
  let respond500 = false
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ path: req.url ?? '', body })
      res.writeHead(respond500 ? 500 : 200)
      res.end('ok')
    })
  })
  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const a = server.address()
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })
    const base = `http://127.0.0.1:${port}`
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    // (e) + (a): save a loopback webhook — the URL is vaulted, not at rest.
    const saveA = saveWebhook({ label: 'n8n', url: `${base}${SECRET_URL_PATH}`, events: ['notify'], insecureAck: false })
    const dbFile = join(app.getPath('userData'), 'app-settings.db')
    let dbText = ''
    try {
      dbText = readFileSync(dbFile, 'latin1')
    } catch {
      /* db path may differ */
    }
    const configText = getSettingsStore()?.getSetting('integrations.webhooks') ?? ''
    const vaultOk = saveA.ok && !dbText.includes(SECRET_URL_PATH) && !configText.includes(SECRET_URL_PATH)

    // (f) plain http to a PUBLIC host is refused (no ack path helps).
    const savePublic = saveWebhook({ label: 'bad', url: 'http://example.com/hook', events: ['notify'] })
    const publicRefused = !savePublic.ok && /https/.test(savePublic.reason ?? '')

    // (a) a notify lands with the exact v1 schema.
    emitBridgeEvent('notify', { workspace: 'ws-A', pane: '1', note: 'build done' })
    await sleep(600)
    const got = received.find((r) => r.path === SECRET_URL_PATH)
    let schemaOk = false
    if (got) {
      const p = JSON.parse(got.body)
      schemaOk = p.v === 1 && p.event === 'notify' && p.workspace === 'ws-A' && p.pane === '1' && p.note === 'build done' && typeof p.ts === 'number'
    }

    // (b) an unchecked kind never arrives (webhook only wants 'notify').
    const before = received.length
    emitBridgeEvent('card-moved', { workspace: 'ws-A', card: 'c1' })
    await sleep(400)
    const uncheckedAbsent = received.length === before

    // (c) workspace scope: a ws-B webhook doesn't get a ws-A event.
    saveWebhook({ label: 'scoped', url: `${base}/scoped`, events: ['notify'], workspaceId: 'ws-B' })
    emitBridgeEvent('notify', { workspace: 'ws-A', note: 'A only' })
    await sleep(500)
    const scopeOk = !received.some((r) => r.path === '/scoped')

    // (d) a 500 receiver retries then drops with a LABEL trail entry.
    respond500 = true
    flushTrailForSmoke()
    saveWebhook({ label: 'flaky', url: `${base}/flaky`, events: ['review-changed'] })
    emitBridgeEvent('review-changed', { workspace: 'ws-A', note: 'r' })
    await sleep(4000) // 1 + 3 retries with 200/400/800ms backoff
    const flakyHits = received.filter((r) => r.path === '/flaky').length
    const trail = readTrail('ws-A')
    const dropEntry = trail.find((t) => t.source === 'bridge' && t.target === 'flaky')
    const retryDropOk = flakyHits >= 3 && !!dropEntry && !JSON.stringify(trail).includes(SECRET_URL_PATH)
    respond500 = false

    // (g) a DEAD receiver never stalls emit (an unroutable TEST-NET address).
    saveWebhook({ label: 'dead', url: 'http://192.0.2.1/hook', events: ['notify'], insecureAck: true })
    const t0 = Date.now()
    emitBridgeEvent('notify', { workspace: 'ws-A', note: 'x' })
    const emitMs = Date.now() - t0
    const nonBlockingOk = emitMs < 200 // emit returns immediately; delivery is queued

    // (h) grep: the secret URL path appears in no trail entry.
    const noUrlInTrail = !JSON.stringify(readTrail()).includes(SECRET_URL_PATH)

    const pass = vaultOk && publicRefused && schemaOk && uncheckedAbsent && scopeOk && retryDropOk && nonBlockingOk && noUrlInTrail
    result = { pass, vaultOk, publicRefused, schemaOk, uncheckedAbsent, scopeOk, retryDropOk, flakyHits, nonBlockingOk, emitMs, noUrlInTrail }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  server.close()
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'evbridge-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}

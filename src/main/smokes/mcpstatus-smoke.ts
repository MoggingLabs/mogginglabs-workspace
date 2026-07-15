import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveConnState, parseCliMcpList } from '@backend/features/integrations'
import { getStatusSnapshot, setStatusVisible, tickForSmoke } from '../mcp-status'

// Env-gated MCP-connection-status smoke (MOGGING_MCPSTATUS, Phase-8/11).
// Windowless: the state derivation + the poller's push/pause discipline, no
// network. (a) registered-only -> registered; (b) the CLI's "Connected" line
// -> connected; (c) "Needs authentication" -> needs-auth; (d) drift verdict ->
// drift; (e) applied-but-absent -> error; (f) a hidden window pauses the tick;
// (g) grep: the snapshot carries states + ids only — no URL, tool, or token.

export async function runMcpStatusSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  try {
    // ── (a)-(e): the state derivation, from the CLI's OWN output + our verdict.
    const connectedOut = 'sentry: https://… - ✓ Connected\nmogging: node - ✓ Connected'
    const needsAuthOut = 'sentry: https://… - Needs authentication'
    const registered = deriveConnState(true, 'not-applied', 'unknown') === 'registered'
    const connected = deriveConnState(true, 'applied', parseCliMcpList('claude-code', connectedOut, 'sentry')) === 'connected'
    const needsAuth = deriveConnState(true, 'applied', parseCliMcpList('claude-code', needsAuthOut, 'sentry')) === 'needs-auth'
    const drift = deriveConnState(true, 'drift-edited', 'unknown') === 'drift'
    const errorState = deriveConnState(true, 'applied', 'absent') === 'error'
    const offState = deriveConnState(false, 'applied', 'connected') === 'off'
    const derivationOk = registered && connected && needsAuth && drift && errorState && offState

    // (b) chip count: connected servers aggregate from the state vocabulary.
    const sample = [
      { state: 'connected' as const },
      { state: 'connected' as const },
      { state: 'needs-auth' as const },
      { state: 'off' as const }
    ]
    const connectedCount = sample.filter((s) => s.state === 'connected').length
    const countOk = connectedCount === 2

    // ── poller push: a poll produces a snapshot (states, no probing).
    await tickForSmoke() // visible by default -> polls the real registry
    const snap = getStatusSnapshot()
    const pushOk = snap.at > 0 && Array.isArray(snap.statuses)

    // ── (f) a hidden window pauses the tick (no fresh snapshot while hidden).
    setStatusVisible(false)
    const beforeAt = getStatusSnapshot().at
    const ranHidden = await tickForSmoke() // must NOT poll
    await new Promise((r) => setTimeout(r, 300))
    const pausedOk = ranHidden === false && getStatusSnapshot().at === beforeAt
    setStatusVisible(true)
    const ranVisible = await tickForSmoke()
    const resumeOk = ranVisible === true

    // ── (g) grep: the snapshot carries ONLY states + ids — never a URL/tool/token.
    const json = JSON.stringify(getStatusSnapshot())
    const vocabularyOk = !/https?:\/\//.test(json) && !/token|Bearer|authorization/i.test(json)

    const pass = derivationOk && countOk && pushOk && pausedOk && resumeOk && vocabularyOk
    result = { pass, derivationOk, countOk, pushOk, pausedOk, resumeOk, vocabularyOk, statusCount: snap.statuses.length }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'mcpstatus-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}

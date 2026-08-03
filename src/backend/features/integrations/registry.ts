import { redactSecrets } from '../review/redact'
import type { GrantKv } from './grant-store'
import type { McpServerEntry } from '@contracts'

// The MCP server registry (Phase-8/06). Persisted rows in the settings KV;
// the built-in house row is composed by main (it knows the install path) and
// never stored. Validation is the boundary: env values must be `${VAR}`
// REFERENCES, and every string field runs the SAME secret deny-list the
// profiles use (the review redactor's patterns) — a secret-shaped value
// cannot even be saved, let alone written into a CLI config (ADR 0002/0008.d).

const KV_SERVERS = 'integrations.servers'
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,47}$/

export function validateServerEntry(raw: unknown): { ok: true; entry: McpServerEntry } | { ok: false; reason: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = String(r.id ?? '').trim()
  if (!ID_SHAPE.test(id)) return { ok: false, reason: 'id must be a short slug: a-z, 0-9, dashes/underscores' }
  const label = String(r.label ?? '').trim().slice(0, 80)
  if (!label) return { ok: false, reason: 'a label is required' }
  const transport = r.transport === 'http' ? 'http' : r.transport === 'stdio' ? 'stdio' : null
  if (!transport) return { ok: false, reason: 'transport must be stdio or http' }
  const entry: McpServerEntry = { id, label, transport }
  if (transport === 'stdio') {
    const command = String(r.command ?? '').trim()
    if (!command) return { ok: false, reason: 'stdio servers need a command' }
    entry.command = command.slice(0, 512)
    if (Array.isArray(r.args)) entry.args = r.args.map((a) => String(a).slice(0, 512)).slice(0, 32)
  } else {
    const url = String(r.url ?? '').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: 'http servers need a valid url' }
    }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return { ok: false, reason: 'server urls are https (plain http only for loopback)' }
    }
    entry.url = url.slice(0, 512)
  }
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) {
      return { ok: false, reason: 'env must be a name -> ${VAR} map' }
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      const key = String(k).trim()
      const val = String(v ?? '').trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, reason: `env name "${key}" is not a valid variable name` }
      if (!ENV_REF.test(val)) {
        return {
          ok: false,
          reason: `env value for ${key} must be a \${VAR} reference — this app never writes secret literals into a CLI config. Set the variable in your own environment (or a vault slot, 8/08) and reference it here.`
        }
      }
      env[key] = val
    }
    if (Object.keys(env).length) entry.env = env
  }
  if (r.headers !== undefined) {
    if (typeof r.headers !== 'object' || r.headers === null || Array.isArray(r.headers)) {
      return { ok: false, reason: 'headers must be a name -> ${VAR} map' }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      const key = String(k).trim()
      const val = String(v ?? '').trim()
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) return { ok: false, reason: `"${key}" is not a valid header name` }
      // `${VAR}` or `Scheme ${VAR}` — the reference rule, never a literal.
      if (!/^(?:[A-Za-z][A-Za-z0-9-]* )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(val)) {
        return {
          ok: false,
          reason: `header ${key} must be a \${VAR} reference (optionally "Bearer \${VAR}") — token literals are never written into a CLI config.`
        }
      }
      headers[key] = val
    }
    if (Object.keys(headers).length) entry.headers = headers
  }
  // THE deny-list (the profiles rule): a secret-shaped string anywhere refuses.
  const flat = [entry.label, entry.command ?? '', entry.url ?? '', ...(entry.args ?? [])].join('\n')
  if (redactSecrets(flat).redactions > 0) {
    return { ok: false, reason: 'that looks like a secret — this app never stores or writes credential literals (ADR 0002)' }
  }
  return { ok: true, entry }
}

export function listStoredServers(kv: GrantKv): McpServerEntry[] {
  try {
    const raw = kv.get(KV_SERVERS)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown[]
    const out: McpServerEntry[] = []
    for (const row of Array.isArray(parsed) ? parsed : []) {
      const v = validateServerEntry(row)
      if (v.ok) out.push(v.entry)
    }
    return out
  } catch {
    return []
  }
}

export function saveServer(kv: GrantKv, raw: unknown): { ok: boolean; reason?: string } {
  const v = validateServerEntry(raw)
  if (!v.ok) return v
  if (v.entry.id === 'mogging') return { ok: false, reason: 'the house server is built in — its entry is not editable' }
  const rows = listStoredServers(kv).filter((s) => s.id !== v.entry.id)
  rows.push(v.entry)
  kv.set(KV_SERVERS, JSON.stringify(rows))
  return { ok: true }
}

export function removeStoredServer(kv: GrantKv, id: string): void {
  kv.set(KV_SERVERS, JSON.stringify(listStoredServers(kv).filter((s) => s.id !== String(id))))
}

/** The two fields of a CLI runtime a stored server entry may name. Structural on purpose —
 *  this module is Electron-free and must not import main's CliRuntime. */
export interface EntryRuntime {
  /** The standalone helper binary. */
  readonly executable: string
  /** A PROTOCOL-NEUTRAL launcher path — one that survives a protocol bump. */
  readonly launcher: string
}

/**
 * Build a stored server entry that names a stable launcher.
 *
 * A CLI config entry outlives the release that wrote it: the file sits in the user's own
 * `~/.claude.json` (or equivalent) and nothing rewrites it on update. So the command it names
 * must be protocol-neutral.
 *
 * The house row has always done this — `{command: executable, args: [mcpEntry]}`, where
 * mcpEntry is a stable launcher under `run/mcp`. The connection row hand-built its own shape
 * and named `connectionShim`, which lives in the VERSION-PINNED `run/v<N>/bin`. After a
 * protocol bump that path is gone and every connection a user had configured stops resolving —
 * silently, in their CLI, with no app involved.
 *
 * `env` is never set. The entry validator refuses any env value that is not a `${VAR}`
 * reference, deliberately, so no credential literal can reach a CLI config; a builder that
 * cannot express env cannot be talked into one.
 */
export function serverEntryFor(
  runtime: EntryRuntime,
  spec: { id: string; label: string; args?: readonly string[]; builtIn?: boolean }
): McpServerEntry {
  return {
    id: spec.id,
    label: spec.label,
    transport: 'stdio',
    command: runtime.executable,
    args: [runtime.launcher, ...(spec.args ?? [])],
    ...(spec.builtIn ? { builtIn: true } : {})
  }
}

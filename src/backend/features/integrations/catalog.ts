import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { ORIGINS } from '../../core/origins'
import { validateServerEntry } from './registry'
import { providerCatalog, providerEntryFor } from './provider-catalog-data'
import { presetFromProvider, type HostedCliId, type McpAuthKind, type McpPreset, type McpServerEntry, type McpTransport } from '@contracts'

// The Integrations Catalog (Phase-8/07; runtime source flipped to the PROVIDER
// CATALOG at phase-tools/05 — presets.json is retired). Every service fact lives
// in src/contracts/integrations/catalog/*.json, one file per provider, provenance
// on every entry (ADR 0020); the McpPreset shape below is a PROJECTION of that
// catalog for the consumers that still read it. The list is OPEN: a catalog row,
// a registry search, or a pasted preset — never code. We never run, proxy, or
// authenticate a server the CLI-owned way: Connect writes config through 06's
// writers; OAuth belongs to each CLI on that route; keys are env-ref pointers.

/** The grid/library ROSTER: display order is a product decision (n8n first, the
 *  Google Workspace group second, the long tail after), so it is data here — the
 *  unit suite pins that it covers the catalog exactly. */
export const CATALOG_ROSTER: readonly string[] = [
  'n8n', 'gw-drive', 'gw-gmail', 'gw-calendar', 'gw-chat', 'slack', 'github-mcp', 'vercel', 'supabase',
  'gohighlevel', 'clickup', 'make', 'sentry', 'posthog', 'stripe', 'cloudflare-docs', 'aws-api', 'azure',
  'gitlab', 'notion', 'tally', 'zapier', 'atlassian', 'figma', 'postman', 'airtable', 'jotform', 'replicate',
  'fal', 'elevenlabs', 'cf-bindings', 'cf-observability', 'cf-radar', 'cf-browser', 'cf-logs', 'cf-ai-gateway',
  'cf-autorag', 'cf-auditlogs', 'cf-dns-analytics', 'cf-dex', 'cf-casb', 'cf-graphql', 'cf-containers',
  'linear', 'asana', 'monday', 'intercom', 'close', 'jam', 'neon', 'prisma', 'box', 'globalping', 'paypal',
  'square', 'plaid', 'canva', 'webflow', 'huggingface', 'deepwiki'
]

/** THE catalog projection, roster-ordered. Derived, never typed twice: every fact
 *  comes out of the provider catalog through presetFromProvider. */
export const MCP_PRESETS: readonly McpPreset[] = (() => {
  const rostered = CATALOG_ROSTER.map((id) => providerEntryFor(id)).filter((e): e is NonNullable<typeof e> => !!e)
  const known = new Set(CATALOG_ROSTER)
  // A catalog row missing from the roster still ships — appended, never hidden.
  const rest = providerCatalog().filter((e) => !known.has(e.id))
  return [...rostered, ...rest].map(presetFromProvider)
})()

export const findPreset = (id: string): McpPreset | undefined => MCP_PRESETS.find((p) => p.id === id)

/** A group's rows (one card, several endpoints), or just the preset itself. */
export function presetRows(preset: McpPreset): McpPreset[] {
  if (!preset.group) return [preset]
  return MCP_PRESETS.filter((p) => p.group === preset.group)
}

// ── Per-CLI capability table (research §8: remote-MCP maturity varies) ───────
// claude-code verified on THIS machine 2026-07-06; codex/gemini floors from
// the research sources (2026-07-05) — not installed on the dev machine, so
// their rows stay research-attributed until a real install re-verifies (7/01).
export interface CliCapability {
  cli: HostedCliId
  /** Speaks remote streamable-HTTP servers natively. */
  remoteHttp: boolean
  /** Handles MCP OAuth itself (browser consent, token in ITS store). */
  oauth: boolean
  /** Tested version floor. */
  floor: string
  /** The interactive step that runs the CLI's OWN authorize (managed pane).
   *  `<id>` interpolates the server id; null = no known command. */
  authorizeCommand: string | null
  // ── Tool-plan materialization (Phase-8/09) ──────────────────────────────
  /** Launch FLAG that loads a scoped MCP config FILE (no worktree file needed).
   *  null = no flag; fall back to a project-scope file. */
  mcpConfigFlag: string | null
  /** Launch FLAG that uses ONLY the scoped config (excludes the CLI's own
   *  global servers) — lets `inheritGlobal:false` truly isolate. null = the
   *  CLI can't exclude its global set at launch (plan ADDS to global). */
  mcpStrictFlag: string | null
  /** Worktree-relative config file to write when there's no flag (managed +
   *  git-excluded so agents never see it in `git status`). null = flag path. */
  projectScopeFile: string | null
  verifiedAt: string
}

export const CLI_CAPABILITIES: readonly CliCapability[] = [
  // claude-code: `--mcp-config <file> --strict-mcp-config` verified on this
  // machine 2026-07-07 — the plan file lives in userData, nothing in the worktree.
  { cli: 'claude-code', remoteHttp: true, oauth: true, floor: '2.x', authorizeCommand: 'claude /mcp', mcpConfigFlag: '--mcp-config', mcpStrictFlag: '--strict-mcp-config', projectScopeFile: null, verifiedAt: '2026-07-07' },
  // codex/gemini: no verified launch flag — a git-excluded project-scope file
  // (research floors 2026-07-05; not installed here, so no strict isolation
  // claimed — the plan file ADDS to the CLI's global set until re-verified).
  { cli: 'codex', remoteHttp: true, oauth: true, floor: '0.44', authorizeCommand: 'codex mcp login <id>', mcpConfigFlag: null, mcpStrictFlag: null, projectScopeFile: '.codex/config.toml', verifiedAt: '2026-07-05' },
  { cli: 'gemini', remoteHttp: true, oauth: true, floor: '0.5', authorizeCommand: 'gemini mcp auth <id>', mcpConfigFlag: null, mcpStrictFlag: null, projectScopeFile: '.gemini/settings.json', verifiedAt: '2026-07-05' }
]

export const capabilityFor = (cli: HostedCliId): CliCapability | undefined => CLI_CAPABILITIES.find((c) => c.cli === cli)

/** Why a preset can't land on a CLI (chip dims with this reason), or null.
 *  Pure over the table so the smoke can probe gap cases directly. */
export function presetBlockedFor(
  preset: McpPreset,
  cap: CliCapability,
  authKind: McpAuthKind = preset.authKinds[0] ?? 'none'
): string | null {
  if (preset.transport === 'http' && !cap.remoteHttp) return `${cap.cli} cannot speak remote HTTP servers (floor ${cap.floor})`
  if (preset.transport === 'http' && authKind === 'oauth' && !cap.oauth) {
    return `${cap.cli} cannot run MCP OAuth (floor ${cap.floor}) — no mcp-remote proxy in v1`
  }
  return null
}

// ── Preset -> registry entry (the ONE pipeline into 06's writers) ────────────
export function presetToServerEntries(
  preset: McpPreset,
  opts: { baseUrl?: string; authKind?: McpAuthKind } = {}
): { ok: true; entries: McpServerEntry[] } | { ok: false; reason: string } {
  const rows = presetRows(preset)
  const entries: McpServerEntry[] = []
  for (const row of rows) {
    const authKind = opts.authKind && row.authKinds.includes(opts.authKind) ? opts.authKind : row.authKinds[0]
    const raw: Record<string, unknown> = { id: row.id, label: row.label, transport: row.transport }
    if (row.transport === 'stdio') {
      const parts = row.urlOrCommand.split(/\s+/)
      raw.command = parts[0]
      if (parts.length > 1) raw.args = parts.slice(1)
      if (row.envRefSlots.length) raw.env = Object.fromEntries(row.envRefSlots.map((s) => [s, `\${${s}}`]))
    } else {
      const url = opts.baseUrl && row.baseUrlOverride ? opts.baseUrl : row.urlOrCommand
      if (/YOUR-/.test(url)) {
        return { ok: false, reason: `${row.label} is self-hosted — paste your instance's MCP URL (the base-URL field)` }
      }
      raw.url = url
      if (authKind === 'token' && row.envRefSlots.length) {
        raw.headers = { Authorization: `Bearer \${${row.envRefSlots[0]}}` }
      }
    }
    const v = validateServerEntry(raw)
    if (!v.ok) return { ok: false, reason: `${row.label}: ${v.reason}` }
    entries.push(v.entry)
  }
  return { ok: true, entries }
}

// ── The official registry: search + update FEED (never a trust source) ───────
export interface RegistryDraft {
  name: string
  description: string
  /** Community — not house-vetted. Every consumer renders the badge. */
  draft: true
  entry: { id: string; label: string; transport: McpTransport; url?: string; command?: string; args?: string[] }
}

// The origin is PINNED (ADR 0016): an env override here let a variable repoint a
// shipped build's registry fetch. baseUrl stays a parameter — a fixture server is
// injected at the CALL SITE (the mcpcat smoke) and the IPC handler never forwards one.
export function fetchRegistry(
  search: string,
  baseUrl: string = ORIGINS.registry
): Promise<{ ok: boolean; drafts?: RegistryDraft[]; reason?: string }> {
  return new Promise((resolve) => {
    const unavailable = (): void => resolve({ ok: false, reason: 'registry unavailable' })
    let url: URL
    try {
      url = new URL(`${baseUrl.replace(/\/$/, '')}/v0/servers?search=${encodeURIComponent(search)}`)
    } catch {
      unavailable()
      return
    }
    const getter = url.protocol === 'http:' ? httpGet : httpsGet
    const req = getter(url, { timeout: 8000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
        if (body.length > 1_000_000) req.destroy() // the registry is a feed, not a firehose
      })
      res.on('end', () => {
        // ANY parse failure = unavailable — the young v0 API never blocks flows.
        try {
          const parsed = JSON.parse(body) as { servers?: Record<string, unknown>[] }
          const drafts: RegistryDraft[] = []
          for (const row of parsed.servers ?? []) {
            // v0 wraps each result as { server, _meta }; tolerate flat too.
            const s = (typeof row.server === 'object' && row.server !== null ? row.server : row) as Record<string, unknown>
            const name = String(s.name ?? '')
            const remotes = Array.isArray(s.remotes) ? (s.remotes as Record<string, unknown>[]) : []
            const packages = Array.isArray(s.packages) ? (s.packages as Record<string, unknown>[]) : []
            const id = name.split('/').pop()?.replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 48) ?? ''
            if (!id) continue
            const remoteUrl = remotes.length ? String(remotes[0].url ?? '') : ''
            if (remoteUrl) {
              drafts.push({
                name,
                description: String(s.description ?? '').slice(0, 200),
                draft: true,
                entry: { id, label: name.slice(0, 80), transport: 'http', url: remoteUrl }
              })
            } else if (packages.length) {
              const pkg = String(packages[0].name ?? packages[0].identifier ?? '')
              if (!pkg) continue
              drafts.push({
                name,
                description: String(s.description ?? '').slice(0, 200),
                draft: true,
                entry: { id, label: name.slice(0, 80), transport: 'stdio', command: 'npx', args: ['-y', pkg] }
              })
            }
          }
          resolve({ ok: true, drafts: drafts.slice(0, 20) })
        } catch {
          unavailable()
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', unavailable)
  })
}

// ── CLI status read-back: PRESENCE from each CLI's own list output ───────────
export type CliServerState = 'connected' | 'needs-auth' | 'listed' | 'absent'

export function parseCliMcpList(cli: HostedCliId, output: string, id: string): CliServerState {
  // The id must OWN its line: `posthog: <url> - ✔ Connected` (claude) or a leading
  // column in a list row (`posthog  enabled`), bullets allowed. A bare word match
  // ANYWHERE false-positived short ids — `git` inside an error sentence or another
  // server's URL read as "listed", which 11 then upgrades to connected.
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const owns = new RegExp(`^\\s*(?:[-*•·>✓✔✗×]\\s*)?${esc}(?=\\s*:|\\s|$)`)
  const line = output.split('\n').find((l) => owns.test(l))
  if (!line) return 'absent'
  if (cli === 'claude-code') {
    if (/Connected/i.test(line)) return 'connected'
    if (/Needs authentication|auth/i.test(line)) return 'needs-auth'
  }
  return 'listed' // presence only — codex/gemini wording is 11's dev-verify
}

import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  capabilityFor,
  fetchRegistry,
  findPreset,
  parseCliMcpList,
  presetBlockedFor,
  presetToServerEntries,
  saveServer,
  MCP_PRESETS,
  type CliHomes,
  type GrantKv
} from '@backend/features/integrations'
import { catConnect, catRefresh, mgrApply } from '../mcp-manager'
import { getSettingsStore } from '../app-settings'

// Env-gated Integrations-Catalog smoke (MOGGING_MCPCAT, Phase-8/07). Fixture
// homes + a FIXTURE registry served on 127.0.0.1 (zero external network):
//   a preset lands dialect-correct in all three CLIs · the n8n base override
//   lands (and its placeholder refuses without one) · a GROUP lands all rows ·
//   a dual-auth preset carries the vault-slot on-ramp (token -> Bearer ref;
//   codex -> bearer_token_env_var) · a registry hit is a DRAFT (community
//   badge data) and flows through the SAME pipeline · an imported/converted
//   secret literal is refused · capability gaps dim (pure-fn probe) · status
//   read-back parses each CLI's own list output for PRESENCE · the update
//   feed is PREVIEW ONLY (target bytes untouched).

// The real v0 shape (2026-07-06): results wrap as { server, _meta }.
const FIXTURE_REGISTRY = {
  servers: [
    {
      server: {
        name: 'io.github.acme/acme-notes',
        description: 'Community notes server',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.acme-notes.example/mcp' }]
      },
      _meta: {}
    },
    {
      server: {
        name: 'io.github.acme/acme-local',
        description: 'Community local tool',
        packages: [{ registry_name: 'npm', name: '@acme/local-mcp' }]
      },
      _meta: {}
    }
  ]
}

export function runMcpCatSmoke(win: BrowserWindow, mode?: string): void {
  const dev = mode === 'DEV' || mode === 'DEVREMOVE'
  if (!dev) setTimeout(() => app.exit(1), 120000) // safety net
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  void win
  let registryServer: Server | null = null

  // DEV / DEVREMOVE: the dev-verify arm — connect (or remove) a preset on the
  // REAL machine through the real pipeline. Preset id + options ride env:
  //   MOGGING_DEV_PRESET (required) · MOGGING_DEV_BASEURL (optional).
  const runDev = async (): Promise<void> => {
    await sleep(2500)
    const presetId = process.env.MOGGING_DEV_PRESET ?? ''
    let out: Record<string, unknown>
    if (mode === 'DEVREMOVE') {
      const { mgrRemoveFrom } = await import('../mcp-manager')
      out = { mode, presetId, removed: mgrRemoveFrom(presetId, 'claude-code') }
    } else {
      out = { mode, presetId, connect: catConnect(presetId, ['claude-code'], { baseUrl: process.env.MOGGING_DEV_BASEURL || undefined }) }
    }
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'mcpcat-dev.json'), JSON.stringify(out, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(0)
  }
  if (dev) {
    setTimeout(() => void runDev(), 1500)
    return
  }

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'mcpcat-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(2500)
      const fixRoot = join(app.getPath('userData'), 'mcpcat-fixtures')
      const homes: CliHomes = { home: join(fixRoot, 'home'), codexDir: join(fixRoot, 'codex'), geminiDir: join(fixRoot, 'gemini') }
      mkdirSync(homes.home, { recursive: true })
      mkdirSync(homes.codexDir, { recursive: true })
      mkdirSync(homes.geminiDir, { recursive: true })
      const claudeFile = join(homes.home, '.claude.json')
      const codexFile = join(homes.codexDir, 'config.toml')
      const geminiFile = join(homes.geminiDir, 'settings.json')

      // ── (a) a preset lands dialect-correct in all three (PostHog: token) ───
      // authKind pinned: posthog's authKinds are oauth-FIRST since app-held
      // connections landed, so a default catConnect picks oauth and lands no
      // Authorization header — this step tests the TOKEN dialect on purpose.
      const posthog = catConnect('posthog', ['claude-code', 'codex', 'gemini'], { authKind: 'token' }, homes)
      const claudeJson = JSON.parse(readFileSync(claudeFile, 'utf8')) as {
        mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>
      }
      const codexText = readFileSync(codexFile, 'utf8')
      const geminiJson = JSON.parse(readFileSync(geminiFile, 'utf8')) as {
        mcpServers?: Record<string, { httpUrl?: string; headers?: Record<string, string> }>
      }
      const dialectOk =
        posthog.ok &&
        claudeJson.mcpServers?.posthog?.url === 'https://mcp.posthog.com/mcp' &&
        claudeJson.mcpServers?.posthog?.headers?.Authorization === 'Bearer ${POSTHOG_API_KEY}' &&
        /\[mcp_servers\.posthog\]\nurl = "https:\/\/mcp\.posthog\.com\/mcp"\nbearer_token_env_var = "POSTHOG_API_KEY"/.test(codexText) &&
        geminiJson.mcpServers?.posthog?.httpUrl === 'https://mcp.posthog.com/mcp'

      // ── (b) n8n: placeholder refuses; the base override lands ──────────────
      const n8nNoBase = catConnect('n8n', ['claude-code'], {}, homes)
      const n8nRefused = !n8nNoBase.ok && /self-hosted|paste/i.test(n8nNoBase.reason ?? '')
      const n8nOk = catConnect('n8n', ['claude-code'], { baseUrl: 'http://127.0.0.1:5678/mcp/fixture-path' }, homes)
      const claudeJson2 = JSON.parse(readFileSync(claudeFile, 'utf8')) as {
        mcpServers?: Record<string, { url?: string }>
      }
      const n8nLanded = n8nOk.ok && claudeJson2.mcpServers?.n8n?.url === 'http://127.0.0.1:5678/mcp/fixture-path'

      // ── (c) the GROUP lands all rows ────────────────────────────────────────
      const gw = catConnect('gw-drive', ['claude-code'], {}, homes)
      const claudeJson3 = JSON.parse(readFileSync(claudeFile, 'utf8')) as { mcpServers?: Record<string, unknown> }
      const groupOk =
        gw.ok &&
        ['gw-drive', 'gw-gmail', 'gw-calendar', 'gw-chat'].every((id) => !!claudeJson3.mcpServers?.[id])

      // ── (d) dual-auth: the vault-slot on-ramp exists and converts ───────────
      const github = findPreset('github-mcp')!
      const dualData = github.authKinds.length === 2 && github.envRefSlots.length > 0
      const tokenPrep = presetToServerEntries(github, { authKind: 'token' })
      const oauthPrep = presetToServerEntries(github, { authKind: 'oauth' })
      const dualOk =
        dualData &&
        tokenPrep.ok && tokenPrep.entries[0].headers?.Authorization === 'Bearer ${GITHUB_PAT}' &&
        oauthPrep.ok && oauthPrep.entries[0].headers === undefined

      // ── (e) registry drafts through the SAME pipeline ──────────────────────
      const port = await new Promise<number>((resolve) => {
        registryServer = createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(req.url?.includes('/v0/servers') ? JSON.stringify(FIXTURE_REGISTRY) : '{}')
        })
        registryServer.listen(0, '127.0.0.1', () => {
          const addr = registryServer?.address()
          resolve(typeof addr === 'object' && addr ? addr.port : 0)
        })
      })
      const feed = await fetchRegistry('acme', `http://127.0.0.1:${port}`)
      const drafts = feed.drafts ?? []
      const store = getSettingsStore()
      const kv: GrantKv = { get: (k) => store?.getSetting(k) ?? null, set: (k, v) => store?.setSetting(k, v) }
      const draftSaved = drafts.length === 2 && drafts.every((d) => d.draft === true) && saveServer(kv, drafts[0].entry).ok
      const draftApplied = draftSaved && mgrApply(drafts[0].entry.id, 'claude-code', homes).ok
      const registryOk = feed.ok && draftApplied
      // a broken registry never blocks: unparseable -> unavailable
      const broken = await fetchRegistry('x', `http://127.0.0.1:1`) // nothing listens
      const brokenOk = !broken.ok && broken.reason === 'registry unavailable'

      // ── (f) a secret literal refuses on the import/convert path ────────────
      const leaky = presetToServerEntries(
        {
          id: 'leaky',
          label: 'Leaky',
          transport: 'stdio',
          urlOrCommand: 'npx -y @leaky/mcp --token sk-ant-api03-abcdefghijklmnop',
          authKinds: ['none'],
          envRefSlots: [],
          cliQuirks: {},
          grantCopy: 'x',
          verifiedAt: ''
        },
        {}
      )
      const secretRefused = !leaky.ok && /secret|credential/i.test(leaky.ok ? '' : leaky.reason)

      // ── (g) capability gaps dim (pure-fn probe + the real table passes) ────
      const oauthHttp = findPreset('clickup')!
      const gapReason = presetBlockedFor(oauthHttp, {
        cli: 'codex',
        remoteHttp: true,
        oauth: false,
        floor: '0.30',
        authorizeCommand: null,
        mcpConfigFlag: null,
        mcpStrictFlag: null,
        projectScopeFile: null,
        verifiedAt: ''
      })
      const realCap = capabilityFor('codex')!
      const capabilityOk = !!gapReason && /OAuth|proxy/i.test(gapReason) && presetBlockedFor(oauthHttp, realCap) === null

      // ── (h) status read-back parses each CLI's own output ──────────────────
      const claudeOut = 'Checking MCP server health…\n\nposthog: https://mcp.posthog.com/mcp (HTTP) - ✔ Connected\nsentry: https://mcp.sentry.dev/mcp (HTTP) - ! Needs authentication\n'
      const statusOk =
        parseCliMcpList('claude-code', claudeOut, 'posthog') === 'connected' &&
        parseCliMcpList('claude-code', claudeOut, 'sentry') === 'needs-auth' &&
        parseCliMcpList('claude-code', claudeOut, 'nothere') === 'absent' &&
        parseCliMcpList('codex', 'posthog  enabled\n', 'posthog') === 'listed'

      // ── (i) the update feed is PREVIEW only ─────────────────────────────────
      // The fixture registry rides catRefresh's baseUrl PARAMETER — the env override
      // this smoke used to set is closed (ADR 0016: origins are pinned in code).
      const before = readFileSync(claudeFile, 'utf8')
      const refresh = await catRefresh('posthog', `http://127.0.0.1:${port}`)
      const previewOnly = refresh.ok === true && /preview only|matches/.test(refresh.diff ?? '') && readFileSync(claudeFile, 'utf8') === before

      // roster order sanity: n8n first, the GW group second (founder priority).
      const rosterOk = MCP_PRESETS[0].id === 'n8n' && MCP_PRESETS[1].group === 'google-workspace'

      const pass =
        dialectOk && n8nRefused && n8nLanded && groupOk && dualOk &&
        registryOk && brokenOk && secretRefused && capabilityOk && statusOk && previewOnly && rosterOk
      result = {
        pass,
        dialectOk,
        n8nRefused,
        n8nLanded,
        groupOk,
        dualOk,
        registryOk,
        brokenOk,
        secretRefused,
        capabilityOk,
        statusOk,
        previewOnly,
        rosterOk,
        presetCount: MCP_PRESETS.length
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    registryServer?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1500)
}

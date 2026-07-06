import { app, dialog, ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  applyState,
  capabilityFor,
  fetchRegistry,
  findPreset,
  findWriter,
  listStoredServers,
  parseCliMcpList,
  presetBlockedFor,
  presetToServerEntries,
  removeStoredServer,
  saveServer,
  sha256,
  CLI_CAPABILITIES,
  MCP_PRESETS,
  MCP_WRITERS,
  type CliHomes,
  type GrantKv
} from '@backend/features/integrations'
import { detectAgents } from '@backend/features/agents'
import { execFile } from 'node:child_process'
import { getSettingsStore } from './app-settings'
import {
  IntegrationsChannels,
  type HostedCliId,
  type McpAuthKind,
  type McpCliStatus,
  type McpPreset,
  type McpServerEntry
} from '@contracts'

// The MCP manager's app wiring (Phase-8/06, ADR 0008.b). The app ORCHESTRATES
// config files the CLIs own — it never runs, proxies, or authenticates a
// server. Every write: explicit user action + a same-session timestamped
// backup first; drift is detected read-only and never auto-healed. The smoke
// passes fixture homes; real homes resolve from the pointer envs the CLIs
// themselves honor.

const kv = (): GrantKv | null => {
  const store = getSettingsStore()
  if (!store) return null
  return { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }
}

const hashKey = (cli: string, id: string): string => `integrations.mgr.hash.${cli}.${id}`

/** Per-OS/pointer-env config homes — the CLIs' own resolution, mirrored. */
export function resolveCliHomes(): CliHomes {
  const home = homedir()
  return {
    home,
    codexDir: process.env.CODEX_HOME || join(home, '.codex'),
    geminiDir: process.env.GEMINI_CONFIG_DIR || join(home, '.gemini')
  }
}

/** The built-in house row — one entry, whole app; never stored, never edited. */
export function houseServerEntry(): McpServerEntry {
  return {
    id: 'mogging',
    label: 'MoggingLabs',
    transport: 'stdio',
    command: 'node',
    args: [join(app.getAppPath(), 'bin', 'mogging-mcp.mjs')],
    builtIn: true
  }
}

export function listServers(): McpServerEntry[] {
  const store = kv()
  return [houseServerEntry(), ...(store ? listStoredServers(store) : [])]
}

const findServer = (id: string): McpServerEntry | undefined => listServers().find((s) => s.id === id)

// One backup per file per session, taken before OUR first write to it.
const backedUpThisSession = new Set<string>()
function ensureBackup(file: string): string | undefined {
  if (backedUpThisSession.has(file) || !existsSync(file)) {
    backedUpThisSession.add(file)
    return undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17)
  const backup = `${file}.bak-${stamp}`
  copyFileSync(file, backup)
  backedUpThisSession.add(file)
  return backup
}

const readIfExists = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null)

const CLI_DETECT_ID: Record<HostedCliId, string> = { 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' }

export function mgrStatus(serverId: string, homes: CliHomes = resolveCliHomes()): McpCliStatus[] {
  const store = kv()
  const detected = detectAgents()
  return MCP_WRITERS.map((w) => {
    const file = w.targetFile(homes)
    const stored = store?.get(hashKey(w.cli, serverId)) ?? null
    return {
      cli: w.cli,
      installed: detected.find((a) => a.id === CLI_DETECT_ID[w.cli])?.installed ?? false,
      file,
      state: applyState(readIfExists(file), w, serverId, stored)
    }
  })
}

export function mgrPreview(
  serverId: string,
  cli: HostedCliId,
  action: 'apply' | 'remove',
  homes: CliHomes = resolveCliHomes()
): { file: string; block: string; summary: string } | null {
  const writer = findWriter(cli)
  const entry = findServer(serverId)
  if (!writer || !entry) return null
  const file = writer.targetFile(homes)
  return {
    file,
    block: action === 'apply' ? writer.renderBlock(entry) : '',
    summary:
      action === 'apply'
        ? `Adds "${entry.label}" to ${cli} — this block lands in ${file}`
        : `Removes "${entry.label}" from ${cli} — only our managed entry leaves ${file}`
  }
}

export function mgrApply(
  serverId: string,
  cli: HostedCliId,
  homes: CliHomes = resolveCliHomes()
): { ok: boolean; reason?: string; backup?: string } {
  const writer = findWriter(cli)
  const entry = findServer(serverId)
  const store = kv()
  if (!writer || !entry || !store) return { ok: false, reason: 'unknown server or CLI' }
  const file = writer.targetFile(homes)
  try {
    const current = readIfExists(file)
    const next = writer.upsert(current, entry)
    const backup = ensureBackup(file)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next, 'utf8')
    store.set(hashKey(cli, serverId), sha256(writer.canonical(entry)))
    return { ok: true, backup }
  } catch (e) {
    return { ok: false, reason: `could not update ${file}: ${String(e).slice(0, 160)}` }
  }
}

export function mgrRemoveFrom(
  serverId: string,
  cli: HostedCliId,
  homes: CliHomes = resolveCliHomes()
): { ok: boolean; reason?: string } {
  const writer = findWriter(cli)
  const store = kv()
  if (!writer || !store) return { ok: false, reason: 'unknown CLI' }
  const file = writer.targetFile(homes)
  try {
    const current = readIfExists(file)
    if (current !== null) {
      const next = writer.remove(current, serverId)
      if (next !== current) {
        ensureBackup(file)
        writeFileSync(file, next, 'utf8')
      }
    }
    store.set(hashKey(cli, serverId), '')
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `could not update ${file}: ${String(e).slice(0, 160)}` }
  }
}

/** Drift verbs: adopt = accept the hand-edited block as ours (hash := current);
 *  forget = drop our claim (for drift-missing — the entry is gone anyway). */
export function mgrAdopt(serverId: string, cli: HostedCliId, forget: boolean, homes: CliHomes = resolveCliHomes()): void {
  const writer = findWriter(cli)
  const store = kv()
  if (!writer || !store) return
  if (forget) {
    store.set(hashKey(cli, serverId), '')
    return
  }
  try {
    const current = readIfExists(writer.targetFile(homes))
    const block = current === null ? null : writer.readCanonical(current, serverId)
    if (block) store.set(hashKey(cli, serverId), sha256(block))
  } catch {
    /* unparseable — nothing to adopt */
  }
}

export function mgrBackups(cli: HostedCliId, homes: CliHomes = resolveCliHomes()): string[] {
  const writer = findWriter(cli)
  if (!writer) return []
  const file = writer.targetFile(homes)
  try {
    const dir = dirname(file)
    const base = basename(file)
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`))
      .sort()
      .reverse()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

// ── The catalog pipeline (8/07): preset -> entries -> save -> 06's writers ──
const KV_CUSTOM_PRESETS = 'integrations.presets.custom'

function customPresets(): McpPreset[] {
  try {
    const raw = kv()?.get(KV_CUSTOM_PRESETS)
    return raw ? (JSON.parse(raw) as McpPreset[]) : []
  } catch {
    return []
  }
}

const findAnyPreset = (id: string): McpPreset | undefined => findPreset(id) ?? customPresets().find((p) => p.id === id)

export function catConnect(
  presetId: string,
  clis: HostedCliId[],
  opts: { baseUrl?: string; authKind?: McpAuthKind } = {},
  homes: CliHomes = resolveCliHomes()
): { ok: boolean; reason?: string; results?: { cli: HostedCliId; ok: boolean; reason?: string }[] } {
  const preset = findAnyPreset(String(presetId))
  const store = kv()
  if (!preset || !store) return { ok: false, reason: 'unknown preset' }
  const prep = presetToServerEntries(preset, opts)
  if (!prep.ok) return prep
  // ONE pipeline: every entry becomes a registry row (same refusals), then
  // 06's writers land it per selected CLI — never a side door.
  for (const entry of prep.entries) {
    const saved = saveServer(store, entry)
    if (!saved.ok) return { ok: false, reason: saved.reason }
  }
  const results = clis.map((cli) => {
    const cap = capabilityFor(cli)
    const blocked = cap ? presetBlockedFor(preset, cap) : 'unknown CLI'
    if (blocked) return { cli, ok: false, reason: blocked }
    for (const entry of prep.entries) {
      const r = mgrApply(entry.id, cli, homes)
      if (!r.ok) return { cli, ok: false, reason: r.reason }
    }
    return { cli, ok: true }
  })
  return { ok: results.some((r) => r.ok), results }
}

/** The update FEED: registry lookup for a preset — PREVIEW text only, never
 *  applied, never trusted (an explicit user action applies via Connect). */
export async function catRefresh(presetId: string): Promise<{ ok: boolean; diff?: string; reason?: string }> {
  const preset = findAnyPreset(String(presetId))
  if (!preset) return { ok: false, reason: 'unknown preset' }
  const feed = await fetchRegistry(preset.label)
  if (!feed.ok || !feed.drafts?.length) return { ok: false, reason: feed.reason ?? 'no registry match' }
  const match = feed.drafts[0]
  const current = preset.transport === 'http' ? preset.urlOrCommand : preset.urlOrCommand
  const proposed = match.entry.url ?? [match.entry.command, ...(match.entry.args ?? [])].join(' ')
  const diff =
    current === proposed
      ? `registry matches the preset (${current})`
      : `preset: ${current}\nregistry (${match.name}, community): ${proposed}\n— preview only; nothing was changed`
  return { ok: true, diff }
}

const CLI_BIN: Record<HostedCliId, string> = { 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' }

/** One-shot status read-back from the CLI's OWN list output (presence only;
 *  the live registry/poller is 8/11's). Never reads a token store. */
export function catAuthStatus(serverId: string, cli: HostedCliId): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      CLI_BIN[cli],
      ['mcp', 'list'],
      { timeout: 30000, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => {
        if (err && !String(stdout)) {
          resolve('unknown')
          return
        }
        resolve(parseCliMcpList(cli, String(stdout), String(serverId)))
      }
    )
  })
}

export function registerMcpManager(): void {
  ipcMain.handle(IntegrationsChannels.serversList, () => listServers())
  ipcMain.handle(IntegrationsChannels.serversSave, (_e, raw: unknown) => {
    const store = kv()
    return store ? saveServer(store, raw) : { ok: false, reason: 'store not ready' }
  })
  ipcMain.handle(IntegrationsChannels.serversRemove, (_e, id: string) => {
    const store = kv()
    if (!store) return { ok: false, reason: 'store not ready' }
    const applied = mgrStatus(String(id)).filter((s) => s.state === 'applied' || s.state === 'drift-edited')
    if (applied.length) return { ok: false, reason: `remove it from ${applied.map((s) => s.cli).join(', ')} first` }
    removeStoredServer(store, String(id))
    return { ok: true }
  })
  ipcMain.handle(IntegrationsChannels.mgrStatus, (_e, serverId: string) => mgrStatus(String(serverId)))
  ipcMain.handle(IntegrationsChannels.mgrPreview, (_e, p: { serverId: string; cli: HostedCliId; action: 'apply' | 'remove' }) =>
    mgrPreview(String(p?.serverId), p?.cli, p?.action === 'remove' ? 'remove' : 'apply')
  )
  ipcMain.handle(IntegrationsChannels.mgrApply, (_e, p: { serverId: string; cli: HostedCliId }) =>
    mgrApply(String(p?.serverId), p?.cli)
  )
  ipcMain.handle(IntegrationsChannels.mgrRemoveFrom, (_e, p: { serverId: string; cli: HostedCliId }) =>
    mgrRemoveFrom(String(p?.serverId), p?.cli)
  )
  ipcMain.handle(IntegrationsChannels.mgrAdopt, (_e, p: { serverId: string; cli: HostedCliId; forget?: boolean }) =>
    mgrAdopt(String(p?.serverId), p?.cli, !!p?.forget)
  )
  ipcMain.handle(IntegrationsChannels.mgrBackups, (_e, cli: HostedCliId) => mgrBackups(cli))

  // ── The catalog (8/07) ─────────────────────────────────────────────────────
  ipcMain.handle(IntegrationsChannels.catList, () => ({ presets: MCP_PRESETS, custom: customPresets() }))
  ipcMain.handle(IntegrationsChannels.catCapabilities, () => CLI_CAPABILITIES)
  ipcMain.handle(IntegrationsChannels.catPrepare, (_e, p: { presetId: string; baseUrl?: string; authKind?: McpAuthKind }) => {
    const preset = findAnyPreset(String(p?.presetId))
    if (!preset) return { ok: false, reason: 'unknown preset' }
    return presetToServerEntries(preset, { baseUrl: p?.baseUrl, authKind: p?.authKind })
  })
  ipcMain.handle(
    IntegrationsChannels.catConnect,
    (_e, p: { presetId: string; clis: HostedCliId[]; baseUrl?: string; authKind?: McpAuthKind }) =>
      catConnect(String(p?.presetId), Array.isArray(p?.clis) ? p.clis : [], { baseUrl: p?.baseUrl, authKind: p?.authKind })
  )
  ipcMain.handle(IntegrationsChannels.catRegistry, (_e, search: string) => fetchRegistry(String(search ?? '')))
  ipcMain.handle(IntegrationsChannels.catImport, (_e, json: string) => {
    const store = kv()
    if (!store) return { ok: false, reason: 'store not ready' }
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(String(json)) as Record<string, unknown>
    } catch {
      return { ok: false, reason: 'not valid JSON' }
    }
    const preset: McpPreset = {
      id: String(raw.id ?? '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 48),
      label: String(raw.label ?? raw.id ?? '').slice(0, 80),
      transport: raw.transport === 'stdio' ? 'stdio' : 'http',
      urlOrCommand: String(raw.urlOrCommand ?? ''),
      authKinds: Array.isArray(raw.authKinds) ? (raw.authKinds.filter((k) => k === 'oauth' || k === 'token' || k === 'none') as McpAuthKind[]) : ['none'],
      envRefSlots: Array.isArray(raw.envRefSlots) ? raw.envRefSlots.map(String) : [],
      cliQuirks: {},
      grantCopy: String(raw.grantCopy ?? 'Community preset — not house-vetted. Review before granting anything.').slice(0, 300),
      verifiedAt: '' // imported = community; a blank date renders the DRAFT badge
    }
    if (!preset.id || !preset.urlOrCommand) return { ok: false, reason: 'a preset needs an id and a url/command' }
    // The SAME refusals as every on-ramp: converting must produce a valid,
    // secret-free entry (the redactor deny-list runs inside).
    const probe = presetToServerEntries(preset, { authKind: preset.authKinds[0] })
    if (!probe.ok) return probe
    const rows = customPresets().filter((c) => c.id !== preset.id)
    rows.push(preset)
    store.set(KV_CUSTOM_PRESETS, JSON.stringify(rows))
    return { ok: true }
  })
  ipcMain.handle(IntegrationsChannels.catExport, async (_e, presetId: string) => {
    const preset = findAnyPreset(String(presetId))
    if (!preset) return false
    const pick = await dialog.showSaveDialog({
      title: 'Export preset',
      defaultPath: `mcp-preset-${preset.id}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (pick.canceled || !pick.filePath) return false
    try {
      writeFileSync(pick.filePath, JSON.stringify(preset, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle(IntegrationsChannels.catRefresh, (_e, presetId: string) => catRefresh(String(presetId)))
  ipcMain.handle(IntegrationsChannels.catAuthStatus, (_e, p: { serverId: string; cli: HostedCliId }) =>
    catAuthStatus(String(p?.serverId), p?.cli)
  )
}

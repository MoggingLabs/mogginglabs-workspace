import { app, ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  applyState,
  findWriter,
  listStoredServers,
  removeStoredServer,
  saveServer,
  sha256,
  MCP_WRITERS,
  type CliHomes,
  type GrantKv
} from '@backend/features/integrations'
import { detectAgents } from '@backend/features/agents'
import { getSettingsStore } from './app-settings'
import {
  IntegrationsChannels,
  type HostedCliId,
  type McpCliStatus,
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
}

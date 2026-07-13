import { dialog, ipcMain } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { getCliRuntime } from './cli-runtime'
import { maybeFault } from './fault-port'
import { authRunnerAuditCapabilities, interceptAuthRunnerConnect } from './authrunner-audit-faults'
import { consumeServerRegisterFailure } from './secretform-audit-faults'
import { serviceKeyClear, serviceKeyNames, serviceKeySet } from './service-keys'
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
// server. Every feature write: explicit user action, a timestamped backup of the bytes
// we are about to replace, and a temp-file+rename so the CLI reading the same
// file never sees half a config; a file that changed under us refuses rather
// than clobbers. Drift is detected read-only and never auto-healed. The smoke
// passes fixture homes; real homes resolve from the pointer envs the CLIs
// themselves honor. The one boot migration below only refreshes an unchanged,
// hash-verified house entry whose old protocol-versioned runtime path would stop working.

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
    geminiDir: process.env.GEMINI_CONFIG_DIR || join(process.env.GEMINI_CLI_HOME || home, '.gemini')
  }
}

/** The built-in house row — one entry, whole app; never stored, never edited. */
export function houseServerEntry(): McpServerEntry {
  const runtime = getCliRuntime()
  return {
    id: 'mogging',
    label: 'MoggingLabs',
    transport: 'stdio',
    command: runtime.executable,
    args: [runtime.mcpEntry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    builtIn: true
  }
}

export function listServers(): McpServerEntry[] {
  const store = kv()
  return [houseServerEntry(), ...(store ? listStoredServers(store) : [])]
}

const findServer = (id: string): McpServerEntry | undefined => listServers().find((s) => s.id === id)

// A backup before OUR write — of the bytes that are actually there. Keyed by the
// CONTENT we last saved, not by "did we back this file up once this session": the
// live CLI rewrites ~/.claude.json constantly, so a second apply in one session
// was landing on state no backup had ever seen.
const backedUp = new Map<string, string>()
function ensureBackup(file: string, current: string | null): string | undefined {
  if (current === null) return undefined // nothing on disk to lose
  const hash = sha256(current)
  if (backedUp.get(file) === hash) return undefined // these exact bytes are already saved
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const base = `${file}.bak-${stamp}-${process.pid}`
  let backup = base
  for (let suffix = 1; existsSync(backup); suffix++) backup = `${base}-${suffix}`
  copyFileSync(file, backup)
  backedUp.set(file, hash)
  return backup
}

/** Temp file in the SAME directory, then rename: a reader (the running CLI) sees
 *  either the old file or the new one, never a half-written config — and a crash
 *  mid-write leaves the original intact. */
class ConcurrentConfigWriteError extends Error {}

function writeAtomic(file: string, text: string, expected: string | null): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    let mode = 0o600
    if (expected !== null) {
      try {
        mode = statSync(file).mode & 0o777
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ConcurrentConfigWriteError()
        throw err
      }
    }
    writeFileSync(tmp, text, { encoding: 'utf8', mode })
    if (process.platform !== 'win32') chmodSync(tmp, mode)
    // Recheck after the replacement bytes exist, immediately before rename. External CLIs do
    // not honor our locks, so this is the narrowest honest compare-before-swap boundary.
    if (!fileMatchesExpected(file, expected)) throw new ConcurrentConfigWriteError()
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* never written */
    }
    throw e
  }
}

const readIfExists = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Compare the actual file bytes, not two UTF-8-decoded strings. Invalid text fails closed. */
function fileMatchesExpected(file: string, expected: string | null): boolean {
  try {
    if (expected === null) return !existsSync(file)
    return readFileSync(file).equals(Buffer.from(expected, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return expected === null
    throw err
  }
}

/** Optimistic concurrency, one line: the file we are about to replace must still
 *  be the file we READ. `~/.claude.json` also holds the CLI's own unrelated state
 *  and the CLI rewrites it whenever it likes — a write that lands in our
 *  read→write window would be silently eaten by our stale copy. */
const changedUnderUs = (file: string, seen: string | null): boolean => !fileMatchesExpected(file, seen)

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
  // The PLAIN one-liner (8/13) — derived from the SAME writer data, no config
  // dialect: CLI display name + scope. Global writes reach every workspace.
  const cliName = CLI_DISPLAY[cli]
  return {
    file,
    block: action === 'apply' ? writer.renderBlock(entry) : '',
    summary:
      action === 'apply'
        ? `Adds ${entry.label} to ${cliName} — all workspaces`
        : `Removes ${entry.label} from ${cliName} — all workspaces`
  }
}

export function mgrApply(
  serverId: string,
  cli: HostedCliId,
  homes: CliHomes = resolveCliHomes(),
  expected?: { current: string | null }
): { ok: boolean; reason?: string; backup?: string } {
  const writer = findWriter(cli)
  const entry = findServer(serverId)
  const store = kv()
  if (!writer || !entry || !store) return { ok: false, reason: 'unknown server or CLI' }
  const file = writer.targetFile(homes)
  try {
    const current = readIfExists(file)
    // Boot-time runtime migration first proves that the exact managed block is still ours,
    // then arrives here. Recheck the whole file before deriving a replacement so a CLI/user
    // edit in that gap is never folded into an automatic write.
    if (expected && (current !== expected.current || !fileMatchesExpected(file, expected.current))) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    const next = writer.upsert(current, entry)
    if (changedUnderUs(file, current)) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    const backup = ensureBackup(file, current)
    writeAtomic(file, next, current)
    store.set(hashKey(cli, serverId), sha256(writer.canonical(entry)))
    return { ok: true, backup }
  } catch (e) {
    if (e instanceof ConcurrentConfigWriteError) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    return { ok: false, reason: `could not update ${file}: ${String(e).slice(0, 160)}` }
  }
}

/**
 * Upgrade only the exact managed house blocks this app last wrote. User-edited/drifted entries
 * are left alone. Refreshing every hash-matching canonical difference also repairs a moved or
 * reinstalled Electron executable, not only the one-time versioned-MCP-path transition.
 */
export function refreshManagedHouseRuntime(homes: CliHomes = resolveCliHomes()): HostedCliId[] {
  const store = kv()
  if (!store) return []
  const refreshed: HostedCliId[] = []
  const desired = houseServerEntry()
  for (const writer of MCP_WRITERS) {
    try {
      const file = writer.targetFile(homes)
      const current = readIfExists(file)
      const stored = store.get(hashKey(writer.cli, 'mogging'))
      if (current === null || !stored) continue
      const block = writer.readCanonical(current, 'mogging')
      if (!block || sha256(block) !== stored) continue
      if (sha256(writer.canonical(desired)) === stored) continue
      if (mgrApply('mogging', writer.cli, homes, { current }).ok) refreshed.push(writer.cli)
    } catch {
      /* malformed or concurrently edited config: preserve it and retry on a later launch */
    }
  }
  return refreshed
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
      if (next === current) {
        // Nothing spliced. If the id is STILL in the file, it is not ours to cut
        // (the _managedBy marker was stripped, or the codex tag/header adjacency
        // was hand-edited): reporting "removed" would leave the user believing the
        // server is off this CLI while the CLI loads it every session. A truly
        // absent entry still reports ok — removing nothing IS the state asked for.
        if (writer.hasEntry(current, serverId)) {
          return { ok: false, reason: `${serverId} is still defined in ${file} but isn't ours to splice out — remove that entry by hand` }
        }
      } else {
        if (changedUnderUs(file, current)) {
          return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
        }
        ensureBackup(file, current)
        writeAtomic(file, next, current)
      }
    }
    store.set(hashKey(cli, serverId), '')
    return { ok: true }
  } catch (e) {
    if (e instanceof ConcurrentConfigWriteError) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
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
  if (!clis.length) return { ok: false, reason: 'pick at least one CLI' }
  const prep = presetToServerEntries(preset, opts)
  if (!prep.ok) return prep
  // ONE pipeline: every entry becomes a registry row (same refusals), then
  // 06's writers land it per selected CLI — never a side door.
  // A GROUP preset is several rows: probe them ALL against the same refusals
  // first (a dry-run store — reads real rows, writes none), so a refusal on the
  // last row can't strand the first ones in the registry.
  const dryRun: GrantKv = { get: (k) => store.get(k), set: () => {} }
  for (const entry of prep.entries) {
    const probe = saveServer(dryRun, entry)
    if (!probe.ok) return { ok: false, reason: probe.reason }
  }
  for (const entry of prep.entries) saveServer(store, entry)
  const results = clis.map((cli) => {
    const cap = capabilityFor(cli)
    const selectedAuth = opts.authKind && preset.authKinds.includes(opts.authKind) ? opts.authKind : preset.authKinds[0]
    const blocked = cap ? presetBlockedFor(preset, cap, selectedAuth) : 'unknown CLI'
    if (blocked) return { cli, ok: false, reason: blocked }
    // Continue on error: stopping at the first failing row left the EARLIER rows
    // written into this CLI's config while the card called the whole thing off.
    const failed = prep.entries
      .map((entry) => ({ id: entry.id, r: mgrApply(entry.id, cli, homes) }))
      .filter((x) => !x.r.ok)
    if (failed.length) return { cli, ok: false, reason: failed.map((f) => `${f.id}: ${f.r.reason}`).join('; ').slice(0, 240) }
    return { cli, ok: true }
  })
  // Connected means CONNECTED: every selected CLI took every row. `some` called a
  // card green when one CLI landed and the rest silently didn't.
  const bad = results.filter((r) => !r.ok)
  if (!bad.length) return { ok: true, results }
  return { ok: false, reason: bad.map((b) => `${CLI_DISPLAY[b.cli]} — ${b.reason}`).join(' · ').slice(0, 300), results }
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
export const CLI_DISPLAY: Record<HostedCliId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' }

/** One-shot status read-back from the CLI's OWN list output (presence only;
 *  the live registry/poller is 8/11's). Never reads a token store. */
/** Run the CLI's OWN `mcp list` ONCE and return raw stdout (or null on hard
 *  failure) — the poller parses it per server (11). Never a token store. */
export function cliMcpListRaw(cli: HostedCliId): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(CLI_BIN[cli], ['mcp', 'list'], { timeout: 30000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
      resolve(err && !String(stdout) ? null : String(stdout))
    })
  })
}

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
  refreshManagedHouseRuntime()
  ipcMain.handle(IntegrationsChannels.serversList, () => listServers())
  ipcMain.handle(IntegrationsChannels.serversSave, (_e, raw: unknown) => {
    // The audit seam (finding 35). saveServer never touches the vault — which is exactly why
    // a register that refuses AFTER the add-server form vaulted its env literals leaves them
    // ORPHANED. The gate fails the register right here to prove the form rolls them back.
    // Inert (a null check) unless the SECRETFORMS gate armed it.
    if (consumeServerRegisterFailure()) return { ok: false, reason: 'injected register failure' }
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
  ipcMain.handle(IntegrationsChannels.catCapabilities, () => authRunnerAuditCapabilities(CLI_CAPABILITIES))
  ipcMain.handle(IntegrationsChannels.catPrepare, async (_e, p: { presetId: string; baseUrl?: string; authKind?: McpAuthKind }) => {
    // Finding 39's seam: the Preview button's ONE read. It disabled itself on click and re-enabled
    // on the line AFTER the await — reject this and the button was stranded disabled forever, so
    // the gate must be able to fail the same handler the panel really calls.
    await maybeFault(IntegrationsChannels.catPrepare)
    const preset = findAnyPreset(String(p?.presetId))
    if (!preset) return { ok: false, reason: 'unknown preset' }
    return presetToServerEntries(preset, { baseUrl: p?.baseUrl, authKind: p?.authKind })
  })
  ipcMain.handle(
    IntegrationsChannels.catConnect,
    async (_e, p: { presetId: string; clis: HostedCliId[]; baseUrl?: string; authKind?: McpAuthKind }) => {
      // Finding 39's seam: the same stranding on Connect, and worse — a Connect button that never
      // comes back is an integration you cannot even retry into place.
      await maybeFault(IntegrationsChannels.catConnect)
      const payload = {
        presetId: String(p?.presetId),
        clis: Array.isArray(p?.clis) ? p.clis : [],
        baseUrl: p?.baseUrl,
        authKind: p?.authKind
      }
      return interceptAuthRunnerConnect(payload) ?? catConnect(payload.presetId, payload.clis, {
        baseUrl: payload.baseUrl,
        authKind: payload.authKind
      })
    }
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

  // ── Vault service keys (8/08) — WRITE-ONLY: set / clear / list-presence ─────
  ipcMain.handle(IntegrationsChannels.serviceKeySet, (_e, p: { name: string; value: string }) =>
    serviceKeySet(String(p?.name ?? ''), String(p?.value ?? ''))
  )
  ipcMain.handle(IntegrationsChannels.serviceKeyClear, (_e, name: string) => serviceKeyClear(String(name)))
  ipcMain.handle(IntegrationsChannels.serviceKeyList, () => serviceKeyNames())
}

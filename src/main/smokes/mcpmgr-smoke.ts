import { app, type BrowserWindow } from 'electron'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findWriter, removeStoredServer, saveServer, sha256, validateServerEntry, type CliHomes, type GrantKv } from '@backend/features/integrations'
import { houseServerEntry, mgrApply, mgrRemoveFrom, mgrStatus, refreshManagedHouseRuntime } from '../mcp-manager'
import { getSettingsStore } from '../app-settings'
import { getCliRuntime } from '../cli-runtime'

// Env-gated MCP-manager smoke (MOGGING_MCPMGR, Phase-8/06). FIXTURE config
// homes only — temp dirs with realistic files, foreign entries, and odd (but
// CLI-plausible) formatting; ZERO writes to real user homes. Asserts:
//   add/apply lands the right dialect in all three CLIs · foreign keys and
//   lines survive our add + remove BYTE-IDENTICAL · a timestamped backup
//   exists before the session's first write · remove extracts only our
//   entry · a secret-shaped env literal is refused at save · an out-of-band
//   edit of our block reads as drift (and adopt/forget stay explicit) ·
//   both Claude-config vintages (existing file / no file) are handled.

// Realistic formatting = what the CLI's own writer produces (stringify-shaped:
// multi-line arrays, two-space indent). Exotic hand formatting normalizes —
// the backup + diff preview is the safety net (IMPLEMENTATION §06).
const FOREIGN_CLAUDE = `{
  "numStartups": 42,
  "mcpServers": {
    "foreign-tool": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@foreign/mcp"
      ]
    }
  },
  "tipsHistory": {
    "new-user-warmup": 1
  }
}
`

const FOREIGN_CODEX = `model = "o3" # keep on o3
approval_policy = "on-request"

[mcp_servers.foreign]
command = "npx" # hand-written, do not touch
args = ["-y", "@foreign/mcp"]

[profiles.work]
model = "o3-pro"
`

const FOREIGN_GEMINI = `{
  "theme": "Default",
  "mcpServers": {
    "foreign-tool": {
      "command": "npx",
      "args": [
        "-y",
        "@foreign/mcp"
      ]
    }
  },
  "usageStatisticsEnabled": false
}
`

export function runMcpMgrSmoke(win: BrowserWindow, mode?: string): void {
  const dev = mode === 'DEV' || mode === 'DEVREMOVE'
  if (!dev) setTimeout(() => app.exit(1), 120000) // safety net
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  void win

  // DEV / DEVREMOVE: the dev-verify arm — apply (or remove) the house server
  // on the REAL machine, installed CLIs only (the writer-skipped rule), so
  // each CLI's own `mcp list` can be checked. Backed up like any user write.
  const runDev = async (): Promise<void> => {
    await sleep(2500)
    const statuses = mgrStatus('mogging')
    const acted: Record<string, unknown>[] = []
    for (const s of statuses) {
      if (!s.installed) {
        acted.push({ cli: s.cli, skipped: 'not installed' })
        continue
      }
      const r = mode === 'DEVREMOVE' ? mgrRemoveFrom('mogging', s.cli) : mgrApply('mogging', s.cli)
      acted.push({ cli: s.cli, file: s.file, ...r })
    }
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'mcpmgr-dev.json'), JSON.stringify({ mode, acted }, null, 2))
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
      writeFileSync(join(app.getAppPath(), 'out', 'mcpmgr-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(2500) // app + settings store ready
      const fixRoot = join(app.getPath('userData'), 'mcpmgr-fixtures')
      const homes: CliHomes = { home: join(fixRoot, 'home'), codexDir: join(fixRoot, 'codex'), geminiDir: join(fixRoot, 'gemini') }
      mkdirSync(homes.home, { recursive: true })
      mkdirSync(homes.codexDir, { recursive: true })
      mkdirSync(homes.geminiDir, { recursive: true })
      const claudeFile = join(homes.home, '.claude.json')
      const codexFile = join(homes.codexDir, 'config.toml')
      const geminiFile = join(homes.geminiDir, 'settings.json')
      writeFileSync(claudeFile, FOREIGN_CLAUDE, 'utf8')
      writeFileSync(codexFile, FOREIGN_CODEX, 'utf8')
      writeFileSync(geminiFile, FOREIGN_GEMINI, 'utf8')
      if (process.platform !== 'win32') {
        for (const file of [claudeFile, codexFile, geminiFile]) chmodSync(file, 0o600)
      }
      const privateMode = (file: string): boolean => process.platform === 'win32' || (statSync(file).mode & 0o777) === 0o600

      // ── secret-literal refused at save (the profiles deny-list) ────────────
      const refused = validateServerEntry({
        id: 'leaky',
        label: 'Leaky',
        transport: 'stdio',
        command: 'npx',
        env: { API_KEY: 'sk-ant-api03-abcdefghijklmnop' }
      })
      const secretRefused = !refused.ok && /\$\{VAR\}|secret/.test(refused.ok ? '' : refused.reason)
      const envRefAccepted = validateServerEntry({
        id: 'clean',
        label: 'Clean',
        transport: 'stdio',
        command: 'npx',
        env: { API_KEY: '${POSTHOG_API_KEY}' }
      }).ok

      // ── apply the house server to all three fixture homes ──────────────────
      const runtime = getCliRuntime()
      const house = houseServerEntry()
      const runtimeExact =
        runtime.binDir === dirname(runtime.cliEntry) &&
        runtime.binDir === dirname(runtime.mcpTarget) &&
        runtime.binDir !== dirname(runtime.mcpEntry) &&
        !/(?:dev-)?v\d+$/i.test(dirname(runtime.mcpEntry)) &&
        runtime.executable === house.command &&
        house.args?.length === 1 &&
        house.args[0] === runtime.mcpEntry &&
        // Post-split (ADR 0016): the house row is a bare command on the standalone
        // helper — no env at all, ELECTRON_RUN_AS_NODE least of all.
        house.env === undefined &&
        /mogging-node(\.exe)?$/.test(runtime.executable) &&
        [
          runtime.executable,
          runtime.cliEntry,
          runtime.mcpEntry,
          runtime.mcpTarget,
          runtime.packageMeta,
          join(runtime.binDir, 'mcp-catalog.json'),
          join(runtime.binDir, 'lib', 'endpoint-client.mjs')
        ].every(existsSync)
      const applyResults = (['claude-code', 'codex', 'gemini'] as const).map((cli) => mgrApply('mogging', cli, homes))
      const applied = applyResults.every((r) => r.ok)
      const claudeAfter = readFileSync(claudeFile, 'utf8')
      const codexAfter = readFileSync(codexFile, 'utf8')
      const geminiAfter = readFileSync(geminiFile, 'utf8')
      const modesPreservedAfterApply = [claudeFile, codexFile, geminiFile].every(privateMode)
      const claudeParsed = JSON.parse(claudeAfter) as {
        numStartups?: number
        mcpServers?: Record<string, {
          type?: string
          command?: string
          args?: string[]
          env?: Record<string, string>
          _managedBy?: string
        }>
      }
      const claudeHouse = claudeParsed.mcpServers?.mogging
      const dialectClaude =
        claudeHouse?.type === 'stdio' &&
        claudeHouse.command === runtime.executable &&
        claudeHouse.args?.length === 1 &&
        claudeHouse.args[0] === runtime.mcpEntry &&
        claudeHouse.env === undefined && // the writer omits an absent env (ADR 0016)

        claudeHouse._managedBy === 'mogginglabs' &&
        claudeParsed.numStartups === 42 &&
        claudeParsed.mcpServers?.['foreign-tool']?.command === 'npx'
      const codexHouseCanonical = findWriter('codex')?.canonical(house) ?? ''
      const dialectCodex =
        codexHouseCanonical.length > 0 &&
        codexAfter.includes(codexHouseCanonical) &&
        codexAfter.includes('command = "npx" # hand-written, do not touch') &&
        codexAfter.includes('[profiles.work]')
      const geminiParsed = JSON.parse(geminiAfter) as { mcpServers?: Record<string, Record<string, unknown>>; theme?: string }
      const geminiHouse = geminiParsed.mcpServers?.mogging
      const dialectGemini =
        geminiHouse?.command === runtime.executable &&
        Array.isArray(geminiHouse.args) &&
        geminiHouse.args.length === 1 &&
        geminiHouse.args[0] === runtime.mcpEntry &&
        geminiHouse.env === undefined && // the writer omits an absent env (ADR 0016)
        geminiParsed.theme === 'Default' &&
        !!geminiParsed.mcpServers?.['foreign-tool']

      // A pre-upgrade house block is still ours only when its persisted hash matches exactly.
      // Plant that vN path in all dialects, then prove boot migration rewrites it to the stable
      // launcher while preserving every foreign byte around it.
      const oldExecutable = join(fixRoot, 'old-install', process.platform === 'win32' ? 'MoggingLabs.exe' : 'mogginglabs')
      const settings = getSettingsStore()
      for (const cli of ['claude-code', 'codex', 'gemini'] as const) {
        const writer = findWriter(cli)
        if (!writer) throw new Error(`missing ${cli} writer`)
        const file = writer.targetFile(homes)
        // Cover all three upgrade shapes: the original protocol-versioned MCP target
        // (claude/codex also carrying the pre-split Electron-as-Node env — the exact
        // block every install written before ADR 0016 has on disk), and an
        // already-stable entry whose app executable moved after reinstall/relocation.
        const legacyHouse = cli === 'gemini'
          ? { ...house, command: oldExecutable }
          : { ...house, args: [runtime.mcpTarget], env: { ELECTRON_RUN_AS_NODE: '1' } }
        writeFileSync(file, writer.upsert(readFileSync(file, 'utf8'), legacyHouse), 'utf8')
        settings?.setSetting(`integrations.mgr.hash.${cli}.mogging`, sha256(writer.canonical(legacyHouse)))
      }
      const runtimeRefreshed = refreshManagedHouseRuntime(homes)
      const protocolUpgradeSafe =
        runtimeRefreshed.length === 3 &&
        readFileSync(claudeFile, 'utf8') === claudeAfter &&
        readFileSync(codexFile, 'utf8') === codexAfter &&
        readFileSync(geminiFile, 'utf8') === geminiAfter

      // A third-party config can be temporarily unreadable or even replaced by a directory.
      // Boot-time best-effort refresh must isolate that writer rather than abort app startup.
      const homesUnreadable: CliHomes = {
        home: join(fixRoot, 'home-unreadable'),
        codexDir: join(fixRoot, 'codex-unreadable'),
        geminiDir: join(fixRoot, 'gemini-unreadable')
      }
      mkdirSync(join(homesUnreadable.home, '.claude.json'), { recursive: true })
      let unreadableConfigSafe = false
      try {
        refreshManagedHouseRuntime(homesUnreadable)
        unreadableConfigSafe = true
      } catch {
        unreadableConfigSafe = false
      }

      // Expected-byte writes are the migration's TOCTOU guard: a user/CLI edit after the
      // ownership proof is preserved byte-for-byte and the automatic apply refuses.
      const beforeRace = readFileSync(codexFile, 'utf8')
      const raced = beforeRace.replace('model = "o3"', 'model = "o4"')
      writeFileSync(codexFile, raced, 'utf8')
      const raceApply = mgrApply('mogging', 'codex', homes, { current: beforeRace })
      const migrationRaceRefused = !raceApply.ok && readFileSync(codexFile, 'utf8') === raced
      writeFileSync(codexFile, codexAfter, 'utf8')

      // Distinct invalid UTF-8 byte sequences can decode to the same replacement character.
      // The expected-file guard compares bytes and must refuse rather than normalize/clobber.
      const invalidBytes = Buffer.concat([Buffer.from(codexAfter, 'utf8'), Buffer.from([0x80])])
      writeFileSync(codexFile, invalidBytes)
      const invalidDecoded = readFileSync(codexFile, 'utf8')
      const invalidApply = mgrApply('mogging', 'codex', homes, { current: invalidDecoded })
      const invalidByteRaceRefused = !invalidApply.ok && readFileSync(codexFile).equals(invalidBytes)
      writeFileSync(codexFile, codexAfter, 'utf8')
      if (process.platform !== 'win32') chmodSync(codexFile, 0o600)

      // ── The Gemini http quirk: a remote entry writes `httpUrl`, never `url`
      //    (while Claude Code writes `url`) — a real registry row, round-tripped.
      const store = getSettingsStore()
      const kv: GrantKv = { get: (k) => store?.getSetting(k) ?? null, set: (k, v) => store?.setSetting(k, v) }
      saveServer(kv, { id: 'remotetool', label: 'Remote Tool', transport: 'http', url: 'https://mcp.example.com/mcp' })
      const httpApplied = mgrApply('remotetool', 'gemini', homes).ok && mgrApply('remotetool', 'claude-code', homes).ok
      const geminiHttp = (JSON.parse(readFileSync(geminiFile, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> })
        .mcpServers?.remotetool
      const claudeHttp = (JSON.parse(readFileSync(claudeFile, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> })
        .mcpServers?.remotetool
      const httpQuirkOk =
        httpApplied &&
        geminiHttp?.httpUrl === 'https://mcp.example.com/mcp' && geminiHttp?.url === undefined &&
        claudeHttp?.url === 'https://mcp.example.com/mcp' && claudeHttp?.type === 'http'
      mgrRemoveFrom('remotetool', 'gemini', homes)
      mgrRemoveFrom('remotetool', 'claude-code', homes)
      removeStoredServer(kv, 'remotetool')

      // ── status: applied everywhere ──────────────────────────────────────────
      const statusApplied = mgrStatus('mogging', homes).every((s) => s.state === 'applied')

      // ── backups exist (one per file, this session, before first write) ─────
      const backupsExist = [claudeFile, codexFile, geminiFile].every(
        (file) => existsSync(file) && readdirSync(dirname(file)).some((f) => f.includes('.bak-'))
      )

      // ── drift: an out-of-band edit reads as drift-edited ────────────────────
      const driftedHouse = codexHouseCanonical.replace(/^command = .*$/m, 'command = "deno"')
      const driftedCodex = codexAfter.replace(codexHouseCanonical, driftedHouse)
      if (driftedCodex === codexAfter) throw new Error('could not plant the Codex house-entry drift fixture')
      writeFileSync(codexFile, driftedCodex, 'utf8')
      const driftDetected = mgrStatus('mogging', homes).find((s) => s.cli === 'codex')?.state === 'drift-edited'
      // Restore the exact pre-drift bytes; paths and env are part of the canonical hash.
      writeFileSync(codexFile, codexAfter, 'utf8')

      // ── remove extracts OUR entries only; foreign files byte-identical ─────
      const removeResults = (['claude-code', 'codex', 'gemini'] as const).map((cli) => mgrRemoveFrom('mogging', cli, homes))
      const removed = removeResults.every((r) => r.ok)
      const bytesClaude = readFileSync(claudeFile, 'utf8') === FOREIGN_CLAUDE
      const bytesCodex = readFileSync(codexFile, 'utf8') === FOREIGN_CODEX
      const bytesGemini = readFileSync(geminiFile, 'utf8') === FOREIGN_GEMINI
      const modesPreservedAfterRemove = [claudeFile, codexFile, geminiFile].every(privateMode)
      const statusGone = mgrStatus('mogging', homes).every((s) => s.state === 'not-applied')

      // ── vintage B: NO .claude.json — apply creates a minimal one ────────────
      const homesB: CliHomes = { ...homes, home: join(fixRoot, 'home-b') }
      mkdirSync(homesB.home, { recursive: true })
      const vintageB = mgrApply('mogging', 'claude-code', homesB).ok
      const vintageBParsed = JSON.parse(readFileSync(join(homesB.home, '.claude.json'), 'utf8')) as {
        mcpServers?: Record<string, { _managedBy?: string }>
      }
      const vintageBFile = join(homesB.home, '.claude.json')
      const vintageBOk =
        vintageB &&
        vintageBParsed.mcpServers?.mogging?._managedBy === 'mogginglabs' &&
        privateMode(vintageBFile)

      // ── COLLISION: a foreign entry under OUR id is refused, never clobbered ──
      // The user already hand-wrote a server called `mogging`. Both dialects used to
      // charge ahead: codex appended a SECOND `[mcp_servers.mogging]` table (TOML forbids
      // redefining a table — codex rejects the whole file and the user loses ALL of its
      // config), and the JSON writers silently overwrote the user's entry, stamped it
      // `_managedBy`, and would have deleted it outright on a later Remove. An id we do
      // not own is a refusal, and the file must not move by a single byte.
      const homesC: CliHomes = {
        home: join(fixRoot, 'home-c'),
        codexDir: join(fixRoot, 'codex-c'),
        geminiDir: join(fixRoot, 'gemini-c')
      }
      mkdirSync(homesC.home, { recursive: true })
      mkdirSync(homesC.codexDir, { recursive: true })
      mkdirSync(homesC.geminiDir, { recursive: true })
      const cCodex = join(homesC.codexDir, 'config.toml')
      const cClaude = join(homesC.home, '.claude.json')
      // Untagged (no `# managed-by:` line) — a config the user wrote themselves.
      const HAND_CODEX = '[mcp_servers.mogging]\ncommand = "my-own-binary"\nargs = ["--serve"]\n'
      const HAND_CLAUDE = '{\n  "mcpServers": {\n    "mogging": {\n      "command": "my-own-binary"\n    }\n  }\n}\n'
      writeFileSync(cCodex, HAND_CODEX, 'utf8')
      writeFileSync(cClaude, HAND_CLAUDE, 'utf8')
      const codexCollision = mgrApply('mogging', 'codex', homesC)
      const claudeCollision = mgrApply('mogging', 'claude-code', homesC)
      const collisionRefused = !codexCollision.ok && !claudeCollision.ok
      const collisionBytesKept =
        readFileSync(cCodex, 'utf8') === HAND_CODEX && readFileSync(cClaude, 'utf8') === HAND_CLAUDE
      // And the refusal SAYS why — a silent no is its own bug.
      const collisionExplained = /not managed|already/i.test(String(codexCollision.reason ?? ''))

      const pass =
        secretRefused && envRefAccepted && runtimeExact && protocolUpgradeSafe && unreadableConfigSafe && migrationRaceRefused && invalidByteRaceRefused &&
        modesPreservedAfterApply && modesPreservedAfterRemove && applied && dialectClaude && dialectCodex && dialectGemini &&
        httpQuirkOk && statusApplied && backupsExist && driftDetected &&
        removed && bytesClaude && bytesCodex && bytesGemini && statusGone && vintageBOk &&
        collisionRefused && collisionBytesKept && collisionExplained
      result = {
        pass,
        secretRefused,
        envRefAccepted,
        runtimeExact,
        protocolUpgradeSafe,
        unreadableConfigSafe,
        migrationRaceRefused,
        invalidByteRaceRefused,
        modesPreservedAfterApply,
        modesPreservedAfterRemove,
        applied,
        dialectClaude,
        dialectCodex,
        dialectGemini,
        httpQuirkOk,
        statusApplied,
        backupsExist,
        driftDetected,
        removed,
        bytesClaude,
        bytesCodex,
        bytesGemini,
        statusGone,
        vintageBOk,
        collisionRefused,
        collisionBytesKept,
        collisionExplained,
        codexCollisionReason: codexCollision.reason ?? null,
        claudeCollisionReason: claudeCollision.reason ?? null
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1500)
}

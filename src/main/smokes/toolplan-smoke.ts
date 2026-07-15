import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpServerEntry, WorkspaceToolPlan } from '@contracts'
import { planFromTemplateTools, planSignature, restartNeededPanes, toolCellState } from '@contracts'
import { composePlanEntries, findWriter, materializePlanFor } from '@backend/features/integrations'
import { getCliRuntime, stableMcpLauncherSource, stableRuntimeExecutable } from '../cli-runtime'
import { setToolPlan } from '../integrations'
import { houseServerEntry } from '../mcp-manager'
import {
  gitExcludeInWorktree,
  materializeToolPlanAtLaunch,
  mergeToolPlanProjectConfig,
  toolPlanSkipReason
} from '../tool-plan'

// Env-gated tool-plan smoke (MOGGING_TOOLPLAN, Phase-8/09). Proves scoping is a
// real mechanism, not a label:
//   (a) a plan of {A,B for claude · A for codex} materializes EXACTLY that —
//       claude via --mcp-config + --strict-mcp-config (userData file), codex via
//       a project-scope config.toml;
//   (b) a CLI launched against the materialized file sees ONLY the planned
//       servers (a shim reads --mcp-config and lists them) — the unplanned
//       global is absent;
//   (c) inheritGlobal drops --strict-mcp-config (global comes back);
//   (d) the codex project file is INVISIBLE to git (info/exclude, real repo);
//   (f) a template's picks seed a new workspace's plan;
//   (g) the matrix cell states match the materialized truth.
// Zero network. (e) restart-needed rides 11's connection status — deferred.

const A: McpServerEntry = { id: 'sentry', label: 'Sentry', transport: 'stdio', command: 'sentry-mcp', args: [] }
const B: McpServerEntry = { id: 'linear', label: 'Linear', transport: 'stdio', command: 'linear-mcp', args: [] }
const GLOBAL_ONLY: McpServerEntry = { id: 'posthog', label: 'PostHog', transport: 'stdio', command: 'posthog-mcp', args: [] }

export async function runToolPlanSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mog-toolplan-'))
    const planDir = join(dir, 'userData', 'toolplans')
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const servers = [A, B, GLOBAL_ONLY]
    const fakeAppDir = join(dir, 'appimage-mount')
    const fakeAppImage = join(dir, 'MoggingLabs.AppImage')
    const fakeMountedExecutable = join(fakeAppDir, 'electron')
    mkdirSync(fakeAppDir, { recursive: true })
    writeFileSync(fakeAppImage, 'appimage fixture')
    writeFileSync(fakeMountedExecutable, 'mounted executable fixture')
    const fakeAppImageEnv = { APPIMAGE: fakeAppImage, APPDIR: fakeAppDir }
    const appImageExecutableOk =
      stableRuntimeExecutable('linux', fakeMountedExecutable, fakeAppImageEnv, true) === fakeAppImage &&
      stableRuntimeExecutable('linux', process.execPath, fakeAppImageEnv, true) === process.execPath &&
      stableRuntimeExecutable('linux', fakeMountedExecutable, fakeAppImageEnv, false) === fakeMountedExecutable &&
      stableRuntimeExecutable('win32', fakeMountedExecutable, fakeAppImageEnv, true) === fakeMountedExecutable

    // The protocol-neutral launcher follows an authenticated pane's exact runtime segment, but
    // a path outside the private run root cannot redirect its dynamic import.
    const fakeRunRoot = join(dir, 'launcher-runtime', 'run')
    const fakeCurrentTarget = join(fakeRunRoot, 'v8', 'bin', 'mogging-mcp.mjs')
    const fakePaneTarget = join(fakeRunRoot, 'v7', 'bin', 'mogging-mcp.mjs')
    const fakeLauncher = join(fakeRunRoot, 'mcp', 'mogging-mcp.mjs')
    mkdirSync(dirname(fakeCurrentTarget), { recursive: true })
    mkdirSync(dirname(fakePaneTarget), { recursive: true })
    mkdirSync(dirname(fakeLauncher), { recursive: true })
    writeFileSync(fakeCurrentTarget, "process.stdout.write('current')\n")
    writeFileSync(fakePaneTarget, "process.stdout.write('pane')\n")
    writeFileSync(fakeLauncher, stableMcpLauncherSource(fakeCurrentTarget))
    const launchFixture = (endpoint?: string): string => {
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      if (endpoint) env.MOGGING_DAEMON_ENDPOINT = endpoint
      else delete env.MOGGING_DAEMON_ENDPOINT
      return execFileSync(process.execPath, [fakeLauncher], { encoding: 'utf8', env, windowsHide: true })
    }
    const paneLauncherSelectOk =
      launchFixture() === 'current' &&
      launchFixture(join(fakeRunRoot, 'v7', 'endpoint.json')) === 'pane' &&
      launchFixture(join(dir, 'outside', 'v7', 'endpoint.json')) === 'current'
    const runtime = getCliRuntime()
    const house = houseServerEntry()
    const mcpProbe = execFileSync(runtime.executable, [runtime.mcpEntry], {
      encoding: 'utf8',
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10000,
      windowsHide: true
    })
    const stableMcpLaunchOk =
      /"id":1/.test(mcpProbe) &&
      /"protocolVersion"/.test(mcpProbe) &&
      mcpProbe.includes(`"version":"${app.getVersion()}"`)
    const packageMeta = JSON.parse(readFileSync(runtime.packageMeta, 'utf8')) as Record<string, unknown>
    const packageMetaOk =
      Object.keys(packageMeta).length === 1 &&
      packageMeta.version === app.getVersion()
    const runtimeExact =
      runtime.executable === house.command &&
      house.args?.length === 1 &&
      house.args[0] === runtime.mcpEntry &&
      dirname(runtime.mcpEntry) !== runtime.binDir &&
      dirname(dirname(runtime.mcpEntry)) === dirname(dirname(runtime.binDir)) &&
      !/(?:^|[\\/])(?:dev-)?v\d+(?:[\\/]|$)/i.test(runtime.mcpEntry.slice(dirname(dirname(runtime.mcpEntry)).length)) &&
      readFileSync(runtime.mcpEntry, 'utf8') === stableMcpLauncherSource(runtime.mcpTarget) &&
      Object.keys(house.env ?? {}).length === 1 &&
      house.env?.ELECTRON_RUN_AS_NODE === '1' &&
      [
        runtime.executable,
        runtime.cliEntry,
        runtime.mcpEntry,
        runtime.mcpTarget,
        runtime.packageMeta,
        join(runtime.binDir, 'mcp-catalog.json'),
        join(runtime.binDir, 'lib', 'endpoint-client.mjs')
      ].every(existsSync)

    const plan: WorkspaceToolPlan = {
      workspaceId: 'ws1',
      entries: { sentry: ['claude-code', 'codex'], linear: ['claude-code'] },
      inheritGlobal: false
    }

    // ── (a) claude materialization: flag + strict + a file of EXACTLY the plan ──
    const claudeEntries = composePlanEntries(plan, 'claude-code', servers, house)
    const claudeMat = materializePlanFor({ cli: 'claude-code', entries: claudeEntries, inheritGlobal: false, planDir, cwd: repo, workspaceId: 'ws1' })
    for (const f of claudeMat.files) {
      mkdirSync(join(f.path, '..'), { recursive: true })
      writeFileSync(f.path, f.content)
    }
    const claudeArgsOk =
      claudeMat.launchArgs[0] === '--mcp-config' && claudeMat.launchArgs.includes('--strict-mcp-config') && claudeMat.excludeRelPaths.length === 0
    const claudeConfig = JSON.parse(claudeMat.files[0].content) as {
      mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    }
    const claudeFileKeys = Object.keys(claudeConfig.mcpServers).sort()
    const claudeFileOk = JSON.stringify(claudeFileKeys) === JSON.stringify(['linear', 'mogging', 'sentry']) // planned exactly, no posthog
    const claudeHouse = claudeConfig.mcpServers.mogging
    const claudeHouseExact =
      claudeHouse.command === runtime.executable &&
      claudeHouse.args?.length === 1 &&
      claudeHouse.args[0] === runtime.mcpEntry &&
      Object.keys(claudeHouse.env ?? {}).length === 1 &&
      claudeHouse.env?.ELECTRON_RUN_AS_NODE === '1'

    // ── (a) codex materialization: project-scope file, no flag, git-excluded ────
    const codexEntries = composePlanEntries(plan, 'codex', servers, house)
    const codexMat = materializePlanFor({ cli: 'codex', entries: codexEntries, inheritGlobal: false, planDir, cwd: repo, workspaceId: 'ws1' })
    const codexTomlHasSentry = /\[mcp_servers\.sentry\]/.test(codexMat.files[0].content) && /\[mcp_servers\.mogging\]/.test(codexMat.files[0].content)
    const codexNoLinear = !/\[mcp_servers\.linear\]/.test(codexMat.files[0].content) // linear was claude-only
    const codexHouseCanonical = findWriter('codex')?.canonical(house) ?? ''
    const codexHouseExact = codexHouseCanonical.length > 0 && codexMat.files[0].content.includes(codexHouseCanonical)
    const codexOk =
      codexMat.launchArgs.length === 0 &&
      codexMat.excludeRelPaths[0] === '.codex/config.toml' &&
      codexTomlHasSentry &&
      codexNoLinear &&
      codexHouseExact

    // Provider settings and scoped MCP blocks coexist in the same file. Replanning
    // replaces only app-managed entries and preserves unrelated user settings.
    const codexForeign = 'model = "gpt-5" # user setting\n\n[features]\nweb_search = true\n'
    const codexMerged = mergeToolPlanProjectConfig('codex', codexForeign, codexEntries)
    const codexReplanned = mergeToolPlanProjectConfig('codex', codexMerged, [house])
    const codexCoexistOk =
      codexMerged.includes('model = "gpt-5" # user setting') &&
      codexMerged.includes('[mcp_servers.sentry]') &&
      codexReplanned.includes('[mcp_servers.mogging]') &&
      !codexReplanned.includes('[mcp_servers.sentry]') &&
      codexReplanned.includes('[features]')
    const geminiForeign = '{\n  // user setting\n  "general": { "previewFeatures": true },\n}\n'
    const geminiMerged = mergeToolPlanProjectConfig('gemini', geminiForeign, [house, A])
    const geminiReplanned = mergeToolPlanProjectConfig('gemini', geminiMerged, [house])
    const geminiCoexistOk =
      geminiMerged.includes('// user setting') &&
      geminiMerged.includes('"sentry"') &&
      geminiReplanned.includes('// user setting') &&
      !geminiReplanned.includes('"sentry"') &&
      geminiReplanned.includes('"general"')
    const coexistOk = codexCoexistOk && geminiCoexistOk

    // ── (b) a CLI launched against the file sees ONLY the planned servers ───────
    const shim = join(dir, 'claude-shim.mjs')
    writeFileSync(
      shim,
      `import fs from 'node:fs'
const a = process.argv.slice(2); const i = a.indexOf('--mcp-config')
let keys = []
if (i >= 0 && a[i+1]) { try { keys = Object.keys(JSON.parse(fs.readFileSync(a[i+1],'utf8')).mcpServers||{}) } catch {} }
process.stdout.write('SERVERS=' + keys.sort().join(',') + '|STRICT=' + a.includes('--strict-mcp-config'))
`
    )
    const shimOut = execFileSync(process.execPath, [shim, ...claudeMat.launchArgs], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const listsPlannedOnly = shimOut.includes('SERVERS=linear,mogging,sentry') && !shimOut.includes('posthog') && shimOut.includes('STRICT=true')

    // ── (c) inheritGlobal drops strict (global comes back) ──────────────────────
    const inheritMat = materializePlanFor({ cli: 'claude-code', entries: claudeEntries, inheritGlobal: true, planDir, cwd: repo, workspaceId: 'ws1' })
    const inheritOk = inheritMat.launchArgs[0] === '--mcp-config' && !inheritMat.launchArgs.includes('--strict-mcp-config')

    // ── (d) the codex project file is INVISIBLE to git ──────────────────────────
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git(['init', '-q'])
    git(['config', 'user.email', 'smoke@mogging.test'])
    git(['config', 'user.name', 'smoke'])
    writeFileSync(join(repo, 'README.md'), '# repo\n')
    mkdirSync(join(repo, '.codex'), { recursive: true })
    writeFileSync(join(repo, '.codex', 'config.toml'), codexMat.files[0].content)
    gitExcludeInWorktree(repo, ['.codex/config.toml'])
    const status = git(['status', '--porcelain'])
    const gitInvisibleOk = !status.includes('.codex') && status.includes('README.md')

    // ── (e) a plan edit flips restart-needed on the workspace's live panes ──────
    const sigAtLaunch = planSignature(plan)
    const livePanes = [
      { paneId: 1, launchSig: sigAtLaunch },
      { paneId: 101, launchSig: sigAtLaunch }
    ]
    const beforeEdit = restartNeededPanes(livePanes, sigAtLaunch) // nothing changed -> none
    const editedPlan: WorkspaceToolPlan = { ...plan, entries: { ...plan.entries, sentry: ['claude-code'] } } // A now claude-only
    const sigAfterEdit = planSignature(editedPlan)
    const afterEdit = restartNeededPanes(livePanes, sigAfterEdit) // both launched at the old sig -> both flip
    const restartFlipsOk = sigAtLaunch !== sigAfterEdit && beforeEdit.length === 0 && afterEdit.length === 2

    // ── (f) template picks seed a new workspace's plan ──────────────────────────
    const seeded = planFromTemplateTools('ws2', ['sentry', 'linear'])
    const templateOk = seeded.entries.sentry === 'all-clis' && seeded.entries.linear === 'all-clis' && seeded.inheritGlobal === false

    // ── (g) matrix cells match the materialized truth ───────────────────────────
    const g1 = toolCellState(plan, 'sentry', 'claude-code', false) === 'planned'
    const g2 = toolCellState(plan, 'linear', 'codex', false) === 'off' // claude-only
    const g3 = toolCellState(plan, 'posthog', 'claude-code', false) === 'off'
    const g4 = toolCellState({ ...plan, inheritGlobal: true }, 'posthog', 'claude-code', true) === 'global'
    const matrixOk = g1 && g2 && g3 && g4

    // A scoped launch that collides with the repo's own config is refused
    // truthfully. The user file stays byte-identical and no global fallback
    // command is produced.
    const foreign = '[user]\nkeep = true\n'
    writeFileSync(join(repo, '.codex', 'config.toml'), foreign)
    setToolPlan({ workspaceId: 'ws-conflict', entries: {}, inheritGlobal: false })
    // materializeToolPlanAtLaunch is ASYNC now (it writes through the atomic file port).
    const refused = await materializeToolPlanAtLaunch({ agentId: 'codex', cwd: repo, workspaceId: 'ws-conflict' })
    const foreignRefused =
      !refused.ok &&
      refused.args.length === 0 &&
      readFileSync(join(repo, '.codex', 'config.toml'), 'utf8') === foreign &&
      /not launched|did not fall back/.test(refused.reason ?? '') &&
      toolPlanSkipReason('ws-conflict') === refused.reason

    const pass =
      appImageExecutableOk && paneLauncherSelectOk && runtimeExact && stableMcpLaunchOk && packageMetaOk &&
      claudeArgsOk && claudeFileOk && claudeHouseExact && codexOk && coexistOk && listsPlannedOnly &&
      inheritOk && gitInvisibleOk && restartFlipsOk && templateOk && matrixOk && foreignRefused
    result = {
      pass,
      appImageExecutableOk,
      paneLauncherSelectOk,
      runtimeExact,
      stableMcpLaunchOk,
      packageMetaOk,
      claudeArgsOk,
      claudeFileOk,
      claudeHouseExact,
      codexOk,
      codexHouseExact,
      coexistOk,
      codexCoexistOk,
      geminiCoexistOk,
      listsPlannedOnly,
      inheritOk,
      gitInvisibleOk,
      restartFlipsOk,
      templateOk,
      matrixOk,
      foreignRefused,
      refused,
      shimOut
    }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'toolplan-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}

import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerEntry, WorkspaceToolPlan } from '@contracts'
import { planFromTemplateTools, planSignature, restartNeededPanes, toolCellState } from '@contracts'
import { composePlanEntries, materializePlanFor } from '@backend/features/integrations'
import { gitExcludeInWorktree } from './tool-plan'

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

const HOUSE: McpServerEntry = { id: 'mogging', label: 'MoggingLabs', transport: 'stdio', command: 'node', args: ['mogging-mcp.mjs'], builtIn: true }
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

    const plan: WorkspaceToolPlan = {
      workspaceId: 'ws1',
      entries: { sentry: ['claude-code', 'codex'], linear: ['claude-code'] },
      inheritGlobal: false
    }

    // ── (a) claude materialization: flag + strict + a file of EXACTLY the plan ──
    const claudeEntries = composePlanEntries(plan, 'claude-code', servers, HOUSE)
    const claudeMat = materializePlanFor({ cli: 'claude-code', entries: claudeEntries, inheritGlobal: false, planDir, cwd: repo, workspaceId: 'ws1' })
    for (const f of claudeMat.files) {
      mkdirSync(join(f.path, '..'), { recursive: true })
      writeFileSync(f.path, f.content)
    }
    const claudeArgsOk =
      claudeMat.launchArgs[0] === '--mcp-config' && claudeMat.launchArgs.includes('--strict-mcp-config') && claudeMat.excludeRelPaths.length === 0
    const claudeFileKeys = Object.keys((JSON.parse(claudeMat.files[0].content) as { mcpServers: object }).mcpServers).sort()
    const claudeFileOk = JSON.stringify(claudeFileKeys) === JSON.stringify(['linear', 'mogging', 'sentry']) // planned exactly, no posthog

    // ── (a) codex materialization: project-scope file, no flag, git-excluded ────
    const codexEntries = composePlanEntries(plan, 'codex', servers, HOUSE)
    const codexMat = materializePlanFor({ cli: 'codex', entries: codexEntries, inheritGlobal: false, planDir, cwd: repo, workspaceId: 'ws1' })
    const codexTomlHasSentry = /\[mcp_servers\.sentry\]/.test(codexMat.files[0].content) && /\[mcp_servers\.mogging\]/.test(codexMat.files[0].content)
    const codexNoLinear = !/\[mcp_servers\.linear\]/.test(codexMat.files[0].content) // linear was claude-only
    const codexOk = codexMat.launchArgs.length === 0 && codexMat.excludeRelPaths[0] === '.codex/config.toml' && codexTomlHasSentry && codexNoLinear

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

    const pass = claudeArgsOk && claudeFileOk && codexOk && listsPlannedOnly && inheritOk && gitInvisibleOk && restartFlipsOk && templateOk && matrixOk
    result = { pass, claudeArgsOk, claudeFileOk, codexOk, listsPlannedOnly, inheritOk, gitInvisibleOk, restartFlipsOk, templateOk, matrixOk, shimOut }
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

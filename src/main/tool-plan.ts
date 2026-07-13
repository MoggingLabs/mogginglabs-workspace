import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MCP_MANAGED_BY, type AgentConfigValue, type HostedCliId, type McpServerEntry } from '@contracts'
import { composePlanEntries, findWriter, materializePlanFor } from '@backend/features/integrations'
import { jsoncCodec, tomlCodec } from '@backend/features/agent-settings'
import { configMutationCoordinator } from '@backend/core/config-files'
import { getToolPlan, hasToolPlan } from './integrations'
import { houseServerEntry, listServers } from './mcp-manager'

const AGENT_TO_CLI: Record<string, HostedCliId | undefined> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini'
}
export const cliForAgent = (agentId: string): HostedCliId | undefined => AGENT_TO_CLI[agentId]

/** Why a scoped launch was refused. It never falls through to global servers. */
const skippedScopes = new Map<string, string>()
export const toolPlanSkipReason = (workspaceId: string): string | undefined => skippedScopes.get(String(workspaceId))

/** Replace only Workspace-tagged MCP entries; every foreign setting/comment remains. */
export function mergeToolPlanProjectConfig(cli: HostedCliId, text: string | null, entries: McpServerEntry[]): string {
  const writer = findWriter(cli)
  if (!writer) throw new Error(`No config writer for ${cli}`)
  if (cli === 'codex') {
    let next = text ?? ''
    const ids = [...next.matchAll(/# managed-by: mogginglabs\r?\n\[mcp_servers\.([^\]]+)\]/g)].map((match) => match[1])
    for (const id of ids) next = writer.remove(next, id)
    for (const entry of entries) next = writer.upsert(next, entry)
    tomlCodec.validate(next)
    return next
  }
  if (cli === 'gemini') {
    let next = text ?? '{}\n'
    const current = jsoncCodec.read(next, ['mcpServers'])
    if (current.present && current.value && typeof current.value === 'object' && !Array.isArray(current.value)) {
      for (const [id, entry] of Object.entries(current.value)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry._managedBy === MCP_MANAGED_BY) {
          next = jsoncCodec.remove(next, ['mcpServers', id])
        }
      }
    }
    for (const entry of entries) {
      const existing = jsoncCodec.read(next, ['mcpServers', entry.id])
      if (
        existing.present &&
        (!existing.value || typeof existing.value !== 'object' || Array.isArray(existing.value) || existing.value._managedBy !== MCP_MANAGED_BY)
      ) {
        throw new Error(`settings.json already defines mcpServers.${entry.id} outside Workspace ownership`)
      }
      const rendered = JSON.parse(writer.renderBlock(entry)) as { mcpServers: Record<string, unknown> }
      next = jsoncCodec.set(next, ['mcpServers', entry.id], rendered.mcpServers[entry.id] as AgentConfigValue)
    }
    jsoncCodec.validate(next)
    return next
  }
  throw new Error(`${cli} does not use a project-scoped tool-plan file`)
}

export interface ToolPlanMaterialization {
  ok: boolean
  args: string[]
  reason?: string
}

/** Materialize one workspace's planned MCP set through the shared config-file queue.
 *  A scoped launch that cannot be materialized is REFUSED (ok:false) — it never falls
 *  through to the CLI's global servers, and every file it touched is rolled back. */
export async function materializeToolPlanAtLaunch(req: {
  agentId: string
  cwd: string
  workspaceId?: string
}): Promise<ToolPlanMaterialization> {
  const cli = cliForAgent(req.agentId)
  // Scoping is OPT-IN: aider/opencode, plan-less launches, and workspaces that
  // never stored a plan all launch UNCHANGED (the CLI's own global config).
  if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return { ok: true, args: [] }
  const workspaceId = req.workspaceId
  const plan = getToolPlan(req.workspaceId)
  const entries = composePlanEntries(plan, cli, listServers(), houseServerEntry())
  const mat = materializePlanFor({
    cli,
    entries,
    inheritGlobal: plan.inheritGlobal,
    planDir: join(app.getPath('userData'), 'toolplans'),
    cwd: req.cwd,
    workspaceId: req.workspaceId
  })
  skippedScopes.delete(req.workspaceId)
  const writer = findWriter(cli)
  // Every file we touch, as it was BEFORE we touched it — a refused launch must leave the
  // worktree exactly as it found it (the coordinator is atomic per file, not across files).
  const before: Array<{ path: string; existed: boolean; content: string }> = []
  const rollback = async (): Promise<void> => {
    for (const prior of [...before].reverse()) {
      try {
        if (prior.existed) {
          await configMutationCoordinator.mutate({ file: prior.path, transform: () => prior.content })
        } else {
          rmSync(prior.path, { force: true })
        }
      } catch {
        /* launch remains refused; never fall back to global config */
      }
    }
  }
  const refuse = async (reason: string): Promise<ToolPlanMaterialization> => {
    skippedScopes.set(workspaceId, reason)
    await rollback()
    console.warn(`tool-plan: ${reason}`)
    return { ok: false, args: [], reason }
  }
  for (const file of mat.files) {
    try {
      // A project-scope plan file lives in the USER'S WORKTREE — and a repo may TRACK its own
      // .codex/config.toml. If what's there is not purely our managed blocks, we do not touch
      // it AND we do not launch: a scoped pane must never silently fall back to global servers.
      if (file.projectScoped && existsSync(file.path) && writer && !writer.isManagedScoped(readFileSync(file.path, 'utf8'))) {
        return await refuse(
          `${file.path} is the repo's own config. The scoped agent was not launched; it did not fall back to global servers.`
        )
      }
      // The write itself goes through the shared config-file queue: CAS on the bytes we read,
      // codec-validated, atomically renamed — and for a project file it MERGES (only
      // Workspace-tagged entries are replaced; foreign settings and comments survive).
      const snapshot = await configMutationCoordinator.read(file.path)
      before.push({ path: file.path, existed: snapshot.text !== null, content: snapshot.text ?? '' })
      await configMutationCoordinator.mutate({
        file: file.path,
        expectedHash: snapshot.hash,
        transform: (current) => (file.projectScoped ? mergeToolPlanProjectConfig(cli, current.text, entries) : file.content),
        validate: file.projectScoped
          ? (content) => (cli === 'codex' ? tomlCodec.validate(content) : jsoncCodec.validate(content))
          : undefined
      })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return await refuse(`Could not materialize the scoped tool plan: ${file.path} was preserved (${why}). The scoped agent was not launched.`)
    }
  }
  if (mat.excludeRelPaths.length && !gitExcludeInWorktree(req.cwd, mat.excludeRelPaths)) {
    return await refuse('Could not hide the managed tool-plan file from Git. The scoped agent was not launched.')
  }
  return { ok: true, args: mat.launchArgs }
}

/** Append paths to the worktree's `.git/info/exclude` (never `.gitignore`, which
 *  IS tracked) so a materialized project-scope plan file is invisible to git.
 *  Handles a linked worktree, where `.git` is a FILE pointing at the real dir. */
export function gitExcludeInWorktree(cwd: string, relPaths: string[]): boolean {
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit)) return false
    let gitDir: string
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit
    } else {
      const match = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'))
      if (!match) return false
      gitDir = match[1].trim()
      if (!isAbsolute(gitDir)) gitDir = join(cwd, gitDir)
    }
    const infoDir = join(gitDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    const file = join(infoDir, 'exclude')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const have = new Set(current.split(/\r?\n/).map((value) => value.trim()))
    const additions = relPaths.map((path) => path.replace(/\\/g, '/')).filter((path) => !have.has(path))
    if (!additions.length) return true
    const separator = current && !current.endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${separator}# MoggingLabs tool-plan (managed)\n${additions.join('\n')}\n`)
    return true
  } catch {
    // A plan file we cannot hide from Git is a refusal, not a best-effort shrug: the caller
    // rolls the worktree back rather than leave a managed file showing in `git status`.
    return false
  }
}

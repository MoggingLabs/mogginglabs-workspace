import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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

/** Materialize one workspace's planned MCP set through the shared config-file queue. */
export async function materializeToolPlanAtLaunch(req: {
  agentId: string
  cwd: string
  workspaceId?: string
}): Promise<string[]> {
  const cli = cliForAgent(req.agentId)
  if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return []
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
  let refused = false
  for (const file of mat.files) {
    try {
      const before = await configMutationCoordinator.read(file.path)
      await configMutationCoordinator.mutate({
        file: file.path,
        expectedHash: before.hash,
        transform: (current) => file.projectScoped ? mergeToolPlanProjectConfig(cli, current.text, entries) : file.content,
        validate: file.projectScoped
          ? (content) => cli === 'codex' ? tomlCodec.validate(content) : jsoncCodec.validate(content)
          : undefined
      })
    } catch (error) {
      refused = true
      const why = error instanceof Error ? error.message : 'the config could not be updated'
      const reason = `${file.path} was preserved: ${why}. This pane keeps ${cli}'s global servers.`
      skippedScopes.set(req.workspaceId, reason)
      console.warn(`tool-plan: ${reason}`)
    }
  }
  if (mat.excludeRelPaths.length && !refused) gitExcludeInWorktree(req.cwd, mat.excludeRelPaths)
  return refused && mat.files.some((file) => file.projectScoped) ? [] : mat.launchArgs
}

/** Add generated project config paths to the worktree-local git exclude file. */
export function gitExcludeInWorktree(cwd: string, relPaths: string[]): void {
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit)) return
    let gitDir: string
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit
    } else {
      const match = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'))
      if (!match) return
      gitDir = match[1].trim()
      if (!isAbsolute(gitDir)) gitDir = join(cwd, gitDir)
    }
    const infoDir = join(gitDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    const file = join(infoDir, 'exclude')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const have = new Set(current.split(/\r?\n/).map((value) => value.trim()))
    const additions = relPaths.map((path) => path.replace(/\\/g, '/')).filter((path) => !have.has(path))
    if (!additions.length) return
    const separator = current && !current.endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${separator}# MoggingLabs tool-plan (managed)\n${additions.join('\n')}\n`)
  } catch {
    // Exclusion is best effort; the scoped provider config still loads.
  }
}

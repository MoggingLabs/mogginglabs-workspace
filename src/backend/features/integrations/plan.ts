import { join } from 'node:path'
import type { HostedCliId, McpServerEntry, WorkspaceToolPlan } from '@contracts'
import { plannedServerIdsForCli } from '@contracts'
import { capabilityFor } from './catalog'
import { findWriter } from './writers'

// Tool-plan composition + materialization (Phase-8/09). PURE + Electron-free:
// it computes the exact server SET a pane gets and the files/args to hand its
// CLI — main does the filesystem writes + git-exclude. The house server is
// ALWAYS present (agents reach the app through it); the rest is the plan.

/** The entries a pane actually gets for one CLI: the house server + the plan's
 *  servers for this CLI, filtered to what the CLI can speak. Order-stable:
 *  house first, then the plan's order. Global inheritance is NOT baked in here
 *  — it's the strict-flag's job at launch (see materializePlanFor). */
export function composePlanEntries(
  plan: WorkspaceToolPlan,
  cli: HostedCliId,
  allServers: McpServerEntry[],
  houseEntry: McpServerEntry
): McpServerEntry[] {
  const cap = capabilityFor(cli)
  const byId = new Map(allServers.map((s) => [s.id, s]))
  const out: McpServerEntry[] = [houseEntry]
  for (const id of plannedServerIdsForCli(plan, cli)) {
    if (id === houseEntry.id) continue
    const entry = byId.get(id)
    if (!entry) continue
    if (entry.transport === 'http' && cap && !cap.remoteHttp) continue // CLI can't speak it
    out.push(entry)
  }
  return out
}

export interface PlanMaterialization {
  /** Args appended to the launch command (the config flag + path, maybe strict). */
  launchArgs: string[]
  /** Absolute files to write (main), each a whole scoped config in the dialect.
   *  `projectScoped` files live in the USER'S WORKTREE (a repo may even track its
   *  own `.codex/config.toml`): main writes one only when nothing but our managed
   *  blocks is there to lose (writer.isManagedScoped) — never a blind clobber. */
  files: { path: string; content: string; projectScoped?: boolean }[]
  /** Worktree-relative paths main must add to `.git/info/exclude` (project-scope
   *  files only) so agents never see a plan file in `git status`. */
  excludeRelPaths: string[]
  /** True when this CLI cannot exclude its global set at launch — the plan file
   *  ADDS to global rather than replacing it (honest, surfaced by the caller). */
  addsToGlobal: boolean
}

/** Compute how to hand `entries` to `cli` at launch. Flag preferred (file in
 *  `planDir`/userData, nothing in the worktree); a git-excluded project-scope
 *  file only where no flag exists. */
export function materializePlanFor(opts: {
  cli: HostedCliId
  entries: McpServerEntry[]
  inheritGlobal: boolean
  planDir: string
  cwd: string
  workspaceId: string
}): PlanMaterialization {
  const { cli, entries, inheritGlobal, planDir, cwd, workspaceId } = opts
  const writer = findWriter(cli)
  const cap = capabilityFor(cli)
  const empty: PlanMaterialization = { launchArgs: [], files: [], excludeRelPaths: [], addsToGlobal: true }
  if (!writer || !cap) return empty
  const content = writer.composeScoped(entries)

  if (cap.mcpConfigFlag) {
    const ext = cli === 'codex' ? 'toml' : 'json'
    const path = join(planDir, `plan-${sanitizeId(workspaceId)}-${cli}.${ext}`)
    const launchArgs = [cap.mcpConfigFlag, path]
    // strict = plan-only; omit to inherit the CLI's global (user-home) servers.
    if (!inheritGlobal && cap.mcpStrictFlag) launchArgs.push(cap.mcpStrictFlag)
    return { launchArgs, files: [{ path, content }], excludeRelPaths: [], addsToGlobal: false }
  }

  if (cap.projectScopeFile) {
    const path = join(cwd, cap.projectScopeFile)
    // No strict flag -> the project file adds to the CLI's global set.
    return { launchArgs: [], files: [{ path, content, projectScoped: true }], excludeRelPaths: [cap.projectScopeFile], addsToGlobal: true }
  }
  return empty
}

const sanitizeId = (s: string): string => String(s).replace(/[^a-zA-Z0-9_-]/g, '')

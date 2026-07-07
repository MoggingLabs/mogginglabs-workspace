import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { HostedCliId } from '@contracts'
import { composePlanEntries, materializePlanFor } from '@backend/features/integrations'
import { getToolPlan, hasToolPlan } from './integrations'
import { houseServerEntry, listServers } from './mcp-manager'

// Tool-plan materialization at pane launch (Phase-8/09). The backend computes
// the scoped config + launch args (pure); this file does the filesystem side:
// writes the plan file (userData for flag-CLIs — nothing in the worktree) and,
// for a no-flag CLI's project-scope file, git-excludes it so agents never see
// a plan file in `git status`. Returns the launch args to append; the daemon
// stays v3 (the args ride the launch command, the env rides spec.env).

const AGENT_TO_CLI: Record<string, HostedCliId | undefined> = { claude: 'claude-code', codex: 'codex', gemini: 'gemini' }
export const cliForAgent = (agentId: string): HostedCliId | undefined => AGENT_TO_CLI[agentId]

export function materializeToolPlanAtLaunch(req: { agentId: string; cwd: string; workspaceId?: string }): string[] {
  const cli = cliForAgent(req.agentId)
  // Scoping is OPT-IN: aider/opencode, plan-less launches, and workspaces that
  // never stored a plan all launch UNCHANGED (the CLI's own global config).
  if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return []
  const plan = getToolPlan(req.workspaceId)
  const entries = composePlanEntries(plan, cli, listServers(), houseServerEntry())
  const planDir = join(app.getPath('userData'), 'toolplans')
  const mat = materializePlanFor({ cli, entries, inheritGlobal: plan.inheritGlobal, planDir, cwd: req.cwd, workspaceId: req.workspaceId })
  for (const f of mat.files) {
    try {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content)
    } catch {
      /* best effort — a failed write just means that server won't load */
    }
  }
  if (mat.excludeRelPaths.length) gitExcludeInWorktree(req.cwd, mat.excludeRelPaths)
  return mat.launchArgs
}

/** Append paths to the worktree's `.git/info/exclude` (never `.gitignore`, which
 *  IS tracked) so a materialized project-scope plan file is invisible to git.
 *  Handles a linked worktree, where `.git` is a FILE pointing at the real dir. */
export function gitExcludeInWorktree(cwd: string, relPaths: string[]): void {
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit)) return
    let gitDir: string
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit
    } else {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'))
      if (!m) return
      gitDir = m[1].trim()
      if (!isAbsolute(gitDir)) gitDir = join(cwd, gitDir)
    }
    const infoDir = join(gitDir, 'info')
    mkdirSync(infoDir, { recursive: true })
    const file = join(infoDir, 'exclude')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const have = new Set(current.split(/\r?\n/).map((s) => s.trim()))
    const toAdd = relPaths.map((p) => p.replace(/\\/g, '/')).filter((p) => !have.has(p))
    if (!toAdd.length) return
    const sep = current && !current.endsWith('\n') ? '\n' : ''
    appendFileSync(file, sep + '# MoggingLabs tool-plan (managed)\n' + toAdd.join('\n') + '\n')
  } catch {
    /* exclude is best-effort; the plan file still loads */
  }
}

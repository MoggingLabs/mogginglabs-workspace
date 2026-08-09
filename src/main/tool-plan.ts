import { app } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MCP_MANAGED_BY, isConnectionBridgeEntry, type AgentConfigValue, type HostedCliId, type McpServerEntry } from '@contracts'
import { composePlanEntries, findWriter, materializePlanFor } from '@backend/features/integrations'
import { jsoncCodec, tomlCodec } from '@backend/features/agent-settings'
import { ConfigMutationError, configMutationCoordinator } from '@backend/core/config-files'
import { verifyConnectionsForLaunch } from './connections'
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

/** What a successful materialization produced, and the disk evidence that says it is
 *  still true. Keyed per (workspace, cli, cwd) — the launch identity of a plan file. */
interface ToolPlanMemo {
  digest: string
  args: string[]
  excludeRelPaths: string[]
  files: Array<{ path: string; mtimeMs: number; size: number }>
}
const materializedPlans = new Map<string, ToolPlanMemo>()

const memoKey = (workspaceId: string, cli: HostedCliId, cwd: string): string => `${workspaceId} ${cli} ${cwd}`

/** The composed plan's identity: the entries themselves, not the stored plan's
 *  signature. A server DEFINITION can change (a command, an env pointer) while the
 *  plan document is untouched, and that must re-materialize. */
function planDigest(entries: unknown, inheritGlobal: boolean, cwd: string, cli: string): string {
  return createHash('sha256').update(JSON.stringify({ entries, inheritGlobal, cwd, cli })).digest('hex')
}

/** Are the materialized files still byte-for-byte what we left there? Stats only —
 *  the point is to avoid re-reading and re-hashing whole config files per launch. */
function filesUnmoved(files: ToolPlanMemo['files']): boolean {
  return files.every((f) => {
    try {
      const s = statSync(f.path)
      return s.mtimeMs === f.mtimeMs && s.size === f.size
    } catch {
      return false
    }
  })
}

/** Which connections this launch's plan carries — composed WITHOUT touching a file, so
 *  the caller can start the bounded pre-launch verification early and let it overlap
 *  the settings reconcile instead of adding to it. Never rejects. */
export function verifyToolPlanForLaunch(req: { agentId: string; workspaceId?: string }): Promise<void> {
  try {
    const cli = cliForAgent(req.agentId)
    if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return Promise.resolve()
    const plan = getToolPlan(req.workspaceId)
    const entries = composePlanEntries(plan, cli, listServers(), houseServerEntry())
    const ids = entries.filter(isConnectionBridgeEntry).map((e) => e.id)
    return ids.length ? verifyConnectionsForLaunch(ids).catch(() => undefined) : Promise.resolve()
  } catch {
    return Promise.resolve()
  }
}

/** Materialize one workspace's planned MCP set through the shared config-file queue.
 *  A scoped launch that cannot be materialized is REFUSED (ok:false) — it never falls
 *  through to the CLI's global servers, and every file it touched is rolled back.
 *
 *  `opts.verified` is the pre-launch connection verification the caller already
 *  started (verifyToolPlanForLaunch). It is still AWAITED here — the budget is allowed
 *  to delay a launch, which is what the pulse gate's broken-budget mutation proves —
 *  it simply ran alongside the reconcile instead of after it. */
export async function materializeToolPlanAtLaunch(
  req: {
    agentId: string
    cwd: string
    workspaceId?: string
  },
  opts?: { verified?: Promise<void> }
): Promise<ToolPlanMaterialization> {
  const cli = cliForAgent(req.agentId)
  // Scoping is OPT-IN: aider/opencode, plan-less launches, and workspaces that
  // never stored a plan all launch UNCHANGED (the CLI's own global config).
  if (!cli || !req.workspaceId || !hasToolPlan(req.workspaceId)) return { ok: true, args: [] }
  const workspaceId = req.workspaceId
  const plan = getToolPlan(req.workspaceId)
  const entries = composePlanEntries(plan, cli, listServers(), houseServerEntry())
  // Pre-launch verify (phase-tools/03, trigger 3): the plan carries connected tools —
  // verify them BEFORE the env materializes, parallel under a hard ~2s budget. The
  // launch never waits past the budget and is never refused by a probe: a slow or
  // failing verification lands as card status afterward, not as a lost pane. This is
  // the seam because it is where the plan becomes launch env — a connection entry's
  // command is our bridge shim, recognizable by its `--connection <id>` argument.
  const connectionIds = entries.filter(isConnectionBridgeEntry).map((e) => e.id)
  if (opts?.verified) await opts.verified
  else if (connectionIds.length) await verifyConnectionsForLaunch(connectionIds)
  // NOTHING CHANGED SINCE THE LAST LAUNCH? Then the files on disk already say exactly
  // what this call would write, and the CAS round trip (read + hash + queue + compare,
  // per file, per launch) is pure restatement. The digest covers what we would write;
  // the per-file stats cover whether anything else moved it. Either doubt re-does the
  // whole thing — the memo only ever skips work it can prove is redundant.
  const key = memoKey(workspaceId, cli, req.cwd)
  const digest = planDigest(entries, plan.inheritGlobal, req.cwd, cli)
  const memo = materializedPlans.get(key)
  if (memo && memo.digest === digest && filesUnmoved(memo.files)) {
    // The exclude append is idempotent and cheap, and it guards something the user can
    // SEE (a managed file showing up in `git status`), so it is re-checked even here.
    if (!memo.excludeRelPaths.length || gitExcludeInWorktree(req.cwd, memo.excludeRelPaths)) {
      skippedScopes.delete(workspaceId)
      return { ok: true, args: memo.args }
    }
    materializedPlans.delete(key) // could not re-hide it — fall through and refuse properly
  }
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
    materializedPlans.delete(key) // a refusal is never remembered as a good materialization
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
      //
      // ONE retry on a lost CAS. The settings reconcile runs alongside this now, and for
      // codex/gemini both can legitimately write the same project config file; the
      // coordinator serializes them, so the loser simply read a snapshot that the winner
      // then replaced. Re-reading and re-merging is the correct answer to that — the
      // merge is defined against whatever is currently there. A SECOND loss is not a
      // race, it is someone else editing the file continuously, and refusal is exactly
      // who refusal is for.
      const writeOnce = async (): Promise<void> => {
        const snapshot = await configMutationCoordinator.read(file.path)
        const res = await configMutationCoordinator.mutate({
          file: file.path,
          expectedHash: snapshot.hash,
          transform: (current) => (file.projectScoped ? mergeToolPlanProjectConfig(cli, current.text, entries) : file.content),
          validate: file.projectScoped
            ? (content) => (cli === 'codex' ? tomlCodec.validate(content) : jsoncCodec.validate(content))
            : undefined
        })
        // Record the undo ONLY after OUR write took. The read→mutate window is not serialized
        // (read is unqueued), so a concurrent launch for the same (workspace, cli) can write the
        // file between our read and our mutate — our mutate then fails `changed-under-us`. If the
        // undo had been recorded before the mutate, this launch's rollback (`existed:false`) would
        // `rmSync` the file the OTHER launch legitimately wrote, deleting a plan the winner already
        // returned `ok:true` for and now points `--mcp-config` at. No successful write ⇒ nothing
        // of ours to undo.
        // `changed:false` is likewise reachable for a file a SIBLING already wrote with our exact
        // values (the coordinator no longer refuses an already-satisfied edit). Recording an undo
        // then would re-open the same defect through the back door: `existed:false` against the
        // WINNER's file. Same rule, both directions — no successful write of OURS, nothing to undo.
        if (res.changed) before.push({ path: file.path, existed: snapshot.text !== null, content: snapshot.text ?? '' })
      }
      try {
        await writeOnce()
      } catch (error) {
        if (!(error instanceof ConfigMutationError) || error.code !== 'changed-under-us') throw error
        await writeOnce()
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return await refuse(`Could not materialize the scoped tool plan: ${file.path} was preserved (${why}). The scoped agent was not launched.`)
    }
  }
  if (mat.excludeRelPaths.length && !gitExcludeInWorktree(req.cwd, mat.excludeRelPaths)) {
    return await refuse('Could not hide the managed tool-plan file from Git. The scoped agent was not launched.')
  }
  // Remember what we just established, with the disk evidence to prove it later. A file
  // we cannot stat right after writing is not evidence, so that memo is simply not kept.
  try {
    materializedPlans.set(key, {
      digest,
      args: mat.launchArgs,
      excludeRelPaths: mat.excludeRelPaths,
      files: mat.files.map((f) => {
        const s = statSync(f.path)
        return { path: f.path, mtimeMs: s.mtimeMs, size: s.size }
      })
    })
  } catch {
    materializedPlans.delete(key)
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

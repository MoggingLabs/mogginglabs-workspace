import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

// THE TOOL PLAN IS RE-ESTABLISHED, NOT RE-DECIDED.
//
// Materializing a workspace's scoped MCP set meant a read + sha256 + queued CAS per
// plan file on EVERY launch, to write bytes that were already there — plus a ~2s
// connection-verification budget awaited BEFORE the settings reconcile rather than
// alongside it. tool-plan.ts and agents.ts both import electron, so the shape is
// pinned here (the pane-life/reconcile-events fallback) while TOOLPLAN, TOOLPULSE and
// LAUNCHNOW keep proving the behavior.

describe('materializeToolPlanAtLaunch memoizes an unchanged plan', () => {
  const src = sourceOf('src/main/tool-plan.ts')
  const body = bodyWithoutComments(src, '): Promise<ToolPlanMaterialization> {')

  it('keys the memo on the COMPOSED entries, not the stored plan signature', () => {
    // A server definition can change while the plan document is untouched; a signature
    // keyed on the document alone would serve a stale command line.
    const digest = bodyWithoutComments(src, 'function planDigest(')
    expect(digest).toMatch(/entries/)
    expect(digest).toMatch(/inheritGlobal/)
    expect(digest).toMatch(/cwd/)
    expect(digest).toMatch(/cli/)
  })

  it('requires the files to be untouched as well as the digest to match', () => {
    expect(body).toMatch(/memo\.digest === digest && filesUnmoved\(memo\.files\)/)
  })

  it('still re-checks the git exclude on a memo hit', () => {
    // The one user-VISIBLE consequence (a managed file appearing in `git status`) is
    // worth one readFile even on the fast path.
    expect(body).toMatch(/gitExcludeInWorktree\(req\.cwd, memo\.excludeRelPaths\)/)
  })

  it('never remembers a refusal', () => {
    expect(bodyWithoutComments(src, 'const refuse = async (')).toMatch(/materializedPlans\.delete\(key\)/)
  })

  it('retries a lost CAS exactly once, by error CODE not message', () => {
    // The reconcile now runs alongside this and can legitimately win the same file.
    expect(body).toMatch(/error instanceof ConfigMutationError/)
    expect(body).toMatch(/error\.code !== 'changed-under-us'/)
    const retries = body.match(/await writeOnce\(\)/g) ?? []
    expect(retries.length, 'one attempt plus exactly one retry').toBe(2)
  })
})

// A LAUNCH MUST NEVER ROLL BACK A FILE IT DID NOT WRITE.
//
// `configMutationCoordinator.read()` is unqueued, so two same-tick launches for one
// (workspace, cli) both read the plan file as absent. The winner writes it; the loser either
// loses the CAS or finds its edit already satisfied — and if the loser had recorded its undo
// BEFORE the mutate, its rollback (`existed:false`) `rmSync`es the WINNER's file, leaving the
// winner's pane pointed at a deleted `--mcp-config`. TOOLPLAN's race phase proves the behavior;
// the ordering is pinned here because tool-plan.ts imports electron.
describe('the rollback ledger only ever holds our own writes', () => {
  const writeOnce = bodyWithoutComments(sourceOf('src/main/tool-plan.ts'), 'const writeOnce = async (): Promise<void> => {')

  it('records the undo only AFTER our own mutate resolved', () => {
    const mutateAt = writeOnce.indexOf('configMutationCoordinator.mutate(')
    const pushAt = writeOnce.indexOf('before.push(')
    expect(mutateAt, 'the write itself must still go through the coordinator').toBeGreaterThan(-1)
    expect(pushAt, 'an undo recorded pre-mutate deletes the winner of a same-tick race').toBeGreaterThan(mutateAt)
  })

  it('records it only when OUR write actually changed the file', () => {
    // `changed:false` is reachable now that the coordinator accepts an already-satisfied
    // edit — that file is the SIBLING's, and undoing it is the same defect by another door.
    expect(writeOnce).toMatch(/if \(res\.changed\) before\.push\(/)
  })
})

describe('the launch handler runs its independent work in parallel', () => {
  const body = bodyWithoutComments(
    sourceOf('src/main/agents.ts'),
    'ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest)'
  )

  it('starts the connection verification before awaiting anything', () => {
    const verifyAt = body.indexOf('verifyToolPlanForLaunch(req)')
    const gatherAt = body.indexOf('await Promise.all([')
    expect(verifyAt, 'the verify must be dispatched, not awaited in line').toBeGreaterThan(-1)
    expect(verifyAt).toBeLessThan(gatherAt)
  })

  it('reconciles settings and materializes the plan together', () => {
    expect(body).toMatch(/await Promise\.all\(\[\s*prepareAgentConfigLaunch\(req, profile\),\s*materializeToolPlanAtLaunch\(req, \{ verified \}\)/)
  })

  it('still refuses on the settings reason FIRST', () => {
    // Two refusals in flight must not become a race over which reason the user reads.
    const preparedAt = body.indexOf('if (!prepared.ok) return')
    const planAt = body.indexOf('if (!plan.ok) return')
    expect(preparedAt).toBeGreaterThan(-1)
    expect(planAt).toBeGreaterThan(preparedAt)
  })

  it('still awaits the verification inside the materialization (the budget may delay a launch)', () => {
    // TOOLPULSE's broken-budget mutation-red proves a delayed launch; fire-and-forget
    // would silently kill that seam.
    expect(bodyWithoutComments(sourceOf('src/main/tool-plan.ts'), '): Promise<ToolPlanMaterialization> {')).toMatch(
      /await opts\.verified/
    )
  })
})

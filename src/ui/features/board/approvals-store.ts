import { GateChannels, type Approval } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Renderer mirror of the reviewer-gate sign-offs (4/03 polish). Push-fed over the
 * relay (`gate:approvals` on every approve/unapprove — zero polling); the board reads
 * it to ✓-chip cards whose bound worktree branch holds a live approval. Display
 * state only — never persisted (approvals are memory-only coordination data).
 */
let branches = new Set<string>()
const subs = new Set<() => void>()
let inited = false

export function initApprovals(): void {
  if (inited) return
  inited = true
  getBridge().on(GateChannels.approvals, (payload) => {
    const list = (payload as { list?: Approval[] })?.list ?? []
    branches = new Set(list.map((a) => a.branch))
    for (const cb of subs) cb()
  })
}

export function isBranchApproved(branch: string): boolean {
  return branches.has(branch)
}

export function onApprovalsChange(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

/** Test-only, main-process seam for the worktree menu regression. It models the
 * transient sharing violation returned by Windows while a just-closed ConPTY
 * releases its former cwd. Production behavior is unchanged unless the smoke
 * explicitly installs a target path. */
export interface WorktreeAuditFaultState {
  lockPath: string
  failures: number
  attempts: number
}

let state: WorktreeAuditFaultState | null = null

export function setWorktreeAuditFault(config: { lockPath: string; failures: number } | null): void {
  state = config
    ? { lockPath: config.lockPath, failures: Math.max(0, Math.trunc(config.failures)), attempts: 0 }
    : null
}

export function worktreeAuditFault(): WorktreeAuditFaultState | null {
  return state
}


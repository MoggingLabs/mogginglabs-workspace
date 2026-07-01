import type { IPty } from 'node-pty'

// Phase 0: a plain kill. Phase 1 replaces this with true process-tree teardown
// (Windows job objects / `taskkill /T`; Unix process-group kill) so long-running
// agent children are never orphaned when a pane closes.
export function killPtyTree(proc: IPty): void {
  try {
    proc.kill()
  } catch {
    // process may already be gone
  }
}

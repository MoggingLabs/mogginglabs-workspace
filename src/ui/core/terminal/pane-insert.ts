import { relativeToDir, quotePathsForShell, type ShellFlavor } from '@contracts'

/**
 * The ONE decision behind "type a path into a pane" — shared by the explorer drag's drop
 * (pane-drop), the OS-file drop, and send-to-pane, so the four surfaces can never again
 * disagree about remoteness. Pure and DOM-free on purpose: importable under the node-env
 * unit tier (the pane-fit precedent), with the write/toast/focus side effects staying in
 * the callers.
 */

export interface PaneInsertSpec {
  /** Absolute LOCAL paths, exactly as the explorer or the OS drop resolved them. */
  paths: readonly string[]
  /** Truthy when the RECEIVING pane's shell lives on an ssh host. */
  remote: boolean
  /** Relativize against this when local; omit for OS-file drops (absolute by design). */
  paneCwd?: string
  /** The local shell's dialect — ignored for remote panes (posix, always). */
  localFlavor: ShellFlavor
}

export interface PaneInsert {
  /** Quoted words, space-joined — what insertTextFor returns and recordDrop stores. */
  text: string
  /** The exact PTY payload: `text` padded one space each side (the dropped-file precedent). */
  data: string
  remote: boolean
}

export function planPaneInsert({ paths, remote, paneCwd, localFlavor }: PaneInsertSpec): PaneInsert {
  // REMOTE FIRST, before any cwd arithmetic: the pane's shell and cwd live on the ssh
  // host while `paths` name LOCAL files. A cwd string that happens to prefix a local
  // path must never fabricate a relative path across that boundary — relativeToDir is
  // pure string arithmetic and cannot tell the namespaces apart on its own.
  const chosen = remote ? paths : paths.map((p) => (paneCwd ? (relativeToDir(p, paneCwd) ?? p) : p))
  // A remote pane's shell speaks POSIX whatever this machine runs; the quoter also strips
  // control characters, so the payload cannot carry a newline and cannot press Enter.
  const text = quotePathsForShell(chosen, remote ? 'posix' : localFlavor)
  return { text, data: ' ' + text + ' ', remote }
}

/** ONE honesty toast, shared by every surface that inserts a local path into a remote
 *  pane. Lives here (not in components) so the copy sits beside the decision that
 *  triggers it — and so the unit tier can pin the title the REMOTE gate greps for. */
export const REMOTE_INSERT_TOAST = {
  tone: 'info',
  title: 'This pane is remote',
  body: 'The inserted path points at a file on THIS machine — the remote host cannot see it unless a mount shares it.'
} as const

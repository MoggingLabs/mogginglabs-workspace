/**
 * Pane buffer tail (read-only). The terminal feature owns the xterm instance; the
 * agents feature's deterministic interrupt (profile switch, F2) needs to SEE the
 * pane's last lines — on Windows, interrupting an npm `.cmd` shim raises cmd.exe's
 * "Terminate batch job (Y/N)?" prompt, which EATS the next typed line, so the
 * interrupt loop must read the tail and answer it before typing anything. Same
 * decoupling pattern as the other core ports: no feature imports a feature; the
 * reader is registered by the pane that owns the terminal and dies with it.
 *
 * Renderer-local and read-only — buffer text never leaves the process through this
 * port (ADR 0002/0005 posture: no content in telemetry, no content over IPC).
 */

const readers = new Map<number, (lines: number) => string>()

/** The terminal pane registers its own tail reader; dispose clears it. */
export function setPaneBufferReader(paneId: number, read: ((lines: number) => string) | null): void {
  if (read) readers.set(paneId, read)
  else readers.delete(paneId)
}

/** The pane's last `lines` buffer lines joined with '\n', or null when no pane
 *  with that id has a live terminal. Callers treat null as "cannot see". */
export function readPaneBufferTail(paneId: number, lines: number): string | null {
  const read = readers.get(paneId)
  if (!read) return null
  try {
    return read(lines)
  } catch {
    return null
  }
}

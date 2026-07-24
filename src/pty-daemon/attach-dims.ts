// Pure seam, deliberately its own module: session.ts imports node-pty at module
// top, so anything session.ts exports drags the native binding into whoever
// imports it — which is exactly how tests/unit/attach-dims.test.ts died on CI
// runners with no pty.node prebuild. The rule lives here, native-free; the
// daemon imports it downward.

/**
 * The dims an ATTACH must apply to an existing session, or null for "leave it alone".
 * Null when the spec carries no usable dims (a bare `attach` has none; a corrupt spec
 * must never reach node-pty, which throws on non-positive sizes) and when they already
 * match (a same-size resize forwarded to ConPTY costs a full spurious repaint — see
 * PaneSession.resize). Floors mirror the renderer's fit minimums (2 cols / 1 row).
 */
export function attachDims(
  spec: { cols?: number; rows?: number },
  current: { cols: number; rows: number }
): { cols: number; rows: number } | null {
  const { cols, rows } = spec
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) return null
  if (cols === current.cols && rows === current.rows) return null
  return { cols, rows }
}

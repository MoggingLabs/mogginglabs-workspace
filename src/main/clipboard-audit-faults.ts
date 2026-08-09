/**
 * Audit-only observability/fault seam for the Electron clipboard boundary.
 *
 * Production behavior is unchanged unless a smoke explicitly arms a failed write. Read
 * counters let the privacy gate prove that an opted-out history watcher never opens the
 * machine-wide clipboard; checking an empty history ring would be only indirect evidence.
 */
interface ClipboardAuditState {
  textReads: number
  imageReads: number
  formatReads: number
  blockedSensitiveEntries: number
  failedWritesRemaining: number
  silentlyDroppedWritesRemaining: number
}

const state: ClipboardAuditState = {
  textReads: 0,
  imageReads: 0,
  formatReads: 0,
  blockedSensitiveEntries: 0,
  failedWritesRemaining: 0,
  silentlyDroppedWritesRemaining: 0
}

export type ClipboardReadKind = 'text' | 'image' | 'formats'

export function noteClipboardRead(kind: ClipboardReadKind): void {
  if (kind === 'text') state.textReads++
  else if (kind === 'image') state.imageReads++
  else state.formatReads++
}

export function noteSensitiveClipboardEntryBlocked(): void {
  state.blockedSensitiveEntries++
}

export function failNextClipboardWrites(count = 1): void {
  state.failedWritesRemaining = Math.max(0, Math.floor(count))
}

export function consumeClipboardWriteFailure(): boolean {
  if (state.failedWritesRemaining <= 0) return false
  state.failedWritesRemaining--
  return true
}

/**
 * Model the REAL Windows hazard, which the throwing fault above cannot: while another process
 * holds the machine-wide clipboard open, `clipboard.writeText` neither copies nor throws — it
 * is a SILENT no-op. A write path that only ever sees the throwing fault looks correct while
 * being unable to notice a write that did not take, so the read-back guards are unprovable
 * against it. Armed writes here return normally, having written nothing.
 */
export function silentlyDropNextClipboardWrites(count = 1): void {
  state.silentlyDroppedWritesRemaining = Math.max(0, Math.floor(count))
}

export function consumeClipboardSilentDrop(): boolean {
  if (state.silentlyDroppedWritesRemaining <= 0) return false
  state.silentlyDroppedWritesRemaining--
  return true
}

export function clipboardAuditState(): Readonly<ClipboardAuditState> {
  return { ...state }
}

export function resetClipboardReadAudit(): void {
  state.textReads = 0
  state.imageReads = 0
  state.formatReads = 0
}

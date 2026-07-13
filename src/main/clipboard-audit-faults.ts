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
}

const state: ClipboardAuditState = {
  textReads: 0,
  imageReads: 0,
  formatReads: 0,
  blockedSensitiveEntries: 0,
  failedWritesRemaining: 0
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

export function clipboardAuditState(): Readonly<ClipboardAuditState> {
  return { ...state }
}

export function resetClipboardReadAudit(): void {
  state.textReads = 0
  state.imageReads = 0
  state.formatReads = 0
}

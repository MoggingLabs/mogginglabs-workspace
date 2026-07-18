import { foldProjectKey } from '../workspace/project-identity'
import { BRAIN_MAX_FILE_BYTES, BRAIN_WRITE_MAX_BODY_BYTES } from '@contracts'
import { nodeOut, partitionOf, type BrainReadHost, type BrainServeReply } from './serve'
import type { BrainNodeRow } from './schema'

// The brain's WRITE family (ADR 0018 step 07): panes edit BY SYMBOL — the
// board's revision-CAS discipline, applied to files. THREE verbs, a CLOSED set
// (growing it needs an ADR revision; rename_symbol stays deferred there):
//   brain.replaceBody   swap exactly the node's line range for a new definition
//   brain.insertAfter   whole-line insertion after the node's last line
//   brain.insertBefore  whole-line insertion before the node's first line
// Custody first, four locks in order, each a typed refusal, no bypass argument:
//   (a) GRANT  — the bin serves these only under the workspace's granted-writes
//                and main re-derives it per call (the board precedent);
//   (b) SCOPE  — the target node's partition must BE the caller's own checkout,
//                never a sibling worktree's (`wrong-checkout`);
//   (c) CAS    — expectedFileHash must match the file's CURRENT bytes on disk
//                (hashed fresh at write time) AND the index's record of them —
//                mismatch answers `stale` carrying the fresh hash, and the
//                caller re-queries first (the refuse-with-fresh-card shape);
//   (d) SANITY — the file exists, is text, sits under the index byte cap; the
//                payload is under BRAIN_WRITE_MAX_BODY_BYTES; the result still
//                fits the cap.
// The landing (service-side, one exclusive queue with drains and rebuilds) is
// atomic-or-refused, then re-indexes THAT file synchronously — the answer is
// the NEW generation, the node at its landed lines, and the newFileHash the
// caller's next edit will CAS against. Splicing is BYTE-level: untouched
// regions round-trip exactly, and the payload lands as INERT BYTES, verbatim.
// Electron-free; symbol names and paths flow back to the calling model only —
// never telemetry (counts only, ADR 0005).

export const BRAIN_WRITE_VERBS = ['brain.replaceBody', 'brain.insertAfter', 'brain.insertBefore'] as const
export type BrainWriteVerb = (typeof BRAIN_WRITE_VERBS)[number]

export const isBrainWriteVerb = (name: string): name is BrainWriteVerb =>
  (BRAIN_WRITE_VERBS as readonly string[]).includes(name)

/** What the splice hands the landing: the whole next file, or a typed refusal. */
export type BrainSpliceResult = { next: Buffer } | { reason: string; detail?: string }

/** The landing's answer (service-side). `landed` marks the one honest partial:
 *  bytes on disk, re-index refused — the freshness law heals it next tick. */
export type BrainLandResult =
  | { ok: true; generation: number; newFileHash: string }
  | { ok: false; reason: string; detail?: string; freshHash?: string; landed?: boolean }

/** What the write family needs from the service: the read door it already has,
 *  plus the ONE write door. Structural, so no import cycle exists. */
export interface BrainWriteHost extends BrainReadHost {
  landSymbolWrite(
    root: string,
    rel: string,
    expectedFileHash: string,
    splice: (current: Buffer) => BrainSpliceResult
  ): Promise<BrainLandResult>
}

const refuse = (reason: string, detail?: string): BrainServeReply =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const SHA256_HEX = /^[0-9a-f]{64}$/

// ── Byte-level line arithmetic (untouched regions must round-trip exactly) ────

/** 0-based byte offset where each 1-based line starts. A trailing newline does
 *  not open a phantom last line — mirroring how the extractor counts lines. */
function lineStarts(buf: Buffer): number[] {
  const starts = [0]
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1)
  if (starts.length > 1 && starts[starts.length - 1] === buf.length) starts.pop()
  return starts
}

const lineEndOffset = (buf: Buffer, starts: number[], line: number): number =>
  line < starts.length ? starts[line] : buf.length

/** The line's own terminator: '\r\n', '\n', or '' (EOF without one). */
function eolOfLine(buf: Buffer, starts: number[], line: number): string {
  const end = lineEndOffset(buf, starts, line)
  if (end > 0 && buf[end - 1] === 0x0a) return end > 1 && buf[end - 2] === 0x0d ? '\r\n' : '\n'
  return ''
}

/** Leading blanks of the line, decoded losslessly (indent bytes are ASCII). */
function indentOfLine(buf: Buffer, starts: number[], line: number): string {
  const start = starts[line - 1]
  const end = lineEndOffset(buf, starts, line)
  let i = start
  while (i < end && (buf[i] === 0x20 || buf[i] === 0x09)) i++
  return buf.subarray(start, i).toString('latin1')
}

const countNewlines = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** The anchor's indentation, prepended to every non-blank payload line — the
 *  caller writes the text unindented; blank lines stay bare. */
function applyIndent(text: string, indent: string): string {
  if (!indent) return text
  return text
    .split(/(?<=\n)/)
    .map((line) => (line.replace(/\r?\n$/, '').trim() === '' ? line : indent + line))
    .join('')
}

interface SplicePlan {
  verb: BrainWriteVerb
  node: Pick<BrainNodeRow, 'startLine' | 'endLine'>
  payload: string
  /** Set by the splice for the post-landing node re-resolution: how many lines
   *  the landed block occupies (inserts) — read only after the landing. */
  out: { blockLines: number }
}

/** Build the whole next file from the current bytes — sanity guards (d) live
 *  here, in order, after the landing's CAS (c) has already held. */
function splice(plan: SplicePlan, current: Buffer): BrainSpliceResult {
  if (current.subarray(0, 8192).includes(0)) {
    return { reason: 'invalid', detail: 'the file is not text — symbol writes edit source, nothing else' }
  }
  if (current.length > BRAIN_MAX_FILE_BYTES) {
    return { reason: 'too-large', detail: `the file exceeds the index byte cap (${BRAIN_MAX_FILE_BYTES})` }
  }
  if (Buffer.byteLength(plan.payload, 'utf8') > BRAIN_WRITE_MAX_BODY_BYTES) {
    return { reason: 'too-large', detail: `the payload exceeds ${BRAIN_WRITE_MAX_BODY_BYTES} bytes` }
  }
  const starts = lineStarts(current)
  const { startLine, endLine } = plan.node
  if (startLine < 1 || endLine < startLine || endLine > starts.length) {
    // Unreachable when the CAS held (the range came from these bytes) — refused
    // anyway rather than splicing blind.
    return { reason: 'stale', detail: 'the node\'s line range no longer fits the file — re-query the node' }
  }

  let next: Buffer
  if (plan.verb === 'brain.replaceBody') {
    const before = current.subarray(0, starts[startLine - 1])
    const afterOffset = lineEndOffset(current, starts, endLine)
    const after = current.subarray(afterOffset)
    let body = plan.payload
    const regionEol = eolOfLine(current, starts, endLine)
    // Whole-line semantics: a body without its own terminator gets the region's
    // (so the next line never fuses), except at a terminator-less EOF.
    if (!body.endsWith('\n') && (after.length > 0 || regionEol !== '')) body += regionEol || '\n'
    plan.out.blockLines = countNewlines(body)
    next = Buffer.concat([before, Buffer.from(body, 'utf8'), after])
  } else {
    const anchorEol = eolOfLine(current, starts, startLine) || '\n'
    const indent = indentOfLine(current, starts, startLine)
    let block = applyIndent(plan.payload, indent)
    if (!block.endsWith('\n')) block += anchorEol
    plan.out.blockLines = countNewlines(block)
    if (plan.verb === 'brain.insertBefore') {
      const at = starts[startLine - 1]
      next = Buffer.concat([current.subarray(0, at), Buffer.from(block, 'utf8'), current.subarray(at)])
    } else {
      const at = lineEndOffset(current, starts, endLine)
      let head = current.subarray(0, at)
      const after = current.subarray(at)
      // Anchor ends the file without a terminator: give it one, or the first
      // inserted line would fuse onto it — whole-line insertion, always.
      if (eolOfLine(current, starts, endLine) === '') head = Buffer.concat([head, Buffer.from(anchorEol, 'utf8')])
      next = Buffer.concat([head, Buffer.from(block, 'utf8'), after])
    }
  }
  if (next.length > BRAIN_MAX_FILE_BYTES) {
    return { reason: 'too-large', detail: `the write would push the file past the index byte cap (${BRAIN_MAX_FILE_BYTES})` }
  }
  return { next }
}

/** The landed node, re-resolved from the FRESH index: same name and kind at the
 *  arithmetic landing line first, then the nearest same-named definition in the
 *  file, else null (an edit may legitimately dissolve or rename its symbol —
 *  the answer never guesses). */
function resolveLandedNode(
  rows: BrainNodeRow[],
  old: BrainNodeRow,
  expectedStart: number,
  windowEnd: number
): BrainNodeRow | null {
  const same = rows.filter((r) => r.name === old.name && r.kind === old.kind)
  const exact = same.find((r) => r.startLine === expectedStart)
  if (exact) return exact
  const inWindow = same
    .filter((r) => r.startLine >= expectedStart && r.startLine <= windowEnd)
    .sort((a, b) => a.startLine - b.startLine)
  if (inWindow.length) return inWindow[0]
  const at = rows.find((r) => r.startLine === expectedStart)
  return at ?? null
}

/**
 * The one write dispatch. `callerRoot` is the pane's resolved checkout root —
 * null (a pane that resolves nowhere, or no pane at all) refuses: pane identity
 * is the custody anchor, and there is no `root` argument on writes, ever.
 * Total: junk in → a typed refusal out, never a throw.
 */
export async function serveBrainWrite(
  host: BrainWriteHost,
  verb: string,
  args: Record<string, unknown>,
  callerRoot: string | null
): Promise<BrainServeReply> {
  try {
    if (!isBrainWriteVerb(verb)) return refuse('invalid', `unknown brain write verb: ${verb}`)
    if (!callerRoot) {
      return refuse('forbidden', 'symbol writes exist only inside a pane session — pane identity is the custody anchor')
    }
    const id = str(args.id)
    if (!id) return refuse('invalid', 'id is required')
    const expected = str(args.expectedFileHash)
    if (!expected || !SHA256_HEX.test(expected)) {
      return refuse('invalid', 'expectedFileHash must be the sha256 hex of the file\'s current bytes — get_node answers it as fileHash')
    }
    const payloadKey = verb === 'brain.replaceBody' ? 'body' : 'text'
    const payload = args[payloadKey]
    if (typeof payload !== 'string' || !payload) return refuse('invalid', `${payloadKey} is required`)

    const h = host.readHandle(callerRoot)
    if ('reason' in h) return { ok: false, reason: h.reason, ...(h.detail ? { detail: h.detail } : {}) }
    const row = h.store.nodeById(id)
    if (!row) return refuse('unknown-node', `unknown node ${id} (not in your project's brain)`)
    // (b) SCOPE: the caller's own partition, never a sibling worktree's. A read
    // may see the sibling under scope:'project'; a write may not touch it.
    const caller = partitionOf(h.project.roots, callerRoot) ?? h.project.projectKey
    if (foldProjectKey(row.root) !== foldProjectKey(caller)) {
      return refuse(
        'wrong-checkout',
        'that symbol lives in a different checkout of this project — write from a pane standing in that checkout'
      )
    }
    if (!row.file) return refuse('invalid', 'this node has no file of its own (a package module) — nothing to edit')

    const out = { blockLines: 0 }
    const plan: SplicePlan = { verb, node: { startLine: row.startLine, endLine: row.endLine }, payload, out }
    const landing = await host.landSymbolWrite(row.root, row.file, expected, (current) => splice(plan, current))
    if (!landing.ok) {
      return {
        ok: false,
        reason: landing.reason,
        ...(landing.detail ? { detail: landing.detail } : {}),
        ...(landing.freshHash ? { freshHash: landing.freshHash } : {}),
        ...(landing.landed ? { landed: true } : {})
      }
    }
    // The synchronous re-index just committed: the store already answers the
    // landed truth, so the node the reply names is the node a next query sees.
    const expectedStart = verb === 'brain.insertBefore' ? row.startLine + out.blockLines : row.startLine
    const windowEnd = verb === 'brain.replaceBody' ? row.startLine + Math.max(0, out.blockLines - 1) : expectedStart
    const node = resolveLandedNode(h.store.nodesForFile(row.root, row.file), row, expectedStart, windowEnd)
    return {
      ok: true,
      generation: landing.generation,
      node: node ? nodeOut(node, false) : null,
      newFileHash: landing.newFileHash
    }
  } catch (e) {
    // A write path error must never throw across the wire; `busy` is the register.
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}

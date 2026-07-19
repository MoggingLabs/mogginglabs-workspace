import { redactSecrets } from '../review'
import { MEMORY_DESCRIPTION_MAX, memorySlug } from './memory'

// Dual memory, auto-captured (ADR 0018 revision C): agents should not have to
// be told to remember. The app already WATCHES every session — command blocks
// (OSC 133 truth: commands + exit codes), review merges, board cards reaching
// Done — and this module turns those SIGNALS into structured draft memories.
// Zero LLM in the base path: a draft's body is lists derived from the signals,
// never invented prose (the optional distillation lens ADDS prose on top and
// keeps the structure below — distill.ts). Everything here is pure text-in/
// text-out, Electron-free, deterministic per input; the service owns landing,
// retention, and the quarantine dir. Two kinds, per the pack:
//   reasoning drafts  (source: session) — HOW it was solved: the command
//                     ladder, its failures, and the failure→retry→fix arcs;
//   knowledge drafts  (source: merge | card) — WHAT was learned: the merged
//                     branch's touched files/symbols, or the finished card.
// Every command line passes the house redaction (review's redactSecrets)
// BEFORE it can land in a draft — a secret typed into a shell never becomes a
// memory.

/** Ladder caps — a draft is a record, not a scrollback dump. */
export const CAPTURE_MAX_BLOCKS = 50
export const CAPTURE_COMMAND_MAX = 300
/** Below this many commands with ZERO failures a session teaches nothing —
 *  no draft lands (an `ls` at a prompt is not a memory). */
export const CAPTURE_MIN_COMMANDS = 2
/** List caps for the knowledge drafts. */
export const CAPTURE_MAX_FILES = 50
export const CAPTURE_MAX_SYMBOLS = 50
export const CAPTURE_NOTES_MAX = 2000

export interface CaptureBlock {
  command: string
  exitCode?: number
  durationMs?: number
}

/** What capture BUILDS and the service LANDS. `slugBase` may collide — the
 *  landing dedupes with a numeric suffix; props are inert frontmatter lines
 *  (`auto`, `source`, …) the parse law already knows how to carry. */
export interface CaptureDraft {
  slugBase: string
  description: string
  tags: string[]
  props: Record<string, string>
  body: string
}

const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()

/** One command line, capture-clean: control-stripped, length-capped, and
 *  passed through the house secret redaction. Exported for the smoke. */
export function captureCommandLine(raw: string): string {
  return redactSecrets(clean(raw)).text.slice(0, CAPTURE_COMMAND_MAX)
}

const secondsOf = (ms: number | undefined): string =>
  ms === undefined || !Number.isFinite(ms) || ms < 0 ? '' : ` · ${(ms / 1000).toFixed(1)}s`

const exitOf = (code: number | undefined): string => (code === undefined ? 'exit ?' : `exit ${code}`)

const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

/**
 * A REASONING draft from one pane's command-block ladder at session end.
 * Null when the ladder carries no signal (fewer than CAPTURE_MIN_COMMANDS
 * commands and zero failures). The arcs section is the deterministic
 * failure→retry→fix read: a command LINE that failed and later succeeded
 * verbatim is a fix, counted by attempt.
 */
export function buildSessionDraft(pane: string, rawBlocks: CaptureBlock[]): CaptureDraft | null {
  const blocks = rawBlocks
    .map((b) => ({
      command: captureCommandLine(String(b.command ?? '')),
      exitCode: typeof b.exitCode === 'number' && Number.isInteger(b.exitCode) ? b.exitCode : undefined,
      durationMs: typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) ? b.durationMs : undefined
    }))
    .filter((b) => b.command.length > 0)
    .slice(-CAPTURE_MAX_BLOCKS)
  const failures = blocks.filter((b) => b.exitCode !== undefined && b.exitCode !== 0)
  if (!failures.length && blocks.length < CAPTURE_MIN_COMMANDS) return null

  const lines: string[] = ['## Commands']
  blocks.forEach((b, i) => lines.push(`${i + 1}. \`${b.command}\` — ${exitOf(b.exitCode)}${secondsOf(b.durationMs)}`))

  if (failures.length) {
    lines.push('', '## Failures')
    for (const f of failures) lines.push(`- \`${f.command}\` — ${exitOf(f.exitCode)}`)
  }

  // The arc: the FIRST failure of each distinct command line, matched against
  // a LATER identical line that exited 0. Attempt = 1-based index among that
  // line's runs. Deterministic; an unfixed failure simply stays a failure.
  const seen = new Set<string>()
  const arcs: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.exitCode === undefined || b.exitCode === 0 || seen.has(b.command)) continue
    seen.add(b.command)
    let attempt = 1
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j].command !== b.command) continue
      attempt += 1
      if (blocks[j].exitCode === 0) {
        arcs.push(`- \`${b.command}\` — failed (exit ${b.exitCode}), then succeeded on attempt ${attempt}`)
        break
      }
    }
  }
  if (arcs.length) lines.push('', '## Fixed', ...arcs)

  const description = cap(
    `Session in pane ${pane}: ${blocks.length} command${blocks.length === 1 ? '' : 's'}, ${failures.length} failed${arcs.length ? `, ${arcs.length} fixed` : ''}`,
    MEMORY_DESCRIPTION_MAX
  )
  const head = memorySlug(blocks[0]?.command.split(/\s+/)[0] ?? '')
  return {
    slugBase: ['session', memorySlug(pane) ?? 'pane', head].filter(Boolean).join('-'),
    description,
    tags: ['auto', 'session'],
    props: { auto: 'true', source: 'session', pane: clean(pane).slice(0, 40) },
    body: lines.join('\n') + '\n'
  }
}

export interface CardFacts {
  title: string
  notes: string
  labels: string[]
  priority: string
  branch: string | null
}

/** A KNOWLEDGE draft from a board card reaching Done. Card text is USER
 *  CONTENT: it lands in the user's own repo (the quarantine) and nowhere
 *  else. Labels become tags — the card's own taxonomy knits the draft into
 *  the graph. Null when the card has no title. */
export function buildCardDraft(card: CardFacts): CaptureDraft | null {
  const title = clean(card.title)
  if (!title) return null
  const labels = [...new Set(card.labels.map((l) => memorySlug(l)).filter((l): l is string => !!l))].sort()
  const lines: string[] = ['## Task', `- ${cap(title, 300)}`]
  const notes = clean(card.notes).slice(0, CAPTURE_NOTES_MAX)
  if (notes) lines.push('', '## Notes', ...notes.split(/(?<=\.)\s+/).map((n) => `- ${n}`))
  const facts: string[] = [`- priority: ${clean(card.priority) || 'normal'}`]
  if (card.branch) facts.push(`- branch: ${clean(card.branch).slice(0, 200)}`)
  if (labels.length) facts.push(`- labels: ${labels.join(', ')}`)
  lines.push('', '## Facts', ...facts)
  return {
    slugBase: `card-${memorySlug(title) ?? 'untitled'}`,
    description: cap(`Board card done: ${title}`, MEMORY_DESCRIPTION_MAX),
    tags: ['auto', 'card', ...labels],
    props: { auto: 'true', source: 'card' },
    body: lines.join('\n') + '\n'
  }
}

export interface MergeFacts {
  branch: string
  files: string[]
  /** Touched symbols via the graph: `name (kind) — file`. Already derived. */
  symbols: string[]
  cardTitle: string | null
}

/** A KNOWLEDGE draft from a review merge landing: the branch, the touched
 *  files, the symbols the graph knew in them, and the card whose task this
 *  was (when a card is bound to the branch). Null when nothing was touched. */
export function buildMergeDraft(merge: MergeFacts): CaptureDraft | null {
  const branch = clean(merge.branch)
  if (!branch || !merge.files.length) return null
  const files = merge.files.map((f) => clean(f)).filter(Boolean).slice(0, CAPTURE_MAX_FILES)
  const symbols = merge.symbols.map((s) => clean(s)).filter(Boolean).slice(0, CAPTURE_MAX_SYMBOLS)
  const lines: string[] = ['## Branch', `- ${cap(branch, 200)}`, '', '## Files', ...files.map((f) => `- ${f}`)]
  if (merge.files.length > CAPTURE_MAX_FILES) lines.push(`- … ${merge.files.length - CAPTURE_MAX_FILES} more`)
  if (symbols.length) {
    lines.push('', '## Symbols', ...symbols.map((s) => `- ${s}`))
    if (merge.symbols.length > CAPTURE_MAX_SYMBOLS) lines.push(`- … ${merge.symbols.length - CAPTURE_MAX_SYMBOLS} more`)
  }
  if (merge.cardTitle) lines.push('', '## Task', `- ${cap(clean(merge.cardTitle), 300)}`)
  return {
    slugBase: `merge-${memorySlug(branch) ?? 'branch'}`,
    description: cap(`Merged ${branch}: ${merge.files.length} file${merge.files.length === 1 ? '' : 's'} touched`, MEMORY_DESCRIPTION_MAX),
    tags: ['auto', 'merge'],
    props: { auto: 'true', source: 'merge' },
    body: lines.join('\n') + '\n'
  }
}

/** The optional distillation's ADDITIVE result: prose above, provenance in
 *  the head — the structured body always survives below (truth survives the
 *  summary). */
export interface DraftDistillation {
  prose: string
  provider: string
  model: string
}

/**
 * The draft's file bytes — the house serialization plus the draft's extra
 * head lines (sorted, one `key: value` each — the props law carries them as
 * inert bytes). With a distillation, the prose lands FIRST and the structured
 * body follows verbatim under its own separator.
 */
export function serializeDraft(slug: string, draft: CaptureDraft, distilled?: DraftDistillation): string {
  const props: Record<string, string> = { ...draft.props }
  if (distilled) {
    props.distilled = 'true'
    props.provider = clean(distilled.provider).slice(0, 120)
    props.model = clean(distilled.model).slice(0, 200)
  }
  const head = ['---', `name: ${slug}`, `description: ${clean(draft.description)}`]
  if (draft.tags.length) head.push(`tags: [${draft.tags.join(', ')}]`)
  for (const key of Object.keys(props).sort()) head.push(`${key}: ${clean(props[key])}`)
  head.push('---', '', '')
  let body = draft.body.replace(/\r\n/g, '\n')
  if (distilled) {
    const prose = distilled.prose.replace(/\r\n/g, '\n').trim()
    if (prose) body = prose + '\n\n' + body
  }
  if (!body.endsWith('\n')) body += '\n'
  return head.join('\n') + body
}

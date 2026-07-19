import { EMBED_FAKE_ENDPOINT, isEmbedEndpoint } from './embed'

// The distillation adapter (ADR 0018 revision C) — the embed seam's
// chat-completions SIBLING. Same BYO law (revision A, verbatim): the endpoint
// and key are the workspace's OWN configured target, there is no bundled
// model and no default endpoint, and no request ever leaves for anywhere
// else. One adapter — `POST <endpoint>/chat/completions` (OpenAI-compatible:
// OpenAI, Azure, Ollama, LM Studio, every local server speaking that shape) —
// so even distillation can be fully offline. The FAKE endpoint (`fake:`) is
// the smokes' whole network: deterministic prose from the structured draft,
// zero sockets. Distillation is ADDITIVE by contract: the caller keeps the
// structured body below the prose, and the output is labeled with its
// provider and model — an unlabeled model opinion is a review rejection.
// Bounded everywhere: input, prose, response bytes, and time all cap; a
// failure is a typed value (the draft lands structured-only), never a throw
// and never a retry loop.

export const DISTILL_MAX_INPUT_CHARS = 6000
export const DISTILL_MAX_PROSE_CHARS = 1200
export const DISTILL_TIMEOUT_MS = 15_000
export const DISTILL_RESPONSE_CAP = 1_048_576

/** The fixed instruction — data, versioned with the code, never configurable
 *  (a configurable prompt is an injection door). */
const DISTILL_INSTRUCTION =
  'Compress the following structured memory draft into 2-4 plain sentences of prose. ' +
  'State only facts present in the draft; do not invent, speculate, or add advice. Answer with the prose only.'

export interface DistillTarget {
  /** Base URL of an OpenAI-compatible API (…/v1), or the FAKE endpoint. */
  endpoint: string
  model: string
  /** Resolved plaintext (in memory only, per request) — null = no header. */
  key: string | null
}

export interface DistillInput {
  name: string
  description: string
  body: string
}

export type DistillResult = { ok: true; prose: string } | { ok: false; detail: string }

// ── Smoke seams: the attempt spies (the embed counters' pattern) ─────────────
// `attempts` counts EVERY adapter invocation (the "zero provider calls with
// consent OFF" witness); `httpAttempts` counts real sockets only (must stay
// zero in every FAKE run).
let attempts = 0
export function distillAttemptsForSmoke(): number {
  return attempts
}
let httpAttempts = 0
export function distillHttpAttemptsForSmoke(): number {
  return httpAttempts
}

const fail = (detail: string): DistillResult => ({ ok: false, detail })

/**
 * Distill one structured draft into prose against the target. Total: junk
 * config, a dead endpoint, a malformed reply — every path is a typed failure.
 */
export async function distillDraft(target: DistillTarget, input: DistillInput): Promise<DistillResult> {
  attempts += 1
  const material = `${input.name}\n${input.description}\n\n${input.body}`.slice(0, DISTILL_MAX_INPUT_CHARS)
  if (target.endpoint === EMBED_FAKE_ENDPOINT) {
    return { ok: true, prose: fakeDistillText(input) }
  }
  if (!isEmbedEndpoint(target.endpoint)) return fail('the endpoint is not an absolute http(s) URL')
  if (!target.model) return fail('no distillation model configured')
  httpAttempts += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISTILL_TIMEOUT_MS)
  try {
    const res = await fetch(target.endpoint.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.key ? { authorization: `Bearer ${target.key}` } : {})
      },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: DISTILL_INSTRUCTION },
          { role: 'user', content: material }
        ]
      }),
      signal: controller.signal
    })
    const body = await res.text()
    if (body.length > DISTILL_RESPONSE_CAP) return fail('the distillation response exceeded its byte cap')
    if (!res.ok) return fail(`the endpoint answered ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`)
    let parsed: { choices?: { message?: { content?: unknown } }[] }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      return fail('the endpoint did not answer JSON')
    }
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return fail('the reply carried no prose')
    return { ok: true, prose: content.trim().slice(0, DISTILL_MAX_PROSE_CHARS) }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The FAKE distiller: deterministic prose from the structured draft — the
 * description first, then the draft's first list lines flattened. Same input,
 * same prose, on every OS; obviously prose (a sentence, not a list), so the
 * smoke can tell the summary from the structure it must preserve.
 */
export function fakeDistillText(input: DistillInput): string {
  const items = input.body
    .split('\n')
    .filter((l) => /^(\d+\.|-)\s/.test(l))
    .slice(0, 3)
    .map((l) => l.replace(/^(\d+\.|-)\s+/, '').replace(/`/g, ''))
  const tail = items.length ? ` Key lines: ${items.join('; ')}.` : ''
  return `Distilled: ${input.description}.${tail}`.slice(0, DISTILL_MAX_PROSE_CHARS)
}

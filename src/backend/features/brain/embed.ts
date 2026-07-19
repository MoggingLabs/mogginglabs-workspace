import { createHash } from 'node:crypto'

// The semantic lens's ONE provider seam (ADR 0018 revision A — the lens law).
// `embedTexts` is the whole surface: texts in, unit vectors out, behind a single
// OpenAI-compatible HTTP adapter (`POST <endpoint>/embeddings`) — which covers
// OpenAI, Azure, Ollama, LM Studio and every local server speaking that shape,
// so even the probabilistic lens can be fully offline. BYO ONLY: there is no
// bundled model, no default endpoint, and no request ever leaves for anywhere
// but the endpoint the user configured (ADR 0002's spirit: we never proxy,
// never meter, take no cut). The key arrives resolved (main owns the ADR 0007a
// vault pointer); it rides one Authorization header, in memory, per request.
//
// The FAKE embedder is the smokes' whole network: `fake:` as the endpoint is a
// deterministic seeded-hash character-trigram embedding — house code, zero
// sockets — real enough that near-vocabulary ("colours parsed" vs "color
// parse") lands close in cosine while FTS5's unstemmed tokens stay disjoint.
// Everything here is Electron-free and bounded: dims, batch, text length,
// response bytes, and time all cap, and a failure is a typed value, never a
// throw or a retry loop.

/** The user-typed endpoint that means "the deterministic FAKE embedder". */
export const EMBED_FAKE_ENDPOINT = 'fake:'
/** The FAKE embedder's fixed shape. */
export const EMBED_FAKE_DIM = 64
export const EMBED_FAKE_MODEL_PREFIX = 'fake'

/** Hard caps — contracts, not tunables (ADR 0018.a's cap posture). */
export const EMBED_MAX_DIM = 4096
export const EMBED_MAX_TEXT_CHARS = 8192
export const EMBED_QUERY_MAX_CHARS = 2048
export const EMBED_BATCH = 16
export const EMBED_TIMEOUT_MS = 10_000
export const EMBED_RESPONSE_CAP = 8 * 1024 * 1024

export interface EmbedTarget {
  /** Base URL of an OpenAI-compatible API (…/v1), or EMBED_FAKE_ENDPOINT. */
  endpoint: string
  model: string
  /** Resolved plaintext (in memory only, per request) — null = no header. */
  key: string | null
}

export type EmbedResult =
  | { ok: true; vectors: Float32Array[]; dim: number }
  | { ok: false; reason: 'embed-failed'; detail: string }

/** The label a probabilistic hit wears: the endpoint's HOST, never a path or a
 *  key — enough for "whose opinion is this", small enough for every hit. */
export function embedProviderLabel(endpoint: string): string {
  if (endpoint === EMBED_FAKE_ENDPOINT) return 'fake'
  try {
    return new URL(endpoint).host || endpoint.slice(0, 120)
  } catch {
    return endpoint.slice(0, 120)
  }
}

/** A valid endpoint: the FAKE scheme, or an absolute http(s) base URL. */
export function isEmbedEndpoint(endpoint: string): boolean {
  if (endpoint === EMBED_FAKE_ENDPOINT) return true
  try {
    const u = new URL(endpoint)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Smoke seams: the HTTP-attempt witness + an armable deterministic fault ───
// (the vault-probe pattern: production never arms them, a gate always may).
let httpAttempts = 0
export function embedHttpAttemptsForSmoke(): number {
  return httpAttempts
}
let armedFailures = 0
export function armEmbedFailureForSmoke(count: number): void {
  armedFailures = Math.max(0, Math.floor(count))
}

const fail = (detail: string): EmbedResult => ({ ok: false, reason: 'embed-failed', detail })

/**
 * Embed a batch of texts against the target. Total: junk config, a dead
 * endpoint, a malformed reply, oversized dims — every path is a typed
 * `embed-failed`, never a throw. Vectors come back L2-NORMALIZED, so cosine
 * downstream is a plain dot product.
 */
export async function embedTexts(target: EmbedTarget, texts: string[]): Promise<EmbedResult> {
  if (!texts.length) return { ok: true, vectors: [], dim: 0 }
  if (armedFailures > 0) {
    armedFailures -= 1
    return fail('armed smoke fault')
  }
  const capped = texts.map((t) => t.slice(0, EMBED_MAX_TEXT_CHARS))
  if (target.endpoint === EMBED_FAKE_ENDPOINT) {
    return { ok: true, vectors: capped.map((t) => fakeEmbedText(t)), dim: EMBED_FAKE_DIM }
  }
  if (!isEmbedEndpoint(target.endpoint)) return fail('the endpoint is not an absolute http(s) URL')
  if (!target.model) return fail('no embedding model configured')
  httpAttempts += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
  try {
    const res = await fetch(target.endpoint.replace(/\/+$/, '') + '/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.key ? { authorization: `Bearer ${target.key}` } : {})
      },
      body: JSON.stringify({ model: target.model, input: capped }),
      signal: controller.signal
    })
    const body = await res.text()
    if (body.length > EMBED_RESPONSE_CAP) return fail('the embedding response exceeded its byte cap')
    if (!res.ok) return fail(`the endpoint answered ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`)
    let parsed: { data?: { embedding?: unknown }[] }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      return fail('the endpoint did not answer JSON')
    }
    const rows = Array.isArray(parsed.data) ? parsed.data : null
    if (!rows || rows.length !== capped.length) return fail('the reply did not carry one embedding per input')
    const vectors: Float32Array[] = []
    let dim = 0
    for (const row of rows) {
      const emb = row?.embedding
      if (!Array.isArray(emb) || !emb.length || emb.length > EMBED_MAX_DIM) {
        return fail(`the reply's embedding shape is invalid (dims 1-${EMBED_MAX_DIM})`)
      }
      if (dim === 0) dim = emb.length
      if (emb.length !== dim) return fail('the reply mixed embedding dimensions')
      const vec = new Float32Array(dim)
      for (let i = 0; i < dim; i++) {
        const v = emb[i]
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail('the reply carried a non-finite component')
        vec[i] = v
      }
      vectors.push(normalize(vec))
    }
    return { ok: true, vectors, dim }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

function normalize(vec: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm
  return vec
}

/**
 * The FAKE embedder: seeded-hash character trigrams → a fixed-dim unit vector.
 * Deterministic on every OS (sha256 over lowercased word trigrams with word
 * boundaries), zero network by construction. Near-spellings share trigrams and
 * land close; disjoint vocabulary under FTS5's unstemmed tokenizer can still
 * be trigram-similar — which is exactly the fixture the BRAINSEM gate proves
 * the lens's value with.
 */
export function fakeEmbedText(text: string): Float32Array {
  const vec = new Float32Array(EMBED_FAKE_DIM)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const token of tokens) {
    const padded = `^${token}$`
    for (let i = 0; i + 3 <= padded.length; i++) {
      const h = createHash('sha256').update(padded.slice(i, i + 3)).digest()
      vec[h.readUInt32BE(0) % EMBED_FAKE_DIM] += h[4] & 1 ? 1 : -1
    }
  }
  return normalize(vec)
}

/** Cosine over ALREADY-NORMALIZED vectors: a dot product, dimension-guarded. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** BLOB ↔ Float32Array, copy-safe against Buffer pooling. */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}
export function blobToVector(blob: Buffer, dim: number): Float32Array | null {
  if (blob.length !== dim * 4 || dim <= 0 || dim > EMBED_MAX_DIM) return null
  const copy = new Uint8Array(blob.length)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

/** What a memory embeds as: name, description, body — one capped text. */
export function embedTextOfMemory(m: { name: string; description: string; body: string }): string {
  return `${m.name}\n${m.description}\n${m.body}`.slice(0, EMBED_MAX_TEXT_CHARS)
}

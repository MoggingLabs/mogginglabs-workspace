import { BRAIN_LIBDOC_README_CAP, BRAIN_LIBFETCH_BYTE_CAP, type BrainLibEcosystem } from '@contracts'

// The brain's ONE network organ (ADR 0018 step 08): fetch a missing-from-disk
// dependency's PUBLISHED docs — npm / PyPI JSON endpoints only, the pinned
// version only, HTTPS only (loopback HTTP allowed solely through the explicit
// registry-override seam the offline smokes use), no redirects followed,
// byte-capped read. Consent is checked by the CALLER (per workspace, default
// OFF) before this module is ever reached; this module enforces everything a
// URL can lie about. Nothing here executes package code — the answer is JSON
// text from a registry, distilled to a README string.

const SAFE_NPM_NAME = /^(@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/i
const SAFE_PY_NAME = /^[A-Za-z0-9_.-]+$/
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,64}$/

export interface LibFetchResult {
  ok: true
  readme: string
  readmeTruncated: boolean
}

export interface LibFetchRefusal {
  ok: false
  reason: 'invalid' | 'fetch-failed' | 'too-large'
  detail: string
}

/** The registry bases — overridable ONLY via the smoke seam envs. */
const npmBase = (): string => process.env.MOGGING_BRAIN_REGISTRY_NPM || 'https://registry.npmjs.org'
const pypiBase = (): string => process.env.MOGGING_BRAIN_REGISTRY_PY || 'https://pypi.org'

/** HTTPS, or loopback HTTP when (and only when) the override seam is in use. */
function allowedBase(base: string, overridden: boolean): boolean {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return overridden && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

/** Read a response body up to the byte cap; past it the read is refused whole —
 *  a registry answer too big to bound is an answer we do not take. */
async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > BRAIN_LIBFETCH_BYTE_CAP) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function getJson(url: string): Promise<{ json: Record<string, unknown> } | LibFetchRefusal> {
  let res: Response
  try {
    // redirect:'error' — an off-registry redirect is a refusal, not a follow.
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: `the registry did not answer (${e instanceof Error ? e.message : String(e)})` }
  }
  if (!res.ok) {
    return { ok: false, reason: 'fetch-failed', detail: `the registry answered ${res.status} for the pinned version` }
  }
  const text = await readCapped(res)
  if (text === null) {
    return { ok: false, reason: 'too-large', detail: `the registry answer exceeds the ${BRAIN_LIBFETCH_BYTE_CAP}-byte fetch cap` }
  }
  try {
    const v = JSON.parse(text) as unknown
    if (typeof v === 'object' && v !== null) return { json: v as Record<string, unknown> }
  } catch {
    /* fall through */
  }
  return { ok: false, reason: 'fetch-failed', detail: 'the registry answer was not JSON' }
}

const strField = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Fetch the pinned version's published README. One ecosystem-pinned endpoint,
 * one bounded read (npm falls back to the packument's readme on the same base
 * when the version doc carries none — still registry-pinned).
 */
export async function fetchLibraryDocs(
  ecosystem: BrainLibEcosystem,
  name: string,
  version: string
): Promise<LibFetchResult | LibFetchRefusal> {
  if (!SAFE_VERSION.test(version)) return { ok: false, reason: 'invalid', detail: 'the pinned version is not a fetchable version string' }
  if (ecosystem === 'npm') {
    if (!SAFE_NPM_NAME.test(name)) return { ok: false, reason: 'invalid', detail: 'that name cannot be a registry package' }
    const base = npmBase()
    if (!allowedBase(base, !!process.env.MOGGING_BRAIN_REGISTRY_NPM)) {
      return { ok: false, reason: 'invalid', detail: 'the npm registry base is not an allowed origin' }
    }
    const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
    const doc = await getJson(`${base}/${encoded}/${encodeURIComponent(version)}`)
    if (!('json' in doc)) return doc
    let readme = strField(doc.json.readme) || strField(doc.json.description)
    if (!readme) {
      const packument = await getJson(`${base}/${encoded}`)
      if ('json' in packument) readme = strField(packument.json.readme)
    }
    if (!readme) return { ok: false, reason: 'fetch-failed', detail: 'the registry has no README for the pinned version' }
    const truncated = readme.length > BRAIN_LIBDOC_README_CAP
    return { ok: true, readme: readme.slice(0, BRAIN_LIBDOC_README_CAP), readmeTruncated: truncated }
  }
  if (ecosystem === 'py') {
    if (!SAFE_PY_NAME.test(name)) return { ok: false, reason: 'invalid', detail: 'that name cannot be a registry package' }
    const base = pypiBase()
    if (!allowedBase(base, !!process.env.MOGGING_BRAIN_REGISTRY_PY)) {
      return { ok: false, reason: 'invalid', detail: 'the PyPI base is not an allowed origin' }
    }
    const doc = await getJson(`${base}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)
    if (!('json' in doc)) return doc
    const info = typeof doc.json.info === 'object' && doc.json.info !== null ? (doc.json.info as Record<string, unknown>) : {}
    const readme = strField(info.description) || strField(info.summary)
    if (!readme) return { ok: false, reason: 'fetch-failed', detail: 'PyPI has no description for the pinned version' }
    const truncated = readme.length > BRAIN_LIBDOC_README_CAP
    return { ok: true, readme: readme.slice(0, BRAIN_LIBDOC_README_CAP), readmeTruncated: truncated }
  }
  return { ok: false, reason: 'invalid', detail: `no registry fetch exists for the ${ecosystem} ecosystem` }
}

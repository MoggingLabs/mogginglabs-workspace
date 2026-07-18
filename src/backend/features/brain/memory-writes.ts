import { BRAIN_WRITE_MAX_BODY_BYTES } from '@contracts'
import {
  MEMORY_DESCRIPTION_MAX,
  MEMORY_MAX_TAGS,
  MEMORY_NAME_MAX,
  isMemorySlug,
  memorySlug,
  serializeMemory
} from './memory'
import type { BrainReadHost, BrainServeReply } from './serve'

// The memory WRITE family (ADR 0018 step 09): create/update `.memory/` files —
// 07's granted family, 07's guards, applied to the team's knowledge graph. TWO
// verbs, a CLOSED set (growing it needs an ADR revision; delete stays human —
// `git rm` is the delete):
//   brain.memCreate   mint `<slug>.md` from a name (hostile names sanitize
//                     through the ONE slugger; a collision refuses `exists`)
//   brain.memUpdate   swap the BODY under the existing head, CAS-guarded
// Custody first, the same locks in order, each a typed refusal, no bypass:
//   (a) GRANT  — the bin serves these only under the workspace's granted-writes
//                and main re-derives it per call (the board precedent);
//   (b) SCOPE  — writes land in the CALLER'S OWN checkout's `.memory/`, never a
//                sibling worktree's, never anywhere else — the slug law makes
//                any other path unspellable (git merges memories home);
//   (c) CAS    — update's expectedFileHash must match the file's CURRENT bytes
//                (hashed fresh at write time) — mismatch answers `stale`
//                carrying the fresh hash (the refuse-with-fresh-card shape);
//   (d) SANITY — name/description/tags/body under their caps; the landing is
//                atomic-or-refused and synchronously re-scanned, so the
//                caller's next read is already true.
// Electron-free; memory text flows back to the calling model only — never
// telemetry (the trail carries counts, ADR 0005).

export const MEMORY_WRITE_VERBS = ['brain.memCreate', 'brain.memUpdate'] as const
export type MemoryWriteVerb = (typeof MEMORY_WRITE_VERBS)[number]

export const isMemoryWriteVerb = (name: string): name is MemoryWriteVerb =>
  (MEMORY_WRITE_VERBS as readonly string[]).includes(name)

/** What the landing does, decided ENTIRELY here — the service only holds locks,
 *  paths, and the atomic write. */
export type MemoryWriteOp =
  | { kind: 'create'; slug: string; text: string }
  | { kind: 'update'; slug: string; expectedFileHash: string; body: string }

export type MemoryLandResult =
  | { ok: true; slug: string; fileHash: string }
  | { ok: false; reason: string; detail?: string; freshHash?: string }

/** What the memory writes need from the service: the read door plus the ONE
 *  memory landing. Structural, so no import cycle exists. */
export interface BrainMemoryWriteHost extends BrainReadHost {
  landMemoryWrite(root: string, op: MemoryWriteOp): Promise<MemoryLandResult>
}

const refuse = (reason: string, detail?: string): BrainServeReply =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * The one memory-write dispatch. `callerRoot` is the pane's resolved checkout
 * root — null refuses: pane identity is the custody anchor, and there is no
 * `root` argument on writes, ever. Total: junk in → a typed refusal out.
 */
export async function serveMemoryWrite(
  host: BrainMemoryWriteHost,
  verb: string,
  args: Record<string, unknown>,
  callerRoot: string | null
): Promise<BrainServeReply> {
  try {
    if (!isMemoryWriteVerb(verb)) return refuse('invalid', `unknown memory write verb: ${verb}`)
    if (!callerRoot) {
      return refuse('forbidden', 'memory writes exist only inside a pane session — pane identity is the custody anchor')
    }
    const body = str(args.body)
    if (!body) return refuse('invalid', 'body is required')
    if (Buffer.byteLength(body, 'utf8') > BRAIN_WRITE_MAX_BODY_BYTES) {
      return refuse('too-large', `the body exceeds ${BRAIN_WRITE_MAX_BODY_BYTES} bytes`)
    }

    let op: MemoryWriteOp
    if (verb === 'brain.memCreate') {
      const name = str(args.name)
      if (!name || name.length > MEMORY_NAME_MAX) {
        return refuse('invalid', `name is required (max ${MEMORY_NAME_MAX} chars)`)
      }
      const description = str(args.description)
      if (!description || description.length > MEMORY_DESCRIPTION_MAX) {
        return refuse('invalid', `description is required (max ${MEMORY_DESCRIPTION_MAX} chars)`)
      }
      // Hostile names sanitize HERE, once, through the one slugger — what lands
      // on disk is a plain kebab-case filename or nothing at all.
      const slug = memorySlug(name)
      if (!slug) return refuse('invalid', 'the name has no sluggable characters (a-z, 0-9)')
      let tags: string[] = []
      if (args.tags !== undefined) {
        if (typeof args.tags !== 'string') return refuse('invalid', 'tags must be a comma-separated string')
        tags = [...new Set(args.tags.split(',').map((t) => memorySlug(t)).filter((t): t is string => !!t))].sort()
        if (tags.length > MEMORY_MAX_TAGS) return refuse('invalid', `at most ${MEMORY_MAX_TAGS} tags`)
      }
      op = { kind: 'create', slug, text: serializeMemory({ slug, description, tags, body }) }
    } else {
      const slug = str(args.slug)
      if (!slug || !isMemorySlug(slug)) {
        return refuse('invalid', 'slug must be the memory\'s kebab-case slug — get_memory / search_memories answer it')
      }
      const expected = str(args.expectedFileHash)
      if (!expected || !SHA256_HEX.test(expected)) {
        return refuse('invalid', 'expectedFileHash must be the sha256 hex of the file\'s current bytes — get_memory answers it as fileHash')
      }
      op = { kind: 'update', slug, expectedFileHash: expected, body }
    }

    const landing = await host.landMemoryWrite(callerRoot, op)
    if (!landing.ok) {
      return {
        ok: false,
        reason: landing.reason,
        ...(landing.detail ? { detail: landing.detail } : {}),
        ...(landing.freshHash ? { freshHash: landing.freshHash } : {})
      }
    }
    // The synchronous re-scan just committed: the slug the reply names is the
    // slug a next search/get already serves, and fileHash is the next CAS.
    return { ok: true, slug: landing.slug, fileHash: landing.fileHash }
  } catch (e) {
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}

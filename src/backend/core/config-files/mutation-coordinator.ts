import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export type ConfigMutationErrorCode =
  | 'changed-under-us'
  | 'dangling-symlink'
  | 'invalid-output'
  | 'invalid-utf8'
  | 'too-large'
  | 'io'

/** Safe for an IPC error mapper: the message never contains a local path or file text. */
export class ConfigMutationError extends Error {
  constructor(readonly code: ConfigMutationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigMutationError'
  }
}

export interface ConfigFileSnapshot {
  /** Null means the selected layer has no file yet. */
  text: string | null
  /** SHA-256 of the exact bytes, including a BOM. Null means absent. */
  hash: string | null
  bom: boolean
  eol: '\n' | '\r\n'
  trailingNewline: boolean
}

export interface ConfigMutationRequest {
  file: string
  /** Optional CAS token obtained from `read`. */
  expectedHash?: string | null
  maxBytes?: number
  transform(current: ConfigFileSnapshot): string
  /** Codec/schema validation runs before a byte can reach disk. */
  validate?(nextText: string): void
}

export interface ConfigMutationResult {
  changed: boolean
  previousHash: string | null
  hash: string | null
  snapshot: ConfigFileSnapshot
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function decode(bytes: Buffer): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  try {
    return { text: UTF8.decode(bom ? bytes.subarray(3) : bytes), bom }
  } catch (cause) {
    throw new ConfigMutationError('invalid-utf8', 'The selected config is not valid UTF-8.', { cause })
  }
}

function formatting(text: string): Pick<ConfigFileSnapshot, 'eol' | 'trailingNewline'> {
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: /(?:\r?\n)$/.test(text)
  }
}

/**
 * Serializes every read→transform→CAS→atomic-write transaction for a real file.
 * All provider writers must share this instance; write-file-atomic supplies the
 * same-directory temp, fsync, mode/chown preservation, symlink following, and rename.
 */
export class ConfigMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  async read(file: string, maxBytes = DEFAULT_MAX_BYTES): Promise<ConfigFileSnapshot> {
    const target = await this.target(file)
    return this.readTarget(target, maxBytes)
  }

  async mutate(request: ConfigMutationRequest): Promise<ConfigMutationResult> {
    const target = await this.target(request.file)
    return this.enqueue(target, async () => {
      const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
      const current = await this.readTarget(target, maxBytes)
      if (request.expectedHash !== undefined && current.hash !== request.expectedHash) {
        throw new ConfigMutationError('changed-under-us', 'The config changed before the edit could be applied.')
      }

      let nextText: string
      try {
        nextText = request.transform(current)
        request.validate?.(nextText)
      } catch (cause) {
        if (cause instanceof ConfigMutationError) throw cause
        throw new ConfigMutationError('invalid-output', 'The requested value would produce an invalid provider config.', { cause })
      }
      const encoded = Buffer.from((current.bom ? '\ufeff' : '') + nextText, 'utf8')
      if (encoded.byteLength > maxBytes) {
        throw new ConfigMutationError('too-large', 'The edited config exceeds the safe size limit.')
      }
      const nextHash = digest(encoded)
      if (nextHash === current.hash) return { changed: false, previousHash: current.hash, hash: current.hash, snapshot: current }

      try {
        // External CLIs may rewrite their own config while our synchronous codec
        // prepares an edit. Re-read inside the per-file queue immediately before
        // replacement; never land a transform based on stale bytes.
        const latest = await this.readTarget(target, maxBytes)
        if (latest.hash !== current.hash) {
          throw new ConfigMutationError('changed-under-us', 'The config changed before the edit could be applied.')
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFileAtomic(target, encoded, { fsync: true })
      } catch (cause) {
        if (cause instanceof ConfigMutationError) throw cause
        throw new ConfigMutationError('io', 'The provider config could not be written atomically.', { cause })
      }
      const snapshot: ConfigFileSnapshot = {
        text: nextText,
        hash: nextHash,
        bom: current.bom,
        ...formatting(nextText)
      }
      return { changed: true, previousHash: current.hash, hash: nextHash, snapshot }
    })
  }

  private async target(file: string): Promise<string> {
    const absolute = resolve(file)
    try {
      const stat = await lstat(absolute)
      if (!stat.isSymbolicLink()) return absolute
      try {
        return await realpath(absolute)
      } catch (cause) {
        throw new ConfigMutationError('dangling-symlink', 'The selected config is a dangling symbolic link.', { cause })
      }
    } catch (cause) {
      if (cause instanceof ConfigMutationError) throw cause
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return absolute
      throw new ConfigMutationError('io', 'The selected config could not be inspected.', { cause })
    }
  }

  private async readTarget(target: string, maxBytes: number): Promise<ConfigFileSnapshot> {
    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { text: null, hash: null, bom: false, eol: '\n', trailingNewline: true }
      }
      throw new ConfigMutationError('io', 'The selected config could not be read.', { cause })
    }
    if (bytes.byteLength > maxBytes) {
      throw new ConfigMutationError('too-large', 'The selected config exceeds the safe size limit.')
    }
    const { text, bom } = decode(bytes)
    return { text, hash: digest(bytes), bom, ...formatting(text) }
  }

  private async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const tail = prior.catch(() => undefined).then(() => gate)
    this.tails.set(key, tail)
    await prior.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

export const configMutationCoordinator = new ConfigMutationCoordinator()

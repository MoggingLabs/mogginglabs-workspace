import { createHash } from 'node:crypto'
import type { HostedCliId, McpApplyState, McpServerEntry } from '@contracts'
import { claudeWriter } from './claude'
import { codexWriter } from './codex'
import { geminiWriter } from './gemini'

// The per-CLI config writers (Phase-8/06) — one adapter per dialect, the
// usage-adapter discipline. SURGICAL by contract: an adapter touches ONLY
// blocks wearing the managed marker, preserves every foreign key and line,
// and never goes near auth/credential keys (ADR 0002). The app writes config;
// the CLIs own and run it.

/** Resolved config homes (main passes real ones; the smoke passes fixtures). */
export interface CliHomes {
  /** The user home (`~/.claude.json` lives here). */
  home: string
  /** Codex config dir (`CODEX_HOME` || `~/.codex`). */
  codexDir: string
  /** Gemini config dir (`GEMINI_CONFIG_DIR` || `~/.gemini`). */
  geminiDir: string
}

export interface McpConfigWriter {
  cli: HostedCliId
  targetFile(homes: CliHomes): string
  /** The dialect block shown in the diff preview. */
  renderBlock(entry: McpServerEntry): string
  /** Canonical serialization — the drift-hash source. Writing `entry` and
   *  then reading it back MUST reproduce this exact string. */
  canonical(entry: McpServerEntry): string
  /** The canonical form of the CURRENT managed block in `text`, or null when
   *  no managed entry with this id exists. Throws on an unparseable file. */
  readCanonical(text: string, id: string): string | null
  /** Is `id` DEFINED in this file at all — ours or the user's own? The honesty
   *  probe behind remove(): an entry we cannot splice is still an entry the CLI
   *  loads every session, and "removed" would be a lie. */
  hasEntry(text: string, id: string): boolean
  /** Does `text` hold NOTHING but managed blocks (a composeScoped file we wrote,
   *  or a blank one)? False for anything the user owns — a repo may TRACK its own
   *  `.codex/config.toml` / `.gemini/settings.json`, and 09 never clobbers it. */
  isManagedScoped(text: string): boolean
  /** New file text with our entry upserted (text null = file absent). */
  upsert(text: string | null, entry: McpServerEntry): string
  /** New file text with exactly our entry extracted. Throws when a hand edit has
   *  made a CLEAN extraction impossible — a lossy splice is worse than a no. */
  remove(text: string, id: string): string
  /** A STANDALONE scoped config (all `entries`, this dialect) — the file a
   *  pane is launched against for a tool plan (Phase-8/09). Unlike upsert this
   *  is a fresh whole-file config, not a surgical splice into a shared one. */
  composeScoped(entries: McpServerEntry[]): string
}

export const MCP_WRITERS: readonly McpConfigWriter[] = [claudeWriter, codexWriter, geminiWriter]

export const findWriter = (cli: string): McpConfigWriter | undefined => MCP_WRITERS.find((w) => w.cli === cli)

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** The drift verdict, read-only (never heals): applied = the managed block
 *  matches the hash we stored at write time; edited/missing surface a chip. */
export function applyState(fileText: string | null, writer: McpConfigWriter, id: string, storedHash: string | null): McpApplyState {
  let block: string | null
  try {
    block = fileText === null ? null : writer.readCanonical(fileText, id)
  } catch {
    return storedHash ? 'drift-edited' : 'not-applied' // unparseable file — never guess
  }
  if (!block) return storedHash ? 'drift-missing' : 'not-applied'
  if (!storedHash) return 'drift-edited' // present but unclaimed — a hand-made twin
  return sha256(block) === storedHash ? 'applied' : 'drift-edited'
}

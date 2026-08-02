import { describe, expect, it } from 'vitest'
import { applyState, findWriter, MCP_WRITERS, sha256 } from '@backend/features/integrations/writers'
import type { McpServerEntry } from '@contracts'

// WRITING INTO A CLI'S OWN CONFIG FILE.
//
// These are the most dangerous writes the app makes: `~/.claude.json` and its siblings are the
// user's, edited by hand and by other tools, and a bad splice breaks the CLI on next launch.
//
// The contract each writer signs is stated in its interface and was never tested: writing an
// entry then reading it back MUST reproduce `canonical(entry)` exactly, because that string is
// the drift hash. If the round trip is lossy, every subsequent read reports drift on a file
// nobody touched — and the app "repairs" it, forever.

const ENTRY: McpServerEntry = {
  id: 'mogging',
  label: 'MoggingLabs',
  transport: 'stdio',
  command: '/rt/mogging-node',
  args: ['/rt/mcp/mogging-mcp.mjs']
}

describe('every writer honours the round-trip contract', () => {
  for (const writer of MCP_WRITERS) {
    describe(writer.cli, () => {
      // THE contract, verbatim from the interface: "Writing `entry` and then reading it back
      // MUST reproduce this exact string."
      it('reading back what it rendered reproduces canonical()', () => {
        const canonical = writer.canonical(ENTRY)
        const file = writer.renderBlock(ENTRY)
        expect(writer.readCanonical(file, ENTRY.id), 'a lossy round trip reports drift forever').toBe(canonical)
      })

      it('reports no managed entry when the file has none', () => {
        expect(writer.readCanonical(writer.renderBlock({ ...ENTRY, id: 'other' }), ENTRY.id)).toBeNull()
      })

      // The honesty probe behind remove(): an entry we cannot splice is still an entry the CLI
      // loads every session, and "removed" would be a lie.
      it('hasEntry sees an id it did not write', () => {
        const file = writer.renderBlock(ENTRY)
        expect(writer.hasEntry(file, ENTRY.id)).toBe(true)
        expect(writer.hasEntry(file, 'never-written')).toBe(false)
      })

      it('canonical is stable — the same entry hashes the same twice', () => {
        expect(writer.canonical(ENTRY)).toBe(writer.canonical({ ...ENTRY }))
      })

      it('canonical changes when the entry does, or drift is undetectable', () => {
        expect(writer.canonical(ENTRY)).not.toBe(writer.canonical({ ...ENTRY, args: ['/rt/other.mjs'] }))
      })

      // The hazard is one thing: a file we cannot understand must never end up with TWO
      // definitions of the same id. The writers reach that differently, and the interface's
      // "Throws on an unparseable file" describes only the parsing ones — codex is line-based
      // and never parses, so it cannot detect unparseable input at all. It closes the same
      // hazard at `upsert`, which refuses a foreign untagged table outright.
      it('never lets a file it cannot understand gain a second definition', () => {
        const broken = '{{{ not valid at all'
        let parsed: string | null
        try {
          parsed = writer.readCanonical(broken, ENTRY.id)
        } catch {
          return // a parsing writer: refusing to read IS the protection
        }
        // A non-parsing writer must not claim the entry is present…
        expect(parsed, 'a writer that cannot parse must not invent a managed block').toBeNull()
        // …and must refuse to append beside a definition it cannot splice.
        const foreign = `[mcp_servers.${ENTRY.id}]\ncommand = "theirs"\n`
        expect(() => writer.upsert(foreign, ENTRY), 'appending would leave two definitions').toThrow()
      })
    })
  }

  it('there is a writer for each hosted CLI, and findWriter finds it', () => {
    expect(MCP_WRITERS.length).toBeGreaterThan(2)
    for (const w of MCP_WRITERS) expect(findWriter(w.cli)).toBe(w)
    expect(findWriter('not-a-cli')).toBeUndefined()
  })
})

describe('applyState never guesses', () => {
  const writer = MCP_WRITERS[0]!
  const file = writer.renderBlock(ENTRY)
  const hash = sha256(writer.canonical(ENTRY))

  it('applied when the block matches the hash we stored', () => {
    expect(applyState(file, writer, ENTRY.id, hash)).toBe('applied')
  })

  it('drift-edited when the block is there but different', () => {
    const edited = writer.renderBlock({ ...ENTRY, args: ['/rt/somewhere-else.mjs'] })
    expect(applyState(edited, writer, ENTRY.id, hash)).toBe('drift-edited')
  })

  it('drift-missing when we claimed it and it is gone', () => {
    expect(applyState('{}', writer, ENTRY.id, hash)).toBe('drift-missing')
  })

  it('not-applied when we never claimed it and it is absent', () => {
    expect(applyState('{}', writer, ENTRY.id, null)).toBe('not-applied')
  })

  // A hand-made twin: present, but not ours. Treating it as `applied` would let the app
  // silently adopt — and later rewrite — an entry the user wrote themselves.
  it('drift-edited for a present but UNCLAIMED entry', () => {
    expect(applyState(file, writer, ENTRY.id, null)).toBe('drift-edited')
  })

  it('an absent FILE is not-applied, not an error', () => {
    expect(applyState(null, writer, ENTRY.id, null)).toBe('not-applied')
  })

  // An unparseable file is the case where guessing costs the most.
  it('an unparseable file reports drift when we claimed it, and never "applied"', () => {
    expect(applyState('{{{ broken', writer, ENTRY.id, hash)).toBe('drift-edited')
    expect(applyState('{{{ broken', writer, ENTRY.id, null)).toBe('not-applied')
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isConnectionBridgeEntry, mergeToolCards } from '@contracts'
import { serverEntryFor } from '@backend/features/integrations'
import type { McpServerEntry } from '@contracts'

// A BRIDGE ROW IS RECOGNIZED BY ITS MARKER, NOT ITS POSITION.
//
// Both CLI config entries — the house row and a connection's row — are built by one
// builder that puts the protocol-neutral LAUNCHER first (`args: [launcher, ...spec]`).
// That pushed `--connection` from index 0 to index 1, and every reader that tested
// `args[0] === '--connection'` silently stopped recognizing a bridge row:
//   · the pre-launch connection verification stopped running at all (tool-plan.ts) —
//     a launch carrying connected tools verified none of them, and the gate that
//     proves it (TOOLPULSE) went red;
//   · a connected service's own bridge row started reading as a CLI-OWNED route in
//     the tool cards, which is the app's own fanout wearing someone else's clothes.
// This file pins the predicate against the REAL builder output, so the two can never
// drift apart again.

const RUNTIME = { executable: 'C:\\app\\node.exe', launcher: 'C:\\app\\run\\v11\\bin\\connection-entry.mjs' }

describe('isConnectionBridgeEntry', () => {
  it('recognizes what the shared builder actually produces', () => {
    const entry = serverEntryFor(RUNTIME, { id: 'linear', label: 'Linear', args: ['--connection', 'linear'] })
    expect(entry.args?.[0], 'the launcher leads — this is the shape that broke the readers').toBe(RUNTIME.launcher)
    expect(isConnectionBridgeEntry(entry)).toBe(true)
  })

  it('still recognizes the legacy marker-first shape', () => {
    // Entries saved by older builds are still in users' CLI configs.
    expect(isConnectionBridgeEntry({ id: 'x', label: 'X', transport: 'stdio', command: 'node', args: ['--connection', 'x'] } as McpServerEntry)).toBe(true)
  })

  it('does not claim an ordinary server row', () => {
    const plain = serverEntryFor(RUNTIME, { id: 'house', label: 'House', args: ['--serve'] })
    expect(isConnectionBridgeEntry(plain)).toBe(false)
    expect(isConnectionBridgeEntry({ id: 'y', label: 'Y', transport: 'stdio', command: 'npx', args: [] } as McpServerEntry)).toBe(false)
    expect(isConnectionBridgeEntry({ id: 'z', label: 'Z', transport: 'stdio', command: 'npx' } as McpServerEntry)).toBe(false)
  })
})

describe('nobody reads the marker by position again', () => {
  // THE regression fence. The first fix was a one-line predicate; what actually let the
  // bug happen was that FOUR call sites each hand-rolled the same positional test, so a
  // change to the builder had four silent readers to break. This scan fails the moment a
  // fifth appears — including in a gate, where two of the stale ones were hiding.
  const readAll = (dir: string): Array<{ file: string; text: string }> => {
    const out: Array<{ file: string; text: string }> = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...readAll(full))
      // Comments are stripped: a scan its own explanation can trip proves nothing (the
      // same rule bodyWithoutComments follows next door).
      else if (entry.isFile() && full.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[^\n'"`]*\/\/.*$/gm, '')
        out.push({ file: full, text })
      }
    }
    return out
  }

  it('no source file tests `--connection` by index', () => {
    const offenders = readAll(resolve(import.meta.dirname, '../../src'))
      .filter((f) => /args\s*\??\.?\[\s*0\s*\]\s*===\s*'--connection'/.test(f.text))
      .map((f) => f.file.replace(/.*[\\/]src[\\/]/, 'src/'))
    expect(offenders, 'use isConnectionBridgeEntry — the marker is not at a fixed index').toEqual([])
  })

  it('every reader goes through the one predicate', () => {
    // A file that mentions the marker as a READER (not as the builder's own spec, and
    // not a mutation fixture) must import the predicate.
    const readers = readAll(resolve(import.meta.dirname, '../../src')).filter(
      (f) => /bridgeRow|connectionIds/i.test(f.text) && f.text.includes("'--connection'")
    )
    for (const r of readers) {
      expect(r.text, `${r.file} names bridge rows without the shared predicate`).toMatch(/isConnectionBridgeEntry/)
    }
  })
})

describe('mergeToolCards treats the bridge row as the connection, not a CLI route', () => {
  it('does not attach the app fanout as a CLI-owned server', () => {
    const bridge = serverEntryFor(RUNTIME, { id: 'linear', label: 'Linear', args: ['--connection', 'linear'] })
    const rows = mergeToolCards(
      [{ id: 'linear', label: 'Linear', state: 'connected' } as never],
      [bridge],
      null
    )
    const linear = rows.find((r) => r.id === 'linear')
    expect(linear?.connection, 'the connection route is the truth here').toBeTruthy()
    expect(linear?.server, 'the bridge row is that same tool, not a second route').toBeUndefined()
  })

  it('still attaches a genuinely CLI-owned server', () => {
    const own: McpServerEntry = { id: 'ripgrep', label: 'ripgrep', transport: 'stdio', command: 'npx', args: ['rg-mcp'] }
    const rows = mergeToolCards([], [own], null)
    expect(rows.find((r) => r.id === 'ripgrep')?.server).toEqual(own)
  })
})

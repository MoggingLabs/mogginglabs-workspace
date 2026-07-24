// The provider catalog as the RUNTIME SOURCE (phase-tools/05).
//
// presets.json is retired: MCP_PRESETS is a projection of the catalog through
// presetFromProvider, roster-ordered. These tests pin the projection's invariants —
// the facts step 01's agreement test held between two files now hold between the
// catalog and its one projection.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { presetFromProvider, type ProviderEntry } from '../../src/contracts/integrations/provider-catalog'
import { CATALOG_ROSTER, MCP_PRESETS } from '../../src/backend/features/integrations/catalog'

const ROOT = process.cwd()
const CATALOG_DIR = join(ROOT, 'src', 'contracts', 'integrations', 'catalog')

const entries = new Map<string, ProviderEntry>(
  readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => {
      const e = JSON.parse(readFileSync(join(CATALOG_DIR, f), 'utf8')) as ProviderEntry
      return [e.id, e] as const
    })
)

describe('provider catalog (ADR 0020, the runtime source)', () => {
  it('the roster covers the catalog exactly (display order is data, not accident)', () => {
    const roster = new Set(CATALOG_ROSTER)
    expect(CATALOG_ROSTER.length).toBe(roster.size) // no duplicate roster rows
    for (const id of roster) expect(entries.has(id), `roster names ${id} with no catalog row`).toBe(true)
    for (const id of entries.keys()) expect(roster.has(id), `catalog row ${id} missing from the roster`).toBe(true)
  })

  it('MCP_PRESETS is exactly the roster-ordered projection', () => {
    expect(MCP_PRESETS.map((p) => p.id)).toEqual([...CATALOG_ROSTER])
    for (const p of MCP_PRESETS) {
      const projected = presetFromProvider(entries.get(p.id)!)
      expect(projected).toEqual(p)
    }
  })

  it('projection sanity: auth kinds derive from method ranks, quirks ride the entry', () => {
    for (const e of entries.values()) {
      const p = presetFromProvider(e)
      expect(p.id).toBe(e.id)
      expect(p.label).toBe(e.label)
      // The first non-cliOwned method's kind decides the primary auth kind.
      const ranked = [...e.methods].sort((a, b) => a.rank - b.rank).filter((m) => m.kind !== 'cliOwned')
      if (ranked.length) {
        const expectedFirst = ranked[0]!.kind === 'oauth' ? 'oauth' : ranked[0]!.kind === 'apiKey' ? 'token' : 'none'
        expect(p.authKinds[0], `${e.id} primary auth kind`).toBe(expectedFirst)
      }
      expect(p.cliQuirks).toEqual(e.cliQuirks ?? {})
    }
  })

  it('every entry offers the Claude Code advanced route, ranked last', () => {
    for (const e of entries.values()) {
      const ranked = [...e.methods].sort((a, b) => a.rank - b.rank)
      expect(ranked[ranked.length - 1]!.kind, `${e.id} last method`).toBe('cliOwned')
      expect(ranked[ranked.length - 1]!.name).toBe('Let Claude Code sign in itself (advanced)')
    }
  })

  it('restTools are invisible to the McpPreset projection (dark data, ADR 0021)', () => {
    // The REST-bridge block (restAuth/requiredPermissions/setupTokenUrl/restTools)
    // lands DARK: stripping it must not move the projection by a single field.
    for (const e of entries.values()) {
      const stripped = structuredClone(e) as unknown as Record<string, unknown>
      delete stripped.restAuth
      delete stripped.requiredPermissions
      delete stripped.setupTokenUrl
      delete stripped.restTools
      expect(presetFromProvider(stripped as unknown as ProviderEntry), `${e.id} projection drifted on restTools`).toEqual(presetFromProvider(e))
    }
    // The dark row that holds the schema honest exists and obeys the curation law.
    const posthog = entries.get('posthog')!
    expect(posthog.restTools?.length).toBeGreaterThan(0)
    expect(posthog.restTools!.length).toBeLessThanOrEqual(12)
    expect(posthog.restTools!.some((t) => t.readOnly !== false)).toBe(true)
  })

  it('profile specs carry usable paths (id plus a nameable field)', () => {
    for (const e of entries.values()) {
      if (!e.profile || e.profile.via === 'oidc') continue
      const paths = e.profile.paths ?? {}
      expect(paths.id, `${e.id} profile.paths.id`).toBeTruthy()
      expect(Boolean(paths.email || paths.name), `${e.id} profile needs email or name path`).toBe(true)
    }
  })
})

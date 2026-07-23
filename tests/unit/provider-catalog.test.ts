// The provider catalog ↔ presets.json agreement (phase-tools/01).
//
// The catalog lands DARK: presets.json stays the runtime source until step 05, and
// providerToPreset() is the shim that keeps McpPreset consumers a projection away.
// This test holds the two in agreement for EVERY preset id — so the day step 05
// flips consumers onto the catalog, nothing the UI renders can change by accident.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerToPreset, type ProviderEntry } from '../../src/contracts/integrations/provider-catalog'
import type { McpPreset } from '../../src/contracts/integrations/presets'

const ROOT = process.cwd()
const CATALOG_DIR = join(ROOT, 'src', 'contracts', 'integrations', 'catalog')

const presets = JSON.parse(
  readFileSync(join(ROOT, 'src', 'backend', 'features', 'integrations', 'presets.json'), 'utf8')
) as McpPreset[]

const entries = new Map<string, ProviderEntry>(
  readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => {
      const e = JSON.parse(readFileSync(join(CATALOG_DIR, f), 'utf8')) as ProviderEntry
      return [e.id, e] as const
    })
)

describe('provider catalog (ADR 0020, landing dark)', () => {
  it('covers every preset id, and nothing else', () => {
    const presetIds = new Set(presets.map((p) => p.id))
    for (const id of presetIds) expect(entries.has(id), `catalog missing ${id}`).toBe(true)
    for (const id of entries.keys()) expect(presetIds.has(id), `catalog has ${id} with no preset`).toBe(true)
  })

  it('projects back onto every preset without drift (the step-05 flip is a no-op)', () => {
    for (const p of presets) {
      const entry = entries.get(p.id)!
      const projected = providerToPreset(entry, p.cliQuirks)
      expect(projected.id).toBe(p.id)
      expect(projected.label).toBe(p.label)
      expect(projected.transport).toBe(p.transport)
      expect(projected.urlOrCommand).toBe(p.urlOrCommand)
      expect(projected.group ?? undefined).toBe(p.group ?? undefined)
      expect([...projected.authKinds]).toEqual([...p.authKinds])
      expect([...projected.envRefSlots].sort()).toEqual([...p.envRefSlots].sort())
      expect(Boolean(projected.baseUrlOverride)).toBe(Boolean(p.baseUrlOverride))
      expect(projected.grantCopy).toBe(p.grantCopy)
      expect(projected.verifiedAt).toBe(p.verifiedAt)
    }
  })

  it('every entry offers the Claude Code advanced route, ranked last', () => {
    for (const e of entries.values()) {
      const ranked = [...e.methods].sort((a, b) => a.rank - b.rank)
      expect(ranked[ranked.length - 1]!.kind, `${e.id} last method`).toBe('cliOwned')
      expect(ranked[ranked.length - 1]!.name).toBe('Let Claude Code sign in itself (advanced)')
    }
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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_CLI_REGISTRY } from '../../src/backend/core/agent-clis'
import { configPointerVars } from '../../src/main/agent-config-pointers'

// F002 — the isolated settings home must be unreachable from an inherited env.
//
// `isolatedEnv` (main/agent-settings.ts) exists because `sources.ts` places each provider's
// config by reading that provider's OWN config-dir env var FIRST. A gate run from inside a
// live agent pane inherits those vars, and the "isolated" run then writes into the user's REAL
// CLI config — measured 2026-07-15, when SETAGENTCFG wrote a fixture including a fake API key
// into a live CLAUDE_CONFIG_DIR.
//
// The deletion list was three hand-written names and had already drifted: gemini's registry
// `pointerEnv` is GEMINI_CLI_HOME, `geminiConfigHome()` reads it at HIGHER precedence than the
// legacy GEMINI_CONFIG_DIR — and only the legacy one was deleted. opencode's four direct reads
// were absent entirely. These goldens re-derive the truth from BOTH sources of it, so the next
// provider (or the next rename) cannot reopen the hole quietly.

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('configPointerVars', () => {
  it('covers every pointerEnv the registry declares', () => {
    const declared = AGENT_CLI_REGISTRY.map((d) =>
      d.config && 'pointerEnv' in d.config ? d.config.pointerEnv : undefined
    ).filter(Boolean)
    expect(declared.length).toBeGreaterThan(0) // a registry that declares none means the parse rotted
    for (const v of declared) expect(configPointerVars()).toContain(v)
  })

  it('covers GEMINI_CLI_HOME, which outranks the legacy var', () => {
    // The specific hole: the registry renamed gemini's pointer and the deletion list did not
    // follow, so the higher-precedence var survived isolation.
    expect(configPointerVars()).toContain('GEMINI_CLI_HOME')
    expect(configPointerVars()).toContain('GEMINI_CONFIG_DIR')
  })

  it('covers every config env var sources.ts actually reads', () => {
    // Derived from the reader itself: if a provider adds a new `env?.X` config read and nobody
    // adds it here, this fails rather than silently letting that var escape isolation.
    const src = read('../../src/backend/features/agent-settings/sources.ts')
    const reads = [...src.matchAll(/(?:ctx|context)\.env\?\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])
    const unique = [...new Set(reads)]
    expect(unique.length).toBeGreaterThan(0) // the pattern going blind must not read as "clean"
    for (const v of unique) expect(configPointerVars()).toContain(v)
  })

  it('is deduplicated and non-empty', () => {
    const vars = configPointerVars()
    expect(vars.length).toBe(new Set(vars).size)
    expect(vars).toContain('CLAUDE_CONFIG_DIR')
    expect(vars).toContain('CODEX_HOME')
  })
})

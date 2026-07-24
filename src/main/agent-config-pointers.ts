// The config-pointer env set — pure and Electron-free (vitest imports it directly), the same
// law as runtime-isolation.ts next door.
//
// THE HAZARD: `backend/features/agent-settings/sources.ts` places each provider's config by
// reading that provider's OWN config-dir env var FIRST. An inherited one — set whenever a gate
// runs from inside a Claude/Codex/Gemini/opencode session, i.e. the fleet/dogfood/CI-from-a-pane
// case — steers an "isolated" run straight into the user's REAL CLI config and mutates it
// (measured 2026-07-15: SETAGENTCFG wrote a fixture, incl. a fake API key, into a live
// CLAUDE_CONFIG_DIR). `isolatedEnv` deletes these so the path helpers fall back to the isolated
// home.
//
// WHY IT IS DERIVED. The list used to be three hand-written names, and it drifted from the
// registry it was meant to mirror. It deleted gemini's LEGACY `GEMINI_CONFIG_DIR` but not
// `GEMINI_CLI_HOME` — the var the registry itself declares as gemini's `pointerEnv`, and which
// `geminiConfigHome()` reads at HIGHER precedence — so the one provider whose pointer had been
// renamed was the one still able to escape. opencode's four direct reads were never listed at
// all. Two lists that must agree, with nothing making them agree; the goldens now re-derive the
// read set out of `sources.ts` and fail when a new one appears.
import { AGENT_CLI_REGISTRY } from '@backend/core/agent-clis'

/**
 * Vars `sources.ts` reads directly rather than declaring as a registry `pointerEnv`. Each one
 * produces a WRITABLE user-scope source, so each can relocate a write out of the isolated home.
 */
export const EXTRA_CONFIG_POINTER_VARS = [
  'GEMINI_CONFIG_DIR', // gemini's legacy pointer; the registry's GEMINI_CLI_HOME outranks it
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TUI_CONFIG'
] as const

/** Every env var that can relocate a provider's config: the registry's declared pointers plus
 *  the set `sources.ts` reads directly. Derived, never hand-listed. */
export function configPointerVars(): string[] {
  // `in` rather than a cast: the registry is a const array of literal shapes and only some
  // providers declare a pointer (aider has none), so the property genuinely may be absent.
  // A plain loop rather than map+filter — the literal-union element type makes a
  // `v is string` predicate unassignable to its own parameter.
  const declared: string[] = []
  for (const definition of AGENT_CLI_REGISTRY) {
    const config = definition.config
    if (config && 'pointerEnv' in config && config.pointerEnv) declared.push(config.pointerEnv)
  }
  return [...new Set<string>([...declared, ...EXTRA_CONFIG_POINTER_VARS])]
}

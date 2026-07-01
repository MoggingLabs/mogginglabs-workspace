import type { ProviderMixTemplate } from '@contracts'

/** Built-in provider-mix templates. Users build + save their own alongside these. */
export const PRESETS: ProviderMixTemplate[] = [
  { id: 'preset-solo', name: 'Solo Claude', mix: [{ provider: 'claude', count: 1 }] },
  {
    id: 'preset-pair',
    name: 'Claude + Codex',
    mix: [
      { provider: 'claude', count: 1 },
      { provider: 'codex', count: 1 }
    ]
  },
  {
    id: 'preset-fullstack',
    name: 'Full Stack (2 Claude + Codex + Gemini)',
    mix: [
      { provider: 'claude', count: 2 },
      { provider: 'codex', count: 1 },
      { provider: 'gemini', count: 1 }
    ]
  },
  { id: 'preset-quad', name: 'Quad Claude', mix: [{ provider: 'claude', count: 4 }] }
]

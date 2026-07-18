import type { HostedCliId } from '@contracts'

// Shared CLI display metadata for the integrations surfaces (Settings § Integrations,
// the Library overlay, and the guided flow). Extracted so library.ts and
// integrations.ts can both use it without importing each other for a constant.
export const CLI_LABEL: Record<HostedCliId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
export const CLI_PROVIDER: Record<HostedCliId, string> = { 'claude-code': 'claude', codex: 'codex', gemini: 'gemini' }
export const HOSTED: readonly HostedCliId[] = ['claude-code', 'codex', 'gemini']

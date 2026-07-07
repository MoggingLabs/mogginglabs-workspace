// Deep-linking WITHIN Settings › Integrations (Phase-8/13). Palette verbs and
// the first-run checklist route here — a one-shot target the integrations
// section consumes on entry: open the guided flow, or scroll to a sub-block.
// Routes, not capabilities: every verb lands on the ONE home.

export type IntegrationsFocus = 'flow' | 'matrix' | 'webhooks' | 'servers'

let pending: IntegrationsFocus | null = null

export function requestIntegrationsFocus(target: IntegrationsFocus): void {
  pending = target
}

export function takeIntegrationsFocus(): IntegrationsFocus | null {
  const t = pending
  pending = null
  return t
}

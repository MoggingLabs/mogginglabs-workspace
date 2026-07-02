// Opener seam for the new-workspace wizard (same shape as open-service): the wizard
// feature registers itself; the rail's "+", Ctrl/Cmd+T, and Home's CTA call openWizard.
import type { ProviderCount } from '@contracts'

export interface WizardPrefill {
  cwd?: string
  name?: string
  paneCount?: number
  /** Pre-seeded provider mix (e.g. from a preset chip on Home). */
  mix?: ProviderCount[]
}

let opener: ((prefill?: WizardPrefill) => void) | null = null

export function setWizardOpener(fn: (prefill?: WizardPrefill) => void): void {
  opener = fn
}

/** Open the wizard. Returns false if no opener is registered (caller may fall back). */
export function openWizard(prefill?: WizardPrefill): boolean {
  if (!opener) return false
  opener(prefill)
  return true
}

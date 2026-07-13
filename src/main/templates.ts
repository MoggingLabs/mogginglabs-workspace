import { ipcMain } from 'electron'
import { resolveLayout, PRESETS } from '@backend/features/templates'
import { TemplateChannels, type ProviderCount, type ProviderMixTemplate } from '@contracts'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import { auditDelay, wizardAuditFaults } from './wizard-audit-faults'

// App-wiring: provider-mix template IPC (06b). Presets + user-saved templates + resolveLayout.
// Metadata only — providers + counts, never credentials (ADR 0002). Templates persist in the
// same store as workspace state (05), so nothing new for the daemon.
export function registerTemplates(): void {
  ipcMain.handle(TemplateChannels.list, async () => {
    await maybeFault(TemplateChannels.list) // finding 39's seam: Home's presets, failable on demand
    const custom = getSettingsStore()?.loadTemplates() ?? []
    return [...PRESETS, ...custom]
  })
  ipcMain.handle(TemplateChannels.resolve, async (_e, mix: ProviderCount[]) => {
    const fault = wizardAuditFaults()
    if (fault) {
      fault.resolveCalls++
      await auditDelay(fault.resolveDelayMs)
      if (fault.resolveReject) throw new Error('injected layout resolution failure')
    }
    return resolveLayout(mix)
  })
  ipcMain.handle(TemplateChannels.save, (_e, t: ProviderMixTemplate) => getSettingsStore()?.saveTemplate(t))
  ipcMain.handle(TemplateChannels.remove, (_e, id: string) => getSettingsStore()?.removeTemplate(id))
}

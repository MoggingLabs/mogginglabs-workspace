import { ipcMain } from 'electron'
import { resolveLayout, PRESETS } from '@backend/features/templates'
import { TemplateChannels, type ProviderCount, type ProviderMixTemplate } from '@contracts'
import { getSettingsStore } from './app-settings'

// App-wiring: provider-mix template IPC (06b). Presets + user-saved templates + resolveLayout.
// Metadata only — providers + counts, never credentials (ADR 0002). Templates persist in the
// same store as workspace state (05), so nothing new for the daemon.
export function registerTemplates(): void {
  ipcMain.handle(TemplateChannels.list, () => {
    const custom = getSettingsStore()?.loadTemplates() ?? []
    return [...PRESETS, ...custom]
  })
  ipcMain.handle(TemplateChannels.resolve, (_e, mix: ProviderCount[]) => resolveLayout(mix))
  ipcMain.handle(TemplateChannels.save, (_e, t: ProviderMixTemplate) => getSettingsStore()?.saveTemplate(t))
  ipcMain.handle(TemplateChannels.remove, (_e, id: string) => getSettingsStore()?.removeTemplate(id))
}

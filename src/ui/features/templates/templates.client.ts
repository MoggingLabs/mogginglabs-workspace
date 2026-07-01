import {
  TemplateChannels,
  AgentChannels,
  type AgentInfo,
  type ProviderCount,
  type ProviderMixTemplate,
  type ResolvedLayout
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Typed client for provider-mix templates (06b). Presets + custom templates + resolveLayout,
 *  plus agent detection (reused from 06) to disable uninstalled providers in the builder. */
export const templatesClient = {
  list: (): Promise<ProviderMixTemplate[]> =>
    getBridge().invoke(TemplateChannels.list) as Promise<ProviderMixTemplate[]>,
  resolve: (mix: ProviderCount[]): Promise<ResolvedLayout> =>
    getBridge().invoke(TemplateChannels.resolve, mix) as Promise<ResolvedLayout>,
  save: (t: ProviderMixTemplate): void => {
    void getBridge().invoke(TemplateChannels.save, t)
  },
  detect: (): Promise<AgentInfo[]> => getBridge().invoke(AgentChannels.detect) as Promise<AgentInfo[]>
}

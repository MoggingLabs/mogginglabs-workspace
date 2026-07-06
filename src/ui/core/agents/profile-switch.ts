import { ProfileChannels, type AgentProfile } from '@contracts'
import { getBridge } from '../ipc/bridge'
import { announceProfilesChanged } from './profiles-port'

/**
 * THE active-profile switch (7/09, shared by the popover tiles, the failover
 * toast, and the Settings § Usage plans table — one implementation, N
 * triggers). Flips Phase-4 `order` pointers via the sanitized profiles:save
 * path so `profileId` becomes order 0 for NEW launches; nothing
 * re-authenticates and running panes keep their spawn-time env. Returns the
 * target profile's NAME on a switch, null when there was nothing to do.
 */
export async function switchActiveProfile(providerId: string, profileId: string): Promise<string | null> {
  const bridge = getBridge()
  const profiles = ((await bridge.invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
  const mine = profiles.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)
  const target = mine.find((p) => p.id === profileId)
  const current = mine[0]
  if (!target || !current || current.id === target.id) return null
  await bridge.invoke(ProfileChannels.save, { ...target, order: current.order })
  await bridge.invoke(ProfileChannels.save, { ...current, order: target.order })
  announceProfilesChanged() // palette + failover data follow live (Phase-4 port)
  return target.name
}

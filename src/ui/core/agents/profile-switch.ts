import { ProfileChannels, type AgentProfile, type ProfileActivateResult } from '@contracts'
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
const providerSwitchQueues = new Map<string, Promise<void>>()

/**
 * Serialize list -> activate decisions per provider. The main-side swap is a
 * SQLite transaction; this queue additionally ensures that two renderer
 * surfaces clicked together make their decisions against successive current
 * states instead of the same captured list.
 */
export function switchActiveProfile(providerId: string, profileId: string): Promise<string | null> {
  const previous = providerSwitchQueues.get(providerId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    const bridge = getBridge()
    const profiles = ((await bridge.invoke(ProfileChannels.list)) as AgentProfile[]) ?? []
    const mine = profiles.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)
    const target = mine.find((p) => p.id === profileId)
    const current = mine[0]
    if (!target) throw new Error('That profile is no longer available.')
    if (!current || current.id === target.id) return null
    const result = (await bridge.invoke(ProfileChannels.activate, { providerId, profileId })) as ProfileActivateResult
    if (!result.ok) throw new Error(result.reason ?? 'The default profile could not be changed.')
    announceProfilesChanged() // palette + failover data follow live (Phase-4 port)
    return result.name ?? target.name
  })
  const settled = run.then(() => undefined, () => undefined)
  providerSwitchQueues.set(providerId, settled)
  return run.finally(() => {
    if (providerSwitchQueues.get(providerId) === settled) providerSwitchQueues.delete(providerId)
  })
}

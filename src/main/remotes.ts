import { ipcMain } from 'electron'
import { getEntitlements } from '@backend'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import {
  RemoteChannels,
  REMOTE_ID_SHAPE,
  normalizeRemoteConnection,
  type RemoteHost,
  type RemoteRemoveResult
} from '@contracts'

// App-wiring: remote (SSH) hosts (Phase-4/05). Connection POINTERS only — the user's
// ssh config/agent does all auth (ADR 0002); we never see keys, passphrases, or
// known_hosts. Host names/values live in the local db and pane chips only.

// Hostname / ssh_config alias / user shapes now live in @contracts/domain/remote, so the
// settings boundary, the socket payload boundary, and persisted rows all validate the same
// way (no shell metacharacters — these become argv elements for `ssh`, an arg ARRAY).
const REMOTE_SHELLS = new Set(['sh', 'bash', 'zsh', 'powershell', 'cmd'])

export function sanitizeRemote(raw: unknown): RemoteHost | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.id !== 'string' || !REMOTE_ID_SHAPE.test(r.id)) return null
  // The shared normalizer only speaks POSIX (remote bootstrap's constraint), so it validates
  // the connection FIELDS (name/host/user/port) against a posix-stamped copy; the dialect this
  // app supports — posix OR windows, plus its shell — is decided right below.
  const connection = normalizeRemoteConnection({ ...r, platform: 'posix' })
  if (!connection) return null
  const out: RemoteHost = {
    id: r.id,
    ...connection
  }
  // UNDEFINED STAYS UNDEFINED. An absent platform means the user has never confirmed
  // this host's dialect (listRemotes' whole stance) — and this boundary used to default
  // it to 'posix', so ANY round-trip save of a legacy row (a rename, a port edit)
  // silently confirmed the host on the user's behalf. Only an explicit platform earns
  // a shell; an unconfirmed row saves back exactly as unconfirmed.
  if (r.platform !== undefined) {
    const platform = r.platform
    if (platform !== 'posix' && platform !== 'windows') return null
    const shell = r.shell === undefined ? (platform === 'windows' ? 'powershell' : 'sh') : r.shell
    if (typeof shell !== 'string' || !REMOTE_SHELLS.has(shell)) return null
    if (platform === 'windows' && shell !== 'powershell' && shell !== 'cmd') return null
    if (platform === 'posix' && shell !== 'sh' && shell !== 'bash' && shell !== 'zsh') return null
    out.platform = platform
    out.shell = shell as RemoteHost['shell']
  } else if (r.shell !== undefined) {
    return null // a shell without a platform is a malformed row, not a confirmation
  }
  if (r.identityHint !== undefined) {
    if (typeof r.identityHint !== 'string' || r.identityHint.length > 120) return null
    out.identityHint = r.identityHint
  }
  return out
}

/** The SSH-hosts gate (phase-accounts/05): a NEW host past the plan's cap refuses;
 *  editing a saved one never does. Reads the Entitlements PORT (the tier numbers live
 *  in the config table + the signed claim, not here). The Settings form pre-checks the
 *  same snapshot and SHOWS this wording — the handler below is the enforcement
 *  backstop behind it, so the two can never tell different stories. Local UX only
 *  (ADR 0015 §5); the Free row is generous. */
export function remoteQuotaRefusal(id: string): string | null {
  const existing = getSettingsStore()?.listRemotes() ?? []
  if (existing.some((r) => r.id === id)) return null
  const cap = getEntitlements().limit('maxRemotes')
  if (existing.length < cap) return null
  const plan = getEntitlements().snapshot().plan
  return `Your ${plan} plan keeps up to ${cap} saved SSH ${cap === 1 ? 'host' : 'hosts'}. Remove one, or upgrade your MoggingLabs plan for more.`
}

export function registerRemotes(): void {
  ipcMain.handle(RemoteChannels.list, async () => {
    await maybeFault(RemoteChannels.list) // finding 39's seam: the other half of that tab
    return getSettingsStore()?.listRemotes() ?? []
  })
  ipcMain.handle(RemoteChannels.save, (_e, raw: unknown) => {
    const remote = sanitizeRemote(raw)
    if (!remote) return false
    if (remoteQuotaRefusal(remote.id)) return false // backstop; the form already said why
    getSettingsStore()?.saveRemote(remote)
    return true
  })
  ipcMain.handle(RemoteChannels.remove, (_e, id: unknown): RemoteRemoveResult => {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid remote host id' }
    const store = getSettingsStore()
    if (!store) return { ok: false, reason: 'settings are unavailable; the host was not deleted' }
    const referencedBy = store
      .load()
      .workspaces
      .filter((workspace) => workspace.remotes?.some((remote) => remote?.hostId === id))
      .map((workspace) => workspace.name)
    if (referencedBy.length > 0) {
      return {
        ok: false,
        reason: `This host is still assigned to ${referencedBy.length === 1 ? 'workspace' : 'workspaces'}: ${referencedBy.join(', ')}. Change those panes to local or delete the workspaces first.`,
        referencedBy
      }
    }
    store.removeRemote(id)
    return { ok: true }
  })
}

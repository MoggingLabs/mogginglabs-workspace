import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import {
  RemoteChannels,
  REMOTE_ID_SHAPE,
  normalizeRemoteConnection,
  type RemoteHost
} from '@contracts'

// App-wiring: remote (SSH) hosts (Phase-4/05). Connection POINTERS only — the user's
// ssh config/agent does all auth (ADR 0002); we never see keys, passphrases, or
// known_hosts. Host names/values live in the local db and pane chips only.

export function sanitizeRemote(raw: unknown): (RemoteHost & { platform: 'posix' }) | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.id !== 'string' || !REMOTE_ID_SHAPE.test(r.id)) return null
  const connection = normalizeRemoteConnection(r)
  if (!connection) return null
  const out: RemoteHost & { platform: 'posix' } = {
    id: r.id,
    ...connection
  }
  if (r.identityHint !== undefined) {
    if (typeof r.identityHint !== 'string' || r.identityHint.length > 120) return null
    out.identityHint = r.identityHint
  }
  return out
}

export function registerRemotes(): void {
  ipcMain.handle(RemoteChannels.list, () => getSettingsStore()?.listRemotes() ?? [])
  ipcMain.handle(RemoteChannels.save, (_e, raw: unknown) => {
    const remote = sanitizeRemote(raw)
    if (!remote) return false
    getSettingsStore()?.saveRemote(remote)
    return true
  })
  ipcMain.handle(RemoteChannels.remove, (_e, id: unknown) => {
    if (typeof id === 'string' && id) getSettingsStore()?.removeRemote(id)
  })
}

import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import { RemoteChannels, type RemoteHost } from '@contracts'

// App-wiring: remote (SSH) hosts (Phase-4/05). Connection POINTERS only — the user's
// ssh config/agent does all auth (ADR 0002); we never see keys, passphrases, or
// known_hosts. Host names/values live in the local db and pane chips only.

const ID_SHAPE = /^[\w.-]{1,64}$/
// Hostname / ssh_config alias / user: conservative shapes, no shell metacharacters —
// these become argv elements for `ssh` (arg ARRAY, no shell), belt + braces anyway.
const HOST_SHAPE = /^[A-Za-z0-9._-]{1,253}$/
const USER_SHAPE = /^[a-z_][a-z0-9._-]{0,31}$/i

export function sanitizeRemote(raw: unknown): RemoteHost | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.id !== 'string' || !ID_SHAPE.test(r.id)) return null
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60) return null
  if (typeof r.host !== 'string' || !HOST_SHAPE.test(r.host)) return null
  const out: RemoteHost = { id: r.id, name: r.name.trim(), host: r.host }
  if (r.user !== undefined) {
    if (typeof r.user !== 'string' || !USER_SHAPE.test(r.user)) return null
    out.user = r.user
  }
  if (r.port !== undefined) {
    const p = Number(r.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null
    out.port = p
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

/** A fully confirmed SSH target. The remote bootstrap currently requires a POSIX shell. */
export interface RemoteConnection {
  name: string
  host: string
  platform: 'posix'
  user?: string
  port?: number
}

export const REMOTE_ID_SHAPE = /^[\w.-]{1,64}$/
export const REMOTE_HOST_SHAPE = /^(?!-)[A-Za-z0-9._-]{1,253}$/
export const REMOTE_USER_SHAPE = /^[a-z_][a-z0-9._-]{0,31}$/i

function isIpv4(raw: string): boolean {
  const parts = raw.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIpv6(raw: string): boolean {
  let value = raw
  if (value.startsWith('[') || value.endsWith(']')) {
    if (!(value.startsWith('[') && value.endsWith(']'))) return false
    value = value.slice(1, -1)
  }
  const zoneAt = value.indexOf('%')
  if (zoneAt !== -1) {
    if (value.indexOf('%', zoneAt + 1) !== -1 || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.slice(zoneAt + 1))) return false
    value = value.slice(0, zoneAt)
  }
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((half) => (half ? half.split(':') : []))
  if (groups.some((group) => !group || (!/^[0-9A-Fa-f]{1,4}$/.test(group) && !isIpv4(group)))) return false
  const ipv4At = groups.findIndex((group) => group.includes('.'))
  if (
    ipv4At !== -1 &&
    (ipv4At !== groups.length - 1 || value.endsWith('::') || !isIpv4(groups[ipv4At]))
  ) return false
  const width = groups.length + (ipv4At === -1 ? 0 : 1)
  return halves.length === 2 ? width < 8 : width === 8
}

export function isRemoteHost(raw: string): boolean {
  return REMOTE_HOST_SHAPE.test(raw) || isIpv6(raw)
}

/** Validate untrusted settings, socket payloads, and persisted rows at one shared boundary. */
export function normalizeRemoteConnection(raw: unknown): RemoteConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.platform !== 'posix') return null
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60 || /[\x00-\x1f\x7f]/.test(r.name)) {
    return null
  }
  if (typeof r.host !== 'string' || !isRemoteHost(r.host)) return null

  const out: RemoteConnection = {
    name: r.name.trim(),
    host: r.host,
    platform: 'posix'
  }
  if (r.user !== undefined) {
    if (typeof r.user !== 'string' || !REMOTE_USER_SHAPE.test(r.user)) return null
    out.user = r.user
  }
  if (r.port !== undefined) {
    if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return null
    out.port = r.port
  }
  return out
}

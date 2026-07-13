/** Mirror the persisted act-origin spelling so editors can verify that the
 * requested origin, rather than an unrelated concurrent change, landed. */
export function normalizeBrowserOrigin(raw: string): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`
  try {
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

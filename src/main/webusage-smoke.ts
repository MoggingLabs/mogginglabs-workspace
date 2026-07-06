import { app, type BrowserWindow } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWebSessionUsage, fixtureCookieBackend, type WebSessionDeps } from '@backend/features/usage'
import { findProvider, isSensitiveOrigin, AllChannels } from '@contracts'
import { keySetPlaintext, keyClear, keySlot, resolveKey, isKeyVaultAvailable } from './usage-keys'
import { getSettingsStore } from './app-settings'

// Env-gated web-session smoke (MOGGING_WEBUSAGE, Phase-7/06, ADR 0007.b).
// Drives the class FUNCTIONS directly with a FIXTURE cookie store + a spy — no
// real browser, no network. Asserts the security surface:
//   1. store-read is gated: OFF -> the store backend is NEVER touched (spy
//      count stays 0), provider reads `unconfigured`
//   2. store-read ON -> the backend IS touched (once), session found
//   3. paste path: a pasted cookie (write-only 0007.a store) resolves without
//      any store-read; ciphertext at rest; replace/clear work
//   4. no cookie value rides the returned PlanUsage (grep)
//   5. a sensitive-origin row is refused store-read even when opted in
export function runWebUsageSmoke(_win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000) // safety net

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'webusage-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const cursor = findProvider('cursor')
      if (!cursor) throw new Error('cursor row missing')
      const COOKIE = 'WEBSMOKE-cookie-value-abc123def456'

      // A spy cookie backend: counts reads, returns the fixture cookie.
      let reads = 0
      const store: Record<string, Record<string, string>> = { 'cursor.com': { WorkosCursorSessionToken: COOKIE } }
      const backend = fixtureCookieBackend(() => store)
      const spyBackend = {
        read: async (o: string, n: string): Promise<string | null> => {
          reads++
          return backend.read(o, n)
        }
      }

      // enable/disable the per-provider store-read opt-in (default OFF)
      const setWebRead = (id: string, on: boolean): void => getSettingsStore()?.setSetting(`usage.webread.${id}`, on ? '1' : '0')
      const deps = (id: string): WebSessionDeps => ({
        pasteValue: (pid) => resolveKey(pid),
        storeReadEnabled: () => getSettingsStore()?.getSetting(`usage.webread.${id}`) === '1',
        readCookie: (o, n) => spyBackend.read(o, n)
      })

      keyClear('cursor')
      setWebRead('cursor', false)

      // 1 ── store-read OFF: the store is NEVER touched, provider unconfigured
      const off = await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
      const offOk = reads === 0 && off.health === 'unconfigured'

      // 2 ── store-read ON: the backend fires (once), session found
      setWebRead('cursor', true)
      const on = await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
      const onOk = reads === 1 && /session found/.test(on.reason ?? '')

      // 3 ── paste path: a pasted cookie resolves WITHOUT touching the store
      setWebRead('cursor', false)
      const vaultAvailable = isKeyVaultAvailable()
      let pasteOk = true
      let cipherAtRestOk = true
      let replaceOk = true
      const readsBeforePaste = reads
      if (vaultAvailable) {
        keySetPlaintext('cursor', COOKIE)
        const pasted = await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
        pasteOk = /session found \(via paste\)/.test(pasted.reason ?? '') && reads === readsBeforePaste // store untouched
        // ciphertext at rest: the settings DB never contains the cookie
        const udata = app.getPath('userData')
        let dbBytes = ''
        for (const f of ['app-settings.db', 'app-settings.db-wal']) {
          const fp = join(udata, f)
          if (existsSync(fp)) dbBytes += readFileSync(fp, 'latin1')
        }
        cipherAtRestOk = dbBytes.length > 0 && !dbBytes.includes(COOKIE) && keySlot('cursor').kind === 'keychain'
        keySetPlaintext('cursor', COOKIE + '-rotated')
        replaceOk = resolveKey('cursor') === COOKIE + '-rotated'
        keyClear('cursor')
      } else {
        pasteOk = true
        cipherAtRestOk = true
        replaceOk = true
      }

      // 4 ── no cookie value in the returned shapes (grep)
      const grepClean = ![off, on].some((p) => JSON.stringify(p).includes(COOKIE))

      // 5 ── sensitive origin refused store-read even when opted in
      const sensRow = { ...cursor, id: 'websmoke-bank', origin: 'chase.com', cookieName: 'session' }
      setWebRead('websmoke-bank', true)
      const readsBeforeSens = reads
      const sens = await fetchWebSessionUsage(sensRow, 'default', new AbortController().signal, {
        pasteValue: () => null,
        storeReadEnabled: () => true,
        readCookie: (o, n) => spyBackend.read(o, n)
      })
      const sensitiveOk = isSensitiveOrigin('chase.com') && reads === readsBeforeSens && sens.health === 'unconfigured' && /blocklist/.test(sens.reason ?? '')

      // 6 ── structural: the cookie rides the write-only key channels; NO
      //      channel returns a key/cookie VALUE (configGet returns presence, not
      //      secrets; webReadSet is a consent toggle — both legitimate).
      const noGetterOk =
        !AllChannels.some((c) => /usage:(key|cookie|secret|session|token)(get|reveal|show|value|peek|read)/i.test(c)) &&
        AllChannels.includes('usage:webReadSet')

      setWebRead('cursor', false)
      keyClear('cursor')

      const pass = offOk && onOk && pasteOk && cipherAtRestOk && replaceOk && grepClean && sensitiveOk && noGetterOk
      result = { pass, offOk, onOk, pasteOk, cipherAtRestOk, replaceOk, grepClean, sensitiveOk, noGetterOk, vaultAvailable, reads }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 800)
}

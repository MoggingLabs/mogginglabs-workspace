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
      // Fixture HTTP: the REAL cursor parse runs against a canned usage-summary
      // body — the spec path is exercised end-to-end with ZERO network.
      let httpCalls = 0
      const CANNED = {
        billingCycleEnd: new Date(Date.now() + 9 * 86_400_000).toISOString(),
        membershipType: 'pro',
        individualUsage: {
          plan: { used: 1520, limit: 2000, totalPercentUsed: 76 },
          onDemand: { enabled: true, used: 1250, limit: 5000 }
        }
      }
      let httpStatus = 200
      const deps = (id: string): WebSessionDeps => ({
        pasteValue: (pid) => resolveKey(pid),
        storeReadEnabled: () => getSettingsStore()?.getSetting(`usage.webread.${id}`) === '1',
        readCookie: (o, n) => spyBackend.read(o, n),
        http: async () => {
          httpCalls++
          return { status: httpStatus, body: httpStatus === 200 ? CANNED : null }
        }
      })

      keyClear('cursor')
      setWebRead('cursor', false)

      // 1 ── store-read OFF: neither the store NOR the endpoint is touched
      const off = await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
      const offOk = reads === 0 && httpCalls === 0 && off.health === 'unconfigured'

      // 2 ── store-read ON: the backend fires (once) and the REAL cursor spec
      //      parses the fixture body into a FRESH plan — percent lane + the
      //      on-demand dollars riding `spend` (phase-11: the class used to
      //      return 'unconfigured' on its own success path).
      setWebRead('cursor', true)
      const on = await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
      const onOk =
        reads === 1 &&
        httpCalls === 1 &&
        on.health === 'fresh' &&
        on.planLabel === 'Cursor (pro)' &&
        on.windows[0]?.label === 'Plan' &&
        on.windows[0]?.usedPct === 76 &&
        !!on.windows[0]?.resetsAt &&
        on.spend?.amount === 12.5 &&
        on.spend?.limit === 50

      // 2b ── a rejected cookie THROWS the human reason (the seam dims stale)
      httpStatus = 401
      let rejectedOk = false
      try {
        await fetchWebSessionUsage(cursor, 'default', new AbortController().signal, deps('cursor'))
      } catch (e) {
        rejectedOk = /cookie rejected/.test(e instanceof Error ? e.message : '')
      }
      httpStatus = 200

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
        pasteOk = pasted.health === 'fresh' && reads === readsBeforePaste // store untouched; the paste alone fed the spec
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

      const pass = offOk && onOk && rejectedOk && pasteOk && cipherAtRestOk && replaceOk && grepClean && sensitiveOk && noGetterOk
      result = { pass, offOk, onOk, rejectedOk, pasteOk, cipherAtRestOk, replaceOk, grepClean, sensitiveOk, noGetterOk, vaultAvailable, reads, httpCalls }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 800)
}

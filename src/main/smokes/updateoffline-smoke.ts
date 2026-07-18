import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The wake-from-sleep regression (found live on v0.14.0 — updater.log): the boot check hit
 * net::ERR_NAME_NOT_RESOLVED while the Wi-Fi re-associated, and the rail wore a red "Update
 * failed — retry" for hours on a healthy network, with a retry that "did nothing" because
 * the network was still down each time it was pressed. Four promises, in order:
 *
 *   1. a BACKGROUND check that fails offline never raises the rail row — quiet idle, and
 *      the settings card says "offline" honestly instead of "the updater broke"
 *   2. a HUMAN-initiated check while offline answers loudly, with connection copy
 *   3. that answer STANDS through further background failures (never silently retracted),
 *      and re-checks keep completing (lastCheckedAt advances)
 *   4. when the network returns, the offline-retry ladder clears the row on its own —
 *      no clicks, phase idle, "up to date"
 *
 * The fixture feed (harness-install) reads MOGGING_UPDATE_OUTCOME per check; this smoke
 * flips it to 'ok' to end the outage, so ordering is deterministic under any timer
 * interleaving. Assertions poll — never a bare sleep — because the compressed retry ladder
 * keeps 250ms 'checking' windows cycling through every state read.
 */
export function runUpdateOfflineSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  interface UState {
    phase: string
    error?: string
    offline?: boolean
    lastCheckedAt?: number
  }
  interface Probe {
    railVisible: boolean
    railLabel: string
    railTitle: string
    railError: boolean
    settingsStatus: string
    settingsRetryEnabled: boolean
  }

  const state = (): Promise<UState> => ES<UState>(`window.bridge.invoke('update:stateGet')`)
  const probe = (): Promise<Probe> =>
    ES<Probe>(`(() => {
      const rail = document.querySelector('.rail-update-btn')
      const footer = rail?.closest('.rail-footer')
      const status = document.querySelector('[data-section="about"] .update-status')
      const retry = [...document.querySelectorAll('[data-section="about"] button')]
        .find((el) => el.textContent?.trim() === 'Check for updates')
      return {
        railVisible: footer instanceof HTMLElement && !footer.hidden,
        railLabel: rail?.textContent?.trim() || '',
        railTitle: rail instanceof HTMLElement ? rail.title : '',
        railError: rail?.classList.contains('is-error') || false,
        settingsStatus: status?.textContent || '',
        settingsRetryEnabled: retry instanceof HTMLButtonElement && !retry.disabled
      }
    })()`)

  const until = async <T>(
    read: () => Promise<T>,
    good: (v: T) => boolean,
    tries: number,
    ms: number
  ): Promise<T> => {
    let v = await read()
    for (let i = 0; i < tries && !good(v); i++) {
      await sleep(ms)
      v = await read()
    }
    return v
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // ── 1. The boot (background) check fails offline → QUIET. MOGGING_UPDATE_OUTCOME is
      // unset, so every fixture check ends net::ERR_NAME_NOT_RESOLVED.
      const s1 = await until(state, (s) => s.phase === 'idle' && s.offline === true && !!s.lastCheckedAt, 60, 250)

      // Settings mounts lazily — same entry a user takes: titlebar gear, then the About tab.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      await ES(`(document.querySelector('.settings-nav-item[data-target="about"]')?.click(), 1)`)
      await sleep(400)
      const p1 = await until(probe, (p) => p.settingsStatus.includes('offline'), 20, 250)

      const quietOk =
        s1.phase === 'idle' &&
        s1.offline === true &&
        !!s1.lastCheckedAt &&
        !p1.railVisible &&
        p1.settingsStatus.includes('offline') &&
        p1.settingsRetryEnabled

      // ── 2. A human clicks "Check for updates" while still offline → LOUD, honest copy.
      await ES(`([...document.querySelectorAll('[data-section="about"] button')]
        .find((el) => el.textContent?.trim() === 'Check for updates')?.click(), 1)`)
      const s2 = await until(state, (s) => s.phase === 'error', 40, 250)
      const p2 = await until(probe, (p) => p.railVisible && p.railError, 20, 250)

      const manualLoudOk =
        s2.phase === 'error' &&
        s2.offline === true &&
        (s2.lastCheckedAt ?? 0) > (s1.lastCheckedAt ?? 0) &&
        s2.error?.includes('check your connection') === true &&
        p2.railVisible &&
        p2.railError &&
        p2.railLabel === 'Update failed — retry' &&
        p2.railTitle.includes('check your connection') &&
        p2.settingsStatus.includes('check your connection')

      // ── 3. The delivered answer STANDS while the outage continues — background retries
      // refresh it (lastCheckedAt advances) but never retract it — and the rail row's own
      // retry keeps re-checking. The click may land inside a 'checking' window and be a
      // no-op; the ladder's next attempt still advances the clock, which is the assertion.
      const clicked = await ES<boolean>(`(() => {
        window.__updOffPhases = []
        window.bridge.on('update:state', (s) => window.__updOffPhases.push(s.phase))
        const b = document.querySelector('.rail-update-btn')
        if (!(b instanceof HTMLButtonElement)) return false
        b.click()
        return true
      })()`)
      const s3 = await until(
        state,
        (s) => s.phase === 'error' && (s.lastCheckedAt ?? 0) > (s2.lastCheckedAt ?? 0),
        40,
        250
      )
      const phases = await ES<string[]>(`window.__updOffPhases || []`)

      const standsOk =
        clicked &&
        phases.includes('checking') &&
        phases.includes('error') &&
        s3.phase === 'error' &&
        s3.offline === true &&
        (s3.lastCheckedAt ?? 0) > (s2.lastCheckedAt ?? 0)

      // ── 4. The network returns. NOBODY clicks anything: the offline-retry ladder must
      // clear the row on its own — that latch outliving the outage IS the shipped bug.
      process.env.MOGGING_UPDATE_OUTCOME = 'ok'
      const s4 = await until(state, (s) => s.phase === 'idle' && s.offline !== true, 80, 250)
      const p4 = await until(probe, (p) => !p.railVisible && p.settingsStatus.includes('up to date'), 20, 250)

      const healOk =
        s4.phase === 'idle' &&
        s4.offline !== true &&
        (s4.lastCheckedAt ?? 0) > (s3.lastCheckedAt ?? 0) &&
        !p4.railVisible &&
        p4.settingsStatus.includes('up to date')

      result = {
        pass: quietOk && manualLoudOk && standsOk && healOk,
        quietOk,
        manualLoudOk,
        standsOk,
        healOk,
        s1,
        s2,
        s3,
        s4,
        p1,
        p2,
        p4,
        phases
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'updateoffline-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}

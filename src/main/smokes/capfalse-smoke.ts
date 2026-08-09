import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateThresholds, type ThresholdKv } from '@backend/features/usage/thresholds'
import { USAGE_ALERT_DEFAULTS, type AgentProfile, type PlanUsageView, type UsageAlert } from '@contracts'
import { getSettingsStore } from '../app-settings'

// CAPFALSE (MOGGING_CAPFALSE) — the gate that would have caught the shipped
// defect: after an app-update restart, EVERY pane was covered by an
// input-blocking "cdev hit its usage limit / Continue on cmain" card, on a
// 5-hour window that was entirely unused.
//
// This gate exists because the claim is a NEGATIVE that spans four modules and
// two processes — the KV outbox, the renderer's mount drain, the usage-capped
// port, and the pane overlay — and no unit tier can compose that. It is
// deliberately its own verdict file rather than a leg of USAGEUI: USAGEUI's
// replay claim is a POSITIVE ("a queued alert reaches the DOM"), and a negative
// bolted onto a positive gate reads as an exception to it.
//
// Claims:
//   a3 — the ENGINE cannot mint a false `capped` across an identity change,
//        against the REAL settings store (real key strings, real JSON
//        round-trip — the one thing an in-memory fake KV cannot exercise).
//   a4 — a lane the engine has never seen cannot fire `capped` at all, held
//        across an explicit observation window rather than a single tick.
//
//   a1 — THE INCIDENT, inverted. A `capped` alert is planted in the persisted
//        outbox for a lane the live snapshot shows at 42%, the renderer is
//        RELOADED (the update-restart shape), and no pane may be covered —
//        asserted across an explicit observation window, with the number of
//        polls written into the verdict file so an unmeasured run cannot pass.
//   a2 — its positive control, same run: the lane port must simultaneously
//        report the genuinely-exhausted fixture AS capped. Without a2, a1 is
//        satisfiable by a port that died.
export function runCapFalseSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 40, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'capfalse-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const NOW = Date.parse('2026-08-02T12:00:00Z')
  const FUTURE = new Date(NOW + 3_600_000).toISOString()

  const profiles: AgentProfile[] = [
    { id: 'cap-a', name: 'cap-a', provider: 'capfalse', env: {}, order: 0 },
    { id: 'cap-b', name: 'cap-b', provider: 'capfalse', env: {}, order: 1 }
  ]

  const plan = (profileId: string, id: string, label: string, usedPct: number): PlanUsageView => ({
    providerId: 'capfalse',
    profileId,
    planLabel: `Plan ${profileId}`,
    windows: [{ id, label, usedPct, resetsAt: FUTURE }],
    fetchedAt: NOW,
    health: 'fresh'
  })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // Poll, never sleep-then-hope: this gate is dispatched during boot and the
      // store is registered on its own schedule.
      let store = getSettingsStore()
      for (let i = 0; i < 50 && !store; i++) {
        await new Promise((r) => setTimeout(r, 200))
        store = getSettingsStore()
      }
      if (!store) throw new Error('settings store not registered')
      // The REAL KV, not a Map: these are the actual key strings and the actual
      // JSON round-trip the shipped app persists through.
      const kv: ThresholdKv = { get: (k) => store.getSetting(k) ?? null, set: (k, v) => store.setSetting(k, v) }

      const evalOne = (p: PlanUsageView, sibling: PlanUsageView): UsageAlert[] =>
        evaluateThresholds([p, sibling], USAGE_ALERT_DEFAULTS, profiles, kv, NOW).filter((a) => a.profileId === p.profileId)
      const cool = plan('cap-b', 'lane_x', 'Weekly (Opus)', 10)

      // ── a4: a lane nobody has ever seen cannot fire `capped`, and the silence
      // is observed across a window rather than inferred from one tick.
      const coldLevels: (string | undefined)[] = []
      for (let i = 0; i < 4; i++) coldLevels.push(evalOne(plan('cap-a', 'lane_new', 'Brand New', 100), cool)[0]?.level)
      const neverSeenNeverCaps = coldLevels[0] === 'warn' && coldLevels.slice(1).every((l) => l === undefined)

      // ── the positive control. Without it, a4 is satisfiable by an engine that
      // simply never speaks, which would be a far worse bug wearing a green gate.
      const armed = evalOne(plan('cap-a', 'lane_ctl', 'Control', 50), cool)
      const capped = evalOne(plan('cap-a', 'lane_ctl', 'Control', 100), cool)
      const knownLaneStillCaps = armed.length === 0 && capped[0]?.level === 'capped'

      // ── a3.1: a LABEL rename must not re-fire. Same lane id, new prose — this
      // is the thing that actually happened (`seven_day_opus` -> `seven_day_fable`).
      const renamedLevels: (string | undefined)[] = []
      for (let i = 0; i < 3; i++) renamedLevels.push(evalOne(plan('cap-a', 'lane_ctl', 'Control RENAMED', 100), cool)[0]?.level)
      const renameIsSilent = renamedLevels.every((l) => l === undefined)

      // ── a3.2: a PROFILE-ID change must not re-fire a lane the user was shown
      // under the old id... and must not fire `capped` for an id with no state.
      const flippedLevels: (string | undefined)[] = []
      for (let i = 0; i < 3; i++) flippedLevels.push(evalOne(plan('login-capfalse', 'lane_ctl', 'Control', 100), cool)[0]?.level)
      const profileFlipNeverCaps = flippedLevels.every((l) => l !== 'capped')

      // The state really did survive as bytes in the store, under the key the
      // shipped app uses — otherwise every claim above passes on an empty read.
      const persisted = store.getSetting('usage.thr.capfalse.cap-a')
      const persistedOk = !!persisted && persisted.includes('lane_ctl')

      // ── a1/a2: the DELIVERY half, against the real renderer.
      //
      // Plant a `capped` alert in the persisted outbox for `fake/default`, whose
      // fixture sits at 42%. This is precisely the shipped shape: an alert queued
      // while the window was gone (an update quit), never acked, replayed on the
      // next mount. Then reload the renderer, which is the restart.
      await waitTrue(`!!(window.__mogging && window.__mogging.agents && window.__mogging.agents.cappedState)`, 60, 250)
      store.setSetting(
        'usage.alert.outbox',
        JSON.stringify([
          {
            kind: 'threshold',
            level: 'capped',
            providerId: 'fake',
            profileId: 'default',
            planLabel: 'Fake Pro (normal)',
            windowLabel: 'Session (5h)',
            usedPct: 100,
            title: 'CAPFALSE — usage limit reached (Session (5h))',
            body: 'planted by the CAPFALSE gate',
            alertId: 'capfalse-stale-1',
            // Recent enough to survive the TTL, and boundary-free so the outbox's
            // own window-expiry rule cannot be what saves us here: this claim is
            // about the PANE path declining, not about delivery hygiene.
            queuedAt: Date.now() - 60_000
          }
        ])
      )
      wc.reload()
      await new Promise<void>((res) => wc.once('did-finish-load', () => res()))

      // The alert really did arrive (its toast rendered) — otherwise "no pane was
      // covered" would be trivially true because nothing happened at all.
      const staleAlertDelivered = await waitTrue(
        `[...document.querySelectorAll('.toast .toast-title')].some(t => t.textContent.includes('CAPFALSE'))`,
        60,
        250
      )
      // ...and the port had LOOKED by then, so the negative is not merely the
      // boot race declining to act.
      await waitTrue(`!!(window.__mogging?.agents?.cappedState) && window.__mogging.agents.cappedState().laneKnown === true`, 60, 250)

      // THE OBSERVATION WINDOW. A negative that cannot prove it looked is not a
      // negative — the poll count rides in the verdict file.
      let offerPollsObserved = 0
      let anyOffer = false
      for (let i = 0; i < 20 && !anyOffer; i++) {
        anyOffer = await ES<boolean>(
          `!!document.querySelector('.pane-offer.is-active') || (window.__mogging?.agents?.cappedState()?.raised.length ?? 0) > 0`
        ).catch(() => false)
        offerPollsObserved++
        await sleep(200)
      }
      const noPaneCovered = !anyOffer && offerPollsObserved >= 20

      // a2, the positive control IN THE SAME RUN: the machinery is alive and the
      // evidence is being read — the genuinely-exhausted fixture IS reported as
      // capped while `fake/default` is not.
      const state = await ES<{ laneKnown: boolean; cappedLanes: string[]; raised: number[] }>(
        `window.__mogging.agents.cappedState()`
      )
      const laneKnown = state?.laneKnown === true
      const sawExhausted = (state?.cappedLanes ?? []).some((l) => l.startsWith('fake/exhausted/'))
      const didNotSeeDefault = !(state?.cappedLanes ?? []).some((l) => l.startsWith('fake/default/'))
      const controlOk = laneKnown && sawExhausted && didNotSeeDefault

      const pass =
        neverSeenNeverCaps &&
        knownLaneStillCaps &&
        renameIsSilent &&
        profileFlipNeverCaps &&
        persistedOk &&
        staleAlertDelivered &&
        noPaneCovered &&
        controlOk
      result = {
        pass,
        neverSeenNeverCaps,
        knownLaneStillCaps,
        renameIsSilent,
        profileFlipNeverCaps,
        persistedOk,
        staleAlertDelivered,
        noPaneCovered,
        controlOk,
        offerPollsObserved,
        cappedLanes: state?.cappedLanes ?? [],
        // Diagnostics, not claims — an engine that went silent for the wrong
        // reason should be one question deep, not an afternoon.
        coldLevels,
        renamedLevels,
        flippedLevels,
        observedTicks: coldLevels.length + renamedLevels.length + flippedLevels.length
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  void run()
}

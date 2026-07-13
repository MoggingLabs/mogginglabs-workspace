import { app, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentChannels,
  BoardChannels,
  BrowserChannels,
  IntegrationsChannels,
  ProfileChannels,
  RemoteChannels,
  ReviewChannels,
  TemplateChannels,
  UsageChannels,
  WorkspaceChannels,
  type PlanUsageView
} from '@contracts'
import { createWorktree } from '@backend/features/worktrees'
import { setAsyncAuditFaults } from './async-audit-faults'
import { flushTrailForSmoke, recordTrail } from './trail'

/**
 * Audit regression gate for finding 39 — the shared async-state policy (MOGGING_ASYNCSTATE).
 *
 * Finding 39 was not one bug; it was eight features each inventing their own answer to "what
 * happens when this call fails", which is the same as having no answer. The fix is one primitive
 * (src/ui/core/async/async-state.ts) that owes the user four things, and this gate exists to prove
 * each of them survives, in the REAL UI, on the REAL channel, driven through the REAL control:
 *
 *   1. a VISIBLE error       — no silence, no blank tab, no calm empty state standing in for a
 *                              failure. Something on screen must name what went wrong.
 *   2. an ACTIONABLE error   — a human sentence, never a stack, never Electron's
 *                              "Error invoking remote handler '…':" wrapper. Every phase runs the
 *                              rendered text through RAW_LEAK below and fails if machine noise
 *                              reaches a person.
 *   3. NOT STRANDED          — every control disabled on click comes back. Integrations' Preview
 *                              and Connect disabled themselves and re-enabled on the line AFTER
 *                              the await, so a rejection stranded them disabled FOREVER: the one
 *                              thing the user needed (retry) was the one thing they could not do.
 *   4. NO STALE WINNER       — a request generation, so a slow answer for the filter you LEFT can
 *                              never overwrite the fast answer for the filter you are READING.
 *
 * Every phase arms a fault on a named channel (src/main/async-audit-faults.ts — reject / hang /
 * a per-channel delay FIFO), drives the same button, select or view-entry a user would, asserts
 * the four laws above on the DOM, disarms, and — where the action is cheap and safe to REALLY run
 * — repeats it unfaulted as a POSITIVE CONTROL. That control is not ceremony: without it a phase
 * could go green because the driver was broken and nothing ever ran. Every click helper below
 * returns whether its node existed, and a missing node FAILS the phase rather than passing it
 * quietly — a rotted selector must never read as a passing gate.
 *
 * Two deliberate abstentions, both about doing real damage:
 *   · `integrations:cat:connect` is only ever clicked with the fault ARMED. maybeAsyncFault runs
 *     as the handler's first line (mcp-manager.ts), so the write pipeline never executes — an
 *     unfaulted Connect would write MCP server entries into the user's real CLI config files,
 *     which no gate may do. Preview (a pure read) carries the positive control for that panel.
 *   · `browser:navigate` is only ever clicked with the fault ARMED, for the same reason at the
 *     network boundary. Reload (a local no-op on an empty guest) carries its control.
 *
 * Evidence: out/asyncstate-result.json records the ACTUAL sentence each surface showed, the
 * actual disabled flags, and the actual rows — because when this fails in six months, that JSON
 * is the only witness left of what the UI really said.
 */

/** Machine noise, in the shapes the audit found leaking into human sentences — plus the one the
 *  IPC layer writes ITSELF. "reply was never sent" is Electron's ReplyChannel destructor answering
 *  an invoke whose handler was collected without settling (see phase 6b): a real reply, arriving as
 *  an ordinary rejection, which the Usage card duly read out to the user as "The cost scan didn’t
 *  run — reply was never sent". If any of these matches what a person can read, describeAsyncError
 *  has stopped doing its job. */
const RAW_LEAK = /Error invoking remote|reply was never sent|at \w+ \(|\.ts:\d+|\bat Object\./

/** A sentence a person can act on: it exists, it says something, and it is not a stack. */
const humane = (s: string | null | undefined): boolean => !!s && s.trim().length > 0 && !RAW_LEAK.test(s)

/** A call that NEVER ANSWERS ends in one of exactly two sentences, and both are ours: the guard's
 *  own `Timed out trying to {action}.`, or describeAsyncError's `Could not {action}. Try again.`
 *  fallback for a rejection that carried nothing readable. WHICH one lands is a race this gate does
 *  not own and must not legislate (6b explains it) — so what is asserted is the thing that actually
 *  matters: the async policy wrote this sentence, not the transport. */
const gaveUpInWords = (s: string): boolean =>
  humane(s) && (/^Timed out trying to \S/.test(s) || /^Could not .+\. Try again\.$/.test(s))

/** async-audit-faults throws `Injected failure for <channel> (async-audit-faults)`. Asserting the
 *  message SURVIVED (stripped of Electron's IPC wrapper, not replaced by a generic) proves both
 *  that our fault is the cause — not some unrelated breakage — and that describeAsyncError kept
 *  the readable half of the error instead of pasting the whole thing at someone. */
const fromFault = (s: string): boolean => s.includes('Injected failure')

interface EmptyRead {
  has: boolean
  title: string
  body: string
  icon: boolean
  retry: boolean
}
interface ToastRead {
  tone: string
  title: string
  body: string
}

/** The FAKE plan the usage surfaces need to exist at all. Under a non-usage smoke the adapter
 *  registry is EMPTY by design (usage.ts: zero network is structural), so `plans` is [] — the
 *  popover paints its "no usage sources" menu and the Settings cost card scans nothing, and the
 *  ONE channel finding 39 broke on both surfaces (`usage:cost`) would never be called. Pushing a
 *  snapshot down the real `usage:changed` channel is how usage ALWAYS arrives in the renderer
 *  (usage/index.ts + settings/usage.ts both subscribe), so the surfaces under test are the real
 *  ones — we are only supplying the data a real session would have. Nothing re-pushes over it:
 *  with no adapters the poller never emits, and with no status fetcher neither does the status
 *  feed. */
const FIXTURE_PLAN: PlanUsageView = {
  providerId: 'fake',
  profileId: 'default',
  planLabel: 'ASYNCSTATE fixture',
  windows: [{ label: 'Session (5h)', usedPct: 42 }],
  fetchedAt: Date.now(),
  health: 'fresh'
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/** A throwaway repo + one commit — the only way to give Review something real to open in its
 *  positive control (an unfaulted diff must produce the MODAL, not another toast). */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mogging-asyncstate-'))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), 'line one\nline two\nline three\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

export function runAsyncStateSmoke(win: BrowserWindow): void {
  // Generous: the hang phase deliberately waits out an 8s UI timeout and the generation phase a
  // 1.5s injected delay, on top of a renderer reload and a git worktree.
  setTimeout(() => app.exit(1), 240000)

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
  const reload = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wc.once('did-finish-load', () => resolve())
      wc.reload()
    })
    await sleep(1800)
  }

  const sel = (s: string): string => JSON.stringify(s)

  /** Click a REAL control. Returns false when the node is missing — which fails the phase, so a
   *  renamed selector can never masquerade as a pass. */
  const click = (s: string): Promise<boolean> =>
    ES<boolean>(`(() => { const e = document.querySelector(${sel(s)}); if (!e) return false; e.click(); return true })()`)

  /** Click a control AND read, in the same synchronous turn, whether the click disabled it. The
   *  guard's onLoading runs before its first await, so this observes the disable the audit says
   *  used to be permanent — half of assertion (c); the other half is read after it settles. */
  const clickAndReadDisabled = (s: string): Promise<{ clicked: boolean; disabledOnClick: boolean }> =>
    ES(`(() => {
      const e = document.querySelector(${sel(s)})
      if (!e) return { clicked: false, disabledOnClick: false }
      e.click()
      return { clicked: true, disabledOnClick: e.disabled === true }
    })()`)

  const text = (s: string): Promise<string> =>
    ES<string>(`(document.querySelector(${sel(s)})?.textContent || '').trim()`)
  const exists = (s: string): Promise<boolean> => ES<boolean>(`!!document.querySelector(${sel(s)})`)
  const isDisabled = (s: string): Promise<boolean | null> =>
    ES<boolean | null>(`(() => { const e = document.querySelector(${sel(s)}); return e ? e.disabled === true : null })()`)
  const viewClass = (): Promise<string> => ES<string>(`document.querySelector('#app')?.className || ''`)

  /** The house EmptyState, read whole: an error state and a calm "you have nothing" state are the
   *  SAME component, and telling them apart is assertion (d). */
  const emptyState = (host: string): Promise<EmptyRead> =>
    ES<EmptyRead>(`(() => {
      const e = document.querySelector(${sel(host)} + ' .empty-state')
      return {
        has: !!e,
        title: (e && e.querySelector('.empty-title') ? e.querySelector('.empty-title').textContent : '').trim(),
        body: (e && e.querySelector('.empty-body') ? e.querySelector('.empty-body').textContent : '').trim(),
        icon: !!(e && e.querySelector('.empty-icon svg')),
        retry: !!(e && e.querySelector('button[aria-label="Retry"]'))
      }
    })()`)

  const toasts = (): Promise<ToastRead[]> =>
    ES<ToastRead[]>(`[...document.querySelectorAll('.toast')].map((t) => ({
      tone: (t.className.match(/toast--(\\w+)/) || ['', ''])[1],
      title: (t.querySelector('.toast-title') ? t.querySelector('.toast-title').textContent : '').trim(),
      body: (t.querySelector('.toast-body') ? t.querySelector('.toast-body').textContent : '').trim()
    }))`)
  /** Harness hygiene, not product behaviour: a toast from the previous phase must never be read as
   *  this phase's evidence. (Toasts self-dismiss at 6s and the stack caps at 4.) */
  const clearToasts = (): Promise<number> =>
    ES<number>(`(() => { const t = [...document.querySelectorAll('.toast')]; t.forEach((x) => x.remove()); return t.length })()`)
  const waitToast = async (titlePrefix: string, tries = 40, gap = 150): Promise<ToastRead | null> => {
    for (let i = 0; i < tries; i++) {
      const hit = (await toasts()).find((t) => t.title.startsWith(titlePrefix))
      if (hit) return hit
      await sleep(gap)
    }
    return null
  }

  // ── Settings navigation ───────────────────────────────────────────────────────
  const SETTINGS_BTN = '.icon-btn[aria-label="Settings"]'
  const inSettings = async (): Promise<boolean> => (await viewClass()).includes('view-settings')

  /**
   * Enter Settings FRESH — leaving first when the page is already up.
   *
   * This matters, and it is easy to get wrong: Profiles/Hosts and Providers do NOT re-read on a
   * tab click. They re-read on the settings ENTRY (settings/index.ts: onViewChange -> a
   * providers.refresh() and a profilesHosts.refresh()), and view-port only notifies on a REAL
   * transition — re-selecting the view you are already on is a no-op. So a gate that armed a fault
   * and clicked a nav item would assert against the reads from BEFORE it armed, and pass while
   * proving nothing. Leaving and coming back is the user's own gesture for "re-read this", and the
   * titlebar button IS that toggle: it calls goBack() when Settings is up (titlebar.ts).
   */
  const enterSettings = async (tab: string): Promise<boolean> => {
    if (await inSettings()) {
      if (!(await click(SETTINGS_BTN))) return false // the same button, leaving
      await sleep(450)
    }
    const opened = await click(SETTINGS_BTN)
    await sleep(550)
    const navved = await click(`.settings-nav-item[data-target="${tab}"]`)
    await sleep(500)
    return opened && navved && (await inSettings())
  }
  /** Switch tabs WITHIN the page (no view transition — nothing re-enters). */
  const showTab = async (tab: string): Promise<boolean> => {
    const ok = await click(`.settings-nav-item[data-target="${tab}"]`)
    await sleep(500)
    return ok
  }
  const leaveSettings = async (): Promise<boolean> => {
    const ok = await click('.settings-back')
    await sleep(450)
    return ok
  }

  const run = async (): Promise<void> => {
    const phases: Record<string, unknown> = {}
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(2000)

      // ══ 1 · HOME — the audit's calmest lie ═════════════════════════════════════
      // Home caught its failures and rendered an EMPTY state: "no recent projects yet" shown when
      // the truth was "we could not ask". Nothing looked wrong, which is what made it the worst
      // one. Both reads are armed and the app is RELOADED, because Home's refresh is driven by
      // view entry (onViewChange replays on subscribe) — a boot into Home IS the user gesture, and
      // it is the exact moment the lie used to be told. Home must be first: the launcher is
      // unreachable once a workspace exists (view-port.ts).
      setAsyncAuditFaults({ reject: [WorkspaceChannels.loadState, TemplateChannels.list] })
      await reload()
      const homeView = await viewClass()
      const recentsErr = await emptyState('.home-recents-grid')
      const presetsErr = await emptyState('.home-list')
      // (a) visible + (b) actionable + (d) NOT the calm empty state. The calm titles are
      // "No recent projects yet" / "No presets yet"; the error titles lead with the subject.
      const homeErrorVisible =
        recentsErr.has &&
        recentsErr.title.startsWith('Recent projects') &&
        presetsErr.has &&
        presetsErr.title.startsWith('Presets')
      const homeNotFalseEmpty =
        !recentsErr.title.startsWith('No recent projects') && !presetsErr.title.startsWith('No presets')
      const homeHumane =
        humane(recentsErr.body) && fromFault(recentsErr.body) && humane(presetsErr.body) && fromFault(presetsErr.body)
      const homeRetryOffered = recentsErr.retry && presetsErr.retry
      // "Visible" is a claim about a page the user is LOOKING at, so prove Home is the live view
      // and not a hidden div we happened to query.
      const homeIsShowing = homeView.includes('view-home')

      // POSITIVE CONTROL — the REAL Retry button in the error state. One click refreshes BOTH lists
      // (they share refresh()), and each must land on its OWN honest resting state. Those two
      // states are not the same shape, and asserting that they were is how this phase went red:
      // recents on a fresh userData is a genuine empty ("No recent projects yet"), but the presets
      // list can never be empty at all. `templates:list` returns `[...PRESETS, ...custom]`
      // (main/templates.ts) and PRESETS ships four built-in mixes (backend/features/templates/
      // presets.ts) — so renderPresets is never called with [], its "No presets yet" EmptyState is
      // unreachable through the real channel, and a gate waiting for that title was waiting for a
      // sentence the product cannot say. Recovery here means: the FAILURE is gone from both lists,
      // and each shows what it actually has — an empty state for recents, the built-in rows for
      // presets.
      //
      // Bounded poll, not one read after a fixed sleep: the two guards settle INDEPENDENTLY, and
      // until each answers its list holds a loading row, not its answer.
      setAsyncAuditFaults(null)
      const homeRetryClicked = await click('.home-recents-grid .empty-state button[aria-label="Retry"]')
      const homeSettled = await waitTrue(
        `(() => {
          const busy = document.querySelector('.home-recents-grid .loading-row, .home-list .loading-row')
          const recents = document.querySelector('.home-recents-grid .empty-state, .home-recents-grid .home-recent')
          const presets = document.querySelector('.home-list .empty-state, .home-list .home-item')
          return !busy && !!recents && !!presets
        })()`,
        40,
        200
      )
      const recentsOk = await emptyState('.home-recents-grid')
      const presetsOk = await emptyState('.home-list')
      const presetRows = await ES<number>(`document.querySelectorAll('.home-list .home-item').length`)
      const homeRecovered =
        homeRetryClicked &&
        homeSettled &&
        recentsOk.title.startsWith('No recent projects') && // no history on a fresh profile: the honest empty
        !presetsOk.has && // the failure is GONE from the presets list…
        presetRows > 0 // …which is back to the built-in mixes it always has

      phases.home = {
        homeView,
        homeIsShowing,
        homeErrorVisible,
        homeNotFalseEmpty,
        homeHumane,
        homeRetryOffered,
        homeSettled,
        homeRecovered,
        errorState: { recents: recentsErr, presets: presetsErr },
        afterRetry: { recents: recentsOk.title, presets: presetsOk.title || `(${presetRows} preset rows)` }
      }
      const homePass =
        homeIsShowing && homeErrorVisible && homeNotFalseEmpty && homeHumane && homeRetryOffered && homeRecovered

      // A rejected workspace:loadState LATCHES the renderer read-only for the session (finding 18:
      // an incomplete in-memory state must never overwrite the store). Only a clean restore clears
      // it — and every phase below persists something, so clear it here rather than debug a
      // silently unsaved board in six months.
      await reload()

      // ══ 2 · Fixtures the later phases need ════════════════════════════════════
      const wsCreated = await ES<boolean>(`(() => {
        window.__mogging.workspace.create({ name: 'Alpha' })
        return true
      })()`)
      await sleep(1200)
      const alphaId = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id
      await ES(`(window.__mogging.workspace.create({ name: 'Bravo' }), 1)`)
      await sleep(1200)
      const bravoId = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id

      // Two workspaces, two OBSERVABLY different trails. The generation test is worthless if the
      // assertion cannot tell A's answer from B's, so the targets are unmistakable.
      recordTrail({ ts: Date.now() - 2000, source: 'mcp', workspaceId: alphaId, verb: 'alpha_write', target: 'ALPHA-ONLY-TARGET', outcome: 'ok' })
      recordTrail({ ts: Date.now() - 1000, source: 'web', workspaceId: bravoId, verb: 'bravo_click', target: 'BRAVO-ONLY-TARGET', outcome: 'ok' })
      flushTrailForSmoke()
      const fixturesOk = wsCreated && !!alphaId && !!bravoId && alphaId !== bravoId

      // ══ 3 · SETTINGS § Profiles & SSH hosts — the BLANK tab ═══════════════════
      // One uncaught Promise.all fed both lists, so any rejection skipped both render calls and
      // the tab rendered literally nothing — the lists are born as empty <div>s. Two guards now,
      // two containers, two named failures.
      setAsyncAuditFaults({ reject: [ProfileChannels.list, RemoteChannels.list] })
      const profNav = await enterSettings('profiles')
      await sleep(900)
      const profErr = await emptyState('.ph-profiles')
      const hostErr = await emptyState('.ph-hosts')
      const profilesErrorVisible =
        profErr.has && profErr.title.startsWith('Profiles') && hostErr.has && hostErr.title.startsWith('SSH hosts')
      const profilesHumane =
        humane(profErr.body) && fromFault(profErr.body) && humane(hostErr.body) && fromFault(hostErr.body)
      // (d): "No logins detected yet" is a claim about a read that SUCCEEDED. It must not stand in
      // for one that failed — and the tab must not be blank either way.
      const profilesNotFalseEmpty = !profErr.title.startsWith('No logins') && profErr.body !== ''

      setAsyncAuditFaults(null)
      const profRetry = await click('.ph-profiles .empty-state button[aria-label="Retry"]')
      await sleep(1200)
      const profAfter = await emptyState('.ph-profiles')
      const hostsAfter = await emptyState('.ph-hosts')
      // Recovered = the failure is GONE from both lists. Real profiles may or may not exist on the
      // machine, so assert the error title is gone rather than guessing what replaced it.
      const profilesRecovered =
        profRetry && !profAfter.title.startsWith('Profiles') && !hostsAfter.title.startsWith('SSH hosts')

      phases.settingsProfiles = {
        profNav,
        profilesErrorVisible,
        profilesHumane,
        profilesNotFalseEmpty,
        profilesRecovered,
        errorState: { profiles: profErr, hosts: hostErr },
        afterRetry: { profiles: profAfter.title || '(rows)', hosts: hostsAfter.title || '(rows)' }
      }
      const profilesPass =
        profNav && profilesErrorVisible && profilesHumane && profilesNotFalseEmpty && profilesRecovered

      // ══ 4 · SETTINGS § Agent CLIs (Providers) — the same blank card ═══════════
      setAsyncAuditFaults({ reject: [AgentChannels.installStates] })
      const provNav = await enterSettings('providers')
      await sleep(900)
      const provErr = await emptyState('.prov-list')
      const providersErrorVisible = provErr.has && provErr.title.startsWith('Agent CLIs')
      const providersHumane = humane(provErr.body) && fromFault(provErr.body)
      // A blank card reads as "no CLIs exist" when the truth is that we never found out.
      const providersNotBlank = provErr.body !== '' && provErr.retry

      setAsyncAuditFaults(null)
      const provRetry = await click('.prov-list .empty-state button[aria-label="Retry"]')
      const providersRecovered = provRetry && (await waitTrue(`!!document.querySelector('.prov-item')`, 30, 200))

      phases.providers = {
        provNav,
        providersErrorVisible,
        providersHumane,
        providersNotBlank,
        providersRecovered,
        errorState: provErr
      }
      const providersPass =
        provNav && providersErrorVisible && providersHumane && providersNotBlank && providersRecovered

      // ══ 5 · SETTINGS § Activity — THE GENERATION TEST ═════════════════════════
      // The heart of finding 39. Four things fire this refresh (both selects, the Refresh button,
      // the view-entry sync) and the workspace id was baked into the REQUEST while renderRows
      // painted whatever came back. Any two close together let the slow answer for the OLD filter
      // land after — and OVER — the fast answer for the new one.
      //
      // So: make the past arrive after the future. Call #1 (workspace A) waits 1500ms; call #2
      // (workspace B) returns immediately. B renders first; A lands last. Without the generation
      // guard, A wins and the user is reading Alpha's trail under Bravo's filter.
      const actNav = await showTab('activity')
      // Settle every trailList call the page makes on its own BEFORE arming: the delay config is a
      // per-channel FIFO, and a stray read would eat the 1500 meant for call #1.
      const refreshClicked = await click('.trail-activity .trail-btn')
      await sleep(1200)

      setAsyncAuditFaults({ delaySequenceMs: { [IntegrationsChannels.trailList]: [1500, 0] } })
      const raced = await ES<{ optionCount: number; a: boolean; b: boolean; ended: string }>(`(() => {
        const s = document.querySelector('.trail-ws')
        if (!s) return { optionCount: -1, a: false, b: false, ended: '(no select)' }
        const has = (v) => [...s.options].some((o) => o.value === v)
        const a = has(${sel(alphaId)})
        const b = has(${sel(bravoId)})
        if (a && b) {
          // The user changes the filter to Alpha…
          s.value = ${sel(alphaId)}
          s.dispatchEvent(new Event('change'))
          // …and immediately thinks better of it. Call #2 is now in flight behind call #1, and
          // call #1 is the one that will answer LAST.
          s.value = ${sel(bravoId)}
          s.dispatchEvent(new Event('change'))
        }
        return { optionCount: s.options.length, a, b, ended: s.value }
      })()`)
      // Well past the injected 1500ms: the stale answer for Alpha has now arrived and been
      // offered the DOM. It must have been refused.
      await sleep(3000)
      const rows = await ES<{ list: string; count: number; filter: string }>(`(() => {
        const l = document.querySelector('.trail-list')
        return {
          list: (l ? l.textContent : '') || '',
          count: l ? l.querySelectorAll('.trail-row').length : 0,
          filter: document.querySelector('.trail-ws') ? document.querySelector('.trail-ws').value : ''
        }
      })()`)
      const generationHeld =
        raced.a &&
        raced.b &&
        raced.ended === bravoId &&
        rows.filter === bravoId &&
        rows.list.includes('BRAVO-ONLY-TARGET') && // the answer to the question actually being asked
        !rows.list.includes('ALPHA-ONLY-TARGET') // …and the stale answer never landed on top of it
      setAsyncAuditFaults(null)

      phases.activityGeneration = {
        actNav,
        refreshClicked,
        raced,
        rows,
        generationHeld,
        note: 'call #1 (Alpha) delayed 1500ms, call #2 (Bravo) immediate — B must win'
      }
      const activityPass = actNav && refreshClicked && generationHeld

      // ══ 6 · USAGE — one channel, both cost surfaces ═══════════════════════════
      // `usage:cost` feeds the popover row AND the Settings § Usage card. The popover row was BORN
      // saying "Cost…" and only ever changed inside .then(), under a .catch(() => undefined) that
      // threw the reason away: a scan that never came back left the ellipsis standing forever, and
      // a scan that FAILED left it standing and silent. The Settings card was worse — its
      // per-provider loop had no catch at all, so a rejection aborted the render before the empty
      // state and the Rescan button (its only retry) were ever appended.
      //
      // Give both surfaces a plan to scan (see FIXTURE_PLAN) and open the cost card.
      wc.send(UsageChannels.changed, [FIXTURE_PLAN])
      await sleep(700)
      const usageNav = await showTab('usage')
      const costCardOpened = await ES<boolean>(`(() => {
        const c = document.querySelector('.collapsible-card.usage-card-cost')
        if (!c) return false
        if (!c.classList.contains('is-open')) c.querySelector('.cc-toggle').click()
        return true
      })()`)
      await sleep(500)
      const rescanSel = '.usage-cost-cfg button.btn.btn--sm[aria-label="Rescan"]'
      // Pre-state: an unfaulted scan with no cost logs is a genuine, honest empty — and it is the
      // state the failure below must be DISTINGUISHABLE from (assertion d).
      const rescanBefore = await click(rescanSel)
      await sleep(1200)
      const costEmptyOk = await emptyState('.usage-cost-cfg')
      const rescanPresentOnSuccess = await exists(rescanSel)

      // ── 6a · REJECT: both surfaces must give up out loud ──────────────────────
      setAsyncAuditFaults({ reject: [UsageChannels.cost] })
      const rescanFaulted = await click(rescanSel)
      await sleep(1200)
      const costErr = await emptyState('.usage-cost-cfg')
      const rescanPresentOnFailure = await exists(rescanSel) // the `finally` this loop never had
      const costCardErrorVisible = costErr.has && costErr.title.startsWith('The cost scan')
      const costCardHumane = humane(costErr.body) && fromFault(costErr.body)
      const costCardNotFalseEmpty =
        costEmptyOk.title.startsWith('No cost data') && // the SUCCESS-and-empty claim…
        !costErr.title.startsWith('No cost data') && // …is never made about a failure
        costEmptyOk.title !== costErr.title

      // ── 6b · HANG: an ellipsis is a promise that an answer is coming ──────────
      // A scan that never comes back left "Cost…" standing forever, and the Settings card stuck on
      // its scanning row. Neither surface can CANCEL an invoke — the only correct answer is to stop
      // believing it. Hang the channel and drive BOTH: the card's Rescan and the popover's gauge.
      //
      // WHO gives up first is not ours to choose, and this gate may not pretend otherwise. The
      // fault hangs by returning a promise that can never settle (async-audit-faults.ts). Nothing
      // holds its resolver, so the handler's awaiting frame is reachable only FROM that promise:
      // the cycle is garbage, V8 collects it, and the invoke's `event._replyChannel` goes with it.
      // Electron's ReplyChannel destructor then ANSWERS the still-pending invoke rather than
      // abandon it — with the literal string "reply was never sent". That is a real IPC reply
      // arriving as an ordinary rejection, and it routinely beats the renderer guard's own 8s
      // timeoutMs (here it landed inside 700ms). Both legs are legitimate, and the UX contract is
      // identical either way, so THAT is what is asserted: the wait is visible, the failure is
      // terminal, it is retryable, and its sentence was written by our async policy — never by the
      // transport. (It once wasn't: this phase caught the product reading "The cost scan didn’t run
      // — reply was never sent" out to a human. describeAsyncError now folds transport remainders
      // into the generic fallback; RAW_LEAK above fails any surface that shows one again.)
      setAsyncAuditFaults({ hang: [UsageChannels.cost] })
      // WAITING is read in the SAME SYNCHRONOUS TURN as the click — not after a sleep. We do not
      // control how long the hang survives, but we do control this: both guards run onLoading
      // before their first await (async-state.ts), and both surfaces reach it on a synchronous call
      // path (settings/usage.ts renderCost; usage/index.ts open → renderPop → scanCost), so the
      // loading markers are on screen before the click even returns. Reading them here is also what
      // proves these two clicks really started a scan.
      const rescanHung = await ES<{ clicked: boolean; scanning: boolean }>(`(() => {
        const e = document.querySelector(${sel(rescanSel)})
        if (!e) return { clicked: false, scanning: false }
        e.click()
        return { clicked: true, scanning: !!document.querySelector('.usage-cost-cfg .loading-row') }
      })()`)
      const gaugeHung = await ES<{ clicked: boolean; costRow: boolean; costText: string; retry: boolean; error: boolean }>(`(() => {
        const g = document.querySelector('.usage-gauge')
        if (!g) return { clicked: false, costRow: false, costText: '', retry: false, error: false }
        g.click()
        return {
          clicked: true,
          costRow: !!document.querySelector('.usage-cost'),
          costText: (document.querySelector('.usage-cost-text')?.textContent || '').trim(),
          retry: !!document.querySelector('.usage-cost-retry'),
          error: !!document.querySelector('.usage-cost-error')
        }
      })()`)
      const pending = { ...gaugeHung, scanning: rescanHung.scanning }
      // Mid-flight: both surfaces visibly WAITING, neither of them terminal yet.
      const costPending =
        pending.costRow && pending.costText.startsWith('Cost') && !pending.retry && !pending.error && pending.scanning

      // The popover repaints once when profiles resolve, so the LIVE row's clock starts a beat after
      // the click. 14s of polling covers the guard's 8s timeout plus honest slack — and comfortably
      // covers the IPC layer's own give-up, whichever of the two arrives first.
      const hangTerminal = await waitTrue(
        `document.querySelector('.usage-cost-text')?.textContent === 'Cost unavailable'`,
        70,
        200
      )
      const hangRetryOffered = await exists('.usage-cost-retry')
      const hangMessage = await text('.usage-cost-error')
      // Terminal is not enough: it has to say something a person can act on. Our timeout sentence
      // or our generic fallback — never a stack, never silence, and never the IPC's own remainder.
      const hangHumane = gaveUpInWords(hangMessage)
      const popoverGaveUp = gaugeHung.clicked && hangTerminal && hangRetryOffered && hangHumane

      // The card gave up too, in its own words, and its ONE retry is still there. Polled rather
      // than assumed: it is a second guard on a second clock, and it settles when it settles.
      const cardTerminal = await waitTrue(`!!document.querySelector('.usage-cost-cfg .empty-state')`, 70, 200)
      const cardHung = await emptyState('.usage-cost-cfg')
      const rescanPresentOnHang = await exists(rescanSel)
      const scanningRowCleared = !(await exists('.usage-cost-cfg .loading-row'))
      const cardGaveUp =
        rescanHung.clicked &&
        cardTerminal &&
        cardHung.has &&
        cardHung.title.startsWith('The cost scan') &&
        gaveUpInWords(cardHung.body) &&
        rescanPresentOnHang &&
        scanningRowCleared

      // ── 6c · POSITIVE CONTROL: the retry the row never had ────────────────────
      setAsyncAuditFaults(null)
      const retryClicked = await click('.usage-cost-retry')
      await sleep(1500)
      const costTextAfterRetry = await text('.usage-cost-text')
      const costErrorGone = !(await exists('.usage-cost-error'))
      // No cost logs under smoke, so a SUCCESSFUL scan reads "Cost —" — an answer, not an ellipsis
      // and not a failure.
      const popoverRecovered = retryClicked && costErrorGone && costTextAfterRetry !== 'Cost unavailable'
      await click('.usage-gauge') // close the popover before it overlays the next phase's clicks
      await sleep(300)

      phases.usage = {
        usageNav,
        costCardOpened,
        // Rescan must be there whatever happened — success, rejection, or a scan that never
        // answered. A failure the user cannot re-attempt is a failure they are stuck in.
        rescan: {
          rescanBefore,
          rescanFaulted,
          rescanHung: rescanHung.clicked,
          rescanPresentOnSuccess,
          rescanPresentOnFailure,
          rescanPresentOnHang
        },
        settingsCard: {
          emptySuccessTitle: costEmptyOk.title, // "No cost data yet"      (a scan that SUCCEEDED and found nothing)
          rejectTitle: costErr.title, //           "The cost scan didn’t run" (a scan that FAILED)
          rejectBody: costErr.body,
          hangTitle: cardHung.title,
          hangBody: cardHung.body, // the sentence a HUMAN read when the scan never answered
          cardTerminal,
          costCardErrorVisible,
          costCardHumane,
          costCardNotFalseEmpty,
          cardGaveUp
        },
        popover: { pending, hangTerminal, hangRetryOffered, hangMessage, costTextAfterRetry, costPending },
        popoverGaveUp,
        popoverRecovered
      }
      const usagePass =
        usageNav &&
        costCardOpened &&
        rescanBefore &&
        rescanFaulted &&
        rescanPresentOnSuccess &&
        rescanPresentOnFailure &&
        costCardErrorVisible &&
        costCardHumane &&
        costCardNotFalseEmpty &&
        costPending &&
        cardGaveUp &&
        popoverGaveUp &&
        popoverRecovered

      // ══ 7 · INTEGRATIONS — the STRANDED button ════════════════════════════════
      // The regression finding 39 named most concretely: `btn.disabled = true` -> await ->
      // `btn.disabled = false`, with no finally. A rejection skipped the re-enable and the button
      // stayed disabled FOREVER — the user could not even retry the call that had just failed.
      const integNav = await showTab('integrations')
      // The catalog card's own Connect… button — the only door to this panel. (startsWith, not an
      // exact match: the label carries a typographic ellipsis, and its two siblings in that row
      // are 'Check feed' and 'Export', so the prefix is unambiguous.)
      const panelOpened = await ES<boolean>(`(() => {
        const b = [...document.querySelectorAll('.cat-card .trail-btn')].find((x) => (x.textContent || '').trim().startsWith('Connect'))
        if (!b) return false
        b.click()
        return true
      })()`)
      await sleep(700)
      const panelUp = await exists('.mgr-panel.cat-panel .cat-preview')

      setAsyncAuditFaults({ reject: [IntegrationsChannels.catPrepare, IntegrationsChannels.catConnect] })
      const preview = await clickAndReadDisabled('.cat-panel .cat-preview')
      await sleep(1500)
      const previewOut = await text('.cat-panel .cat-preview-out')
      const previewDisabledAfter = await isDisabled('.cat-panel .cat-preview')

      // Connect is clicked ONLY here, with the fault armed: maybeAsyncFault is the handler's first
      // line, so the write pipeline never runs and nothing touches a real CLI config file.
      const connect = await ES<{ clicked: boolean; disabledOnClick: boolean; note: string }>(`(() => {
        const e = document.querySelector('.cat-panel .cat-connect')
        if (!e) return { clicked: false, disabledOnClick: false, note: '' }
        e.click()
        const n = document.querySelector('.cat-panel .cat-note')
        return { clicked: true, disabledOnClick: e.disabled === true, note: (n ? n.textContent : '') || '' }
      })()`)
      await sleep(1500)
      const connectNote = await text('.cat-panel .cat-note')
      const connectDisabledAfter = await isDisabled('.cat-panel .cat-connect')

      // (a) the failure is in the block the answer was going to fill · (b) it is a sentence ·
      // (c) BOTH buttons disabled on click and BOTH came back.
      const integErrorVisible = humane(previewOut) && fromFault(previewOut) && humane(connectNote) && fromFault(connectNote)
      const integNotStranded =
        preview.disabledOnClick &&
        previewDisabledAfter === false &&
        connect.disabledOnClick &&
        connectDisabledAfter === false
      const integLoadingShown = connect.note.includes('Connecting') // the promise the error replaces

      // POSITIVE CONTROL on the READ half only (Preview is a pure preview; Connect writes).
      setAsyncAuditFaults(null)
      const previewAgain = await click('.cat-panel .cat-preview')
      await sleep(1500)
      const previewOutAfter = await text('.cat-panel .cat-preview-out')
      const previewEnabledAfter = await isDisabled('.cat-panel .cat-preview')
      const integRecovered =
        previewAgain && previewEnabledAfter === false && !previewOutAfter.includes('Injected failure') && previewOutAfter !== ''

      phases.integrations = {
        integNav,
        panelOpened,
        panelUp,
        preview,
        previewOut,
        previewDisabledAfter,
        connect,
        connectNote,
        connectDisabledAfter,
        integErrorVisible,
        integNotStranded,
        integLoadingShown,
        integRecovered,
        previewOutAfter: previewOutAfter.slice(0, 200)
      }
      const integPass =
        integNav && panelOpened && panelUp && integErrorVisible && integNotStranded && integLoadingShown && integRecovered

      // ══ 8 · BOARD — the optimistic mutation that lied ═════════════════════════
      // The card moved on screen before the write landed, which is the right feel and was, until
      // now, a lie: `void invoke(...)` with no catch meant a REJECTED write left the card exactly
      // where the user dropped it, on a board that silently disagreed with the database. The fix
      // is a danger toast AND a reconcile — re-read board:list and render what is actually stored.
      const leftSettings = await leaveSettings()
      const boardNav = await click('.icon-btn[aria-label="Board"]')
      await sleep(800)
      const boardUp = (await viewClass()).includes('view-board')
      // A real card, through the real modal (the lane's own EmptyState action).
      const addClicked = await click('.board-lane[data-lane="todo"] .empty-state button')
      await sleep(600)
      const cardTyped = await ES<boolean>(`(() => {
        const t = document.querySelector('.board-edit-title')
        if (!t) return false
        t.value = 'ASYNCSTATE card'
        return true
      })()`)
      const cardSaved = await click('.board-edit-footer button[aria-label="Add card"]')
      await sleep(1200)
      const cardInTodo = await exists('.board-lane[data-lane="todo"] .board-card')

      await clearToasts()
      setAsyncAuditFaults({ reject: [BoardChannels.save] })
      // The ⋯ menu's "Move to Doing" — the same mutation the drop handler runs.
      const moveClicked = await ES<boolean>(`(() => {
        const more = document.querySelector('.board-lane[data-lane="todo"] .board-card .board-card-more')
        if (!more) return false
        more.click()
        return true
      })()`)
      await sleep(400)
      const moveItemClicked = await ES<boolean>(`(() => {
        const i = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => (x.textContent || '').includes('Move to Doing'))
        if (!i) return false
        i.click()
        return true
      })()`)
      const saveToast = await waitToast('That change was not saved')
      await sleep(1500) // let the reconcile re-read board:list and re-render
      const laneAfterFailedMove = await ES<string>(`(() => {
        const c = document.querySelector('.board-card')
        const l = c ? c.closest('.board-lane') : null
        return l ? l.dataset.lane : '(no card)'
      })()`)
      const boardSaveSpoke = !!saveToast && saveToast.tone === 'danger' && humane(saveToast.body) && fromFault(saveToast.body)
      const boardRolledBack = laneAfterFailedMove === 'todo' // the database never agreed to the move

      // Delete: the same law on the other verb — the card must come BACK, not vanish into a
      // board that disagrees with the store.
      await clearToasts()
      setAsyncAuditFaults({ reject: [BoardChannels.remove] })
      await ES(`(document.querySelector('.board-card .board-card-more')?.click(), 1)`)
      await sleep(400)
      const deleteClicked = await ES<boolean>(`(() => {
        const i = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((x) => (x.textContent || '').includes('Delete card'))
        if (!i) return false
        i.click()
        return true
      })()`)
      await sleep(500)
      const confirmClicked = await click('.confirm-actions .btn--danger')
      const removeToast = await waitToast('The card was not deleted')
      await sleep(1500)
      const cardBack = await exists('.board-card')
      const boardRemoveSpoke =
        !!removeToast && removeToast.tone === 'danger' && humane(removeToast.body) && fromFault(removeToast.body)
      setAsyncAuditFaults(null)

      phases.board = {
        leftSettings,
        boardNav,
        boardUp,
        addClicked,
        cardTyped,
        cardSaved,
        cardInTodo,
        moveClicked,
        moveItemClicked,
        saveToast,
        laneAfterFailedMove,
        boardSaveSpoke,
        boardRolledBack,
        deleteClicked,
        confirmClicked,
        removeToast,
        cardBack,
        boardRemoveSpoke
      }
      const boardPass =
        leftSettings &&
        boardNav &&
        boardUp &&
        addClicked &&
        cardTyped &&
        cardSaved &&
        cardInTodo &&
        moveClicked &&
        moveItemClicked &&
        boardSaveSpoke &&
        boardRolledBack &&
        deleteClicked &&
        confirmClicked &&
        boardRemoveSpoke &&
        cardBack

      // ══ 9 · BROWSER — the navigation that reported nothing ════════════════════
      // Both calls were `void invoke(...)` with no catch: a rejected IPC was an unhandled promise
      // and the dock simply sat there looking like it had done what you asked.
      await clearToasts()
      const dockOpened = await click('.titlebar-right .icon-btn[aria-label="Browser"]')
      await sleep(800)
      setAsyncAuditFaults({ reject: [BrowserChannels.navigate, BrowserChannels.nav] })
      // Reload: a nav verb, faulted at the handler's first line — nothing reaches the guest.
      const reloadClicked = await click('.browser-dock-header .icon-btn[aria-label="Reload"]')
      const navToast = await waitToast('Could not reload the page')
      // The URL bar: Enter is the real gesture. `browser:navigate` is armed, so the fault throws
      // before the handler body — no webview ever points anywhere, and no packet leaves the host.
      await clearToasts()
      const urlTyped = await ES<boolean>(`(() => {
        const i = document.querySelector('.browser-url')
        if (!i || i.disabled) return false
        i.value = 'http://127.0.0.1:1/asyncstate'
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
      })()`)
      const urlToast = await waitToast('Could not open')
      const browserSpoke =
        !!navToast &&
        navToast.tone === 'danger' &&
        humane(navToast.body) &&
        fromFault(navToast.body) &&
        !!urlToast &&
        urlToast.tone === 'danger' &&
        humane(urlToast.body) &&
        fromFault(urlToast.body)

      // POSITIVE CONTROL: the same Reload click, unfaulted, is silent — so the toast above was the
      // failure speaking, not the button being broken.
      setAsyncAuditFaults(null)
      await clearToasts()
      const reloadAgain = await click('.browser-dock-header .icon-btn[aria-label="Reload"]')
      await sleep(1200)
      const quietToasts = await toasts()
      const browserQuietWhenOk = reloadAgain && !quietToasts.some((t) => t.tone === 'danger')
      await click('.browser-dock-header .icon-btn[aria-label="Close browser"]')
      await sleep(300)

      phases.browser = {
        dockOpened,
        reloadClicked,
        navToast,
        urlTyped,
        urlToast,
        browserSpoke,
        reloadAgain,
        browserQuietWhenOk,
        quietToasts
      }
      const browserPass =
        dockOpened && reloadClicked && urlTyped && browserSpoke && browserQuietWhenOk

      // ══ 10 · REVIEW — the UI that just sat there ══════════════════════════════
      // Both callers do `void openReview(...)`, so before finding 39 a rejected diff was an
      // unhandled rejection and nothing happened at all: no modal, no error, and no way to tell
      // "still working" from "already dead". Now: a loading toast, then a terminal danger toast.
      //
      // The driver is the pane ⋯ menu's ENTIRE body — it dispatches this exact CustomEvent
      // (terminal-pane.ts) and the review feature listens for it (review/index.ts). No internal
      // function is called; a real worktree gives the positive control something real to open.
      await clearToasts()
      const repo = makeRepo()
      const wt = await createWorktree(repo)
      if (!wt.ok || !wt.path) throw new Error('review fixture: worktree create failed')
      writeFileSync(join(wt.path, 'feature.ts'), 'export const shipped = true\n')

      const reviewOpen = (): Promise<boolean> =>
        ES<boolean>(`(() => {
          document.dispatchEvent(new CustomEvent('mogging:review-pane', { detail: ${JSON.stringify({ repo, worktree: wt.path })} }))
          return true
        })()`)

      setAsyncAuditFaults({ reject: [ReviewChannels.diff] })
      const reviewDispatched = await reviewOpen()
      const diffToast = await waitToast('Could not read the diff')
      await sleep(600)
      const modalWhileFaulted = await exists('.review-modal')
      const loadingToastCleared = !(await toasts()).some((t) => t.title.startsWith('Reading the diff'))
      const reviewSpoke =
        reviewDispatched &&
        !!diffToast &&
        diffToast.tone === 'danger' &&
        humane(diffToast.body) &&
        fromFault(diffToast.body) &&
        !modalWhileFaulted && // it failed: there is nothing to review
        loadingToastCleared // …and onSettle took the "Reading the diff…" promise down with it

      // POSITIVE CONTROL: the same dispatch, unfaulted, opens the real modal — so the toast above
      // was the failure speaking, not a dead entry point.
      setAsyncAuditFaults(null)
      await clearToasts()
      const reviewAgain = await reviewOpen()
      const modalOpened = await waitTrue(`!!document.querySelector('.review-modal')`, 40, 250)
      const reviewRecovered = reviewAgain && modalOpened

      phases.review = { reviewDispatched, diffToast, modalWhileFaulted, loadingToastCleared, reviewSpoke, reviewRecovered }
      const reviewPass = reviewSpoke && reviewRecovered

      const pass =
        homePass &&
        fixturesOk &&
        profilesPass &&
        providersPass &&
        activityPass &&
        usagePass &&
        integPass &&
        boardPass &&
        browserPass &&
        reviewPass
      result = {
        pass,
        homePass,
        fixturesOk,
        profilesPass,
        providersPass,
        activityPass,
        usagePass,
        integPass,
        boardPass,
        browserPass,
        reviewPass,
        workspaces: { alphaId, bravoId },
        phases
      }
    } catch (error) {
      result = { pass: false, error: error instanceof Error ? error.message : String(error), phases }
    } finally {
      setAsyncAuditFaults(null) // never leave a fault armed behind us
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'asyncstate-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

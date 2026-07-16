import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalChannels } from '@contracts'

// Env-gated GLOBAL-HOOKS smoke (MOGGING_GLOBALHOOKS=1) — the hand-typed-launch gap, end to end.
//
// The unit tests (tests/unit/global-hooks.test.ts) own the pure merge/strip/state rules. What
// they cannot see is the wiring a regression would actually kill silently: the IPC surface
// (agentHooks:* through the REAL preload allowlist — a dropped AllChannels spread refuses every
// call and reads as a feature bug), the write discipline against a real file (backup + atomic
// rewrite that preserves the user's own keys and hook entries), the once-per-run nudge toast on
// a DETECTED claude, and the Settings › Agent CLIs card's wire/remove round trip.
//
// ISOLATION: CLAUDE_CONFIG_DIR is pointed INSIDE this gate's already-isolated userData before a
// single handler runs, so the smoke reads and rewrites its own fixture settings.json — never
// the machine's real Claude home. The detector event is injected main→renderer over the same
// channel the daemon relay uses; no real claude, no real daemon traffic.
//
//   seed      a user settings.json: model + permissions + their OWN Stop hook
//   status    -> not-applied, and the file is OUR fixture (the isolation assert)
//   nudge     a detected claude arrives -> ONE attention toast with a Wire-alerts action
//   wire      click the action -> success toast; file now carries our five entries, the
//             user's keys and their Stop hook byte-for-value intact, ours APPENDED after
//             theirs; a timestamped .bak of the seeded bytes sits beside it
//   once      a second detected claude -> no second nudge (one per app run)
//   card      Settings › Agent CLIs shows '✓ wired'; Remove strips exactly ours and flips
//             the pill; the user's Stop hook survives
//   stale     an old-install vintage of our entry reads 'partial'; apply REPLACES it —
//             exactly one copy per event, pointing at the current script
//   junk      an unreadable settings.json reads 'unreadable' and apply refuses byte-for-byte

export function runGlobalHooksSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 110000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 40, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  // The isolated Claude home, inside this gate's own userData (resolveHome honors the pointer).
  const home = join(app.getPath('userData'), 'globalhooks-home')
  process.env.CLAUDE_CONFIG_DIR = home
  const settings = join(home, 'settings.json')
  const SEED = {
    model: 'smoke-model',
    permissions: { defaultMode: 'plan' },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-own-stop-logger' }] }] }
  }

  const readSettings = (): { text: string; obj: Record<string, unknown> | null } => {
    try {
      const text = readFileSync(settings, 'utf8')
      try {
        return { text, obj: JSON.parse(text) as Record<string, unknown> }
      } catch {
        return { text, obj: null }
      }
    } catch {
      return { text: '', obj: null }
    }
  }
  type HookEntry = { hooks?: Array<{ command?: string }> }
  const entriesFor = (obj: Record<string, unknown> | null, event: string): HookEntry[] => {
    const hooks = (obj?.hooks ?? {}) as Record<string, unknown>
    const value = hooks[event]
    return Array.isArray(value) ? (value as HookEntry[]) : []
  }
  const oursIn = (list: HookEntry[]): HookEntry[] =>
    list.filter((e) => e.hooks?.some((h) => typeof h.command === 'string' && /notify-hook[\\/]notify\.mjs/.test(h.command) && h.command.includes('--event')))
  const EVENTS = ['Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']

  const invoke = (channel: string): Promise<{ state?: string; file?: string; ok?: boolean; reason?: string }> =>
    ES(`window.bridge.invoke(${JSON.stringify(channel)})`)

  const run = async (): Promise<void> => {
    const result: Record<string, unknown> = { pass: false }
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(settings, JSON.stringify(SEED, null, 2) + '\n')
      await sleep(1500) // let the renderer mount its features

      // ── status through the real preload bridge, against the fixture home ──
      const before = await invoke('agentHooks:status')
      const statusIsolated = before?.state === 'not-applied' && before?.file === settings
      result.before = before
      result.statusIsolated = statusIsolated

      // ── the nudge: a DETECTED claude in a pane, exactly as the daemon relay reports it ──
      wc.send(TerminalChannels.agent, { id: 1, agentId: 'claude', cwd: '' })
      const nudgeShown = await waitTrue(
        `(() => { const t = document.querySelector('.toast--attention'); return !!(t && /no alerts/i.test(t.querySelector('.toast-title')?.textContent || '') && t.querySelector('.toast-action')) })()`
      )
      result.nudgeShown = nudgeShown

      // ── wire it from the toast's own action ──
      await ES(`(document.querySelector('.toast--attention .toast-action')?.click(), 1)`)
      const wiredToast = await waitTrue(
        `(() => !!document.querySelector('.toast--success') && /wired globally/i.test(document.querySelector('.toast--success .toast-title')?.textContent || ''))()`
      )
      const afterWire = readSettings()
      const backups = existsSync(home) ? readdirSync(home).filter((f) => f.startsWith('settings.json.bak-')) : []
      const wiredFile =
        !!afterWire.obj &&
        (afterWire.obj.model as string) === 'smoke-model' &&
        (afterWire.obj.permissions as { defaultMode?: string })?.defaultMode === 'plan' &&
        EVENTS.every((event) => oursIn(entriesFor(afterWire.obj, event)).length === 1) &&
        entriesFor(afterWire.obj, 'Stop').length === 2 &&
        entriesFor(afterWire.obj, 'Stop')[0]?.hooks?.[0]?.command === 'user-own-stop-logger'
      result.wiredToast = wiredToast
      result.wiredFile = wiredFile
      result.backupMade = backups.length >= 1
      const statusWired = (await invoke('agentHooks:status'))?.state === 'applied'
      result.statusWired = statusWired

      // ── once per run: a second detected claude must not nudge again ──
      await waitTrue(`(() => !document.querySelector('.toast--attention'))()`) // the first toast is gone
      wc.send(TerminalChannels.agent, { id: 101, agentId: 'claude', cwd: '' })
      await sleep(1200)
      const nudgedOnce = await ES<boolean>(`!document.querySelector('.toast--attention')`)
      result.nudgedOnce = nudgedOnce

      // ── the Settings card: state on display, Remove strips exactly ours ──
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      await ES(`(document.querySelector('.settings-nav-item[data-target="providers"]')?.click(), 1)`)
      const cardRow = `[...document.querySelectorAll('.prov-row')].find(r => (r.textContent || '').includes('global alert hooks'))`
      const cardWired = await waitTrue(`(() => { const r = ${cardRow}; return !!r && (r.textContent || '').includes('✓ wired') })()`)
      result.cardWired = cardWired
      await ES(`(() => { const r = ${cardRow}; const b = r && [...r.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Remove'); if (b) b.click(); return 1 })()`)
      const cardRemoved = await waitTrue(`(() => { const r = ${cardRow}; return !!r && (r.textContent || '').includes('not wired') })()`)
      const afterRemove = readSettings()
      const removedFile =
        !!afterRemove.obj &&
        (afterRemove.obj.model as string) === 'smoke-model' &&
        EVENTS.every((event) => oursIn(entriesFor(afterRemove.obj, event)).length === 0) &&
        entriesFor(afterRemove.obj, 'Stop').length === 1 &&
        entriesFor(afterRemove.obj, 'Stop')[0]?.hooks?.[0]?.command === 'user-own-stop-logger'
      result.cardRemoved = cardRemoved
      result.removedFile = removedFile

      // ── a stale install's vintage reads partial, and apply REPLACES instead of stacking ──
      const staleEntry = { hooks: [{ type: 'command', command: 'node "C:\\old-install\\notify-hook\\notify.mjs" --event done' }] }
      const staleObj = readSettings().obj ?? {}
      staleObj.hooks = { ...(staleObj.hooks as Record<string, unknown> ?? {}), Stop: [...entriesFor(staleObj as Record<string, unknown>, 'Stop'), staleEntry] }
      writeFileSync(settings, JSON.stringify(staleObj, null, 2) + '\n')
      const statusStale = (await invoke('agentHooks:status'))?.state === 'partial'
      const reapply = await invoke('agentHooks:apply')
      const afterReapply = readSettings()
      const replacedNotStacked =
        reapply?.ok === true &&
        EVENTS.every((event) => oursIn(entriesFor(afterReapply.obj, event)).length === 1) &&
        !afterReapply.text.includes('old-install')
      result.statusStale = statusStale
      result.replacedNotStacked = replacedNotStacked

      // ── junk refuses byte-for-byte ──
      writeFileSync(settings, '{ this is not json\n')
      const junkBytes = readFileSync(settings, 'utf8')
      const statusJunk = (await invoke('agentHooks:status'))?.state === 'unreadable'
      const junkApply = await invoke('agentHooks:apply')
      const junkRefused = junkApply?.ok === false && readFileSync(settings, 'utf8') === junkBytes
      result.statusJunk = statusJunk
      result.junkRefused = junkRefused

      result.pass =
        statusIsolated && nudgeShown && wiredToast && wiredFile && (result.backupMade as boolean) &&
        statusWired && nudgedOnce && cardWired && cardRemoved && removedFile &&
        statusStale && replacedNotStacked && statusJunk && junkRefused
    } catch (e) {
      result.error = String(e)
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'globalhooks-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    console.log('GLOBALHOOKS_RESULT ' + JSON.stringify(result))
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}

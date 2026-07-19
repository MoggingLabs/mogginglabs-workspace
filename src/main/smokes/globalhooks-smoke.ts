import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalChannels } from '@contracts'

// Env-gated GLOBAL-HOOKS smoke (MOGGING_GLOBALHOOKS=1) — the hand-typed-launch gap, end to
// end, all four CLIs.
//
// The unit tests (tests/unit/global-hooks.test.ts + global-bells.test.ts) own the pure
// merge/strip/state rules per dialect. What they cannot see is the wiring a regression would
// kill silently: the IPC surface (agentHooks:* through the REAL preload allowlist — a dropped
// AllChannels spread refuses every call and reads as a feature bug), the write discipline
// against real files (backup + atomic rewrite preserving the user's own content), the
// per-provider once-per-run AUTO-WIRE on a DETECTED agent (with its Undo toast, and the
// persisted opt-out an explicit Remove leaves behind), the Settings card's wire/remove round
// trip, codex's CONFLICT refusal, and the OpenCode plugin's materialization into userData.
//
// ISOLATION: every CLI home pointer (CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CONFIG_DIR,
// XDG_CONFIG_HOME for opencode) is pointed INSIDE this gate's already-isolated userData before
// a single handler runs — the machine's real config homes are never read or written. The
// detector event is injected main→renderer over the same channel the daemon relay uses.

export function runGlobalHooksSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 130000) // safety net
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

  // The isolated homes, inside this gate's own userData (resolveHome / XDG honor the pointers).
  const homes = join(app.getPath('userData'), 'globalhooks-homes')
  const claudeHome = join(homes, 'claude')
  const codexHome = join(homes, 'codex')
  const geminiHome = join(homes, 'gemini')
  const xdgHome = join(homes, 'xdg')
  const opencodeDir = join(xdgHome, 'opencode')
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.CODEX_HOME = codexHome
  process.env.GEMINI_CONFIG_DIR = geminiHome
  process.env.XDG_CONFIG_HOME = xdgHome

  const claudeFile = join(claudeHome, 'settings.json')
  const codexFile = join(codexHome, 'config.toml')
  const geminiFile = join(geminiHome, 'settings.json')
  const opencodeTui = join(opencodeDir, 'tui.json')
  const opencodeCfg = join(opencodeDir, 'opencode.json')

  const read = (file: string): string => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const json = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(read(file)) as Record<string, unknown>
    } catch {
      return null
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

  type Row = { provider: string; state: string; files: string[]; reason?: string }
  const status = async (): Promise<Record<string, Row>> => {
    const rows = await ES<Row[]>(`window.bridge.invoke('agentHooks:status')`)
    return Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.provider, r]))
  }
  const mutate = (channel: 'apply' | 'remove', provider: string): Promise<{ ok?: boolean; reason?: string; backups?: string[] }> =>
    ES(`window.bridge.invoke('agentHooks:${channel}', { provider: ${JSON.stringify(provider)} })`)

  const run = async (): Promise<void> => {
    const result: Record<string, unknown> = { pass: false }
    try {
      for (const dir of [claudeHome, codexHome, geminiHome, opencodeDir]) mkdirSync(dir, { recursive: true })
      // User content in every fixture: the writes must preserve all of it.
      writeFileSync(claudeFile, JSON.stringify({
        model: 'smoke-model',
        permissions: { defaultMode: 'plan' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-own-stop-logger' }] }] }
      }, null, 2) + '\n')
      writeFileSync(codexFile, '# my codex config\nmodel = "o4"\n\n[mcp_servers.mine]\ncommand = "my-server"\n')
      writeFileSync(geminiFile, JSON.stringify({
        general: { vimMode: true },
        hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'their-after' }] }] }
      }, null, 2) + '\n')
      writeFileSync(opencodeTui, JSON.stringify({ theme: 'mono' }, null, 2) + '\n')
      writeFileSync(opencodeCfg, JSON.stringify({ plugin: ['their-plugin'] }, null, 2) + '\n')
      await sleep(1500) // let the renderer mount its features

      // ── status through the real preload bridge: four rows, each against its fixture ──
      const before = await status()
      const statusIsolated =
        before.claude?.state === 'not-applied' && before.claude?.files?.[0] === claudeFile &&
        before.codex?.state === 'not-applied' && before.codex?.files?.[0] === codexFile &&
        before.gemini?.state === 'not-applied' && before.gemini?.files?.[0] === geminiFile &&
        before.opencode?.state === 'not-applied' && before.opencode?.files?.join('|') === `${opencodeTui}|${opencodeCfg}`
      result.before = before
      result.statusIsolated = statusIsolated

      // ── AUTO-WIRE: a DETECTED claude in a pane, exactly as the daemon relay reports it,
      // wires the global alerts itself (the ask-toast it replaced never converted — found
      // live 2026-07-18 as eight verdict-mute hand-typed panes) and SAYS SO, with an Undo.
      wc.send(TerminalChannels.agent, { id: 1, agentId: 'claude', cwd: '' })
      const wiredToast = await waitTrue(
        `(() => { const t = document.querySelector('.toast--success'); return !!(t && /wired globally/i.test(t.querySelector('.toast-title')?.textContent || '') && t.querySelector('.toast-action')) })()`
      )
      const afterWire = json(claudeFile)
      const backups = readdirSync(claudeHome).filter((f) => f.startsWith('settings.json.bak-'))
      const wiredFile =
        !!afterWire &&
        (afterWire.model as string) === 'smoke-model' &&
        (afterWire.permissions as { defaultMode?: string })?.defaultMode === 'plan' &&
        EVENTS.every((event) => oursIn(entriesFor(afterWire, event)).length === 1) &&
        entriesFor(afterWire, 'Stop').length === 2 &&
        entriesFor(afterWire, 'Stop')[0]?.hooks?.[0]?.command === 'user-own-stop-logger'
      result.wiredToast = wiredToast
      result.wiredFile = wiredFile
      result.backupMade = backups.length >= 1
      result.statusWired = (await status()).claude?.state === 'applied'

      // ── once per provider per run: a second detected claude must not wire (or toast) again ──
      const claudeBytes = read(claudeFile)
      await ES(`(document.querySelectorAll('.toast-dismiss').forEach((b) => b.click()), 1)`)
      await waitTrue(`(() => !document.querySelector('.toast--success') && !document.querySelector('.toast--attention'))()`, 60)
      wc.send(TerminalChannels.agent, { id: 101, agentId: 'claude', cwd: '' })
      await sleep(1200)
      result.wiredOnce =
        (await ES<boolean>(`!document.querySelector('.toast--success') && !document.querySelector('.toast--attention')`)) &&
        read(claudeFile) === claudeBytes

      // ── ...but a detected CODEX auto-wires its own provider (per-provider guards) ──
      wc.send(TerminalChannels.agent, { id: 102, agentId: 'codex', cwd: '' })
      const codexAutoWired = await waitTrue(
        `(() => { const t = document.querySelector('.toast--success'); return !!t && /Codex/.test(t.querySelector('.toast-title')?.textContent || '') })()`
      )
      result.codexAutoWired = codexAutoWired && read(codexFile).includes('managed-by')
      await ES(`(document.querySelector('.toast--success .toast-dismiss')?.click(), 1)`)

      // ── wire the other three over the same IPC the card uses ──
      const codexApply = await mutate('apply', 'codex')
      const codexText = read(codexFile)
      const codexWired =
        codexApply?.ok === true &&
        codexText.includes('# my codex config') &&
        codexText.includes('model = "o4"') &&
        codexText.includes('command = "my-server"') &&
        /notify = \[ "node", .*notify\.mjs" \] # managed-by: mogginglabs/.test(codexText) &&
        codexText.includes('notifications = true # managed-by: mogginglabs') &&
        (await status()).codex?.state === 'applied'
      result.codexWired = codexWired

      const geminiApply = await mutate('apply', 'gemini')
      const geminiObj = json(geminiFile)
      const geminiWired =
        geminiApply?.ok === true &&
        (geminiObj?.general as { vimMode?: boolean; enableNotifications?: boolean })?.vimMode === true &&
        (geminiObj?.general as { enableNotifications?: boolean })?.enableNotifications === true &&
        entriesFor(geminiObj, 'AfterAgent').length === 2 &&
        entriesFor(geminiObj, 'AfterAgent')[0]?.hooks?.[0]?.command === 'their-after' &&
        oursIn(entriesFor(geminiObj, 'BeforeAgent')).length === 1 &&
        (await status()).gemini?.state === 'applied'
      result.geminiWired = geminiWired

      const ocApply = await mutate('apply', 'opencode')
      const ocTui = json(opencodeTui)
      const ocCfg = json(opencodeCfg)
      const ocPlugins = (ocCfg?.plugin as string[] | undefined) ?? []
      const pluginFile = join(app.getPath('userData'), 'notify-hook', 'opencode-notify-plugin.mjs')
      const opencodeWired =
        ocApply?.ok === true &&
        (ocTui?.theme as string) === 'mono' &&
        (ocTui?.attention as { enabled?: boolean; notifications?: boolean })?.enabled === true &&
        (ocTui?.attention as { notifications?: boolean })?.notifications === true &&
        ocPlugins.length === 2 &&
        ocPlugins[0] === 'their-plugin' &&
        /^file:\/\/\/.*notify-hook\/opencode-notify-plugin\.mjs$/.test(ocPlugins[1] ?? '') &&
        existsSync(pluginFile) &&
        (await status()).opencode?.state === 'applied'
      result.opencodeWired = opencodeWired

      // ── the Settings card: four rows, claude's Remove strips exactly ours ──
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      // The session-alerts card lives on Settings › Notifications now (F-08; tab id
      // stays 'webhooks' — ids are plumbing, not labels).
      await ES(`(document.querySelector('.settings-nav-item[data-target="webhooks"]')?.click(), 1)`)
      const fourRows = await waitTrue(`document.querySelectorAll('[data-hooks-provider]').length === 4`)
      result.fourRows = fourRows
      const claudeRow = `document.querySelector('[data-hooks-provider="claude"]')`
      const cardWired = await waitTrue(`(() => { const r = ${claudeRow}; return !!r && (r.textContent || '').includes('✓ wired') })()`)
      result.cardWired = cardWired
      await ES(`(() => { const r = ${claudeRow}; const b = r && [...r.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Remove'); if (b) b.click(); return 1 })()`)
      const cardRemoved = await waitTrue(`(() => { const r = ${claudeRow}; return !!r && (r.textContent || '').includes('not wired') })()`)
      const afterRemove = json(claudeFile)
      const removedFile =
        !!afterRemove &&
        (afterRemove.model as string) === 'smoke-model' &&
        EVENTS.every((event) => oursIn(entriesFor(afterRemove, event)).length === 0) &&
        entriesFor(afterRemove, 'Stop').length === 1 &&
        entriesFor(afterRemove, 'Stop')[0]?.hooks?.[0]?.command === 'user-own-stop-logger'
      result.cardRemoved = cardRemoved
      result.removedFile = removedFile

      // ── the opt-out: an explicit Remove is remembered, so detection's auto-wire must
      // never write back what the user just deleted (status carries the contract flag the
      // agents feature honors; an explicit re-Apply clears it again).
      const optedOut = (await status()).claude as Row & { autoWire?: boolean }
      result.optOutRecorded = optedOut?.state === 'not-applied' && optedOut?.autoWire === false

      // ── remove the other three: user content intact, memo-restored booleans ──
      const codexRemove = await mutate('remove', 'codex')
      const codexAfter = read(codexFile)
      result.codexRemoved =
        codexRemove?.ok === true &&
        codexAfter.includes('model = "o4"') &&
        codexAfter.includes('command = "my-server"') &&
        !codexAfter.includes('managed-by') &&
        !codexAfter.includes('notify = ')
      const geminiRemove = await mutate('remove', 'gemini')
      const geminiAfter = json(geminiFile)
      result.geminiRemoved =
        geminiRemove?.ok === true &&
        (geminiAfter?.general as { vimMode?: boolean; enableNotifications?: unknown })?.vimMode === true &&
        (geminiAfter?.general as { enableNotifications?: unknown })?.enableNotifications === undefined &&
        entriesFor(geminiAfter, 'AfterAgent').length === 1 &&
        entriesFor(geminiAfter, 'BeforeAgent').length === 0
      const ocRemove = await mutate('remove', 'opencode')
      const ocTuiAfter = json(opencodeTui)
      const ocCfgAfter = json(opencodeCfg)
      result.opencodeRemoved =
        ocRemove?.ok === true &&
        (ocTuiAfter?.theme as string) === 'mono' &&
        ocTuiAfter?.attention === undefined &&
        ((ocCfgAfter?.plugin as string[] | undefined) ?? []).join('|') === 'their-plugin'

      // ── codex CONFLICT: the user's own notify slot refuses byte-for-byte ──
      const conflictToml = 'notify = [ "say", "done" ]\nmodel = "o4"\n'
      writeFileSync(codexFile, conflictToml)
      const conflictRow = (await status()).codex
      const conflictApply = await mutate('apply', 'codex')
      result.codexConflict =
        conflictRow?.state === 'conflict' &&
        /notify/.test(conflictRow?.reason ?? '') &&
        conflictApply?.ok === false &&
        read(codexFile) === conflictToml

      // ── junk claude settings refuses byte-for-byte ──
      writeFileSync(claudeFile, '{ this is not json\n')
      const junkBytes = read(claudeFile)
      const statusJunk = (await status()).claude?.state === 'unreadable'
      const junkApply = await mutate('apply', 'claude')
      result.statusJunk = statusJunk
      result.junkRefused = junkApply?.ok === false && read(claudeFile) === junkBytes

      const KEYS = [
        'statusIsolated', 'wiredToast', 'wiredFile', 'backupMade', 'statusWired',
        'wiredOnce', 'codexAutoWired', 'codexWired', 'geminiWired', 'opencodeWired', 'fourRows',
        'cardWired', 'cardRemoved', 'removedFile', 'optOutRecorded', 'codexRemoved', 'geminiRemoved',
        'opencodeRemoved', 'codexConflict', 'statusJunk', 'junkRefused'
      ]
      result.pass = KEYS.every((k) => result[k] === true)
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

import { describe, expect, it } from 'vitest'
import {
  applyCodexGlobal,
  applyGeminiGlobal,
  applyOpencodePlugin,
  applyOpencodeTui,
  codexGlobalState,
  geminiGlobalState,
  opencodeGlobalState,
  opencodePluginSpec,
  removeCodexGlobal,
  removeGeminiGlobal,
  removeOpencodePlugin,
  removeOpencodeTui,
  tomlLineValue
} from '../../src/backend/features/agents/global-hooks'

// The other three CLIs of the hand-typed-alerts treatment — codex (tagged TOML line
// splices), gemini (JSON + a memo for the boolean that cannot carry a marker), opencode
// (two files: the tui chime pair + the file:// plugin spec). Same rules as the claude
// half: user content survives byte-for-value, ours replace their own stale vintages and
// never stack, a user's own occupied slot is a CONFLICT that refuses, junk is refused.

const INV = 'node "C:\\Users\\p\\AppData\\Roaming\\app\\notify-hook\\notify.mjs"'
const SCRIPT = 'C:\\Users\\p\\AppData\\Roaming\\app\\notify-hook\\notify.mjs'
const STALE_SCRIPT = 'C:\\old-install\\notify-hook\\notify.mjs'
const PLUGIN = 'C:\\Users\\p\\AppData\\Roaming\\app\\notify-hook\\opencode-notify-plugin.mjs'
const STALE_PLUGIN = 'C:\\old-install\\notify-hook\\opencode-notify-plugin.mjs'

describe('codex global wiring (config.toml, tagged line splices)', () => {
  it('wires an absent file: top-level notify + a [tui] table, every line tagged', () => {
    const next = applyCodexGlobal(null, SCRIPT)
    expect(next).toMatch(/^notify = \[ "node", "C:\\\\Users\\\\p[^\n]*# managed-by: mogginglabs$/m)
    expect(next).toMatch(/^\[tui\]$/m)
    expect(next).toMatch(/^notifications = true # managed-by: mogginglabs$/m)
    expect(next).toMatch(/^notification_method = "osc9" # managed-by: mogginglabs$/m)
    expect(next).toMatch(/^notification_condition = "always" # managed-by: mogginglabs$/m)
    expect(codexGlobalState(next, SCRIPT).state).toBe('applied')
  })

  it('preserves the user file line-for-line: foreign keys, tables and comments untouched', () => {
    const user = [
      '# my codex config',
      'model = "o4"',
      '',
      '[mcp_servers.mine]',
      'command = "my-server" # inline comment',
      ''
    ].join('\n')
    const next = applyCodexGlobal(user, SCRIPT)
    for (const line of ['# my codex config', 'model = "o4"', '[mcp_servers.mine]', 'command = "my-server" # inline comment']) {
      expect(next).toContain(line)
    }
    expect(next.indexOf('notify = ')).toBeLessThan(next.indexOf('[mcp_servers.mine]'))
    expect(codexGlobalState(next, SCRIPT).state).toBe('applied')
  })

  it('merges INTO an existing [tui] table without touching the user keys in it', () => {
    const user = ['[tui]', 'theme = "dark"', '', '[other]', 'x = 1'].join('\n')
    const next = applyCodexGlobal(user, SCRIPT)
    expect(next).toContain('theme = "dark"')
    expect(next).toContain('x = 1')
    expect(next.indexOf('notifications = true')).toBeGreaterThan(next.indexOf('[tui]'))
    expect(next.indexOf('notifications = true')).toBeLessThan(next.indexOf('[other]'))
    expect(codexGlobalState(next, SCRIPT).state).toBe('applied')
  })

  it("the user's own equal value is satisfied; a differing one is a CONFLICT, refused", () => {
    const satisfied = ['[tui]', 'notifications = true', ''].join('\n')
    expect(codexGlobalState(applyCodexGlobal(satisfied, SCRIPT), SCRIPT).state).toBe('applied')
    const conflicting = ['[tui]', 'notification_method = "desktop"', ''].join('\n')
    expect(codexGlobalState(conflicting, SCRIPT).state).toBe('conflict')
    expect(() => applyCodexGlobal(conflicting, SCRIPT)).toThrow()
    const theirNotify = 'notify = [ "say", "done" ]\n'
    expect(codexGlobalState(theirNotify, SCRIPT).state).toBe('conflict')
    expect(() => applyCodexGlobal(theirNotify, SCRIPT)).toThrow()
    const manualOurs = 'notify = ["node", "C:/somewhere/notify-hook/notify.mjs"]\n'
    expect(codexGlobalState(manualOurs, SCRIPT).state).not.toBe('conflict')
  })

  it('replaces a stale vintage instead of stacking, and is idempotent', () => {
    const stale = applyCodexGlobal(null, STALE_SCRIPT)
    expect(codexGlobalState(stale, SCRIPT).state).toBe('partial')
    const next = applyCodexGlobal(stale, SCRIPT)
    expect(next.match(/notify = /g)).toHaveLength(1)
    expect(next).not.toContain('old-install')
    expect(applyCodexGlobal(next, SCRIPT)).toBe(next)
  })

  it('remove strips exactly the tagged lines and reports nothing-to-do on clean files', () => {
    const user = 'model = "o4"\n'
    const removed = removeCodexGlobal(applyCodexGlobal(user, SCRIPT))
    expect(removed).toContain('model = "o4"')
    expect(removed).not.toContain('managed-by')
    expect(removed).not.toContain('notify = ')
    expect(removeCodexGlobal(user)).toBeNull()
    expect(removeCodexGlobal(null)).toBeNull()
  })

  it('tomlLineValue strips comments outside strings only', () => {
    expect(tomlLineValue('notifications = true # managed-by: mogginglabs')).toBe('true')
    expect(tomlLineValue('a = "with # inside" # real comment')).toBe('"with # inside"')
  })
})

describe('gemini global wiring (settings.json + memo)', () => {
  it('wires hooks + enableNotifications, preserving user keys and hook entries', () => {
    const user = JSON.stringify({
      general: { vimMode: true },
      hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'their-after' }] }] }
    })
    const { text, memo } = applyGeminiGlobal(user, INV)
    const obj = JSON.parse(text) as {
      general: { vimMode: boolean; enableNotifications: boolean }
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(memo.enableNotifications).toBe('absent')
    expect(obj.general.vimMode).toBe(true)
    expect(obj.general.enableNotifications).toBe(true)
    expect(obj.hooks.AfterAgent).toHaveLength(2)
    expect(obj.hooks.AfterAgent[0].hooks[0].command).toBe('their-after')
    expect(obj.hooks.AfterAgent[1].hooks[0].command).toBe(`${INV} --event done`)
    expect(obj.hooks.BeforeAgent[0].hooks[0].command).toBe(`${INV} --event turn-start`)
    expect(geminiGlobalState(text, INV).state).toBe('applied')
  })

  it('replaces stale vintages; state walks not-applied -> applied -> partial on a stale path', () => {
    expect(geminiGlobalState(null, INV).state).toBe('not-applied')
    const { text } = applyGeminiGlobal(null, INV)
    expect(geminiGlobalState(text, INV).state).toBe('applied')
    expect(geminiGlobalState(text, `node "${STALE_SCRIPT}"`).state).toBe('partial')
    const re = applyGeminiGlobal(text, `node "${STALE_SCRIPT}"`).text
    expect((JSON.parse(re) as { hooks: { AfterAgent: unknown[] } }).hooks.AfterAgent).toHaveLength(1)
  })

  it('remove restores enableNotifications from the memo — false, absent, or left alone without one', () => {
    const wasFalse = applyGeminiGlobal(JSON.stringify({ general: { enableNotifications: false } }), INV)
    expect(wasFalse.memo.enableNotifications).toBe('false')
    expect((JSON.parse(removeGeminiGlobal(wasFalse.text, wasFalse.memo)!) as { general: { enableNotifications: boolean } }).general.enableNotifications).toBe(false)
    const wasAbsent = applyGeminiGlobal('{}', INV)
    expect((JSON.parse(removeGeminiGlobal(wasAbsent.text, wasAbsent.memo)!) as { general?: unknown }).general).toBeUndefined()
    const noMemo = JSON.parse(removeGeminiGlobal(wasAbsent.text, null)!) as { general: { enableNotifications: boolean }; hooks?: unknown }
    expect(noMemo.general.enableNotifications).toBe(true)
    expect(noMemo.hooks).toBeUndefined()
  })

  it('refuses JSONC rather than deleting comments', () => {
    expect(() => applyGeminiGlobal('{ // my comment\n}', INV)).toThrow()
    expect(geminiGlobalState('{ // my comment\n}', INV).state).toBe('unreadable')
  })
})

describe('opencode global wiring (tui.json + opencode.json)', () => {
  it('tui: sets the attention pair, memos priors, restores on remove', () => {
    const { text, memo } = applyOpencodeTui(JSON.stringify({ theme: 'mono', attention: { sound: false, enabled: false } }))
    const obj = JSON.parse(text) as { theme: string; attention: Record<string, boolean> }
    expect(obj.theme).toBe('mono')
    expect(obj.attention.sound).toBe(false)
    expect(obj.attention.enabled).toBe(true)
    expect(obj.attention.notifications).toBe(true)
    expect(memo).toEqual({ enabled: 'false', notifications: 'absent' })
    const restored = JSON.parse(removeOpencodeTui(text, memo)!) as { attention: Record<string, boolean | undefined> }
    expect(restored.attention.enabled).toBe(false)
    expect(restored.attention.notifications).toBeUndefined()
    expect(restored.attention.sound).toBe(false)
    expect(removeOpencodeTui(text, null)).toBeNull()
  })

  it('plugin: appends the file:// spec, replaces stale vintages, strips exactly ours', () => {
    const user = JSON.stringify({ plugin: ['their-plugin', opencodePluginSpec(STALE_PLUGIN)] })
    const next = applyOpencodePlugin(user, PLUGIN)
    const obj = JSON.parse(next) as { plugin: string[] }
    expect(obj.plugin).toHaveLength(2)
    expect(obj.plugin[0]).toBe('their-plugin')
    expect(obj.plugin[1]).toBe(opencodePluginSpec(PLUGIN))
    const removed = JSON.parse(removeOpencodePlugin(next)!) as { plugin: string[] }
    expect(removed.plugin).toEqual(['their-plugin'])
    expect(removeOpencodePlugin(JSON.stringify({ plugin: ['their-plugin'] }))).toBeNull()
    expect(() => applyOpencodePlugin(JSON.stringify({ plugin: 'oops' }), PLUGIN)).toThrow()
  })

  it('state composes both files', () => {
    expect(opencodeGlobalState(null, null, PLUGIN).state).toBe('not-applied')
    const tui = applyOpencodeTui(null).text
    const cfg = applyOpencodePlugin(null, PLUGIN)
    expect(opencodeGlobalState(tui, cfg, PLUGIN).state).toBe('applied')
    expect(opencodeGlobalState(null, cfg, PLUGIN).state).toBe('partial')
    expect(opencodeGlobalState(tui, cfg, PLUGIN.replace('app', 'newer-app')).state).toBe('partial')
    expect(opencodeGlobalState('{ //jsonc\n}', cfg, PLUGIN).state).toBe('unreadable')
  })
})

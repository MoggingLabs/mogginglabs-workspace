import { describe, expect, it } from 'vitest'
import {
  bomOf,
  isManagedScopedJson,
  parseConfig,
  stringifyConfig
} from '@backend/features/integrations/writers/json-dialect'

// THE BOM, pinned.
//
// JSON.parse throws on a leading U+FEFF, and every Windows tool that touches a config file
// writes one — PowerShell's Out-File, Notepad, `>` redirection in older shells. macOS and
// Linux never produce one, so this failed in exactly one direction and no gate on the other
// two platforms could see it.
//
// The loud half was a user's own settings.json becoming unreadable. The quiet half was
// worse: isManagedScopedJson catches the parse failure and returns FALSE, which reads as
// "this file is not ours to write" — so a scoped tool-plan config with a BOM was silently
// abandoned rather than managed.
//
// The sibling dialect module (agent-settings/codecs/common.ts splitBom) has always handled
// this. This one never adopted it.

const BOM = '﻿'
const scoped = '{\n  "mcpServers": {}\n}\n'

describe('parseConfig with a BOM', () => {
  it('parses a config that opens with a BOM', () => {
    expect(parseConfig(BOM + '{"a":1}')).toEqual({ a: 1 })
  })

  it('parses one without a BOM exactly as before', () => {
    expect(parseConfig('{"a":1}')).toEqual({ a: 1 })
  })

  it('still refuses JSONC, with the honest message, BOM or not', () => {
    // The refusal must survive the BOM strip: we decline rather than eat the comments.
    expect(() => parseConfig(BOM + '{\n  // hi\n  "a": 1\n}')).toThrow(/comments or trailing commas/)
  })

  it('still throws for genuinely broken JSON', () => {
    expect(() => parseConfig(BOM + '{oops')).toThrow()
  })
})

describe('isManagedScopedJson with a BOM', () => {
  // The quiet half: a false here means "not ours", and the config is abandoned.
  it('recognises a managed scoped config that opens with a BOM', () => {
    expect(isManagedScopedJson(BOM + scoped)).toBe(true)
  })

  it('still refuses a config carrying the user’s own keys', () => {
    expect(isManagedScopedJson(BOM + '{\n  "theme": "dark",\n  "mcpServers": {}\n}\n')).toBe(false)
  })
})

describe('stringifyConfig preserves the file’s BOM', () => {
  it('gives back the BOM the file opened with', () => {
    const out = stringifyConfig({ a: 1 }, BOM + '{\n  "a": 0\n}\n')
    expect(out.startsWith(BOM)).toBe(true)
    // ...and is still valid JSON once the BOM is taken off again.
    expect(parseConfig(out)).toEqual({ a: 1 })
  })

  it('does not invent a BOM for a file that had none', () => {
    expect(stringifyConfig({ a: 1 }, '{\n  "a": 0\n}\n').startsWith(BOM)).toBe(false)
    expect(stringifyConfig({ a: 1 }, null).startsWith(BOM)).toBe(false)
  })

  it('keeps preserving indent and the trailing-newline convention alongside it', () => {
    const out = stringifyConfig({ a: { b: 1 } }, BOM + '{\n    "a": 0\n}')
    expect(out).toContain('\n    "a"') // 4-space indent detected through the BOM
    expect(out.endsWith('\n')).toBe(false) // original had no trailing newline
  })

  it('bomOf reports what the file opened with', () => {
    expect(bomOf(BOM + '{}')).toBe(BOM)
    expect(bomOf('{}')).toBe('')
    expect(bomOf(null)).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { quotePathForShell, quotePathsForShell, shellFlavor } from '@contracts/domain/shell-quote'

// The drop-a-file quoting contract: ALWAYS one shell word, ALWAYS quoted, and a
// filename must never be able to forge input (control chars, cmd %-expansion, the
// trailing-backslash-before-quote escape). Each cmd case below restates a rule the
// module measured against real cmd.exe.
describe('shellFlavor', () => {
  it('everything non-win32 is posix', () => {
    expect(shellFlavor('/bin/zsh', 'darwin')).toBe('posix')
    expect(shellFlavor('C:/anything.exe', 'linux')).toBe('posix')
  })
  it('win32 defaults to cmd; only pwsh/powershell executables opt out', () => {
    expect(shellFlavor('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd')
    expect(shellFlavor('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell')
    expect(shellFlavor('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')).toBe('powershell')
    expect(shellFlavor('C:\\tools\\bash.exe', 'win32')).toBe('cmd')
  })
})

describe('quotePathForShell', () => {
  it('posix: single quotes, embedded quote closes-escapes-reopens', () => {
    expect(quotePathForShell('/tmp/plain file', 'posix')).toBe("'/tmp/plain file'")
    expect(quotePathForShell("/tmp/it's here", 'posix')).toBe("'/tmp/it'\\''s here'")
  })

  it('powershell: single quotes, embedded quote doubled, $ stays literal', () => {
    expect(quotePathForShell("C:\\it's here", 'powershell')).toBe("'C:\\it''s here'")
    expect(quotePathForShell('C:\\$Recycle.Bin', 'powershell')).toBe("'C:\\$Recycle.Bin'")
  })

  it('cmd: plain paths come back double-quoted, byte-identical inside', () => {
    expect(quotePathForShell('C:\\tmp\\plain file.txt', 'cmd')).toBe('"C:\\tmp\\plain file.txt"')
  })

  it('cmd: % splices between quoted runs so no %NAME% pair survives phase-1', () => {
    expect(quotePathForShell('C:\\tmp\\100%PATHX%end', 'cmd')).toBe('"C:\\tmp\\100"%"PATHX"%"end"')
  })

  it('cmd: a backslash run abutting a closing quote is doubled', () => {
    expect(quotePathForShell('C:\\', 'cmd')).toBe('"C:\\\\"')
  })

  it('cmd: embedded double quotes are stripped, never emitted', () => {
    expect(quotePathForShell('C:\\evil"dir', 'cmd')).toBe('"C:\\evildir"')
  })

  it('control characters are removed in every flavor (no forged Enter)', () => {
    expect(quotePathForShell('/tmp/a\nb', 'posix')).toBe("'/tmp/ab'")
    expect(quotePathForShell('C:\\a\rb', 'cmd')).toBe('"C:\\ab"')
  })

  it('joins several paths as separate words', () => {
    expect(quotePathsForShell(['/a b', '/c'], 'posix')).toBe("'/a b' '/c'")
  })
})

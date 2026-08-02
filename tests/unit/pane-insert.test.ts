import { describe, expect, it } from 'vitest'
import { sourceOf } from './source-body'
import { planFallbackInsert, planPaneInsert, REMOTE_INSERT_TOAST } from '@ui/core/terminal/pane-insert'

// The ONE decision behind "type a path into a pane" — shared by the explorer drag's
// drop, the OS-file drop, and send-to-pane. The cases that matter most are the two
// remote-namespace bugs this module was extracted to kill: a remote cwd that merely
// string-prefixes a local path must never fabricate a relative path, and the local
// shell's flavor must never quote for an ssh host.

describe('planPaneInsert', () => {
  it('remote beats a prefix-matching POSIX cwd — always absolute (the bug-A pin)', () => {
    const p = planPaneInsert({ paths: ['/srv/repo/a b.ts'], remote: true, paneCwd: '/srv/repo', localFlavor: 'posix' })
    expect(p.text).toBe("'/srv/repo/a b.ts'")
    expect(p.data).toBe(" '/srv/repo/a b.ts' ")
    expect(p.remote).toBe(true)
  })

  it('remote beats a drive-lettered prefix cwd, and localFlavor is ignored (posix always)', () => {
    const p = planPaneInsert({ paths: ['C:\\srv\\Repo\\f.ts'], remote: true, paneCwd: 'c:\\srv\\repo', localFlavor: 'cmd' })
    expect(p.text).toBe("'C:\\srv\\Repo\\f.ts'") // posix single quotes, backslashes literal
  })

  it('local + cwd containing the path → relative, in the local flavor', () => {
    const p = planPaneInsert({ paths: ['C:\\repo\\src\\main.ts'], remote: false, paneCwd: 'C:\\repo', localFlavor: 'cmd' })
    expect(p.text).toBe('"src\\main.ts"')
  })

  it('local + path outside the cwd → absolute, never a fabricated relative', () => {
    const p = planPaneInsert({ paths: ['/other/f.ts'], remote: false, paneCwd: '/repo', localFlavor: 'posix' })
    expect(p.text).toBe("'/other/f.ts'")
  })

  it('local with NO paneCwd (the OS-file drop) → absolute even when a cwd would have matched', () => {
    const p = planPaneInsert({ paths: ['/repo/f.ts'], remote: false, localFlavor: 'posix' })
    expect(p.text).toBe("'/repo/f.ts'")
  })

  it('multiple paths: per-path relativization, one quoted word each, space-joined', () => {
    const p = planPaneInsert({
      paths: ['/repo/a.ts', '/elsewhere/b.ts'],
      remote: false,
      paneCwd: '/repo',
      localFlavor: 'posix'
    })
    expect(p.text).toBe("'a.ts' '/elsewhere/b.ts'")
  })

  it('control characters never survive into text or data — the cannot-press-Enter guarantee', () => {
    const p = planPaneInsert({ paths: ['/tmp/evil\r\nname.txt'], remote: true, localFlavor: 'posix' })
    expect(p.text).not.toMatch(/[\r\n]/)
    expect(p.data).not.toMatch(/[\r\n]/)
  })

  it("apostrophes escape the posix way ('\\'' ), mirroring the REMOTE gate's fixture", () => {
    const p = planPaneInsert({ paths: ["/srv/work trees/O'Reilly"], remote: true, localFlavor: 'cmd' })
    expect(p.text).toBe("'/srv/work trees/O'\\''Reilly'")
  })

  it('the toast copy is pinned — the REMOTE gate greps this exact title', () => {
    expect(REMOTE_INSERT_TOAST.title).toBe('This pane is remote')
    expect(REMOTE_INSERT_TOAST.tone).toBe('info')
    expect(REMOTE_INSERT_TOAST.body).toContain('THIS machine')
  })
})

describe('planFallbackInsert — the degraded drop path', () => {
  // A marker with no raw payload leaves only the already-quoted `text/plain` half. It cannot
  // be re-quoted, because the raw path is gone.
  //
  // pane-drop wrote it into the PTY VERBATIM, skipping the only control-character strip in the
  // insert path. planPaneInsert's own comment says the payload "cannot press Enter" — true of
  // that function, because quotePathsForShell strips on the way through, and false of this
  // branch, which never called it. A CR in the payload forges an Enter and the shell runs
  // whatever preceded it.
  it('passes a clean payload through with the same padding as a normal insert', () => {
    expect(planFallbackInsert('/srv/app/file.txt')).toEqual({
      text: '/srv/app/file.txt',
      data: ' /srv/app/file.txt ',
      remote: false
    })
  })

  it('REFUSES a payload carrying a carriage return', () => {
    expect(planFallbackInsert('safe.txt\rrm -rf /')).toBeNull()
  })

  it('refuses every control character, not just CR', () => {
    for (const ch of ['\n', '\r', '\u0000', '\u001b', '\u007f', '\u0007']) {
      expect(planFallbackInsert(`a${ch}b`), JSON.stringify(ch)).toBeNull()
    }
  })

  it('refuses an empty payload — there is nothing to type', () => {
    expect(planFallbackInsert('')).toBeNull()
  })

  // Refusing rather than stripping is the deliberate choice: silently removing bytes would
  // type a DIFFERENT path than the one dropped, and at this point we cannot tell a hostile
  // name from a corrupted marker. Typing nothing is the honest outcome.
  it('refuses rather than sanitizing — a stripped path is a different path', () => {
    const out = planFallbackInsert('safe\rmalicious')
    expect(out, 'a sanitized " safemalicious " would name a file the user never dropped').toBeNull()
  })
})

describe('the drop path uses the planner', () => {
  const src = sourceOf('src/ui/features/terminal/pane-drop.ts')

  it('no longer writes the fallback verbatim', () => {
    expect(src).toContain('planFallbackInsert(quotedFallback)')
    expect(src, 'the verbatim write is the defect').not.toMatch(/data:\s*' '\s*\+\s*quotedFallback/)
  })

  it('types nothing when the planner refuses', () => {
    expect(src).toMatch(/const fallback = planFallbackInsert\(quotedFallback\)\s*\n\s*if \(fallback\)/)
  })
})

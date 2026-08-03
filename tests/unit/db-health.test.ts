import { describe, expect, it } from 'vitest'
import { corruptAsidePath, corruptSidecars, isSqliteCorruption } from '@backend/features/workspace'

// THE TWO OPPOSITE DATABASE BUGS, pinned.
//
// The daemon treated EVERY open failure as corruption and renamed the file aside. A lock,
// an EBUSY from a scanner mid-write, a momentary permission denial — each moved a
// perfectly good store out of the way. The retry failed the same way, the daemon died
// that boot, and the next healthy boot opened a fresh empty file. Every restorable pane,
// gone, because the disk was busy for a second.
//
// The app treated NO failure as corruption. One genuinely corrupt file left store = null
// for the process lifetime: workspaces, layout, board and profiles simply stopped
// persisting, permanently, and the only recovery was deleting the file by hand.
//
// One predicate decides both. Getting it wrong is silent in either direction, which is
// exactly why it is tested rather than reasoned about.

const err = (message: string, code?: string): Error => Object.assign(new Error(message), code ? { code } : {})

describe('isSqliteCorruption', () => {
  it('recognises the codes better-sqlite3 raises for an unusable file', () => {
    expect(isSqliteCorruption(err('malformed', 'SQLITE_CORRUPT'))).toBe(true)
    expect(isSqliteCorruption(err('nope', 'SQLITE_NOTADB'))).toBe(true)
  })

  it('recognises the messages when no code is attached (a throw inside a migration)', () => {
    expect(isSqliteCorruption(err('database disk image is malformed'))).toBe(true)
    expect(isSqliteCorruption(err('file is not a database'))).toBe(true)
    expect(isSqliteCorruption(err('file is encrypted or is not a database'))).toBe(true)
  })

  // THE regression. Each of these CAN clear on its own, so the file must stay put.
  it('refuses to call a transient failure corruption', () => {
    for (const e of [
      err('EBUSY: resource busy or locked', 'EBUSY'),
      err('EACCES: permission denied', 'EACCES'),
      err('EPERM: operation not permitted', 'EPERM'),
      err('ENOSPC: no space left on device', 'ENOSPC'),
      err('EMFILE: too many open files', 'EMFILE'),
      err('database is locked', 'SQLITE_BUSY'),
      err('EIO: i/o error', 'EIO')
    ]) {
      expect(isSqliteCorruption(e), String((e as { code?: string }).code)).toBe(false)
    }
  })

  it('does not choke on a non-Error throw', () => {
    expect(isSqliteCorruption('database disk image is malformed')).toBe(true)
    expect(isSqliteCorruption(undefined)).toBe(false)
    expect(isSqliteCorruption(null)).toBe(false)
    expect(isSqliteCorruption({})).toBe(false)
  })

  it('matches case-insensitively — sqlite messages are not a stable case', () => {
    expect(isSqliteCorruption(err('Database Disk Image Is Malformed'))).toBe(true)
  })
})

describe('set-aside naming', () => {
  it('uses one spelling so a human sweeping up finds every one of them', () => {
    expect(corruptAsidePath('/x/app.db', 0)).toBe('/x/app.db.corrupt-0')
    expect(corruptAsidePath('/x/app.db', 1)).toMatch(/^\/x\/app\.db\.corrupt-/)
  })

  it('names the journal files, so a fresh database cannot inherit the old tail', () => {
    // -wal/-shm left behind hand the NEW database the old file's uncommitted writes —
    // a clean start that carries forward the corruption it just escaped.
    expect(corruptSidecars('/x/app.db')).toEqual(['/x/app.db-wal', '/x/app.db-shm'])
  })
})

// Classifying a sqlite open failure. PURE — no I/O, no state.
//
// Both stores answer the same question when an open throws, and both got it wrong in
// opposite directions:
//
//   the daemon (pty-daemon/index.ts) treated EVERY failure as corruption and renamed the
//   file aside. A lock, an EBUSY from a virus scanner mid-write, a momentary permission
//   denial — each moved a PERFECTLY GOOD store out of the way. The retry then failed the
//   same way, so the daemon died that boot, and the NEXT healthy boot opened a fresh empty
//   file. Every restorable pane, gone, because the disk was busy for a second.
//
//   the app (main/app-settings.ts) treated NO failure as corruption. One genuinely corrupt
//   file bricked workspace, layout, board and profile persistence permanently — the store
//   is never reopened, and the only recovery was deleting the file by hand.
//
// The distinction is the fix, and it belongs in one place because getting it wrong is
// silent in both directions.
//
// SQLITE_CORRUPT / SQLITE_NOTADB are the codes better-sqlite3 surfaces for a file whose
// bytes are not a usable database. Those do not heal: reopening runs the same read and
// throws again, so setting the file aside is the ONLY way forward. Everything else — a
// lock, a permission error, a full disk, a transient I/O fault — is a condition that can
// clear on its own, and the file must be left exactly where it is.
export function isSqliteCorruption(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true
  // better-sqlite3 does not always attach a code (a throw from inside a migration, for
  // instance), so fall back to the messages sqlite itself emits for the same two states.
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase()
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('file is not a database') ||
    msg.includes('file is encrypted or is not a database')
  )
}

/** The name a set-aside file takes. One spelling, so a human sweeping up finds all of them
 *  and no caller invents its own suffix. */
export function corruptAsidePath(dbPath: string, stamp: number): string {
  return `${dbPath}.corrupt-${stamp.toString(36)}`
}

/** better-sqlite3 keeps its journal beside the database. Leaving `-wal`/`-shm` behind when
 *  the main file is set aside hands the FRESH database the old file's uncommitted tail,
 *  which is how a "clean start" inherits the corruption it just escaped. */
export function corruptSidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`]
}

import type Database from 'better-sqlite3'

/**
 * Idempotent additive column migration, shared by both stores (session + settings).
 *
 * Deliberately the same TRY-ALTER semantics the stores always had — an existing db is
 * at an unknown point in the column history, so "add it, and an 'already exists' error
 * means done" is the one rule that is correct for every db ever written. What this
 * helper removes is the dozen copy-pasted try/catch blocks, not the semantics. It
 * still swallows ONLY the duplicate-column error: any other failure (corrupt db,
 * locked file) propagates, exactly as the inline blocks did not — that was the one
 * real defect of the copy-paste form (a locked db read as "column already exists").
 */
export function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/duplicate column name/i.test(message)) throw error
  }
}

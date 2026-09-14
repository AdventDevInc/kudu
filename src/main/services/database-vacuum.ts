import fs from 'fs'
import Database from 'better-sqlite3'

/** Only call in the database helper process: SQLite work is synchronous. */
export function vacuumDatabase(filePath: string): number {
  const sizeBefore = fs.statSync(filePath).size + walSize(filePath)
  // Busy databases belong to running applications. Skip promptly instead of
  // waiting repeatedly for their write locks.
  const db = new Database(filePath, { fileMustExist: true, timeout: 250 })
  try {
    // Keep SQLite's journaling enabled so interruption rolls back safely.
    db.exec('VACUUM')
  } finally {
    db.close()
  }
  return Math.max(0, sizeBefore - (fs.statSync(filePath).size + walSize(filePath)))
}

function walSize(filePath: string): number {
  try {
    return fs.statSync(filePath + '-wal').size
  } catch {
    return 0
  }
}

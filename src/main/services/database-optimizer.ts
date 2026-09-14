import { existsSync } from 'fs'
import { join } from 'path'
import { spawnTrackedLines } from './exec-utf8'

export const DATABASE_TIMEOUT_MS = 30_000

/** Run maintenance off the main thread, with a deadline for the entire operation. */
export async function optimizeDatabase(filePath: string): Promise<number> {
  // Shared Rollup chunks live one directory below the helper entry.
  const adjacentWorker = join(__dirname, 'database-worker.js')
  const workerPath = existsSync(adjacentWorker)
    ? adjacentWorker
    : join(__dirname, '..', 'database-worker.js')
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // Run only our bundled helper, with the packaged Electron native-module ABI.
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.ELECTRON_NO_ASAR
  const lines: string[] = []
  const { code, timedOut } = await spawnTrackedLines(
    process.execPath,
    [workerPath, filePath],
    (line) => lines.push(line),
    { timeout: DATABASE_TIMEOUT_MS, env }
  )
  if (timedOut) {
    throw new Error('Database optimization timed out; close the application and try again')
  }
  if (code !== 0 || lines.length !== 1) {
    throw new Error('Database optimization process failed')
  }
  const result = JSON.parse(lines[0]) as {
    reclaimed?: number
    error?: { code?: string; message: string }
  }
  if (result.error)
    throw Object.assign(new Error(result.error.message), { code: result.error.code })
  if (
    typeof result.reclaimed !== 'number' ||
    !Number.isFinite(result.reclaimed) ||
    result.reclaimed < 0
  ) {
    throw new Error('Invalid database optimization result')
  }
  return result.reclaimed
}

import { vacuumDatabase } from '../services/database-vacuum'

// One database per process. The parent can kill a stuck native SQLite call;
// a Promise timeout or worker-thread termination cannot reliably interrupt it.
try {
  const reclaimed = vacuumDatabase(process.argv[2])
  process.stdout.write(JSON.stringify({ reclaimed }) + '\n')
} catch (error) {
  const err = error as { code?: string; message?: string }
  process.stdout.write(
    JSON.stringify({
      error: { code: err.code, message: err.message || 'Database optimization failed' }
    }) + '\n'
  )
}

import { lstat } from 'fs/promises'
import { execTracked } from './exec-utf8'

export const JOURNAL_ROOT = '/var/log/journal'
const JOURNALCTL = '/usr/bin/journalctl'

async function checkJournalDirectory(): Promise<void> {
  for (const path of ['/var', '/var/log', JOURNAL_ROOT]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Journal path changed or is not a real directory.')
  }
}

export async function inspectJournalCleanup(): Promise<void> {
  await checkJournalDirectory()
  // Discovery only. Active and archived bytes are not a reclaimable estimate.
  await execTracked(JOURNALCTL, ['--no-pager', `--directory=${JOURNAL_ROOT}`, '--disk-usage'], { timeout: 10_000 })
}

export async function vacuumJournalCleanup(path: string): Promise<void> {
  if (path !== JOURNAL_ROOT) throw new Error('Journal location changed; scan again.')
  await checkJournalDirectory()
  // Do not rotate: active journals must remain active and outside vacuum scope.
  // Either limit may remove archived files; this is not a 30-day retention guarantee.
  await execTracked(JOURNALCTL, [
    '--no-pager', `--directory=${JOURNAL_ROOT}`, '--vacuum-time=30d', '--vacuum-size=1G',
  ], { timeout: 300_000 })
}

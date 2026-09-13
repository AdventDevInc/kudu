/**
 * Counts main-process operations that keep running after the renderer that requested them
 * is gone (cleaner deletions, registry fixes, package upgrades, driver installs). The
 * scheduler holds its execution lock for an orphaned run until such work is positively known
 * to have finished: nothing in flight and at least one tracked operation completed since the
 * run was orphaned.
 */
let inFlight = 0
let completed = 0

export function trackMainWork<T>(work: Promise<T>): Promise<T> {
  inFlight++
  return work.finally(() => {
    inFlight--
    completed++
  })
}

export function hasMainWorkInFlight(): boolean {
  return inFlight > 0
}

/** Increments each time a tracked operation settles, so callers can detect completions. */
export function mainWorkGeneration(): number {
  return completed
}

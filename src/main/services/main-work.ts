/**
 * Counts main-process operations that keep running after the renderer that requested them
 * is gone (package upgrades, driver installs). The scheduler holds its execution lock for an
 * orphaned run while any such work is in flight.
 */
let inFlight = 0

export function trackMainWork<T>(work: Promise<T>): Promise<T> {
  inFlight++
  return work.finally(() => {
    inFlight--
  })
}

export function hasMainWorkInFlight(): boolean {
  return inFlight > 0
}

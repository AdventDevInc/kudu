/**
 * Give Electron's main loop a macrotask turn during very large bookkeeping
 * loops. Promise-based filesystem calls yield to microtasks, which can still
 * starve window and IPC events when thousands resolve back-to-back.
 */
export class CooperativeScheduler {
  private lastYield = Date.now()

  constructor(private readonly intervalMs = 12) {}

  async yieldIfNeeded(): Promise<void> {
    if (Date.now() - this.lastYield < this.intervalMs) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.lastYield = Date.now()
  }
}

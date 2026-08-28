import { describe, expect, it } from 'vitest'
import { CooperativeScheduler } from './cooperative-scheduler'

describe('CooperativeScheduler', () => {
  it('gives queued main-loop work a turn once the interval is reached', async () => {
    const scheduler = new CooperativeScheduler(0)
    let mainLoopRan = false
    setImmediate(() => { mainLoopRan = true })

    await scheduler.yieldIfNeeded()

    expect(mainLoopRan).toBe(true)
  })
})

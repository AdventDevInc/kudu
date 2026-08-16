import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processListMock = vi.hoisted(() => ({
  stdout: '',
  error: null as Error | null,
}))

vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    if (processListMock.error) {
      callback(processListMock.error)
      return
    }
    callback(null, { stdout: processListMock.stdout, stderr: '' })
  },
}))

import { getDetectedGame, startGameDetector, stopGameDetector } from './game-detector'

describe('game detector lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    processListMock.stdout = ''
    processListMock.error = null
  })

  afterEach(() => {
    stopGameDetector()
    vi.useRealTimers()
  })

  it('retries detection when activation was not accepted', async () => {
    processListMock.stdout = '"cs2.exe","1234","Console","1","100 K"\r\n'
    const onGameDetected = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const onGameExited = vi.fn()

    startGameDetector({ onGameDetected, onGameExited }, [])
    await vi.advanceTimersByTimeAsync(0)

    expect(onGameDetected).toHaveBeenCalledTimes(1)
    expect(getDetectedGame()).toBeNull()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(onGameDetected).toHaveBeenCalledTimes(2)
    expect(getDetectedGame()).toBe('cs2.exe')
  })

  it('does not treat a failed process query as a game exit', async () => {
    processListMock.stdout = '"cs2.exe","1234","Console","1","100 K"\r\n'
    const onGameDetected = vi.fn().mockResolvedValue(true)
    const onGameExited = vi.fn()

    startGameDetector({ onGameDetected, onGameExited }, [])
    await vi.advanceTimersByTimeAsync(0)
    expect(getDetectedGame()).toBe('cs2.exe')

    processListMock.error = new Error('tasklist unavailable')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(onGameExited).not.toHaveBeenCalled()
    expect(getDetectedGame()).toBe('cs2.exe')
  })
})

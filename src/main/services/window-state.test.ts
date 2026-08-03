import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { WindowState } from '../../shared/types'

const savedStates: WindowState[] = []
let storedState: WindowState | null = null
let readThrows = false

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => displays,
  },
}))

vi.mock('./settings-store', () => ({
  getWindowState: () => {
    if (readThrows) throw new Error('config unreadable')
    return storedState
  },
  setWindowState: (s: WindowState) => {
    savedStates.push(s)
    return Promise.resolve()
  },
}))

import {
  sanitizeWindowState,
  loadWindowState,
  trackWindowState,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from './window-state'

const display = (x: number, y: number, width: number, height: number) => ({
  workArea: { x, y, width, height },
})

const LAPTOP = display(0, 0, 1920, 1040)
let displays = [LAPTOP]

const FALLBACK = { width: 1440, height: 832 }

describe('sanitizeWindowState (issue #270)', () => {
  it('falls back to the default size when nothing was ever saved', () => {
    expect(sanitizeWindowState(null, [LAPTOP], FALLBACK)).toEqual({
      width: 1440,
      height: 832,
      isMaximized: false,
    })
  })

  it('restores a previously saved size and position verbatim', () => {
    const saved = { width: 1200, height: 700, x: 100, y: 60, isMaximized: false }
    expect(sanitizeWindowState(saved, [LAPTOP], FALLBACK)).toEqual(saved)
  })

  it('restores the maximized flag', () => {
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: 10, y: 10, isMaximized: true },
      [LAPTOP],
      FALLBACK
    )
    expect(state.isMaximized).toBe(true)
  })

  it('clamps a size below the window minimums', () => {
    const state = sanitizeWindowState({ width: 300, height: 200, isMaximized: false }, [LAPTOP], FALLBACK)
    expect(state.width).toBe(MIN_WINDOW_WIDTH)
    expect(state.height).toBe(MIN_WINDOW_HEIGHT)
  })

  it('shrinks a size saved on a larger display to fit the current one', () => {
    // Saved on a 4K monitor, reopened on the laptop screen.
    const state = sanitizeWindowState(
      { width: 3400, height: 1900, x: 0, y: 0, isMaximized: false },
      [LAPTOP],
      FALLBACK
    )
    expect(state.width).toBe(1920)
    expect(state.height).toBe(1040)
  })

  it('drops a position left behind by an unplugged monitor', () => {
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: 2600, y: 300, isMaximized: false },
      [LAPTOP],
      FALLBACK
    )
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
    // The size the user chose is still worth keeping.
    expect(state).toMatchObject({ width: 1200, height: 700 })
  })

  it('keeps a position on a secondary display placed left of the primary', () => {
    const secondary = display(-1920, 0, 1920, 1040)
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: -1500, y: 120, isMaximized: false },
      [LAPTOP, secondary],
      FALLBACK
    )
    expect(state).toMatchObject({ x: -1500, y: 120 })
  })

  it('drops a position that leaves only a sliver of the window on-screen', () => {
    // 40px of the window pokes onto the display — not enough to grab the
    // frameless drag bar with.
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: 1880, y: 200, isMaximized: false },
      [LAPTOP],
      FALLBACK
    )
    expect(state.x).toBeUndefined()
  })

  it('ignores a corrupt or partially written record', () => {
    for (const bad of [
      { width: Number.NaN, height: 700, isMaximized: false },
      { width: -1200, height: 700, isMaximized: false },
      { width: 1200, isMaximized: false },
      {},
    ]) {
      expect(sanitizeWindowState(bad as Partial<WindowState>, [LAPTOP], FALLBACK)).toMatchObject(FALLBACK)
    }
  })

  it('ignores a position with a missing or non-numeric coordinate', () => {
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: 100, y: Number.NaN, isMaximized: false },
      [LAPTOP],
      FALLBACK
    )
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
  })

  it('accepts a position at the origin', () => {
    const state = sanitizeWindowState(
      { width: 1200, height: 700, x: 0, y: 0, isMaximized: false },
      [LAPTOP],
      FALLBACK
    )
    expect(state).toMatchObject({ x: 0, y: 0 })
  })
})

describe('loadWindowState', () => {
  beforeEach(() => {
    storedState = null
    readThrows = false
    displays = [LAPTOP]
  })

  it('reads the persisted state through the settings store', () => {
    storedState = { width: 1100, height: 720, x: 40, y: 40, isMaximized: false }
    expect(loadWindowState(FALLBACK)).toEqual(storedState)
  })

  it('falls back to the default size when the config cannot be read', () => {
    readThrows = true
    expect(loadWindowState(FALLBACK)).toEqual({ ...FALLBACK, isMaximized: false })
  })
})

/** Minimal stand-in for the bits of BrowserWindow that trackWindowState uses. */
class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  fullScreen = false
  maximized = false
  normalBounds = { x: 20, y: 30, width: 1200, height: 700 }

  isDestroyed = (): boolean => this.destroyed
  isMinimized = (): boolean => this.minimized
  isFullScreen = (): boolean => this.fullScreen
  isMaximized = (): boolean => this.maximized
  getNormalBounds = (): { x: number; y: number; width: number; height: number } => this.normalBounds
}

function track(): FakeWindow {
  const win = new FakeWindow()
  trackWindowState(win as unknown as import('electron').BrowserWindow)
  return win
}

describe('trackWindowState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    savedStates.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists the new geometry after a resize settles', () => {
    const win = track()
    win.normalBounds = { x: 20, y: 30, width: 1310, height: 880 }
    win.emit('resize')

    expect(savedStates).toHaveLength(0) // debounced, not written mid-drag
    vi.runAllTimers()

    expect(savedStates).toEqual([{ x: 20, y: 30, width: 1310, height: 880, isMaximized: false }])
  })

  it('coalesces a drag-resize into a single write', () => {
    const win = track()
    for (let i = 0; i < 25; i++) {
      win.normalBounds = { x: 20, y: 30, width: 1000 + i, height: 700 }
      win.emit('resize')
      vi.advanceTimersByTime(16)
    }
    vi.runAllTimers()

    expect(savedStates).toHaveLength(1)
    expect(savedStates[0].width).toBe(1024)
  })

  it('persists a move', () => {
    const win = track()
    win.normalBounds = { x: 400, y: 250, width: 1200, height: 700 }
    win.emit('move')
    vi.runAllTimers()

    expect(savedStates[0]).toMatchObject({ x: 400, y: 250 })
  })

  it('records the maximized flag alongside the restore size', () => {
    const win = track()
    win.maximized = true
    win.emit('maximize')
    vi.runAllTimers()

    expect(savedStates[0]).toEqual({ x: 20, y: 30, width: 1200, height: 700, isMaximized: true })
  })

  it('writes the final geometry on close without waiting for the debounce', () => {
    const win = track()
    win.normalBounds = { x: 20, y: 30, width: 1500, height: 900 }
    win.emit('resize')
    win.emit('close')

    expect(savedStates).toEqual([{ x: 20, y: 30, width: 1500, height: 900, isMaximized: false }])

    // The pending debounce must not fire a second, redundant write.
    vi.runAllTimers()
    expect(savedStates).toHaveLength(1)
  })

  it('does not save transient minimized or fullscreen geometry', () => {
    const win = track()
    win.minimized = true
    win.emit('resize')
    vi.runAllTimers()
    expect(savedStates).toHaveLength(0)

    win.minimized = false
    win.fullScreen = true
    win.emit('resize')
    vi.runAllTimers()
    expect(savedStates).toHaveLength(0)
  })

  it('does not touch the store once the window is destroyed', () => {
    const win = track()
    win.emit('resize')
    win.destroyed = true
    vi.runAllTimers()
    expect(savedStates).toHaveLength(0)
  })

  it('ignores a bogus zero-sized measurement', () => {
    const win = track()
    win.normalBounds = { x: 0, y: 0, width: 0, height: 0 }
    win.emit('resize')
    vi.runAllTimers()
    expect(savedStates).toHaveLength(0)
  })
})

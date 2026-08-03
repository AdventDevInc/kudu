import { screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import { getWindowState, setWindowState } from './settings-store'
import type { WindowState } from '../../shared/types'

// Kept here rather than inline in createWindow so the restore clamp and the
// BrowserWindow constraint can never drift apart.
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 600

// Resize/move fire continuously while dragging — coalesce them into one write.
const SAVE_DEBOUNCE_MS = 400

// How much of the window must overlap a display's work area for the saved
// position to be reused.  A monitor that was unplugged (or a resolution
// change) can leave the window entirely off-screen with no way to drag it
// back — this window is frameless, so the drag handle goes with it.
const MIN_VISIBLE_PX = 80

interface DisplayLike {
  workArea: Rectangle
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** True when enough of `bounds` lands on some display to remain grabbable. */
function isReachable(bounds: Rectangle, displays: DisplayLike[]): boolean {
  return displays.some(({ workArea: wa }) => {
    const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x)
    const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y)
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX
  })
}

/**
 * Turn whatever is on disk into bounds that are safe to hand to
 * BrowserWindow: sized within the min constraints and the largest available
 * display, and positioned only if that position is still on-screen.
 *
 * Exported (and display-injected) so the restore rules can be tested without
 * a real Electron screen.
 */
export function sanitizeWindowState(
  saved: Partial<WindowState> | null | undefined,
  displays: DisplayLike[],
  fallback: { width: number; height: number }
): WindowState {
  if (!saved || !isFinitePositive(saved.width) || !isFinitePositive(saved.height)) {
    return { ...fallback, isMaximized: saved?.isMaximized === true }
  }

  // Never restore bigger than the roomiest display — a window saved on a 4K
  // monitor must still fit after switching to a laptop screen.
  const maxWidth = Math.max(...displays.map((d) => d.workArea.width), MIN_WINDOW_WIDTH)
  const maxHeight = Math.max(...displays.map((d) => d.workArea.height), MIN_WINDOW_HEIGHT)

  const width = Math.round(Math.max(MIN_WINDOW_WIDTH, Math.min(saved.width, maxWidth)))
  const height = Math.round(Math.max(MIN_WINDOW_HEIGHT, Math.min(saved.height, maxHeight)))
  const state: WindowState = { width, height, isMaximized: saved.isMaximized === true }

  if (isFiniteCoord(saved.x) && isFiniteCoord(saved.y)) {
    const x = Math.round(saved.x)
    const y = Math.round(saved.y)
    if (isReachable({ x, y, width, height }, displays)) {
      state.x = x
      state.y = y
    }
  }

  return state
}

/**
 * Bounds to open the main window with: the last session's geometry when it is
 * still usable, otherwise `fallback` (centred by Electron).
 */
export function loadWindowState(fallback: { width: number; height: number }): WindowState {
  let saved: Partial<WindowState> | null = null
  try {
    saved = getWindowState()
  } catch {
    // Unreadable config — fall back to the default size rather than not opening.
  }
  return sanitizeWindowState(saved, screen.getAllDisplays(), fallback)
}

/**
 * Record the window's geometry as the user changes it, and once more on close
 * so a resize made in the final moments before quitting isn't lost.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null

  const capture = (): void => {
    if (win.isDestroyed()) return
    // Minimized/fullscreen bounds describe a transient state, not something to
    // reopen into — keep whatever was saved before entering it.
    if (win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    // getNormalBounds() is the un-maximized geometry, so restoring a maximized
    // window still knows what size to un-maximize back to.
    const { x, y, width, height } = win.getNormalBounds()
    if (!isFinitePositive(width) || !isFinitePositive(height)) return
    void setWindowState({ x, y, width, height, isMaximized: maximized }).catch(() => {
      // Best-effort — a failed geometry write must never break the window.
    })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      capture()
    }, SAVE_DEBOUNCE_MS)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)

  win.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    capture()
  })
}

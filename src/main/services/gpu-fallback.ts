import { app } from 'electron'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDataDir } from './settings-store'

// ─── GPU fallback ───────────────────────────────────────────
// `app.disableHardwareAcceleration()` turns off GPU *compositing* but
// Chromium still spawns a GPU process for rasterization/info probing.
// On heavily stripped Windows builds (e.g. Ghost Spectre SUPERLITE) that
// process can't launch at all — Chromium retries, then fatally aborts:
//   GPU process launch failed: error_code=18
//   [FATAL] GPU process isn't usable. Goodbye.
// …and the app dies before any window appears.  See issue #203.
//
// Recovery: when we observe a GPU process launch failure, persist a marker
// and relaunch with --disable-gpu so no GPU process is spawned at all.  The
// marker means subsequent launches skip the GPU process up front, so the
// user never has to pass --disable-gpu by hand.

const MARKER_FILENAME = '.disable-gpu'

let attemptedRecovery = false

function markerPath(): string {
  return join(getDataDir(), MARKER_FILENAME)
}

/**
 * Whether the GPU process should be disabled this launch. True when the
 * user passed --disable-gpu, set KUDU_DISABLE_GPU, or a previous launch
 * recorded a GPU launch failure.
 */
export function shouldDisableGpu(): boolean {
  if (process.argv.includes('--disable-gpu')) return true
  if (process.env.KUDU_DISABLE_GPU) return true
  try {
    return existsSync(markerPath())
  } catch {
    return false
  }
}

/**
 * Append the switches that prevent Chromium from spawning a GPU process.
 * Must be called before app.whenReady().
 */
export function applyGpuFallbackSwitches(): void {
  app.commandLine.appendSwitch('disable-gpu')
  // The GPU process sandbox is the part that fails to initialize on
  // stripped Windows; disable it too so a forced software path still works.
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

function persistMarker(): void {
  try {
    const dir = getDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(markerPath(), '')
  } catch {
    // Best effort — recovery still happens this run via relaunch args.
  }
}

/**
 * Listen for GPU process launch failures and recover by relaunching with
 * the GPU disabled. Registering before whenReady() maximizes the chance of
 * catching the failure before Chromium's fatal abort.
 */
export function registerGpuCrashRecovery(): void {
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return
    if (details.reason !== 'launch-failed' && details.reason !== 'crashed' && details.reason !== 'abnormal-exit') return
    // Already running without a GPU process — nothing more we can do, and
    // relaunching would loop. Leave the marker in place.
    if (attemptedRecovery || shouldDisableGpu()) return
    attemptedRecovery = true

    persistMarker()
    app.relaunch({ args: process.argv.slice(1).concat('--disable-gpu') })
    app.exit(0)
  })
}

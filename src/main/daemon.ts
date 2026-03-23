import { app } from 'electron'
import { cloudAgent } from './services/cloud-agent'
import { getSettings, setSettings, flushSettings } from './services/settings-store'
import { setDaemonMode } from './services/logger'
import { initAutoUpdater } from './services/auto-updater'

function log(msg: string): void {
  const ts = new Date().toISOString()
  process.stdout.write(`[${ts}] ${msg}\n`)
}

/**
 * Headless daemon mode — starts the cloud agent, sends telemetry and health
 * reports, and responds to remote commands. No GUI, no tray, no window.
 *
 * Usage:
 *   kudu --daemon [--api-key <key>]
 */
export async function runDaemon(): Promise<void> {
  const args = process.argv

  // Enable stdout mirroring for all cloud agent logs
  setDaemonMode(true)

  // ─── Handle --api-key flag (write to config and continue) ────
  const apiKeyIdx = args.indexOf('--api-key')
  if (apiKeyIdx !== -1) {
    const key = args[apiKeyIdx + 1]
    if (!key || key.startsWith('--')) {
      log('Error: --api-key requires a value')
      app.exit(1)
      return
    }
    if (key.length < 10 || key.length > 200) {
      log('Error: API key must be between 10 and 200 characters')
      app.exit(1)
      return
    }
    const settings = getSettings()
    setSettings({ cloud: { ...settings.cloud, apiKey: key } })
    log('API key saved to config')
  }

  // ─── Flush any pending config writes before reading ───────────
  await flushSettings()

  // ─── Validate that we have an API key ────────────────────────
  const settings = getSettings()
  if (!settings.cloud.apiKey) {
    log('Error: No cloud API key configured.')
    log('Set one with: kudu --daemon --api-key <your-key>')
    log('Or via:       kudu --cli config set cloud.apiKey <your-key>')
    app.exit(1)
    return
  }

  // ─── Start ───────────────────────────────────────────────────
  log(`Kudu daemon v${app.getVersion()} starting`)
  log(`Platform: ${process.platform} (${process.arch})`)
  log(`PID: ${process.pid}`)
  log(`Config: ${app.getPath('userData')}`)

  // ─── Auto-updater (download + auto-restart) ─────────────────
  initAutoUpdater({ daemon: true })

  log('Starting cloud agent...')
  await cloudAgent.start()

  const state = cloudAgent.getStatus()
  if (state.status === 'dormant') {
    log('Error: Cloud agent failed to start (status: dormant)')
    app.exit(1)
    return
  }
  log(`Cloud agent status: ${state.status}`)
  log(`Device ID: ${state.deviceId}`)

  // ─── Graceful shutdown on SIGTERM / SIGINT ───────────────────
  const shutdown = (): void => {
    log('Shutting down...')
    cloudAgent.stop()
    log('Cloud agent stopped. Goodbye.')
    app.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // ─── Heartbeat log every 5 minutes ──────────────────────────
  setInterval(() => {
    const s = cloudAgent.getStatus()
    log(`Heartbeat — status: ${s.status}, last telemetry: ${s.lastTelemetryAt || 'never'}, last command: ${s.lastCommandAt || 'never'}`)
  }, 5 * 60 * 1000)

  log('Daemon running. Press Ctrl+C to stop.')
}

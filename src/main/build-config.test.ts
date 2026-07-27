import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import yaml from 'js-yaml'

// Guards the packaging invariants that only show up once a user runs the
// installer — nothing in the app's own code paths can catch a regression here.
// See https://github.com/AdventDevInc/kudu/issues/264.

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'electron-builder.yml')

interface BuildConfig {
  win?: { requestedExecutionLevel?: string }
  nsis?: {
    oneClick?: boolean
    perMachine?: boolean
  }
}

const config = yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) as BuildConfig

describe('electron-builder.yml', () => {
  it('requests admin for the app executable', () => {
    // Kudu edits HKLM, system directories and other machine-wide state, so the
    // manifest asks for elevation rather than re-launching at runtime.
    expect(config.win?.requestedExecutionLevel).toBe('requireAdministrator')
  })

  it('installs per-machine whenever the app manifest requires admin', () => {
    // requestedExecutionLevel is applied to Kudu.exe only; the NSIS installer
    // has a separate execution level derived from nsis.perMachine. If they
    // disagree, the installer runs unelevated and installs an auto-elevating
    // binary into user-writable %LOCALAPPDATA%\Programs — which both breaks the
    // install and is a local privilege-escalation path, since the auto-launch
    // task runs that exe with RunLevel HighestAvailable.
    if (config.win?.requestedExecutionLevel === 'requireAdministrator') {
      expect(config.nsis?.perMachine).toBe(true)
    }
  })

  it('keeps the one-click installer flow', () => {
    // perMachine + oneClick is what makes electron-builder mark
    // isAdminRightsRequired on the published update metadata, so electron-updater
    // elevates when applying an update.
    expect(config.nsis?.oneClick).toBe(true)
  })
})

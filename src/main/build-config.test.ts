import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// Guards the packaging invariants that only show up once a user runs the
// installer — nothing in the app's own code paths can catch a regression here.
// See https://github.com/AdventDevInc/kudu/issues/264.

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'electron-builder.yml')
const CONFIG = readFileSync(CONFIG_PATH, 'utf-8')

// electron-builder.yml is hand-maintained and flat, so the two lookups below are
// done without pulling in a YAML parser — the repo has no direct one, and adding
// a dependency for a three-assertion test is not worth the lockfile churn.

/** Lines belonging to a top-level `key:` block, up to the next unindented line. */
function block(key: string): string[] {
  const lines = CONFIG.split(/\r?\n/)
  const start = lines.indexOf(`${key}:`)
  if (start === -1) throw new Error(`electron-builder.yml has no top-level "${key}:" block`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.trim() !== '' && !line.startsWith(' '))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Value of a direct `  key: value` child of a top-level block. */
function option(key: string, name: string): string | undefined {
  const line = block(key).find((l) => l.startsWith(`  ${name}:`))
  return line?.slice(line.indexOf(':') + 1).trim()
}

describe('electron-builder.yml', () => {
  it('requests admin for the app executable', () => {
    // Kudu edits HKLM, system directories and other machine-wide state, so the
    // manifest asks for elevation rather than re-launching at runtime.
    expect(option('win', 'requestedExecutionLevel')).toBe('requireAdministrator')
  })

  it('installs per-machine whenever the app manifest requires admin', () => {
    // requestedExecutionLevel is applied to Kudu.exe only; the NSIS installer
    // has a separate execution level derived from nsis.perMachine. If they
    // disagree, the installer runs unelevated and installs an auto-elevating
    // binary into user-writable %LOCALAPPDATA%\Programs — which both breaks the
    // install and is a local privilege-escalation path, since the auto-launch
    // task runs that exe with RunLevel HighestAvailable.
    if (option('win', 'requestedExecutionLevel') === 'requireAdministrator') {
      expect(option('nsis', 'perMachine')).toBe('true')
    }
  })

  it('keeps the one-click installer flow', () => {
    // perMachine + oneClick is what makes electron-builder mark
    // isAdminRightsRequired on the published update metadata, so electron-updater
    // elevates when applying an update.
    expect(option('nsis', 'oneClick')).toBe('true')
  })

  it('publishes a Windows portable artifact alongside NSIS', () => {
    expect(block('win').some((l) => l.includes('target: portable'))).toBe(true)
    expect(option('portable', 'artifactName')).toBe('Kudu-Portable-${version}.${ext}')
  })

  it('publishes a stable AppImage name for in-place Linux auto-update', () => {
    // Versioned AppImage basenames make electron-updater write a new file and
    // delete the old one, breaking desktop Exec= paths (#401).
    expect(option('appImage', 'artifactName')).toBe('Kudu-${arch}.${ext}')
    expect(option('appImage', 'artifactName')).not.toContain('${version}')
  })

  it('keeps versioned Linux deb artifact names', () => {
    expect(option('deb', 'artifactName')).toBe('Kudu-${version}-${arch}.${ext}')
  })

  it('publishes Linux AppImage for x64 and arm64', () => {
    // Release matrix builds each arch on a native runner; both must be listed
    // here so --linux --arm64 actually emits an AppImage (#396).
    const linux = block('linux')
    const appImageStart = linux.findIndex((l) => l.includes('target: AppImage'))
    expect(appImageStart).toBeGreaterThanOrEqual(0)
    const nextTarget = linux.findIndex(
      (l, i) => i > appImageStart && l.trimStart().startsWith('- target:')
    )
    const appImageBlock = linux.slice(
      appImageStart,
      nextTarget === -1 ? undefined : nextTarget
    )
    expect(appImageBlock.some((l) => l.trim() === '- x64')).toBe(true)
    expect(appImageBlock.some((l) => l.trim() === '- arm64')).toBe(true)
  })

  it('documents arm64 Linux release publish mode in the workflow', () => {
    // Guard the Critical invariant: arm64 must not --publish always or it
    // clobbers latest-linux.yml and breaks x64 AppImage auto-update.
    const release = readFileSync(
      path.resolve(__dirname, '..', '..', '.github', 'workflows', 'release.yml'),
      'utf-8'
    )
    expect(release).toMatch(/ubuntu-24\.04-arm[\s\S]*?publish:\s*never/)
    expect(release).toMatch(/gh release upload/)
  })
})

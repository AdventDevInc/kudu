import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { load } from 'js-yaml'
import { Platform } from 'app-builder-lib'
import { Arch } from 'builder-util'
import { configureBuildCommand, createYargs, normalizeOptions } from 'electron-builder/out/builder'
import { computeArchToTargetNamesMap } from 'app-builder-lib/out/targets/targetFactory'

// Guards the packaging invariants that only show up once a user runs the
// installer — nothing in the app's own code paths can catch a regression here.
// See https://github.com/AdventDevInc/kudu/issues/264.

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'electron-builder.yml')
const CONFIG = readFileSync(CONFIG_PATH, 'utf-8')

// These small helpers preserve the existing flat packaging-option checks.

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
  it.each([
    ['ubuntu-latest', Arch.x64],
    ['ubuntu-24.04-arm', Arch.arm64]
  ])('builds only native Linux release targets on %s', (runner, architecture) => {
    const release = load(
      readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
    ) as any
    const job = release.jobs.build.strategy.matrix.include.find((job: any) => job.os === runner)
    const args = configureBuildCommand(createYargs()).parseSync(job['build-args'].split(/\s+/))
    const options = normalizeOptions(args)
    // Exercise electron-builder's actual config fallback: architecture flags
    // alone still expand the two architectures declared in electron-builder.yml.
    const targets = computeArchToTargetNamesMap(
      options.targets!.get(Platform.LINUX)!,
      { platformSpecificBuildOptions: (load(CONFIG) as any).linux } as any,
      Platform.LINUX
    )
    expect([...targets]).toEqual([[architecture, ['AppImage', 'deb']]])
  })

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
    expect(option('portable', 'requestExecutionLevel')).toBe('admin')
    expect((load(CONFIG) as any).afterAllArtifactBuild).toBe('scripts/build-portable-zip.js')
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
    const appImageBlock = linux.slice(appImageStart, nextTarget === -1 ? undefined : nextTarget)
    expect(appImageBlock.some((l) => l.trim() === '- x64')).toBe(true)
    expect(appImageBlock.some((l) => l.trim() === '- arm64')).toBe(true)
  })

  it('stages native ARM64 builds without publishing over x64 update metadata', () => {
    // Both architectures must reach verification separately, with no runner
    // able to publish or overwrite the other's manifest during packaging.
    const release = load(
      readFileSync(
        path.resolve(__dirname, '..', '..', '.github', 'workflows', 'release.yml'),
        'utf-8'
      )
    ) as any
    expect(release.jobs.build.strategy.matrix.include).toContainEqual({
      os: 'ubuntu-24.04-arm',
      'build-args': '--linux AppImage deb --arm64'
    })
    const buildSteps = release.jobs.build.steps as { run?: string }[]
    const packaging = buildSteps.map((step) => step.run || '').join('\n')
    expect(packaging).toContain('--publish never')
    expect(packaging).not.toContain('--publish always')
    expect(packaging).not.toContain('gh release upload')
    const download = release.jobs['publish-release'].steps.find((step: any) =>
      step.uses?.startsWith('actions/download-artifact@')
    )
    expect(download.with['merge-multiple']).toBe(false)
  })
})

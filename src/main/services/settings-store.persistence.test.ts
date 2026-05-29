import { describe, it, expect, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

const TEST_DIR = join(tmpdir(), `kudu-test-${randomUUID()}`)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => TEST_DIR,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { setSettings, getSettings, flushSettings, updateRegistryIgnoredTweaks, getMalwareAllowlist, addMalwareAllowlistEntry, removeMalwareAllowlistEntry } from './settings-store'
import type { MalwareAllowlistEntry } from '../../shared/types'

describe('settings persistence — game mode toggle round-trip (issue #172)', () => {
  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('keeps a game mode optimization disabled across a simulated restart', async () => {
    const initial = getSettings()
    expect(initial.gameMode.enabledOptimizations).toContain('svc-sysmain')

    const without = initial.gameMode.enabledOptimizations.filter((o) => o !== 'svc-sysmain')
    setSettings({
      gameMode: {
        ...initial.gameMode,
        enabledOptimizations: without,
      },
    })
    await flushSettings()

    const afterRestart = getSettings()
    expect(afterRestart.gameMode.enabledOptimizations).not.toContain('svc-sysmain')
    expect(afterRestart.gameMode.enabledOptimizations).toEqual(without)
  })

  it('keeps an empty enabledOptimizations array empty across a simulated restart', async () => {
    setSettings({
      gameMode: {
        enabledOptimizations: [],
        customProcessKillList: [],
        autoDetect: false,
        autoDeactivate: true,
        customGameProcesses: [],
      },
    })
    await flushSettings()

    const afterRestart = getSettings()
    expect(afterRestart.gameMode.enabledOptimizations).toEqual([])
  })

  it('defaults registryIgnoredTweaks to an empty array', () => {
    expect(getSettings().registryIgnoredTweaks).toEqual([])
  })

  it('remembers an ignored registry tweak across a simulated restart (issue #172)', async () => {
    const sig = 'hklm\\system\\currentcontrolset\\services\\sysmain|start'
    updateRegistryIgnoredTweaks([sig], true)
    await flushSettings()
    expect(getSettings().registryIgnoredTweaks).toEqual([sig])

    // Un-ignoring (re-selecting) clears it again.
    updateRegistryIgnoredTweaks([sig], false)
    await flushSettings()
    expect(getSettings().registryIgnoredTweaks).toEqual([])
  })

  it('merges ignore deltas atomically without dropping earlier signatures', async () => {
    const a = 'hklm\\a|start'
    const b = 'hklm\\b|start'
    // Two independent toggles (e.g. fired back-to-back) must both survive —
    // the second must not overwrite the first with a stale base (issue #172).
    updateRegistryIgnoredTweaks([a], true)
    updateRegistryIgnoredTweaks([b], true)
    await flushSettings()
    expect(getSettings().registryIgnoredTweaks.sort()).toEqual([a, b])

    // Removing one leaves the other intact.
    updateRegistryIgnoredTweaks([a], false)
    await flushSettings()
    expect(getSettings().registryIgnoredTweaks).toEqual([b])
  })
})

describe('malware allowlist (false positives)', () => {
  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  const entry = (sha256: string, over: Partial<MalwareAllowlistEntry> = {}): MalwareAllowlistEntry => ({
    sha256,
    path: `C:/Games/${sha256}.exe`,
    fileName: `${sha256}.exe`,
    detectionName: 'Heuristic.Suspicious.PE',
    addedAt: 1,
    ...over,
  })

  it('defaults the allowlist to an empty array', () => {
    expect(getMalwareAllowlist()).toEqual([])
  })

  it('adds an entry that survives a simulated restart', async () => {
    addMalwareAllowlistEntry(entry('aaa'))
    await flushSettings()
    const list = getMalwareAllowlist()
    expect(list).toHaveLength(1)
    expect(list[0].sha256).toBe('aaa')
  })

  it('de-dupes by content hash, refreshing the existing entry', async () => {
    addMalwareAllowlistEntry(entry('aaa', { path: 'C:/Moved/Gw.exe', fileName: 'Gw.exe' }))
    await flushSettings()
    const list = getMalwareAllowlist()
    expect(list.filter((e) => e.sha256 === 'aaa')).toHaveLength(1)
    expect(list.find((e) => e.sha256 === 'aaa')?.fileName).toBe('Gw.exe')
  })

  it('removes an entry by hash', async () => {
    addMalwareAllowlistEntry(entry('bbb'))
    await flushSettings()
    expect(getMalwareAllowlist().some((e) => e.sha256 === 'bbb')).toBe(true)

    removeMalwareAllowlistEntry('bbb')
    await flushSettings()
    expect(getMalwareAllowlist().some((e) => e.sha256 === 'bbb')).toBe(false)
  })

  it('merges concurrent adds without dropping earlier entries', async () => {
    addMalwareAllowlistEntry(entry('c1'))
    addMalwareAllowlistEntry(entry('c2'))
    await flushSettings()
    const hashes = getMalwareAllowlist().map((e) => e.sha256)
    expect(hashes).toContain('c1')
    expect(hashes).toContain('c2')
  })
})

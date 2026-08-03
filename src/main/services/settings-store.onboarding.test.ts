import { describe, it, expect, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
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

import {
  setSettings,
  flushSettings,
  getSettings,
  getOnboardingComplete,
  setOnboardingComplete,
  getMachineId,
} from './settings-store'

const DATA_DIR = join(TEST_DIR, 'Kudu-Dev')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const onDisk = (): any => JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))

describe('onboarding completion persistence (issue #269)', () => {
  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('writes the flag through to disk, not just to the in-memory copy', async () => {
    expect(getOnboardingComplete()).toBe(false)
    await setOnboardingComplete(true)
    expect(onDisk().onboardingComplete).toBe(true)
    expect(getOnboardingComplete()).toBe(true)
  })

  it('keeps the flag through the wizard write order and the settings writes after it', async () => {
    await setOnboardingComplete(false)

    // Step 1 of the wizard persists the language on its own…
    setSettings({ language: 'ar' })
    await flushSettings()
    // …the final step records completion, and the preference writes it kicks
    // off land afterwards. None of them may take the flag back down.
    await setOnboardingComplete(true)
    setSettings({
      runAtStartup: true,
      minimizeToTray: true,
      schedule: { enabled: true, frequency: 'weekly', day: 1, hour: 9 },
    })
    await flushSettings()

    const after = onDisk()
    expect(after.onboardingComplete).toBe(true)
    expect(after.settings.language).toBe('ar')
    expect(after.settings.runAtStartup).toBe(true)
  })

  it('generates and persists a machine id on first use', async () => {
    const id = getMachineId()
    await flushSettings()
    expect(id).not.toBe('')
    expect(onDisk().machineId).toBe(id)
    // Stable across calls — a second read must not mint a new one.
    expect(getMachineId()).toBe(id)
  })

  it('reports a failed write instead of resolving as if it saved', async () => {
    // Stand a directory where config.json belongs: the rename onto it fails,
    // which is the shape of the EPERM an antivirus scanner produces.
    rmSync(CONFIG_PATH)
    mkdirSync(CONFIG_PATH)
    try {
      await expect(setOnboardingComplete(true)).rejects.toBeDefined()
    } finally {
      rmSync(CONFIG_PATH, { recursive: true, force: true })
    }

    // A failed write must not wedge the queue for every write after it.
    setSettings({ theme: 'light' })
    await flushSettings()
    expect(getSettings().theme).toBe('light')

    // …and must not leave temp files behind.
    expect(readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

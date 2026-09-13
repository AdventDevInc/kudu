import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const state = vi.hoisted(() => ({ directory: '', available: true, encryptions: 0 }))
vi.mock('electron', () => {
  // Authenticated encryption models safeStorage's tamper rejection without accessing a keychain.
  const key = randomBytes(32)
  return {
    app: { isPackaged: true, getPath: () => state.directory },
    safeStorage: {
      isEncryptionAvailable: () => state.available,
      encryptString: (text: string) => {
        state.encryptions++
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), body])
      },
      decryptString: (buffer: Buffer) => {
        const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12))
        cipher.setAuthTag(buffer.subarray(12, 28))
        return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8')
      }
    }
  }
})

import {
  recordRecoveryChange,
  listRecoveryEntries,
  listRecoveryPage,
  getRecoveryEntry,
  updateRecoveryEntry,
  removeRestoredRecoveryEntry
} from './recovery-store'

const target = { kind: 'registry-dword' as const, key: 'HKCU\\Software\\KuduTest', name: 'Enabled' }
const record = (apply: () => Promise<void> = async () => {}) =>
  recordRecoveryChange('privacy', 'Test setting', target, null, 1, apply)
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'kudu-recovery-test-'))
  state.available = true
  state.encryptions = 0
})
afterEach(async () => {
  // Only the temporary directory allocated above is removed.
  await rm(state.directory, { recursive: true, force: true })
})

describe('durable recovery journal', () => {
  it('persists the original absent value before applying and seals sensitive metadata', async () => {
    await record(async () => {
      expect(await listRecoveryEntries()).toEqual([
        expect.objectContaining({ before: null, after: 1, status: 'pending' })
      ])
    })
    expect(await listRecoveryEntries()).toEqual([expect.objectContaining({ status: 'ready' })])
    expect(await readFile(join(state.directory, 'recovery/changes.json'), 'utf8')).not.toContain(
      'KuduTest'
    )
  })

  it('does not mutate when original state cannot be stored securely', async () => {
    state.available = false
    const apply = vi.fn()
    await expect(record(apply)).rejects.toThrow('Secure recovery storage')
    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps evidence of a failed or interrupted operation', async () => {
    await expect(
      record(async () => {
        throw new Error('Access denied')
      })
    ).rejects.toThrow('Access denied')
    expect(await listRecoveryEntries()).toEqual([
      expect.objectContaining({ status: 'failed', before: null, after: 1 })
    ])
  })

  it('serializes concurrent writes without re-encrypting unrelated history', async () => {
    await Promise.all(Array.from({ length: 52 }, () => record()))
    expect((await listRecoveryPage(0)).entries).toHaveLength(50)
    expect((await listRecoveryPage(50)).entries).toHaveLength(2)
    expect((await listRecoveryPage(50)).total).toBe(52)
    expect(state.encryptions).toBe(104)
  })

  it('allows removing only a restored record', async () => {
    await record()
    const [entry] = await listRecoveryEntries()
    await expect(removeRestoredRecoveryEntry(entry.id)).rejects.toThrow('Only restored')
    await updateRecoveryEntry({ ...entry, status: 'restored' })
    await removeRestoredRecoveryEntry(entry.id)
    expect(await getRecoveryEntry(entry.id)).toBeUndefined()
  })

  it('rejects tampered records instead of trusting their restore targets', async () => {
    await record()
    const path = join(state.directory, 'recovery/changes.json')
    const entries = JSON.parse(await readFile(path, 'utf8'))
    const buffer = Buffer.from(entries[0].body, 'base64')
    buffer[buffer.length - 1] ^= 1
    entries[0].body = buffer.toString('base64')
    await writeFile(path, JSON.stringify(entries))
    await expect(listRecoveryEntries()).rejects.toThrow()
  })

  it('preserves a corrupt index and prevents mutation', async () => {
    await record()
    const path = join(state.directory, 'recovery/changes.json')
    await writeFile(path, '{broken')
    const apply = vi.fn()
    await expect(record(apply)).rejects.toThrow()
    expect(apply).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })
})

import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

// ─── Prior-state store for macOS Privacy Shield ─────────────
// Before a setting is applied, the state it is about to change is captured
// here so revert can put back exactly what the user had — after an app
// restart too. The values mirror files that are already readable on disk
// (preference plists, /etc/sysctl.conf, /etc/ssh/sshd_config), so like
// service-start-types.json on Windows this is plain JSON, owner-only.
//
// Shape: { version: 1, settings: { [settingId]: { [partId]: priorState } } }.
// Individual prior states are validated by their owner before use.

export type PriorState = Record<string, unknown>

interface StoreFile {
  version: 1
  settings: Record<string, PriorState>
}

function storePath(): string {
  const dir = app.isPackaged ? app.getPath('userData') : join(app.getPath('userData'), 'Kudu-Dev')
  return join(dir, 'privacy-prior-state.json')
}

async function readStore(): Promise<StoreFile> {
  let raw: string
  try {
    raw = await readFile(storePath(), 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { version: 1, settings: {} }
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed?.version === 1 &&
      parsed.settings &&
      typeof parsed.settings === 'object' &&
      !Array.isArray(parsed.settings) &&
      Object.values(parsed.settings).every((s) => !!s && typeof s === 'object' && !Array.isArray(s))
    )
      return parsed
  } catch {
    /* fall through */
  }
  // Unusable data can't drive a restore either way; start over rather than
  // blocking every future apply on a file the user can't easily fix.
  console.warn('[privacy] prior-state store is unreadable; starting fresh')
  return { version: 1, settings: {} }
}

let writes: Promise<unknown> = Promise.resolve()

function update(mutate: (store: StoreFile) => boolean): Promise<void> {
  const pending = writes.then(async () => {
    const store = await readStore()
    if (!mutate(store)) return
    const file = storePath()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(store, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(file + '.tmp', file)
  })
  writes = pending.catch(() => {})
  return pending
}

export async function loadPriorState(settingId: string): Promise<PriorState | undefined> {
  await writes
  return (await readStore()).settings[settingId]
}

export function savePriorState(settingId: string, state: PriorState): Promise<void> {
  return update((store) => {
    store.settings[settingId] = state
    return true
  })
}

export function clearPriorState(settingId: string): Promise<void> {
  return update((store) => {
    if (!(settingId in store.settings)) return false
    delete store.settings[settingId]
    return true
  })
}

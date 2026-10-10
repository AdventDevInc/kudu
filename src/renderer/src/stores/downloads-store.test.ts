import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDownloadsStore } from './downloads-store'
import type { DownloadsScanResult } from '@shared/downloads-review'

const result: DownloadsScanResult = {
  scanId: 'scan',
  directory: '/Downloads',
  skipped: 0,
  limited: false,
  files: ['a', 'b'].map((id) => ({ id, name: `${id}.zip`, size: 10, modified: 0, kind: 'archive' }))
}
describe('downloads review selection and outcomes', () => {
  const scan = vi.fn(),
    trash = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('window', { kudu: { downloadsScan: scan, downloadsTrash: trash } })
    scan.mockReset().mockResolvedValue(structuredClone(result))
    trash.mockReset()
    useDownloadsStore.setState({
      result: null,
      busy: false,
      phase: 'idle',
      selected: new Set(),
      outcome: null,
      error: null
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('starts each scan with no personal files selected and never trashes an empty selection', async () => {
    await useDownloadsStore.getState().scan()
    expect(useDownloadsStore.getState().selected.size).toBe(0)
    await useDownloadsStore.getState().trash()
    expect(trash).not.toHaveBeenCalled()
    useDownloadsStore.getState().select(['a', 'b'])
    await useDownloadsStore.getState().scan()
    expect(useDownloadsStore.getState().selected.size).toBe(0)
  })
  it('sends only explicitly selected IDs and removes only successful outcomes', async () => {
    await useDownloadsStore.getState().scan()
    useDownloadsStore.getState().select(['a', 'b'])
    trash.mockResolvedValue({ trashedIds: ['a'], skippedIds: ['b'] })
    await useDownloadsStore.getState().trash()
    expect(trash).toHaveBeenCalledExactlyOnceWith('scan', ['a', 'b'])
    expect(useDownloadsStore.getState().result?.files.map((file) => file.id)).toEqual(['b'])
    expect(useDownloadsStore.getState().selected.size).toBe(0)
    expect(useDownloadsStore.getState().outcome?.skippedIds).toEqual(['b'])
  })
  it('preserves the review on trash failure and reports a truthful phase while awaiting IPC', async () => {
    await useDownloadsStore.getState().scan()
    useDownloadsStore.getState().toggle('a')
    let reject!: (error: Error) => void
    trash.mockImplementation(
      () =>
        new Promise((_resolve, failure) => {
          reject = failure
        })
    )
    const pending = useDownloadsStore.getState().trash()
    expect(useDownloadsStore.getState().phase).toBe('moving')
    await useDownloadsStore.getState().scan()
    expect(scan).toHaveBeenCalledOnce()
    reject(new Error('Permission denied'))
    await pending
    expect(useDownloadsStore.getState().result?.files).toHaveLength(2)
    expect(useDownloadsStore.getState().selected.has('a')).toBe(true)
    expect(useDownloadsStore.getState().phase).toBe('idle')
    expect(useDownloadsStore.getState().error).toBe('Permission denied')
  })
})

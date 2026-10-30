import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDiskStore } from './disk-store'
import { useDiskMaintenanceStore } from './disk-maintenance-store'
import type { DiskNode, DriveInfo, TrimRunResult } from '@shared/types'

const tree: DiskNode = { name: 'C:', path: 'C:', size: 10, children: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('disk request lifecycle', () => {
  beforeEach(() => {
    useDiskStore.setState({ drives: [], drivesLoading: false, selectedDrive: 'C' })
    useDiskStore.getState().reset()
    useDiskMaintenanceStore.getState().reset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows enumeration until settled, deduplicates requests and selects an available drive', async () => {
    const request = deferred<DriveInfo[]>()
    const diskDrives = vi.fn(() => request.promise)
    vi.stubGlobal('window', { kudu: { diskDrives } })
    const pending = useDiskStore.getState().loadDrives()
    expect(useDiskStore.getState().drivesLoading).toBe(true)
    await useDiskStore.getState().loadDrives()
    expect(diskDrives).toHaveBeenCalledTimes(1)
    request.resolve([{ letter: '/', isSystem: true } as DriveInfo])
    await pending
    expect(useDiskStore.getState()).toMatchObject({ drivesLoading: false, selectedDrive: '/' })
  })

  it('exits enumeration on rejection and allows retry', async () => {
    const diskDrives = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
    vi.stubGlobal('window', { kudu: { diskDrives } })
    await expect(useDiskStore.getState().loadDrives()).rejects.toThrow('offline')
    expect(useDiskStore.getState().drivesLoading).toBe(false)
    await useDiskStore.getState().loadDrives()
    expect(diskDrives).toHaveBeenCalledTimes(2)
  })

  it('clears stale analysis, locks the target and blocks overlapping scans until completion', async () => {
    const request = deferred<DiskNode>()
    const diskAnalyze = vi.fn(() => request.promise)
    const diskFileTypes = vi.fn()
    vi.stubGlobal('window', { kudu: { diskAnalyze, diskFileTypes } })
    useDiskStore.setState({
      data: tree,
      breadcrumb: [tree],
      fileTypes: [{ extension: '.old' }] as never
    })
    const pending = useDiskStore.getState().analyze()
    expect(useDiskStore.getState()).toMatchObject({
      analyzing: true,
      data: null,
      breadcrumb: [],
      fileTypes: []
    })
    useDiskStore.getState().setSelectedDrive('D')
    await useDiskStore.getState().analyze()
    await useDiskStore.getState().scanFileTypes()
    expect(useDiskStore.getState().selectedDrive).toBe('C')
    expect(diskAnalyze).toHaveBeenCalledTimes(1)
    expect(diskFileTypes).not.toHaveBeenCalled()
    request.resolve(tree)
    await pending
    expect(useDiskStore.getState()).toMatchObject({
      analyzing: false,
      data: tree,
      breadcrumb: [tree]
    })
    useDiskStore.getState().setSelectedDrive('D')
    expect(useDiskStore.getState()).toMatchObject({ data: null, breadcrumb: [], fileTypes: [] })
  })

  it.each(['analyze', 'scanFileTypes'] as const)(
    '%s exits on rejection and can run again',
    async (action) => {
      const request = vi
        .fn()
        .mockRejectedValueOnce(new Error('cancelled'))
        .mockResolvedValue(action === 'analyze' ? tree : [])
      vi.stubGlobal('window', { kudu: { diskAnalyze: request, diskFileTypes: request } })
      await expect(useDiskStore.getState()[action]()).rejects.toThrow('cancelled')
      expect(useDiskStore.getState()).toMatchObject({
        analyzing: false,
        fileTypesLoading: false,
        data: null,
        fileTypes: []
      })
      await useDiskStore.getState()[action]()
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('removes prior TRIM output on retry and ignores late progress after settlement', () => {
    const store = useDiskMaintenanceStore.getState()
    store.setResult('C', { success: true, summary: 'Old success' } as TrimRunResult)
    store.setBatchRunning(true)
    store.setRunState('C', 'running')
    store.setProgress({ driveId: 'C', phase: 'running', percent: -1, message: 'Working' })
    expect(useDiskMaintenanceStore.getState().results.C).toBeUndefined()
    expect(useDiskMaintenanceStore.getState().progress.C.message).toBe('Working')
    store.setRunState('C', 'failed')
    store.setBatchRunning(false)
    store.clearProgress()
    store.setProgress({ driveId: 'C', phase: 'done', percent: 100, message: 'Late' })
    expect(useDiskMaintenanceStore.getState().progress).toEqual({})
  })
})

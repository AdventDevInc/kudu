import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  state: { setStatus: vi.fn(), setResults: vi.fn(), addResults: vi.fn(), setProgress: vi.fn() }
}))
vi.mock('@/stores/scan-store', () => ({ useScanStore: { getState: () => mocks.state } }))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { cleaner: { createRestorePoint: false, protectRecycleBin: true } }
    })
  },
  refreshSettings: vi.fn()
}))
vi.mock('@/stores/history-store', () => ({
  useHistoryStore: { getState: () => ({ addEntry: mocks.history }) }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }
}))
import { runSchedule } from './useScheduledScan'
const payload = {
  scheduleId: 'one',
  runId: 'run-token',
  scheduleName: 'Test',
  tasks: ['cleaner:system'],
  autoApply: true
}
const result = (subcategory: string, id: string) => ({
  category: 'System',
  subcategory,
  itemCount: 1,
  totalSize: 10,
  items: [{ id, size: 10 }]
})
const api = {
  scheduleAuthorize: vi.fn(),
  scheduleRunComplete: vi.fn(),
  notifyScheduledScanComplete: vi.fn(),
  systemScan: vi.fn(),
  systemClean: vi.fn(),
  registryScan: vi.fn(),
  registryFix: vi.fn(),
  recycleBinScan: vi.fn()
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { kudu: api })
  api.scheduleAuthorize.mockReset().mockResolvedValue({ allowed: true, reason: null })
  api.systemScan.mockResolvedValue([result('Cache', 'one'), result('Logs', 'two')])
  api.systemClean.mockResolvedValue({ filesDeleted: 1, totalCleaned: 10, errors: [] })
  api.registryScan.mockResolvedValue([{ id: 'registry-id' }])
  api.registryFix.mockResolvedValue({ fixed: 1, failed: 0 })
})
afterEach(() => vi.unstubAllGlobals())
it('runs tasks in the saved order and restricts cleanup to fresh matching categories', async () => {
  await runSchedule({
    ...payload,
    tasks: ['registry', 'cleaner:system'],
    cleanerSubcategories: { 'cleaner:system': ['Logs'] }
  })
  expect(api.registryFix).toHaveBeenCalledBefore(api.systemScan)
  expect(api.systemClean).toHaveBeenCalledWith(['two'])
  expect(api.scheduleRunComplete).toHaveBeenCalledWith('one', 'success', 'run-token')
})
it('defers a queued run if eligibility changes before execution', async () => {
  api.scheduleAuthorize.mockResolvedValue({ allowed: false, reason: 'power' })
  await runSchedule(payload)
  expect(api.systemScan).not.toHaveBeenCalled()
  expect(api.scheduleRunComplete).toHaveBeenCalledWith('one', 'deferred', 'run-token')
})
it('rechecks immediately before mutation and records partial work without cleaning', async () => {
  api.scheduleAuthorize
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValue({ allowed: false, reason: 'game-mode' })
  await runSchedule(payload)
  expect(api.systemScan).toHaveBeenCalledTimes(1)
  expect(api.systemClean).not.toHaveBeenCalled()
  expect(api.scheduleRunComplete).toHaveBeenCalledWith('one', 'partial', 'run-token')
  expect(mocks.history).toHaveBeenCalledWith(
    expect.objectContaining({ totalItemsFound: 2, totalItemsCleaned: 0, errorCount: 1 })
  )
})
it('honors empty scope and the existing Recycle Bin protection', async () => {
  await runSchedule({
    ...payload,
    tasks: ['cleaner:system', 'cleaner:recycleBin'],
    cleanerSubcategories: { 'cleaner:system': [] }
  })
  expect(api.systemClean).not.toHaveBeenCalled()
  expect(api.recycleBinScan).not.toHaveBeenCalled()
})
it('reports returned cleanup failures as partial instead of success', async () => {
  api.systemClean.mockResolvedValue({ filesDeleted: 0, totalCleaned: 0, errors: ['locked'] })
  await runSchedule(payload)
  expect(api.scheduleRunComplete).toHaveBeenCalledWith('one', 'partial', 'run-token')
})
it('files history under the task that actually ran when a workflow stops early', async () => {
  api.scheduleAuthorize
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValue({ allowed: false, reason: 'power' })
  await runSchedule({ ...payload, tasks: ['registry', 'cleaner:system'] })
  expect(api.registryFix).toHaveBeenCalledTimes(1)
  expect(api.systemScan).not.toHaveBeenCalled()
  expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ type: 'registry' }))
  expect(api.scheduleRunComplete).toHaveBeenCalledWith('one', 'partial', 'run-token')
})

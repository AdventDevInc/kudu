import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useScanStore } from '@/stores/scan-store'
import { useHistoryStore } from '@/stores/history-store'
import { useSettingsStore, refreshSettings } from '@/stores/settings-store'
import { ScanStatus } from '@shared/enums'
import type { ScanResult, ScheduleEntry } from '@shared/types'
import { formatBytes, formatNumber } from '@/lib/utils'

class ScheduleConditionChanged extends Error {}
interface ScheduleRunPayload {
  runId: string
  cleanerSubcategories?: ScheduleEntry['cleanerSubcategories']
  scheduleId: string
  scheduleName: string
  tasks: string[]
  autoApply: boolean
}

// Map task types to scan/clean functions
const CLEANER_TASKS: Record<
  string,
  {
    label: string
    scan: () => Promise<ScanResult[]>
    clean: (ids: string[]) => Promise<any>
  }
> = {
  'cleaner:system': {
    label: 'System',
    scan: () => window.kudu.systemScan(),
    clean: (ids) => window.kudu.systemClean(ids)
  },
  'cleaner:browsers': {
    label: 'Browsers',
    scan: () => window.kudu.browserScan(),
    clean: (ids) => window.kudu.browserClean(ids)
  },
  'cleaner:apps': {
    label: 'Applications',
    scan: () => window.kudu.appScan(),
    clean: (ids) => window.kudu.appClean(ids)
  },
  'cleaner:gaming': {
    label: 'Gaming',
    scan: () => window.kudu.gamingScan(),
    clean: (ids) => window.kudu.gamingClean(ids)
  },
  'cleaner:recycleBin': {
    label: 'Recycle Bin',
    scan: () => window.kudu.recycleBinScan(),
    clean: () => window.kudu.recycleBinClean()
  },
  'cleaner:databases': {
    label: 'Databases',
    scan: () => window.kudu.databaseScan(),
    clean: (ids) => window.kudu.databaseClean(ids)
  }
}

/**
 * Execute a single schedule's tasks.
 */
export async function runSchedule(payload: ScheduleRunPayload): Promise<void> {
  const store = useScanStore.getState()
  const startTime = Date.now()

  let started = false
  const assertAllowed = async () => {
    const result = await window.kudu.scheduleAuthorize(payload.scheduleId, payload.runId)
    if (!result.allowed) throw new ScheduleConditionChanged(result.reason ?? 'unavailable')
  }
  let status: 'success' | 'partial' | 'failed' | 'skipped' = 'success'
  let totalSize = 0
  let totalItems = 0
  let totalCleaned = 0
  let totalSpaceSaved = 0
  const categoryResults: Record<string, { found: number; cleaned: number; size: number }> = {}

  const recordHistory = async () => {
    // Pick the most representative history type based on tasks that actually ran
    const hasCleanerTasks = payload.tasks.some((t) => t.startsWith('cleaner:'))
    const historyType = hasCleanerTasks
      ? 'cleaner'
      : payload.tasks.includes('registry')
        ? 'registry'
        : payload.tasks.includes('drivers')
          ? 'drivers'
          : payload.tasks.includes('software-update')
            ? 'software-update'
            : 'cleaner'

    // Log to history
    await useHistoryStore.getState().addEntry({
      id: Date.now().toString(),
      type: historyType,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      // Window for looking up the deleted paths in the deletion log
      cleanedFrom: new Date(startTime).toISOString(),
      cleanedTo: new Date().toISOString(),
      totalItemsFound: totalItems,
      totalItemsCleaned: totalCleaned,
      totalItemsSkipped: totalItems - totalCleaned,
      totalSpaceSaved,
      categories: Object.entries(categoryResults).map(([name, d]) => ({
        name,
        itemsFound: d.found,
        itemsCleaned: d.cleaned,
        spaceSaved: d.size
      })),
      errorCount: status === 'success' ? 0 : 1,
      scheduled: true,
      scheduleName: payload.scheduleName
    })
  }
  try {
    await assertAllowed()
    toast.info(`Running "${payload.scheduleName}"`, { description: 'Scheduled task started...' })
    store.setStatus(ScanStatus.Scanning)
    store.setResults([])
    // ── Restore point before auto-apply cleaning ──
    const cleanerTasks = payload.tasks.filter((t) => t.startsWith('cleaner:'))
    if (payload.autoApply && cleanerTasks.length > 0) {
      const { createRestorePoint } = useSettingsStore.getState().settings.cleaner
      if (createRestorePoint) {
        try {
          await window.kudu.createRestorePoint(`Kudu scheduled clean — ${payload.scheduleName}`)
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          // Best-effort — don't block the clean
        }
      }
    }

    // ── Cleaner tasks ──
    const { protectRecycleBin } = useSettingsStore.getState().settings.cleaner
    // Each selected task runs in the user's chosen order.
    for (const taskType of payload.tasks) {
      await assertAllowed()
      if (taskType.startsWith('cleaner:')) {
        if (taskType === 'cleaner:recycleBin' && protectRecycleBin) continue
        const task = CLEANER_TASKS[taskType]
        if (!task) continue
        try {
          const scanned = await task.scan()
          started = true
          const scope =
            payload.cleanerSubcategories?.[
              taskType as keyof NonNullable<ScheduleEntry['cleanerSubcategories']>
            ]
          const results = scope ? scanned.filter((r) => scope.includes(r.subcategory)) : scanned
          store.addResults(results)
          const found = results.reduce((s, r) => s + r.itemCount, 0)
          const size = results.reduce((s, r) => s + r.totalSize, 0)
          totalSize += size
          totalItems += found

          if (payload.autoApply && found > 0) {
            const allIds = results.flatMap((r) => r.items.map((i) => i.id))
            try {
              await assertAllowed()
              const cleanResult = await task.clean(allIds)
              if (cleanResult?.errors?.length) status = 'partial'
              const cleaned = cleanResult?.filesDeleted ?? 0
              const saved = cleanResult?.totalCleaned ?? 0
              totalCleaned += cleaned
              totalSpaceSaved += saved
              categoryResults[task.label] = { found, cleaned, size: saved }
            } catch (error) {
              if (error instanceof ScheduleConditionChanged) throw error
              status = 'partial'
              categoryResults[task.label] = { found, cleaned: 0, size: 0 }
            }
          } else if (found > 0) {
            categoryResults[task.label] = { found, cleaned: 0, size }
          }
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          status = 'partial'
        }
      }

      // ── Registry fixes ──
      if (taskType === 'registry') {
        try {
          started = true
          const entries = await window.kudu.registryScan()
          const found = entries.length
          totalItems += found
          if (payload.autoApply && found > 0) {
            const ids = entries.map((e) => e.id)
            try {
              await assertAllowed()
              const result = await window.kudu.registryFix(ids)
              if (result.failed > 0) status = 'partial'
              totalCleaned += result.fixed
              categoryResults['Registry'] = { found, cleaned: result.fixed, size: 0 }
            } catch (error) {
              if (error instanceof ScheduleConditionChanged) throw error
              status = 'partial'
              categoryResults['Registry'] = { found, cleaned: 0, size: 0 }
            }
          } else if (found > 0) {
            categoryResults['Registry'] = { found, cleaned: 0, size: 0 }
          }
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          status = 'partial'
        }
      }

      // ── Driver updates ──
      if (taskType === 'drivers') {
        try {
          started = true
          const result = await window.kudu.driverUpdateScan()
          const found = result.updates.length
          totalItems += found
          if (payload.autoApply && found > 0) {
            const ids = result.updates.map((u) => u.updateId)
            try {
              await assertAllowed()
              const installResult = await window.kudu.driverUpdateInstall(ids)
              if (installResult.failed > 0) status = 'partial'
              totalCleaned += installResult.installed
              categoryResults['Drivers'] = { found, cleaned: installResult.installed, size: 0 }
            } catch (error) {
              if (error instanceof ScheduleConditionChanged) throw error
              status = 'partial'
              categoryResults['Drivers'] = { found, cleaned: 0, size: 0 }
            }
          } else if (found > 0) {
            categoryResults['Drivers'] = { found, cleaned: 0, size: 0 }
          }
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          status = 'partial'
        }
      }

      // ── Software updates ──
      if (taskType === 'software-update') {
        try {
          started = true
          const result = await window.kudu.softwareUpdateCheck()
          const found = result.apps.length
          totalItems += found
          if (payload.autoApply && found > 0) {
            const items = result.apps.map((a) => ({ id: a.id, source: a.source }))
            try {
              await assertAllowed()
              const updateResult = await window.kudu.softwareUpdateRun(items)
              if (updateResult.failed > 0) status = 'partial'
              totalCleaned += updateResult.succeeded
              categoryResults['Software'] = { found, cleaned: updateResult.succeeded, size: 0 }
            } catch (error) {
              if (error instanceof ScheduleConditionChanged) throw error
              status = 'partial'
              categoryResults['Software'] = { found, cleaned: 0, size: 0 }
            }
          } else if (found > 0) {
            categoryResults['Software'] = { found, cleaned: 0, size: 0 }
          }
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          status = 'partial'
        }
      }
      if (taskType === 'cve-scan') {
        try {
          started = true
          const result = await window.kudu.cveFetch()
          totalItems += result.total
          categoryResults['Vulnerabilities'] = { found: result.total, cleaned: 0, size: 0 }
        } catch {
          status = 'partial'
        }
      }
    }
    store.setStatus(ScanStatus.Complete)
    store.setProgress(null)

    await recordHistory()

    // Notify main process and refresh renderer state so the UI shows updated status
    window.kudu.notifyScheduledScanComplete?.(totalSize, totalItems)
    await window.kudu.scheduleRunComplete?.(payload.scheduleId, status, payload.runId)
    refreshSettings()

    const desc = payload.autoApply
      ? `Cleaned ${formatNumber(totalCleaned)} items (${formatBytes(totalSpaceSaved)}).`
      : `Found ${formatNumber(totalItems)} items (${formatBytes(totalSize)}) that can be cleaned.`
    if (status === 'success')
      toast.success(`"${payload.scheduleName}" complete`, { description: desc })
    else toast.warning(`"${payload.scheduleName}" completed with issues`, { description: desc })
  } catch (error) {
    if (error instanceof ScheduleConditionChanged) {
      store.setStatus(ScanStatus.Complete)
      store.setProgress(null)
      status = started ? 'partial' : 'skipped'
      if (started) await recordHistory()
      await window.kudu.scheduleRunComplete?.(
        payload.scheduleId,
        started ? 'partial' : 'deferred',
        payload.runId
      )
      refreshSettings()
      toast.warning(`"${payload.scheduleName}" stopped`, {
        description:
          'Conditions changed (' + error.message + '). Completed actions were not repeated.'
      })
      return
    }
    store.setStatus(ScanStatus.Error)
    store.setProgress(null)
    status = 'failed'
    window.kudu.scheduleRunComplete?.(payload.scheduleId, status, payload.runId)
    refreshSettings()
    toast.error(`"${payload.scheduleName}" failed`, {
      description: 'An error occurred during the scheduled task.'
    })
  }
}

/**
 * Hook that listens for scheduled scan triggers from the main process
 * and runs the configured tasks when triggered. Queues multiple triggers.
 */
export function useScheduledScan(): void {
  const runningRef = useRef(false)
  const queueRef = useRef<ScheduleRunPayload[]>([])

  useEffect(() => {
    if (!window.kudu?.onScheduleRunTrigger) return undefined

    const waitForIdle = async (): Promise<boolean> => {
      // Wait up to 5 minutes for any manual scan/clean to finish
      for (let waited = 0; waited < 300_000; waited += 10_000) {
        const s = useScanStore.getState().status
        if (s !== ScanStatus.Scanning && s !== ScanStatus.Cleaning) return true
        await new Promise((r) => setTimeout(r, 10_000))
      }
      return false
    }

    const processQueue = async () => {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!
        try {
          // Wait for any manual work to finish before running
          const idle = await waitForIdle()
          if (!idle) {
            await window.kudu.scheduleRunComplete?.(next.scheduleId, 'deferred', next.runId)
            toast.warning(`"${next.scheduleName}" skipped`, {
              description: 'Timed out waiting for manual scan to finish.'
            })
            continue
          }
          await runSchedule(next)
        } catch (error) {
          if (error instanceof ScheduleConditionChanged) throw error
          // Ensure completion is reported even on unexpected errors
          await window.kudu.scheduleRunComplete?.(next.scheduleId, 'failed', next.runId)
        }
      }
      runningRef.current = false
    }

    const unsubscribe = window.kudu.onScheduleRunTrigger((payload: ScheduleRunPayload) => {
      queueRef.current.push(payload)
      if (!runningRef.current) {
        runningRef.current = true
        processQueue()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

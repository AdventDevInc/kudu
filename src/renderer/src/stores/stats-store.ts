import { create } from 'zustand'
import type { AppStats } from '@shared/types'
import { useHistoryStore } from './history-store'
import { formatBytes } from '@/lib/utils'

interface StatsState {
  stats: AppStats
  loaded: boolean
  recompute: () => void
}

const defaultStats: AppStats = {
  totalSpaceSaved: 0,
  totalFilesCleaned: 0,
  totalScans: 0,
  lastScanDate: null,
  recentActivity: []
}

function computeStats(): AppStats {
  const entries = useHistoryStore.getState().entries
  if (entries.length === 0) return defaultStats

  const totalSpaceSaved = entries.reduce((s, e) => s + e.totalSpaceSaved, 0)
  const totalFilesCleaned = entries.reduce((s, e) => s + e.totalItemsCleaned, 0)
  const totalScans = entries.length
  const lastScanDate = entries[0].timestamp

  const typeLabel: Record<string, string> = {
    cleaner: 'System Clean',
    registry: 'Registry Fix',
    debloater: 'Debloater',
    network: 'Network Cleanup',
    drivers: 'Driver Cleanup'
  }

  const activityTypeMap: Record<string, string> = {
    cleaner: 'clean',
    network: 'network',
    registry: 'registry',
    debloater: 'clean',
    drivers: 'drivers'
  }

  const recentActivity = entries.slice(0, 20).map((e) => ({
    id: e.id,
    type: (activityTypeMap[e.type] || 'scan') as
      'clean' | 'registry' | 'startup' | 'scan' | 'drivers' | 'network',
    message:
      `${typeLabel[e.type] || e.type}: ${e.totalItemsCleaned} items` +
      (e.totalSpaceSaved > 0 ? ` (${formatBytes(e.totalSpaceSaved)})` : ''),
    timestamp: e.timestamp,
    spaceSaved: e.totalSpaceSaved || undefined
  }))

  return { totalSpaceSaved, totalFilesCleaned, totalScans, lastScanDate, recentActivity }
}

export const useStatsStore = create<StatsState>((set) => ({
  stats: defaultStats,
  loaded: false,
  recompute: () => {
    set({ stats: computeStats(), loaded: true })
  }
}))

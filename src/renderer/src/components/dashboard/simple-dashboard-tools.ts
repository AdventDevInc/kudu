import type { PlatformInfo } from '@shared/types'

export type DashboardGoal = 'space' | 'speed' | 'protection'
interface GoalTool {
  path: string
  titleKey: string
  feature?: keyof PlatformInfo['features']
  tier?: 'pro' | 'basic'
  windowsOnly?: boolean
}

const tools: Record<DashboardGoal, GoalTool[]> = {
  space: [
    { path: '/cleaner', titleKey: 'sidebar:cleaner' },
    { path: '/large-files', titleKey: 'largeFiles:pageTitle' },
    { path: '/duplicates', titleKey: 'duplicates:pageTitle' },
    { path: '/disk', titleKey: 'disk:pageTitle' },
    { path: '/storage-history', titleKey: 'disk:storage.title' },
    { path: '/empty-folders', titleKey: 'emptyFolders:pageTitle' },
    { path: '/file-shredder', titleKey: 'fileShredder:pageTitle' }
  ],
  speed: [
    { path: '/performance', titleKey: 'performance:pageTitle' },
    { path: '/startup', titleKey: 'startup:pageTitle' },
    { path: '/performance-diagnostics', titleKey: 'diagnostics:title', tier: 'pro' },
    { path: '/services', titleKey: 'hardening:serviceManager.pageTitle' },
    { path: '/network', titleKey: 'network:pageTitle' },
    { path: '/disk-repair', titleKey: 'disk:repairTitle', windowsOnly: true },
    { path: '/disk-maintenance', titleKey: 'disk:maintenanceTitle' },
    { path: '/game-mode', titleKey: 'gameMode:pageTitle', feature: 'gameMode' }
  ],
  protection: [
    { path: '/malware', titleKey: 'malware:pageTitle' },
    { path: '/privacy', titleKey: 'hardening:privacy.pageTitle' },
    { path: '/cve', titleKey: 'cveScanner:pageTitle', tier: 'pro' },
    { path: '/threat-monitor', titleKey: 'threatMonitor:pageTitle', tier: 'pro' },
    { path: '/firewall', titleKey: 'sidebar:firewallAudit', feature: 'firewallAudit' },
    { path: '/breach-monitor', titleKey: 'breachMonitor:pageTitle', tier: 'basic' }
  ]
}

export function getGoalTools(goal: DashboardGoal, info: PlatformInfo): GoalTool[] {
  return tools[goal].filter(
    (tool) =>
      (!tool.feature || info.features[tool.feature]) &&
      (!tool.windowsOnly || info.platform === 'win32')
  )
}

import {
  Activity,
  AppWindow,
  CalendarClock,
  Cloud,
  CopyCheck,
  Database,
  Download,
  Eraser,
  Eye,
  FileUp,
  Flame,
  FolderX,
  Gamepad2,
  HardDrive,
  History,
  Info,
  Mail,
  MousePointerClick,
  PackageMinus,
  Radar,
  Server,
  Settings2,
  Shield,
  Sparkles,
  Wifi,
  Wrench,
  Zap,
  Cpu,
  FolderClock,
  RotateCcw,
  type LucideIcon
} from 'lucide-react'

export interface PageExperience {
  key: string
  icon: LucideIcon
  family: 'care' | 'protection' | 'storage' | 'performance' | 'workspace'
  steps?: [string, string, string]
}

// Each tool describes its own workflow. These are instructions, never progress or scan results.
export const pageExperiences: Record<string, PageExperience> = {
  '/storage-history': {
    key: 'storageHistory',
    icon: FolderClock,
    family: 'storage',
    steps: ['trackFolder', 'captureSnapshot', 'compareGrowth']
  },
  '/recovery': {
    key: 'recovery',
    icon: RotateCcw,
    family: 'workspace',
    steps: ['findChange', 'reviewRestore', 'restoreSupported']
  },
  '/performance-diagnostics': {
    key: 'diagnostics',
    icon: Activity,
    family: 'performance',
    steps: ['recordSession', 'inspectRecording', 'consentAnalysis']
  },
  '/cleaner': {
    key: 'cleaner',
    icon: Sparkles,
    family: 'care',
    steps: ['scan', 'reviewCategories', 'reviewClean']
  },
  '/registry': {
    key: 'registry',
    icon: Database,
    family: 'care',
    steps: ['scanRegistry', 'reviewIssues', 'fixSelected']
  },
  '/context-menu': {
    key: 'contextMenu',
    icon: MousePointerClick,
    family: 'care',
    steps: ['scanEntries', 'chooseEntries', 'applyChanges']
  },
  '/startup': {
    key: 'startup',
    icon: Zap,
    family: 'performance',
    steps: ['compareImpact', 'reviewApp', 'toggleStartup']
  },
  '/disk': {
    key: 'disk',
    icon: HardDrive,
    family: 'storage',
    steps: ['chooseDrive', 'analyze', 'exploreFolders']
  },
  '/duplicates': {
    key: 'duplicates',
    icon: CopyCheck,
    family: 'storage',
    steps: ['chooseFolder', 'compareCopies', 'keepOriginal']
  },
  '/large-files': {
    key: 'largeFiles',
    icon: FileUp,
    family: 'storage',
    steps: ['chooseFolder', 'sortSize', 'reviewDelete']
  },
  '/empty-folders': {
    key: 'emptyFolders',
    icon: FolderX,
    family: 'storage',
    steps: ['chooseFolder', 'findEmpty', 'reviewDelete']
  },
  '/file-shredder': {
    key: 'shredder',
    icon: Eraser,
    family: 'storage',
    steps: ['addFiles', 'reviewPaths', 'confirmShred']
  },
  '/disk-repair': {
    key: 'repair',
    icon: Wrench,
    family: 'storage',
    steps: ['chooseCheck', 'runCheck', 'readReport']
  },
  '/disk-maintenance': {
    key: 'maintenance',
    icon: HardDrive,
    family: 'storage',
    steps: ['reviewDrives', 'chooseMaintenance', 'runSelected']
  },
  '/network': {
    key: 'network',
    icon: Wifi,
    family: 'care',
    steps: ['scanNetwork', 'reviewConnections', 'cleanSelected']
  },
  '/malware': {
    key: 'malware',
    icon: Shield,
    family: 'protection',
    steps: ['scanThreats', 'reviewFindings', 'handleThreats']
  },
  '/threat-monitor': {
    key: 'threatMonitor',
    icon: Radar,
    family: 'protection',
    steps: ['checkConnection', 'reviewActivity', 'inspectAlerts']
  },
  '/cve': {
    key: 'cve',
    icon: Shield,
    family: 'protection',
    steps: ['refreshFindings', 'prioritizeSeverity', 'updateApps']
  },
  '/game-mode': {
    key: 'gameMode',
    icon: Gamepad2,
    family: 'performance',
    steps: ['chooseOptimizations', 'reviewChanges', 'activate']
  },
  '/performance': {
    key: 'performance',
    icon: Activity,
    family: 'performance',
    steps: ['watchTrends', 'compareProcesses', 'inspectLoad']
  },
  '/uninstaller': {
    key: 'uninstaller',
    icon: AppWindow,
    family: 'care',
    steps: ['findApp', 'reviewApp', 'uninstall']
  },
  '/history': { key: 'history', icon: History, family: 'workspace' },
  '/settings': { key: 'settings', icon: Settings2, family: 'workspace' },
  '/about': { key: 'about', icon: Info, family: 'workspace' },
  '/cloud': {
    key: 'cloud',
    icon: Cloud,
    family: 'workspace',
    steps: ['linkAccount', 'reviewCloud', 'checkConnection']
  },
  '/breach-monitor': {
    key: 'breach',
    icon: Mail,
    family: 'protection',
    steps: ['addEmail', 'checkExposure', 'reviewBreach']
  },
  '/privacy': {
    key: 'privacy',
    icon: Eye,
    family: 'protection',
    steps: ['checkPrivacy', 'reviewSettings', 'applySelected']
  },
  '/services': {
    key: 'services',
    icon: Server,
    family: 'performance',
    steps: ['scanServices', 'reviewPurpose', 'applySelected']
  },
  '/firewall': {
    key: 'firewall',
    icon: Flame,
    family: 'protection',
    steps: ['auditRules', 'reviewScope', 'applySelected']
  },
  '/debloater': {
    key: 'debloater',
    icon: PackageMinus,
    family: 'care',
    steps: ['findApps', 'reviewPackages', 'removeSelected']
  },
  '/updates': {
    key: 'updates',
    icon: Download,
    family: 'care',
    steps: ['checkUpdates', 'reviewVersions', 'updateSelected']
  },
  '/schedules': {
    key: 'schedules',
    icon: CalendarClock,
    family: 'workspace',
    steps: ['chooseTasks', 'setTime', 'saveRoutine']
  },
  '/drivers': {
    key: 'drivers',
    icon: Cpu,
    family: 'care',
    steps: ['scanDrivers', 'reviewVersions', 'applySelected']
  }
}

import type { ServiceSafety, ServiceCategory } from './types'

export interface ServiceSafetyEntry {
  safety: ServiceSafety
  category: ServiceCategory
  note: string
}

/**
 * Static knowledge base of Windows services and their safety ratings.
 * Keys are lowercase service names.
 *
 * - safe:    commonly disabled without issues
 * - caution: may affect some functionality
 * - unsafe:  should not be disabled (system-critical)
 */
export const SERVICE_SAFETY_KB: Record<string, ServiceSafetyEntry> = {
  // ── Telemetry ──────────────────────────────────────────────
  diagtrack: {
    safety: 'safe',
    category: 'telemetry',
    note: 'Connected User Experiences and Telemetry'
  },
  dmwappushservice: {
    safety: 'safe',
    category: 'telemetry',
    note: 'WAP Push Message Routing for telemetry'
  },
  dmwappushsvc: {
    safety: 'safe',
    category: 'telemetry',
    note: 'WAP Push Message Routing (alternate name)'
  },
  wersvc: {
    safety: 'safe',
    category: 'telemetry',
    note: 'Windows Error Reporting'
  },
  lfsvc: {
    safety: 'safe',
    category: 'telemetry',
    note: 'Geolocation Service'
  },
  cdpsvc: {
    safety: 'caution',
    category: 'telemetry',
    note: 'Connected Devices Platform — used by Timeline and device sync'
  },
  cdpusersvc: {
    safety: 'caution',
    category: 'telemetry',
    note: 'Connected Devices Platform per-user service'
  },

  // ── Xbox ───────────────────────────────────────────────────
  xblauthmanager: {
    safety: 'caution',
    category: 'xbox',
    note: 'Xbox Live Auth Manager — needed for Xbox/Game Pass'
  },
  xblgamesave: {
    safety: 'caution',
    category: 'xbox',
    note: 'Xbox Live Game Save — needed for cloud saves'
  },
  xboxgipsvc: {
    safety: 'caution',
    category: 'xbox',
    note: 'Xbox Accessory Management — needed for Xbox controllers'
  },
  xboxnetapisvc: {
    safety: 'caution',
    category: 'xbox',
    note: 'Xbox Live Networking Service — needed for Xbox online features'
  },

  // ── Print & Fax ────────────────────────────────────────────
  spooler: {
    safety: 'caution',
    category: 'print',
    note: 'Print Spooler — needed if you use a printer'
  },
  fax: {
    safety: 'safe',
    category: 'fax',
    note: 'Fax service'
  },
  printnotify: {
    safety: 'caution',
    category: 'print',
    note: 'Printer Extensions and Notifications'
  },

  // ── Media ──────────────────────────────────────────────────
  wmpnetworksvc: {
    safety: 'safe',
    category: 'media',
    note: 'Windows Media Player Network Sharing'
  },

  // ── Misc (safe) ────────────────────────────────────────────
  mapsbroker: {
    safety: 'safe',
    category: 'misc',
    note: 'Downloaded Maps Manager'
  },
  retaildemo: {
    safety: 'safe',
    category: 'misc',
    note: 'Retail Demo Service'
  },
  wisvc: {
    safety: 'safe',
    category: 'misc',
    note: 'Windows Insider Service'
  },
  phonesvc: {
    safety: 'caution',
    category: 'misc',
    note: 'Phone Service — required by some wireless headset dongles, including Audeze Maxwell'
  },
  icssvc: {
    safety: 'safe',
    category: 'network',
    note: 'Windows Mobile Hotspot Service'
  },
  pcasvc: {
    safety: 'safe',
    category: 'misc',
    note: 'Program Compatibility Assistant'
  },
  tabletinputservice: {
    safety: 'safe',
    category: 'misc',
    note: 'Touch Keyboard and Handwriting — safe if no touch screen'
  },
  wbiosrvc: {
    safety: 'safe',
    category: 'misc',
    note: 'Windows Biometric Service — safe if no fingerprint reader'
  },
  seclogon: {
    safety: 'safe',
    category: 'misc',
    note: 'Secondary Logon (Run As)'
  },
  sharedaccess: {
    safety: 'safe',
    category: 'network',
    note: 'Internet Connection Sharing'
  },
  remoteregistry: {
    safety: 'safe',
    category: 'remote',
    note: 'Remote Registry'
  },
  termservice: {
    safety: 'caution',
    category: 'remote',
    note: 'Remote Desktop Services — needed for RDP'
  },
  sessionenv: {
    safety: 'caution',
    category: 'remote',
    note: 'Remote Desktop Configuration'
  },
  umrdpservice: {
    safety: 'caution',
    category: 'remote',
    note: 'Remote Desktop Services UserMode Port Redirector'
  },
  remoteaccess: {
    safety: 'safe',
    category: 'remote',
    note: 'Routing and Remote Access'
  },

  // ── Misc (caution) ────────────────────────────────────────
  wsearch: {
    safety: 'caution',
    category: 'misc',
    note: 'Windows Search — disabling removes file indexing and search'
  },
  sysmain: {
    safety: 'caution',
    category: 'misc',
    note: 'Superfetch/SysMain — safe on SSDs, may slow HDDs'
  },
  themes: {
    safety: 'caution',
    category: 'misc',
    note: 'Disabling removes theme support and visual styles'
  },
  wpnservice: {
    safety: 'caution',
    category: 'misc',
    note: 'Windows Push Notifications — needed for app notifications'
  },
  wpnuserservice: {
    safety: 'caution',
    category: 'misc',
    note: 'Windows Push Notifications per-user service'
  },
  onesyncsvc: {
    safety: 'caution',
    category: 'misc',
    note: 'Sync Host — used by Mail, Calendar, Contacts'
  },
  diagsvc: {
    safety: 'safe',
    category: 'telemetry',
    note: 'Diagnostic Execution Service'
  },
  diagsystemhost: {
    safety: 'safe',
    category: 'telemetry',
    note: 'Diagnostic System Host'
  },

  // ── Bluetooth ──────────────────────────────────────────────
  bthserv: {
    safety: 'caution',
    category: 'bluetooth',
    note: 'Bluetooth Support Service — needed for Bluetooth devices'
  },
  bthavctpsvc: {
    safety: 'caution',
    category: 'bluetooth',
    note: 'AVCTP service for Bluetooth audio'
  },

  // ── Hyper-V ────────────────────────────────────────────────
  vmcompute: {
    safety: 'caution',
    category: 'hyper-v',
    note: 'Hyper-V Host Compute Service'
  },
  vmms: {
    safety: 'caution',
    category: 'hyper-v',
    note: 'Hyper-V Virtual Machine Management'
  },
  hvhost: {
    safety: 'caution',
    category: 'hyper-v',
    note: 'HV Host Service'
  },

  // ── Developer ──────────────────────────────────────────────
  'ssh-agent': {
    safety: 'caution',
    category: 'developer',
    note: 'OpenSSH Authentication Agent'
  },
  sshd: {
    safety: 'caution',
    category: 'developer',
    note: 'OpenSSH SSH Server'
  },

  // ── Core / Unsafe ─────────────────────────────────────────
  rpcss: {
    safety: 'unsafe',
    category: 'core',
    note: 'Remote Procedure Call — critical for Windows operation'
  },
  dcomlaunch: {
    safety: 'unsafe',
    category: 'core',
    note: 'DCOM Server Process Launcher — critical for COM+'
  },
  eventlog: {
    safety: 'unsafe',
    category: 'core',
    note: 'Windows Event Log — needed for diagnostics and auditing'
  },
  winmgmt: {
    safety: 'unsafe',
    category: 'core',
    note: 'Windows Management Instrumentation — widely depended on'
  },
  schedule: {
    safety: 'unsafe',
    category: 'core',
    note: 'Task Scheduler — used by many Windows components'
  },
  power: {
    safety: 'unsafe',
    category: 'core',
    note: 'Power service — required for power management'
  },
  wuauserv: {
    safety: 'unsafe',
    category: 'core',
    note: 'Windows Update — required to receive security patches'
  },
  bits: {
    safety: 'unsafe',
    category: 'core',
    note: 'Background Intelligent Transfer — used by Windows Update'
  },
  trustedinstaller: {
    safety: 'unsafe',
    category: 'core',
    note: 'Windows Modules Installer — required for updates'
  },
  profsvc: {
    safety: 'unsafe',
    category: 'core',
    note: 'User Profile Service — required for login'
  },
  plugplay: {
    safety: 'unsafe',
    category: 'core',
    note: 'Plug and Play — required for device detection'
  },
  sppsvc: {
    safety: 'unsafe',
    category: 'core',
    note: 'Software Protection Platform — Windows activation'
  },
  lsm: {
    safety: 'unsafe',
    category: 'core',
    note: 'Local Session Manager — required for session management'
  },

  // ── Security / Unsafe ─────────────────────────────────────
  windefend: {
    safety: 'unsafe',
    category: 'security',
    note: 'Windows Defender Antivirus — primary system protection'
  },
  mpssvc: {
    safety: 'unsafe',
    category: 'security',
    note: 'Windows Defender Firewall — network protection'
  },
  bfe: {
    safety: 'unsafe',
    category: 'security',
    note: 'Base Filtering Engine — required by firewall'
  },
  cryptsvc: {
    safety: 'unsafe',
    category: 'security',
    note: 'Cryptographic Services — required for signatures and certificates'
  },
  samss: {
    safety: 'unsafe',
    category: 'security',
    note: 'Security Accounts Manager — required for authentication'
  },
  securityhealthservice: {
    safety: 'unsafe',
    category: 'security',
    note: 'Windows Security Center'
  },

  // ── Network / Unsafe ──────────────────────────────────────
  dhcp: {
    safety: 'unsafe',
    category: 'network',
    note: 'DHCP Client — required for automatic IP addressing'
  },
  dnscache: {
    safety: 'unsafe',
    category: 'network',
    note: 'DNS Client — required for name resolution'
  },
  nsi: {
    safety: 'unsafe',
    category: 'network',
    note: 'Network Store Interface — required for network connectivity'
  },
  lanmanserver: {
    safety: 'unsafe',
    category: 'network',
    note: 'Server service — required for file sharing'
  },
  lanmanworkstation: {
    safety: 'unsafe',
    category: 'network',
    note: 'Workstation service — required for network resource access'
  },
  nlasvc: {
    safety: 'unsafe',
    category: 'network',
    note: 'Network Location Awareness — required for network detection'
  },
  netprofm: {
    safety: 'unsafe',
    category: 'network',
    note: 'Network List Service — required for network management'
  },
}

/**
 * Look up a service in the knowledge base.
 * Strips per-user suffixes (e.g. CDPUserSvc_abc12) before matching.
 */
export function lookupServiceSafety(serviceName: string): ServiceSafetyEntry {
  const key = serviceName.replace(/_[a-f0-9]+$/i, '').toLowerCase()
  return (
    SERVICE_SAFETY_KB[key] ?? {
      safety: 'caution' as const,
      category: 'unknown' as const,
      note: ''
    }
  )
}

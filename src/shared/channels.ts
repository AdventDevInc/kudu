export const IPC = {
  // System cleaner
  SYSTEM_SCAN: 'cleaner:system:scan',
  SYSTEM_CLEAN: 'cleaner:system:clean',

  // Browser cleaner
  BROWSER_SCAN: 'cleaner:browser:scan',
  BROWSER_CLEAN: 'cleaner:browser:clean',

  // App cleaner
  APP_SCAN: 'cleaner:app:scan',
  APP_CLEAN: 'cleaner:app:clean',

  // Gaming cleaner
  GAMING_SCAN: 'cleaner:gaming:scan',
  GAMING_CLEAN: 'cleaner:gaming:clean',

  // Database optimizer
  DATABASE_SCAN: 'cleaner:database:scan',
  DATABASE_CLEAN: 'cleaner:database:clean',

  // Recycle bin
  RECYCLE_BIN_SCAN: 'cleaner:recyclebin:scan',
  RECYCLE_BIN_CLEAN: 'cleaner:recyclebin:clean',

  // Uninstall leftovers
  UNINSTALL_LEFTOVERS_SCAN: 'cleaner:uninstall-leftovers:scan',
  UNINSTALL_LEFTOVERS_CLEAN: 'cleaner:uninstall-leftovers:clean',

  // Shortcut cleaner
  SHORTCUT_SCAN: 'cleaner:shortcut:scan',
  SHORTCUT_CLEAN: 'cleaner:shortcut:clean',

  // Environment cleaner (orphaned PATH entries & env vars)
  ENVIRONMENT_SCAN: 'cleaner:environment:scan',
  ENVIRONMENT_CLEAN: 'cleaner:environment:clean',

  // Cleaner shared
  CLEANER_OPEN_LOCATION: 'cleaner:open-location',

  // Registry
  REGISTRY_SCAN: 'cleaner:registry:scan',
  REGISTRY_FIX: 'cleaner:registry:fix',
  REGISTRY_SCAN_CANCEL: 'cleaner:registry:scan:cancel',
  REGISTRY_FIX_CANCEL: 'cleaner:registry:fix:cancel',
  REGISTRY_SET_TWEAK_IGNORED: 'cleaner:registry:tweak:set-ignored',

  // Context Menu Cleaner (Windows shell extensions / right-click verbs)
  CONTEXT_MENU_SCAN: 'cleaner:context-menu:scan',
  CONTEXT_MENU_SCAN_CANCEL: 'cleaner:context-menu:scan:cancel',
  CONTEXT_MENU_APPLY: 'cleaner:context-menu:apply',
  CONTEXT_MENU_APPLY_PROGRESS: 'cleaner:context-menu:apply:progress',

  // Startup
  STARTUP_LIST: 'startup:list',
  STARTUP_TOGGLE: 'startup:toggle',
  STARTUP_DELETE: 'startup:delete',
  STARTUP_BOOT_TRACE: 'startup:boot-trace',
  STARTUP_SAFETY_FETCH: 'startup:safety:fetch',
  STARTUP_SAFETY_UPDATED: 'startup:safety:updated',

  // Debloater
  DEBLOATER_SCAN: 'debloater:scan',
  DEBLOATER_REMOVE: 'debloater:remove',
  DEBLOATER_REMOVE_PROGRESS: 'debloater:remove:progress',

  // Duplicate Finder
  DUPLICATES_SCAN: 'duplicates:scan',
  DUPLICATES_DELETE: 'duplicates:delete',
  DUPLICATES_CANCEL: 'duplicates:cancel',
  DUPLICATES_PROGRESS: 'duplicates:progress',
  DUPLICATES_SELECT_DIR: 'duplicates:select-dir',
  DUPLICATES_OPEN_LOCATION: 'duplicates:open-location',

  // Disk analyzer
  DISK_ANALYZE: 'disk:analyze',
  DISK_DRIVES: 'disk:drives',
  DISK_FILE_TYPES: 'disk:file-types',

  // Disk repair (SFC/DISM/CHKDSK)
  DISK_REPAIR_SFC: 'disk:repair:sfc',
  DISK_REPAIR_DISM: 'disk:repair:dism',
  DISK_REPAIR_CHKDSK: 'disk:repair:chkdsk',
  DISK_REPAIR_PROGRESS: 'disk:repair:progress',

  // Disk maintenance (SSD TRIM)
  DISK_TRIM_LIST: 'disk:trim:list',
  DISK_TRIM_RUN: 'disk:trim:run',
  DISK_TRIM_PROGRESS: 'disk:trim:progress',

  // Network cleanup
  NETWORK_SCAN: 'cleaner:network:scan',
  NETWORK_CLEAN: 'cleaner:network:clean',

  // Progress events (main -> renderer)
  SCAN_PROGRESS: 'scan:progress',
  REGISTRY_FIX_PROGRESS: 'registry:fix:progress',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_SELECT_BACKUP_DIR: 'settings:select-backup-dir',
  SETTINGS_OPEN_BACKUP_DIR: 'settings:open-backup-dir',

  // System
  ELEVATION_CHECK: 'elevation:check',
  ELEVATION_RELAUNCH: 'elevation:relaunch',
  RESTORE_POINT_CREATE: 'system:restore-point:create',

  // Scheduled scans (legacy single-schedule)
  SCHEDULE_NEXT_SCAN: 'schedule:next-scan',
  SCHEDULE_SCAN_TRIGGER: 'schedule:scan-trigger',
  SCHEDULE_SCAN_COMPLETE: 'schedule:scan-complete',

  // Multi-schedule
  SCHEDULE_RUN_TRIGGER: 'schedule:run-trigger',
  SCHEDULE_RUN_COMPLETE: 'schedule:run-complete',

  // Settings apply (renderer -> main)
  SETTINGS_APPLY_STARTUP: 'settings:apply-startup',
  SETTINGS_APPLY_TRAY: 'settings:apply-tray',

  // Scan history
  HISTORY_GET: 'history:get',
  HISTORY_ADD: 'history:add',
  HISTORY_CLEAR: 'history:clear',

  // Malware scanner
  MALWARE_SCAN: 'malware:scan',
  MALWARE_QUARANTINE: 'malware:quarantine',
  MALWARE_DELETE: 'malware:delete',
  MALWARE_RESTORE: 'malware:restore',
  MALWARE_PROGRESS: 'malware:progress',
  MALWARE_QUARANTINE_LIST: 'malware:quarantine:list',
  MALWARE_IGNORE: 'malware:ignore',
  MALWARE_ALLOWLIST_LIST: 'malware:allowlist:list',
  MALWARE_ALLOWLIST_REMOVE: 'malware:allowlist:remove',
  MALWARE_YARA_INFO: 'malware:yara:info',
  MALWARE_YARA_UPDATE: 'malware:yara:update',
  MALWARE_YARA_COMPILE_PROGRESS: 'malware:yara:compile-progress',

  // Privacy Shield
  PRIVACY_SCAN: 'privacy:scan',
  PRIVACY_APPLY: 'privacy:apply',
  PRIVACY_REVERT: 'privacy:revert',
  PRIVACY_PROGRESS: 'privacy:progress',

  // Driver Manager
  DRIVER_SCAN: 'driver:scan',
  DRIVER_CLEAN: 'driver:clean',
  DRIVER_PROGRESS: 'driver:progress',
  DRIVER_UPDATE_SCAN: 'driver:update:scan',
  DRIVER_UPDATE_INSTALL: 'driver:update:install',
  DRIVER_UPDATE_PROGRESS: 'driver:update:progress',

  // Program Uninstaller
  UNINSTALLER_LIST: 'uninstaller:list',
  UNINSTALLER_UNINSTALL: 'uninstaller:uninstall',
  UNINSTALLER_FORCE_REMOVE: 'uninstaller:force-remove',
  UNINSTALLER_PROGRESS: 'uninstaller:progress',
  PROGRAM_SAFETY_FETCH: 'program:safety:fetch',
  PROGRAM_SAFETY_UPDATED: 'program:safety:updated',

  // Onboarding
  ONBOARDING_GET: 'onboarding:get',
  ONBOARDING_SET: 'onboarding:set',

  // Performance Monitor
  PERF_QUICK_STATS: 'perf:quick-stats',
  PERF_GET_SYSTEM_INFO: 'perf:system-info',
  PERF_START_MONITORING: 'perf:start',
  PERF_STOP_MONITORING: 'perf:stop',
  PERF_SNAPSHOT: 'perf:snapshot',
  PERF_PROCESS_LIST: 'perf:process-list',
  PERF_KILL_PROCESS: 'perf:kill',
  PERF_DISK_HEALTH: 'perf:disk-health',

  // Auto-updater
  UPDATER_CHECK: 'updater:check',
  UPDATER_DOWNLOAD: 'updater:download',
  UPDATER_INSTALL: 'updater:install',
  UPDATER_GET_STATUS: 'updater:get-status',
  UPDATER_STATUS: 'updater:status',

  // Service Manager
  SERVICE_SCAN: 'service:scan',
  SERVICE_APPLY: 'service:apply',
  SERVICE_PROGRESS: 'service:progress',

  // Firewall Audit (Windows-only)
  FIREWALL_SCAN: 'firewall:scan',
  FIREWALL_APPLY: 'firewall:apply',
  FIREWALL_PROGRESS: 'firewall:progress',

  // Software Updater
  SOFTWARE_UPDATE_CHECK: 'software-update:check',
  SOFTWARE_UPDATE_RUN: 'software-update:run',
  SOFTWARE_UPDATE_PROGRESS: 'software-update:progress',

  // Cloud Agent
  CLOUD_LINK: 'cloud:link',
  CLOUD_UNLINK: 'cloud:unlink',
  CLOUD_GET_STATUS: 'cloud:get-status',
  CLOUD_RECONNECT: 'cloud:reconnect',

  // Threat Monitor
  THREAT_MONITOR_GET_SNAPSHOT: 'threat-monitor:get-snapshot',
  THREAT_MONITOR_UPDATED: 'threat-monitor:updated',

  // CVE Scanner
  CVE_FETCH: 'cve:fetch',
  CVE_UPDATED: 'cve:updated',

  // Breach Monitor
  BREACH_MONITOR_FETCH: 'breach-monitor:fetch',
  BREACH_MONITOR_ADD: 'breach-monitor:add',
  BREACH_MONITOR_REMOVE: 'breach-monitor:remove',
  BREACH_MONITOR_ACKNOWLEDGE: 'breach-monitor:acknowledge',

  // Cloud Action History
  CLOUD_HISTORY_GET: 'cloud:history:get',
  CLOUD_HISTORY_CLEAR: 'cloud:history:clear',

  // History push events (main -> renderer)
  HISTORY_CHANGED: 'history:changed',
  CLOUD_HISTORY_CHANGED: 'cloud:history:changed',

  // Large File Finder
  LARGE_FILES_SCAN: 'large-files:scan',
  LARGE_FILES_CANCEL: 'large-files:cancel',
  LARGE_FILES_PROGRESS: 'large-files:progress',
  LARGE_FILES_SELECT_DIR: 'large-files:select-dir',
  LARGE_FILES_DELETE: 'large-files:delete',
  LARGE_FILES_OPEN_LOCATION: 'large-files:open-location',

  // Empty Folder Cleaner
  EMPTY_FOLDERS_SCAN: 'empty-folders:scan',
  EMPTY_FOLDERS_CANCEL: 'empty-folders:cancel',
  EMPTY_FOLDERS_PROGRESS: 'empty-folders:progress',
  EMPTY_FOLDERS_SELECT_DIR: 'empty-folders:select-dir',
  EMPTY_FOLDERS_DELETE: 'empty-folders:delete',
  EMPTY_FOLDERS_OPEN_LOCATION: 'empty-folders:open-location',

  // File Shredder
  SHREDDER_SELECT_FILES: 'shredder:select-files',
  SHREDDER_SELECT_FOLDERS: 'shredder:select-folders',
  SHREDDER_SHRED: 'shredder:shred',
  SHREDDER_CANCEL: 'shredder:cancel',
  SHREDDER_PROGRESS: 'shredder:progress',
  SHREDDER_OPEN_LOCATION: 'shredder:open-location',

  // Game Mode
  GAME_MODE_ACTIVATE: 'game-mode:activate',
  GAME_MODE_DEACTIVATE: 'game-mode:deactivate',
  GAME_MODE_STATUS: 'game-mode:status',
  GAME_MODE_PROGRESS: 'game-mode:progress',
  GAME_MODE_AUTO_EVENT: 'game-mode:auto-event',

  // Platform
  PLATFORM_INFO: 'platform:info',

  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const

import { join } from 'path'
import { homedir } from 'os'

const HOME = homedir()
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')
const WINDIR = process.env.WINDIR || 'C:\\Windows'
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData'
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files'

export const SYSTEM_PATHS = {
  // Core temp files
  userTemp: join(LOCALAPPDATA, 'Temp'),
  systemTemp: join(WINDIR, 'Temp'),
  prefetch: join(WINDIR, 'Prefetch'),
  windowsLogs: join(WINDIR, 'Logs'),
  setupLogs: join(WINDIR, 'Panther'),

  // Caches
  thumbnailCache: join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer'),
  fontCache: join(WINDIR, 'ServiceProfiles', 'LocalService', 'AppData', 'Local', 'FontCache'),
  dxShaderCache: join(LOCALAPPDATA, 'D3DSCache'),
  inetCache: join(LOCALAPPDATA, 'Microsoft', 'Windows', 'INetCache'),

  // Windows Update & Delivery
  windowsUpdateCache: join(WINDIR, 'SoftwareDistribution', 'Download'),
  deliveryOptimization: join(WINDIR, 'SoftwareDistribution', 'DeliveryOptimization'),

  // Error reports & crash dumps
  errorReports: join(LOCALAPPDATA, 'Microsoft', 'Windows', 'WER'),
  systemErrorReports: join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER'),
  crashDumps: join(LOCALAPPDATA, 'CrashDumps'),
  memoryDumps: join(WINDIR, 'Minidump'),
  fullMemoryDump: join(WINDIR, 'MEMORY.DMP'),

  // Windows Installer & patches
  installerPatchCache: join(WINDIR, 'Installer', '$PatchCache$'),
  appxStaging: join(PROGRAMDATA, 'Microsoft', 'Windows', 'AppRepository', 'Packages'),

  // Event logs
  eventLogs: join(WINDIR, 'System32', 'winevt', 'Logs'),

  // Defender
  defenderScanHistory: join(PROGRAMDATA, 'Microsoft', 'Windows Defender', 'Scans', 'History'),

  // Previous installation
  windowsOld: 'C:\\Windows.old'
}

// Only cache paths — never touch cookies, history, sessions, passwords, or bookmarks
const CHROMIUM_CACHE_DIRS = {
  cache: 'Cache\\Cache_Data',
  codeCache: 'Code Cache',
  gpuCache: 'GPUCache',
  serviceWorker: 'Service Worker\\CacheStorage'
}

export const BROWSER_PATHS = {
  chrome: {
    base: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    ...CHROMIUM_CACHE_DIRS
  },
  edge: {
    base: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
    ...CHROMIUM_CACHE_DIRS
  },
  brave: {
    base: join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ...CHROMIUM_CACHE_DIRS
  },
  opera: {
    base: join(APPDATA, 'Opera Software', 'Opera Stable'),
    ...CHROMIUM_CACHE_DIRS
  },
  operaGX: {
    base: join(APPDATA, 'Opera Software', 'Opera GX Stable'),
    ...CHROMIUM_CACHE_DIRS
  },
  vivaldi: {
    base: join(LOCALAPPDATA, 'Vivaldi', 'User Data'),
    ...CHROMIUM_CACHE_DIRS
  },
  firefox: {
    base: join(APPDATA, 'Mozilla', 'Firefox', 'Profiles'),
    cache: join(LOCALAPPDATA, 'Mozilla', 'Firefox', 'Profiles')
  }
}

export const APP_PATHS = [
  // Communication
  {
    id: 'discord',
    name: 'Discord',
    paths: [
      join(APPDATA, 'discord', 'Cache', 'Cache_Data'),
      join(APPDATA, 'discord', 'Code Cache'),
      join(APPDATA, 'discord', 'GPUCache')
    ]
  },
  { id: 'teams', name: 'Microsoft Teams', paths: [join(APPDATA, 'Microsoft', 'Teams', 'Cache')] },
  {
    id: 'slack',
    name: 'Slack',
    paths: [
      join(APPDATA, 'Slack', 'Cache', 'Cache_Data'),
      join(APPDATA, 'Slack', 'Code Cache'),
      join(APPDATA, 'Slack', 'GPUCache')
    ]
  },
  {
    id: 'zoom',
    name: 'Zoom',
    paths: [join(APPDATA, 'Zoom', 'data'), join(APPDATA, 'Zoom', 'logs')]
  },
  {
    id: 'telegram',
    name: 'Telegram',
    paths: [
      join(APPDATA, 'Telegram Desktop', 'tdata', 'user_data'),
      join(APPDATA, 'Telegram Desktop', 'tdata', 'emoji')
    ]
  },

  // Editors & IDEs
  {
    id: 'vscode',
    name: 'VS Code',
    paths: [
      join(APPDATA, 'Code', 'Cache', 'Cache_Data'),
      join(APPDATA, 'Code', 'CachedData'),
      join(APPDATA, 'Code', 'CachedExtensions'),
      join(APPDATA, 'Code', 'logs')
    ]
  },
  { id: 'jetbrains', name: 'JetBrains IDEs', paths: [join(LOCALAPPDATA, 'JetBrains')] },

  // Media
  {
    id: 'spotify',
    name: 'Spotify',
    paths: [join(LOCALAPPDATA, 'Spotify', 'Storage'), join(LOCALAPPDATA, 'Spotify', 'Data')]
  },
  {
    id: 'obs',
    name: 'OBS Studio',
    paths: [join(APPDATA, 'obs-studio', 'logs'), join(APPDATA, 'obs-studio', 'profiler_data')]
  },
  {
    id: 'adobe',
    name: 'Adobe Creative Cloud',
    paths: [
      join(LOCALAPPDATA, 'Adobe', 'AcroCef', 'Cache'),
      join(APPDATA, 'Adobe', 'Common', 'Media Cache Files'),
      join(APPDATA, 'Adobe', 'Common', 'Media Cache')
    ]
  },

  // Dev tools — package managers
  { id: 'npm', name: 'npm Cache', paths: [join(APPDATA, 'npm-cache')] },
  { id: 'yarn', name: 'Yarn Cache', paths: [join(LOCALAPPDATA, 'Yarn', 'Cache')] },
  { id: 'pnpm', name: 'pnpm Store', paths: [join(LOCALAPPDATA, 'pnpm-store')] },
  { id: 'bun', name: 'Bun Cache', paths: [join(LOCALAPPDATA, '.bun', 'install', 'cache')] },
  { id: 'pip', name: 'pip Cache', paths: [join(LOCALAPPDATA, 'pip', 'Cache')] },
  {
    id: 'nuget',
    name: 'NuGet Cache',
    paths: [join(LOCALAPPDATA, 'NuGet', 'v3-cache'), join(LOCALAPPDATA, 'NuGet', 'plugins-cache')]
  },
  {
    id: 'cargo',
    name: 'Cargo/Rust Cache',
    paths: [join(HOME, '.cargo', 'registry', 'cache'), join(HOME, '.cargo', 'registry', 'src')]
  },
  { id: 'go', name: 'Go Module Cache', paths: [join(HOME, 'go', 'pkg', 'mod', 'cache')] },
  {
    id: 'gradle',
    name: 'Gradle Cache',
    paths: [join(HOME, '.gradle', 'caches'), join(HOME, '.gradle', 'daemon')]
  },
  { id: 'maven', name: 'Maven Cache', paths: [join(HOME, '.m2', 'repository')] },
  { id: 'composer', name: 'Composer Cache', paths: [join(LOCALAPPDATA, 'Composer', 'cache')] },

  // Containers
  {
    id: 'docker',
    name: 'Docker Desktop',
    paths: [join(LOCALAPPDATA, 'Docker', 'wsl', 'data'), join(APPDATA, 'Docker Desktop', 'cache')]
  }
]

// Gaming launcher cache paths — ONLY safe-to-clean targets
// Never touch auth tokens, session data, spool/sync, or offline caches
export const GAMING_PATHS = [
  // Steam — logs, dumps, http cache only (not htmlcache/cefdata which hold login session)
  {
    id: 'steam',
    name: 'Steam Launcher',
    paths: [
      join(PROGRAMFILES_X86, 'Steam', 'logs'),
      join(PROGRAMFILES_X86, 'Steam', 'dumps'),
      join(PROGRAMFILES_X86, 'Steam', 'appcache', 'httpcache')
    ]
  },
  // Epic Games — webcache and logs only (not Data which holds download state)
  {
    id: 'epic',
    name: 'Epic Games Launcher',
    paths: [
      join(LOCALAPPDATA, 'EpicGamesLauncher', 'Saved', 'webcache'),
      join(LOCALAPPDATA, 'EpicGamesLauncher', 'Saved', 'webcache_4430'),
      join(LOCALAPPDATA, 'EpicGamesLauncher', 'Saved', 'Logs'),
      join(LOCALAPPDATA, 'EpicGamesLauncher', 'Intermediate'),
      join(PROGRAMDATA, 'Epic', 'EpicGamesLauncher', 'VaultCache')
    ]
  },
  // EA App — logs and overlay cache only (not CEF browser/offline cache which hold auth)
  {
    id: 'ea',
    name: 'EA App',
    paths: [
      join(LOCALAPPDATA, 'Electronic Arts', 'EA Desktop', 'Logs'),
      join(LOCALAPPDATA, 'Electronic Arts', 'EA Desktop', 'IGOCache'),
      join(LOCALAPPDATA, 'EADesktop', 'cache'),
      join(LOCALAPPDATA, 'Origin', 'cache')
    ]
  },
  // Ubisoft Connect — logs only (not cache/spool which hold auth and pending sync)
  {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    paths: [join(LOCALAPPDATA, 'Ubisoft Game Launcher', 'logs')]
  },
  // GOG Galaxy
  {
    id: 'gog',
    name: 'GOG Galaxy',
    paths: [
      join(LOCALAPPDATA, 'GOG.com', 'Galaxy', 'webcache'),
      join(PROGRAMDATA, 'GOG.com', 'Galaxy', 'logs'),
      join(PROGRAMDATA, 'GOG.com', 'Galaxy', 'webcache')
    ]
  },
  // Battle.net
  {
    id: 'battlenet',
    name: 'Battle.net',
    paths: [
      join(LOCALAPPDATA, 'Blizzard Entertainment', 'Battle.net', 'Logs'),
      join(APPDATA, 'Battle.net', 'Logs')
    ]
  },
  // Riot Games
  {
    id: 'riot',
    name: 'Riot Games',
    paths: [join(LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Logs')]
  },
  // Xbox/Microsoft Store gaming
  {
    id: 'xbox',
    name: 'Xbox App',
    paths: [
      join(LOCALAPPDATA, 'Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalCache'),
      join(LOCALAPPDATA, 'Packages', 'Microsoft.XboxApp_8wekyb3d8bbwe', 'LocalCache')
    ]
  }
]

// GPU shader caches — safe to delete, auto-rebuilt on next launch
export const GPU_CACHE_PATHS = [
  {
    id: 'nvidia',
    name: 'NVIDIA Shader Cache',
    paths: [
      join(LOCALAPPDATA, 'NVIDIA', 'GLCache'),
      join(LOCALAPPDATA, 'NVIDIA', 'DXCache'),
      join(LOCALAPPDATA, 'NVIDIA Corporation', 'NV_Cache'),
      join(PROGRAMDATA, 'NVIDIA Corporation', 'NV_Cache')
    ]
  },
  {
    id: 'amd',
    name: 'AMD Shader Cache',
    paths: [
      join(LOCALAPPDATA, 'AMD', 'DxCache'),
      join(LOCALAPPDATA, 'AMD', 'GLCache'),
      join(LOCALAPPDATA, 'AMD', 'VkCache')
    ]
  }
]

// Directories to scan for uninstall leftovers (top-level folders only)
export const UNINSTALL_LEFTOVER_DIRS = [
  { id: 'localappdata', name: 'AppData Local', path: LOCALAPPDATA },
  { id: 'appdata', name: 'AppData Roaming', path: APPDATA },
  { id: 'programfiles', name: 'Program Files', path: PROGRAMFILES },
  { id: 'programfiles-x86', name: 'Program Files (x86)', path: PROGRAMFILES_X86 },
  { id: 'programdata', name: 'ProgramData', path: PROGRAMDATA }
]

// Known redistributable folder names found inside game directories
export const STEAM_REDIST_PATTERNS = [
  '_CommonRedist',
  'CommonRedist',
  '__installer',
  '__Installer',
  '_Redist',
  'Redist',
  'redist',
  'DirectX',
  'directx',
  'vcredist',
  'VCRedist',
  'DotNetFX',
  'dotnetfx',
  'UE4PrereqSetup',
  'xnafx',
  'DXSETUP',
  'Mono',
  'WindowsNoEditor\\Engine\\Extras\\Redist'
]

// Default Steam library locations to scan for redistributables
export const DEFAULT_STEAM_LIBRARIES = [
  join(PROGRAMFILES_X86, 'Steam'),
  join(PROGRAMFILES, 'Steam'),
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
  'F:\\SteamLibrary'
]

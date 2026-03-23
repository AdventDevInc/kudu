import { execFile } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { updateSshdConfig, updateSysctlConfig } from '../config-utils'
import type { PlatformPrivacy, PrivacySettingDef } from '../types'

const execFileAsync = promisify(execFile)

function isRoot(): boolean {
  return process.getuid?.() === 0
}

export function createDarwinPrivacy(): PlatformPrivacy {
  return {
    getSettings(): PrivacySettingDef[] {
      return [
        ...DARWIN_PRIVACY_SETTINGS,
        ...DARWIN_ADS_SETTINGS,
        ...DARWIN_SEARCH_SETTINGS,
        ...DARWIN_SYNC_SETTINGS,
        ...DARWIN_AI_SETTINGS,
        ...DARWIN_BROWSER_SETTINGS,
        ...DARWIN_KERNEL_SETTINGS,
        ...DARWIN_NETWORK_SETTINGS,
        ...DARWIN_ACCESS_SETTINGS,
      ]
    },
  }
}

// ─── Elevated execution helper ──────────────────────────────
// When the Electron process is not root (common even with `sudo npm run dev`
// because npm/electron-vite can drop privileges), this uses osascript to
// show a native macOS password dialog — the same UX as System Settings.

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

async function elevatedExec(cmd: string, args: string[]): Promise<string> {
  if (isRoot()) {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 })
    return stdout
  }
  const escaped = [cmd, ...args].map(shellEscape).join(' ')
  const script = `do shell script ${JSON.stringify(escaped)} with administrator privileges`
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 30_000 })
  return stdout
}

async function elevatedWriteFile(filePath: string, content: string): Promise<void> {
  if (isRoot()) {
    await writeFile(filePath, content, 'utf8')
    return
  }
  // Write to temp first (no root needed), then elevated mv to target
  const tmp = join(tmpdir(), `kudu-${randomUUID()}.tmp`)
  await writeFile(tmp, content, 'utf8')
  await elevatedExec('/bin/mv', ['-f', tmp, filePath])
}

// ─── defaults helpers ───────────────────────────────────────

async function defaultsRead(domain: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/defaults', ['read', domain, key], { timeout: 5_000 })
  return stdout.trim()
}

async function defaultsWrite(domain: string, key: string, type: string, value: string): Promise<void> {
  await execFileAsync('/usr/bin/defaults', ['write', domain, key, `-${type}`, value], { timeout: 5_000 })
}

async function elevatedDefaultsWrite(domain: string, key: string, type: string, value: string): Promise<void> {
  await elevatedExec('/usr/bin/defaults', ['write', domain, key, `-${type}`, value])
}

async function elevatedDefaultsDelete(domain: string, key: string): Promise<void> {
  await elevatedExec('/usr/bin/defaults', ['delete', domain, key])
}

// ─── systemsetup helpers ────────────────────────────────────

async function systemsetupGet(flag: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/systemsetup', [flag], { timeout: 5_000 })
  return stdout.trim()
}

async function systemsetupSet(flag: string, ...args: string[]): Promise<void> {
  await elevatedExec('/usr/sbin/systemsetup', [flag, ...args])
}

// ─── socketfilterfw (Application Firewall) helpers ──────────

const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw'

async function socketfilterfwGet(flag: string): Promise<string> {
  const { stdout } = await execFileAsync(SOCKETFILTERFW, [flag], { timeout: 5_000 })
  return stdout.trim()
}

async function socketfilterfwSet(flag: string, value: string): Promise<void> {
  await elevatedExec(SOCKETFILTERFW, [flag, value])
}

// ─── Sysctl helpers (macOS) ─────────────────────────────────

const SYSCTL_CONF = '/etc/sysctl.conf'

async function sysctlGet(param: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', param], { timeout: 5_000 })
  return stdout.trim()
}

async function sysctlApply(param: string, value: string): Promise<void> {
  // Apply live first — fail fast if the kernel rejects the value
  await elevatedExec('/usr/sbin/sysctl', ['-w', `${param}=${value}`])

  // Persist to /etc/sysctl.conf (macOS uses a single file, not .d/)
  let existing = ''
  try {
    existing = await readFile(SYSCTL_CONF, 'utf8')
  } catch { /* file doesn't exist yet */ }

  const updated = updateSysctlConfig(
    existing, param, value, '=',
    '# Delete this file and reboot to revert all changes',
  )

  await elevatedWriteFile(SYSCTL_CONF, updated)
}

// ─── App detection helper (for browser settings) ───────────
// Uses mdfind (Spotlight metadata) to locate apps by bundle identifier,
// so installs in ~/Applications, other volumes, or renamed bundles are found.

async function isBrowserInstalled(bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`], { timeout: 5_000 })
    return stdout.trim().length > 0
  } catch { return false }
}

// ─── SSH config helper (macOS) ──────────────────────────────

async function applySshdDirective(directive: string, value: string): Promise<void> {
  const content = await readFile('/etc/ssh/sshd_config', 'utf8')
  const updated = updateSshdConfig(content, directive, value)
  await elevatedWriteFile('/etc/ssh/sshd_config', updated)
  // Reload sshd via launchctl
  try {
    await elevatedExec('/bin/launchctl', ['kickstart', '-k', 'system/com.openssh.sshd'])
  } catch {
    await elevatedExec('/bin/launchctl', ['stop', 'com.openssh.sshd']).catch(() => {})
  }
}

const DARWIN_PRIVACY_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-diagnostics',
    category: 'telemetry',
    label: 'Diagnostic & Usage Data',
    description: 'Disable sharing diagnostic and usage data with Apple',
    requiresAdmin: true,
    async check() {
      try {
        const val = await defaultsRead('/Library/Application Support/CrashReporter/DiagnosticMessagesHistory', 'AutoSubmit')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await elevatedDefaultsWrite('/Library/Application Support/CrashReporter/DiagnosticMessagesHistory', 'AutoSubmit', 'bool', 'false')
    },
  },
  {
    id: 'macos-siri-analytics',
    category: 'telemetry',
    label: 'Siri Analytics',
    description: 'Disable Siri analytics and improvement data collection',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.assistant.support', 'Siri Data Sharing Opt-In Status')
        return val === '2' // 2 = opted out
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.assistant.support', 'Siri Data Sharing Opt-In Status', 'int', '2')
    },
  },
  {
    id: 'macos-health-data-sharing',
    category: 'telemetry',
    label: 'Health Data Sharing',
    description: 'Disable sharing health data with Apple for research',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.HealthKit', 'ResearchDataSharingEnabled')
        return val === '0'
      } catch {
        // Key doesn't exist = not sharing = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite('com.apple.HealthKit', 'ResearchDataSharingEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-recent-files',
    category: 'services',
    label: 'Recent Files in Finder',
    description: 'Disable tracking of recently accessed files',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.finder', 'FXRecentFolders')
        return val === '0' || val === '()'
      } catch {
        // Key doesn't exist = we deleted it = setting is applied
        return true
      }
    },
    async apply() {
      await execFileAsync('/usr/bin/defaults', ['delete', 'com.apple.finder', 'FXRecentFolders'], { timeout: 5_000 }).catch(() => {})
    },
  },
  {
    id: 'macos-airdrop-discoverability',
    category: 'services',
    label: 'AirDrop Discoverability',
    description: 'Set AirDrop to "No One" — you will not be able to receive files via AirDrop until re-enabled in System Settings',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.sharingd', 'DiscoverableMode')
        return val === 'Off'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.sharingd', 'DiscoverableMode', 'string', 'Off')
    },
  },
  {
    id: 'macos-crash-reporter',
    category: 'telemetry',
    label: 'Crash Reporter',
    description: 'Set crash reporter to not send reports automatically',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.CrashReporter', 'DialogType')
        return val === 'none'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.CrashReporter', 'DialogType', 'string', 'none')
    },
  },
]

// ─── Ads & Suggestions ──────────────────────────────────────

const DARWIN_ADS_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-ad-tracking',
    category: 'ads',
    label: 'Personalized Ads',
    description: 'Limit ad tracking by Apple',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.AdLib', 'allowApplePersonalizedAdvertising')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.AdLib', 'allowApplePersonalizedAdvertising', 'bool', 'false')
    },
  },
  {
    id: 'macos-siri-suggestions-appstore',
    category: 'ads',
    label: 'Siri Suggestions in App Store',
    description: 'Disable Siri Suggestions in the App Store',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.AppStore', 'SiriSuggestionsEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.AppStore', 'SiriSuggestionsEnabled', 'bool', 'false')
    },
  },
]

// ─── Search ─────────────────────────────────────────────────

const DARWIN_SEARCH_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-safari-suggestions',
    category: 'search',
    label: 'Safari Suggestions',
    description: 'Disable Safari search suggestions sent to Apple',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'UniversalSearchEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'UniversalSearchEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-spotlight-suggestions',
    category: 'search',
    label: 'Spotlight Suggestions',
    description: 'Disable Spotlight web suggestions',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.lookup.shared', 'LookupSuggestionsDisabled')
        return val === '1'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.lookup.shared', 'LookupSuggestionsDisabled', 'bool', 'true')
    },
  },
  {
    id: 'macos-safari-preload-top-hit',
    category: 'search',
    label: 'Safari Preload Top Hit',
    description: 'Disable Safari preloading the top search hit which sends browsing data to sites',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'PreloadTopHit')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'PreloadTopHit', 'bool', 'false')
    },
  },
]

// ─── Sync & Cloud ───────────────────────────────────────────

const DARWIN_SYNC_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-handoff',
    category: 'sync',
    label: 'Handoff',
    description: 'Disable Handoff and Universal Clipboard — you will no longer be able to continue activities or copy/paste between Apple devices',
    requiresAdmin: false,
    async check() {
      try {
        const { stdout } = await execFileAsync('/usr/bin/defaults', ['-currentHost', 'read', 'com.apple.coreservices.useractivityd', 'ActivityReceivingAllowed'], { timeout: 5_000 })
        return stdout.trim() === '0'
      } catch { return false }
    },
    async apply() {
      await execFileAsync('/usr/bin/defaults', ['-currentHost', 'write', 'com.apple.coreservices.useractivityd', 'ActivityReceivingAllowed', '-bool', 'false'], { timeout: 5_000 })
    },
  },
  {
    id: 'macos-icloud-analytics',
    category: 'sync',
    label: 'iCloud Analytics',
    description: 'Disable iCloud analytics sharing with Apple',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.iCloud.Diagnostics', 'iCloudAnalyticsEnabled')
        return val === '0'
      } catch {
        // Key doesn't exist = not sharing = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite('com.apple.iCloud.Diagnostics', 'iCloudAnalyticsEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-safari-cloud-tabs',
    category: 'sync',
    label: 'Safari iCloud Tabs',
    description: 'Disable Safari iCloud tab syncing — you will no longer see tabs open on your other Apple devices',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'CloudTabsEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'CloudTabsEnabled', 'bool', 'false')
    },
  },
]

// ─── AI Features ────────────────────────────────────────────

const DARWIN_AI_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-siri-enabled',
    category: 'ai',
    label: 'Siri',
    description: 'Disable Siri entirely — Hey Siri, voice commands, and Siri Shortcuts will stop working',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.assistant.support', 'Assistant Enabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.assistant.support', 'Assistant Enabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-siri-dictation',
    category: 'ai',
    label: 'Siri Dictation',
    description: 'Disable dictation — the microphone key on your keyboard will stop working',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.speech.recognition.AppleSpeechRecognition.prefs', 'DictationIMMEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.speech.recognition.AppleSpeechRecognition.prefs', 'DictationIMMEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-apple-intelligence',
    category: 'ai',
    label: 'Apple Intelligence',
    description: 'Disable Apple Intelligence AI features (macOS 15 Sequoia and later)',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.assistant.support', 'Apple Intelligence Enabled')
        return val === '0'
      } catch {
        // Key doesn't exist = feature not available = privacy-friendly
        return true
      }
    },
    async apply() {
      await defaultsWrite('com.apple.assistant.support', 'Apple Intelligence Enabled', 'bool', 'false')
    },
  },
]

// ─── Browser Telemetry ──────────────────────────────────────

const CHROME_BUNDLE_ID = 'com.google.Chrome'
const FIREFOX_BUNDLE_ID = 'org.mozilla.firefox'
const MANAGED_PREFS = '/Library/Managed Preferences'

const DARWIN_BROWSER_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-safari-dnt',
    category: 'browser',
    label: 'Safari Do Not Track',
    description: 'Enable the Do Not Track header in Safari',
    requiresAdmin: false,
    async check() {
      try {
        const val = await defaultsRead('com.apple.Safari', 'SendDoNotTrackHTTPHeader')
        return val === '1'
      } catch { return false }
    },
    async apply() {
      await defaultsWrite('com.apple.Safari', 'SendDoNotTrackHTTPHeader', 'bool', 'true')
    },
  },
  {
    id: 'macos-chrome-metrics',
    category: 'browser',
    label: 'Chrome Metrics Reporting',
    description: 'Stop Chrome from sending usage metrics to Google',
    requiresAdmin: true,
    async check() {
      if (!await isBrowserInstalled(CHROME_BUNDLE_ID)) return true
      try {
        const val = await defaultsRead(`${MANAGED_PREFS}/com.google.Chrome`, 'MetricsReportingEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/bin/mkdir', ['-p', MANAGED_PREFS])
      await elevatedDefaultsWrite(`${MANAGED_PREFS}/com.google.Chrome`, 'MetricsReportingEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-chrome-safe-browsing',
    category: 'browser',
    label: 'Chrome Safe Browsing Reports',
    description: 'Stop Chrome from sending extended URL and download reports to Google',
    requiresAdmin: true,
    async check() {
      if (!await isBrowserInstalled(CHROME_BUNDLE_ID)) return true
      try {
        const val = await defaultsRead(`${MANAGED_PREFS}/com.google.Chrome`, 'SafeBrowsingExtendedReportingEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/bin/mkdir', ['-p', MANAGED_PREFS])
      await elevatedDefaultsWrite(`${MANAGED_PREFS}/com.google.Chrome`, 'SafeBrowsingExtendedReportingEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-firefox-telemetry',
    category: 'browser',
    label: 'Firefox Telemetry',
    description: 'Disable Firefox telemetry data collection and upload to Mozilla',
    requiresAdmin: true,
    async check() {
      if (!await isBrowserInstalled(FIREFOX_BUNDLE_ID)) return true
      try {
        const val = await defaultsRead(`${MANAGED_PREFS}/org.mozilla.firefox`, 'DisableTelemetry')
        return val === '1'
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/bin/mkdir', ['-p', MANAGED_PREFS])
      await elevatedDefaultsWrite(`${MANAGED_PREFS}/org.mozilla.firefox`, 'DisableTelemetry', 'bool', 'true')
    },
  },
]

// ─── Kernel / System Hardening ──────────────────────────────

const DARWIN_KERNEL_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-gatekeeper',
    category: 'kernel',
    label: 'Gatekeeper',
    description: 'Ensure Gatekeeper is enabled to block unverified applications',
    requiresAdmin: true,
    async check() {
      try {
        const { stdout, stderr } = await execFileAsync('/usr/sbin/spctl', ['--status'], { timeout: 5_000 })
        const out = (stdout + stderr).trim()
        return out.includes('assessments enabled')
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/usr/sbin/spctl', ['--master-enable'])
    },
  },
  {
    id: 'macos-remote-apple-events',
    category: 'kernel',
    label: 'Remote Apple Events',
    description: 'Disable remote Apple Events to prevent remote automation of your Mac',
    requiresAdmin: true,
    async check() {
      try {
        const out = await systemsetupGet('-getremoteappleevents')
        return out.toLowerCase().includes('off')
      } catch { return false }
    },
    async apply() {
      await systemsetupSet('-setremoteappleevents', 'off')
    },
  },
  {
    id: 'macos-wake-on-network',
    category: 'kernel',
    label: 'Wake on Network Access',
    description: 'Disable wake on network access to prevent remote wake-ups',
    requiresAdmin: true,
    async check() {
      try {
        const out = await systemsetupGet('-getwakeonnetworkaccess')
        return out.toLowerCase().includes('off')
      } catch { return false }
    },
    async apply() {
      await systemsetupSet('-setwakeonnetworkaccess', 'off')
    },
  },
  {
    id: 'macos-guest-account',
    category: 'kernel',
    label: 'Guest Account',
    description: 'Disable the guest account to prevent unauthorized local access',
    requiresAdmin: true,
    async check() {
      try {
        const val = await defaultsRead('/Library/Preferences/com.apple.loginwindow', 'GuestEnabled')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await elevatedDefaultsWrite('/Library/Preferences/com.apple.loginwindow', 'GuestEnabled', 'bool', 'false')
    },
  },
  {
    id: 'macos-auto-login',
    category: 'kernel',
    label: 'Automatic Login',
    description: 'Disable automatic login to require authentication at startup',
    requiresAdmin: true,
    async check() {
      try {
        const val = await defaultsRead('/Library/Preferences/com.apple.loginwindow', 'autoLoginUser')
        // If the key exists and has a value, auto-login is enabled
        return !val || val.length === 0
      } catch {
        // Key doesn't exist = auto-login is disabled = good
        return true
      }
    },
    async apply() {
      await elevatedDefaultsDelete('/Library/Preferences/com.apple.loginwindow', 'autoLoginUser').catch(() => {})
    },
  },
]

// ─── Network Hardening ──────────────────────────────────────

const DARWIN_NETWORK_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-firewall',
    category: 'network',
    label: 'Application Firewall',
    description: 'Enable the macOS Application Firewall to control incoming connections',
    requiresAdmin: true,
    async check() {
      try {
        const out = await socketfilterfwGet('--getglobalstate')
        return out.toLowerCase().includes('enabled')
      } catch { return false }
    },
    async apply() {
      await socketfilterfwSet('--setglobalstate', 'on')
    },
  },
  {
    id: 'macos-stealth-mode',
    category: 'network',
    label: 'Stealth Mode',
    description: 'Enable stealth mode so your Mac does not respond to probe requests (ICMP ping)',
    requiresAdmin: true,
    dependsOn: 'macos-firewall',
    async check() {
      try {
        const out = await socketfilterfwGet('--getstealthmode')
        return out.toLowerCase().includes('enabled')
      } catch { return false }
    },
    async apply() {
      await socketfilterfwSet('--setstealthmode', 'on')
    },
  },
  {
    id: 'macos-ip-forwarding',
    category: 'network',
    label: 'Disable IP Forwarding',
    description: 'Prevent the system from forwarding packets between network interfaces',
    requiresAdmin: true,
    async check() {
      try {
        return (await sysctlGet('net.inet.ip.forwarding')) === '0'
      } catch { return false }
    },
    async apply() {
      await sysctlApply('net.inet.ip.forwarding', '0')
    },
  },
  {
    id: 'macos-block-signed-auto',
    category: 'network',
    label: 'Block Signed App Auto-Allow',
    description: 'Prevent signed applications from automatically bypassing the firewall',
    requiresAdmin: true,
    dependsOn: 'macos-firewall',
    async check() {
      try {
        const out = await socketfilterfwGet('--getallowsigned')
        // Output has two lines (built-in + download). Hardened = neither says "enabled"
        return !out.toLowerCase().includes('enabled')
      } catch { return false }
    },
    async apply() {
      // Must disable both built-in and downloaded signed app auto-allow
      await socketfilterfwSet('--setallowsignedapp', 'off')
      await socketfilterfwSet('--setallowsigned', 'off')
    },
  },
]

// ─── Access Control ─────────────────────────────────────────

const DARWIN_ACCESS_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'macos-remote-login',
    category: 'access',
    label: 'Disable Remote Login (SSH)',
    description: 'Disable the SSH server entirely. If you need SSH access, leave this off and harden SSH settings instead',
    requiresAdmin: true,
    async check() {
      try {
        const out = await systemsetupGet('-getremotelogin')
        return out.toLowerCase().includes('off')
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/usr/sbin/systemsetup', ['-f', '-setremotelogin', 'off'])
    },
  },
  {
    id: 'macos-ssh-root-login',
    category: 'access',
    label: 'Disable SSH Root Login',
    description: 'Prevent direct root login over SSH — use sudo from a regular account instead',
    requiresAdmin: true,
    async check() {
      try {
        const content = await readFile('/etc/ssh/sshd_config', 'utf8')
        return /^\s*PermitRootLogin\s+no\s*$/m.test(content)
      } catch { return false }
    },
    async apply() {
      await applySshdDirective('PermitRootLogin', 'no')
    },
  },
  {
    id: 'macos-ssh-password-auth',
    category: 'access',
    label: 'Disable SSH Password Authentication',
    description: 'Require key-based SSH authentication only. WARNING: ensure SSH keys are configured before enabling or you may be locked out',
    requiresAdmin: true,
    async check() {
      try {
        const content = await readFile('/etc/ssh/sshd_config', 'utf8')
        return /^\s*PasswordAuthentication\s+no\s*$/m.test(content)
      } catch { return false }
    },
    async apply() {
      await applySshdDirective('PasswordAuthentication', 'no')
    },
  },
  {
    id: 'macos-core-dumps',
    category: 'access',
    label: 'Disable Core Dumps',
    description: 'Prevent core dumps to avoid leaking sensitive memory contents',
    requiresAdmin: true,
    async check() {
      try {
        const { stdout } = await execFileAsync('/bin/launchctl', ['limit', 'core'], { timeout: 5_000 })
        // Output format: "\tcore\t\t<soft>\t\t<hard>"
        const parts = stdout.trim().split(/\s+/)
        return parts.length >= 3 && parts[1] === '0' && parts[2] === '0'
      } catch { return false }
    },
    async apply() {
      await elevatedExec('/bin/launchctl', ['limit', 'core', '0', '0'])
    },
  },
]

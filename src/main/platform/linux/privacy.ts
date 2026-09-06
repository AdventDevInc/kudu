import { execFile } from 'child_process'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { promisify } from 'util'
import { updateSshdConfig, updateSysctlConfig, removeSysctlConfigParam } from '../config-utils'
import type { PlatformPrivacy, PrivacySettingDef } from '../types'

const execFileAsync = promisify(execFile)

export function createLinuxPrivacy(): PlatformPrivacy {
  return {
    getSettings(): PrivacySettingDef[] {
      const desktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() ?? ''
      let desktopSettings: PrivacySettingDef[] = []
      if (desktop.includes('gnome') || desktop.includes('unity')) {
        desktopSettings = LINUX_PRIVACY_SETTINGS
      } else if (desktop.includes('kde') || desktop.includes('plasma')) {
        desktopSettings = KDE_PRIVACY_SETTINGS
      }
      return [
        ...desktopSettings,
        ...SYSCTL_KERNEL_SETTINGS,
        ...SYSCTL_NETWORK_SETTINGS,
        ...ACCESS_CONTROL_SETTINGS,
      ]
    },
  }
}

async function gsettingsGet(schema: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/gsettings', ['get', schema, key], { timeout: 5_000 })
  return stdout.trim()
}

async function gsettingsSet(schema: string, key: string, value: string): Promise<void> {
  await execFileAsync('/usr/bin/gsettings', ['set', schema, key, value], { timeout: 5_000 })
}

const LINUX_PRIVACY_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'gnome-usage-stats',
    category: 'telemetry',
    label: 'Usage Statistics',
    description: 'Disable GNOME usage statistics collection',
    requiresAdmin: false,
    async check() {
      try {
        const val = await gsettingsGet('org.gnome.desktop.privacy', 'send-software-usage-stats')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await gsettingsSet('org.gnome.desktop.privacy', 'send-software-usage-stats', 'false')
    },
    async revert() {
      await gsettingsSet('org.gnome.desktop.privacy', 'send-software-usage-stats', 'true')
    },
  },
  {
    id: 'gnome-recent-files',
    category: 'services',
    label: 'Recent Files Tracking',
    description: 'Disable tracking of recently used files',
    requiresAdmin: false,
    async check() {
      try {
        const val = await gsettingsGet('org.gnome.desktop.privacy', 'remember-recent-files')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await gsettingsSet('org.gnome.desktop.privacy', 'remember-recent-files', 'false')
    },
    async revert() {
      await gsettingsSet('org.gnome.desktop.privacy', 'remember-recent-files', 'true')
    },
  },
  {
    id: 'gnome-location',
    category: 'telemetry',
    label: 'Location Services',
    description: 'Disable GNOME location services',
    requiresAdmin: false,
    async check() {
      try {
        const val = await gsettingsGet('org.gnome.system.location', 'enabled')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await gsettingsSet('org.gnome.system.location', 'enabled', 'false')
    },
    async revert() {
      await gsettingsSet('org.gnome.system.location', 'enabled', 'true')
    },
  },
  {
    id: 'gnome-crash-reporting',
    category: 'telemetry',
    label: 'Crash Reporting (Apport)',
    description: 'Disable automatic crash report submission',
    requiresAdmin: false,
    async check() {
      try {
        const val = await gsettingsGet('com.ubuntu.update-notifier', 'show-apport-crashes')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await gsettingsSet('com.ubuntu.update-notifier', 'show-apport-crashes', 'false')
    },
    async revert() {
      await gsettingsSet('com.ubuntu.update-notifier', 'show-apport-crashes', 'true')
    },
  },
  {
    id: 'gnome-connectivity-check',
    category: 'telemetry',
    label: 'Connectivity Check',
    description: 'Disable periodic network connectivity checks',
    requiresAdmin: true,
    async check() {
      try {
        // Read the ConnectivityCheckEnabled D-Bus property directly
        const { stdout } = await execFileAsync('/usr/bin/busctl', [
          'get-property', 'org.freedesktop.NetworkManager',
          '/org/freedesktop/NetworkManager',
          'org.freedesktop.NetworkManager',
          'ConnectivityCheckEnabled',
        ], { timeout: 5_000 })
        // busctl returns: "b false" or "b true"
        return stdout.trim().endsWith('false')
      } catch { return false }
    },
    async apply() {
      // Requires writing to NM config — needs root
      await execFileAsync('/usr/bin/busctl', [
        'set-property', 'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        'ConnectivityCheckEnabled', 'b', 'false',
      ], { timeout: 5_000 })
    },
    async revert() {
      await execFileAsync('/usr/bin/busctl', [
        'set-property', 'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        'ConnectivityCheckEnabled', 'b', 'true',
      ], { timeout: 5_000 })
    },
  },
]

// ─── KDE Plasma helpers ──────────────────────────────────

async function kdeConfigRead(file: string, group: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/kreadconfig5', [
    '--file', file, '--group', group, '--key', key,
  ], { timeout: 5_000 })
  return stdout.trim()
}

async function kdeConfigWrite(file: string, group: string, key: string, value: string): Promise<void> {
  await execFileAsync('/usr/bin/kwriteconfig5', [
    '--file', file, '--group', group, '--key', key, value,
  ], { timeout: 5_000 })
}

// ─── Sysctl helpers ─────────────────────────────────────────

const SYSCTL_CONF = '/etc/sysctl.d/99-kudu.conf'

async function sysctlGet(param: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', param], { timeout: 5_000 })
  return stdout.trim()
}

async function sysctlApply(param: string, value: string): Promise<void> {
  // Apply live first — if the kernel rejects the parameter we fail fast
  // WITHOUT writing it to the persistent config.
  await execFileAsync('/usr/sbin/sysctl', ['-w', `${param}=${value}`], { timeout: 5_000 })

  // Live apply succeeded — now persist to the drop-in config file
  let existing = ''
  try {
    existing = await readFile(SYSCTL_CONF, 'utf8')
  } catch { /* file doesn't exist yet */ }

  const updated = updateSysctlConfig(
    existing, param, value, ' = ',
    '# Remove this file and run "sysctl --system" to revert all changes',
  )

  await mkdir('/etc/sysctl.d', { recursive: true })
  await writeFile(SYSCTL_CONF, updated, 'utf8')
}

async function sysctlRevert(param: string, softValue: string): Promise<void> {
  // Live write may fail (e.g. irreversible bpf=1); still clear the drop-in.
  await execFileAsync('/usr/sbin/sysctl', ['-w', `${param}=${softValue}`], { timeout: 5_000 })
    .catch(() => {})
  let existing = ''
  try {
    existing = await readFile(SYSCTL_CONF, 'utf8')
  } catch {
    return
  }
  const updated = removeSysctlConfigParam(existing, param)
  const hasAssignment = updated.split('\n').some((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('#') && t.includes('=')
  })
  if (!hasAssignment) {
    await unlink(SYSCTL_CONF).catch(() => {})
    return
  }
  await writeFile(SYSCTL_CONF, updated, 'utf8')
}

function sysctlSetting(
  id: string,
  param: string,
  hardenedValue: string,
  softValue: string | null,
  label: string,
  description: string,
  category: 'kernel' | 'network',
): PrivacySettingDef {
  const setting: PrivacySettingDef = {
    id,
    category,
    label,
    description,
    requiresAdmin: true,
    async check() {
      try {
        return (await sysctlGet(param)) === hardenedValue
      } catch { return false }
    },
    async apply() {
      await sysctlApply(param, hardenedValue)
    },
  }
  // Omit revert when soft would be below the kernel default or equal to hardened
  // (toggle would either weaken security or leave check() stuck on).
  if (softValue !== null) {
    setting.revert = async () => {
      await sysctlRevert(param, softValue)
    }
  }
  return setting
}

// ─── Kernel Hardening (sysctl) ──────────────────────────────

const SYSCTL_KERNEL_SETTINGS: PrivacySettingDef[] = [
  // Omit revert when soft opens an attack path or equals the common distro default.
  sysctlSetting(
    'sysctl-aslr', 'kernel.randomize_va_space', '2', null,
    'Address Space Randomization (ASLR)',
    'Enable full randomization of memory address layout to prevent exploitation',
    'kernel',
  ),
  // Soft 1 still hides pointers from non-root (≠ hardened 2); soft 0 would expose them.
  sysctlSetting(
    'sysctl-kptr-restrict', 'kernel.kptr_restrict', '2', '1',
    'Kernel Pointer Restriction',
    'Hide kernel pointer addresses from all users to prevent information leaks',
    'kernel',
  ),
  sysctlSetting(
    'sysctl-dmesg-restrict', 'kernel.dmesg_restrict', '1', null,
    'Restrict dmesg Access',
    'Restrict kernel log (dmesg) access to root only',
    'kernel',
  ),
  sysctlSetting(
    'sysctl-ptrace-scope', 'kernel.yama.ptrace_scope', '1', null,
    'Ptrace Scope Restriction',
    'Restrict process tracing to parent processes only (requires Yama LSM)',
    'kernel',
  ),
  // Harden to 2 (reversible); value 1 cannot be cleared until reboot.
  sysctlSetting(
    'sysctl-unprivileged-bpf', 'kernel.unprivileged_bpf_disabled', '2', null,
    'Disable Unprivileged BPF',
    'Prevent unprivileged users from loading BPF programs',
    'kernel',
  ),
]

// ─── Network Hardening (sysctl) ─────────────────────────────

const SYSCTL_NETWORK_SETTINGS: PrivacySettingDef[] = [
  sysctlSetting(
    'sysctl-tcp-syncookies', 'net.ipv4.tcp_syncookies', '1', null,
    'TCP SYN Cookie Protection',
    'Enable SYN cookies to protect against SYN flood denial-of-service attacks',
    'network',
  ),
  sysctlSetting(
    'sysctl-icmp-broadcast', 'net.ipv4.icmp_echo_ignore_broadcasts', '1', null,
    'Ignore ICMP Broadcasts',
    'Ignore ICMP echo requests sent to broadcast addresses (Smurf attack defense)',
    'network',
  ),
  sysctlSetting(
    'sysctl-rp-filter', 'net.ipv4.conf.all.rp_filter', '1', null,
    'Reverse Path Filtering',
    'Enable strict source address verification to prevent IP spoofing',
    'network',
  ),
  // Soft 1 re-enables ICMP redirect MITM — same policy as source-route.
  sysctlSetting(
    'sysctl-accept-redirects', 'net.ipv4.conf.all.accept_redirects', '0', null,
    'Reject ICMP Redirects',
    'Reject ICMP redirect messages that could be used to alter routing tables',
    'network',
  ),
  sysctlSetting(
    'sysctl-source-route', 'net.ipv4.conf.all.accept_source_route', '0', null,
    'Reject Source-Routed Packets',
    'Reject packets with source routing options that bypass normal routing',
    'network',
  ),
  sysctlSetting(
    'sysctl-log-martians', 'net.ipv4.conf.all.log_martians', '1', '0',
    'Log Martian Packets',
    'Log packets arriving with impossible source addresses for security auditing',
    'network',
  ),
  sysctlSetting(
    'sysctl-ipv6-redirects', 'net.ipv6.conf.all.accept_redirects', '0', null,
    'Reject IPv6 ICMP Redirects',
    'Reject IPv6 ICMP redirect messages to prevent routing table manipulation',
    'network',
  ),
]

// ─── SSH config helper ──────────────────────────────────────

/**
 * Safely set an sshd_config directive by commenting out ALL existing
 * occurrences (commented or active) and appending a single canonical line.
 * This avoids the bug where a later uncommented line shadows our change.
 */
async function applySshdDirective(directive: string, value: string): Promise<void> {
  const content = await readFile('/etc/ssh/sshd_config', 'utf8')
  const updated = updateSshdConfig(content, directive, value)
  await writeFile('/etc/ssh/sshd_config', updated, 'utf8')
  // Reload sshd — service name varies by distro
  try {
    await execFileAsync('/usr/bin/systemctl', ['reload', 'sshd'], { timeout: 10_000 })
  } catch {
    await execFileAsync('/usr/bin/systemctl', ['reload', 'ssh'], { timeout: 10_000 })
  }
}

// ─── Access Control Settings ────────────────────────────────

const ACCESS_CONTROL_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'core-dump-disable',
    category: 'access',
    label: 'Disable Core Dumps',
    description: 'Prevent core dumps to avoid leaking sensitive memory contents',
    requiresAdmin: true,
    async check() {
      try {
        const suid = await sysctlGet('fs.suid_dumpable')
        if (suid !== '0') return false
        const content = await readFile('/etc/security/limits.d/99-kudu.conf', 'utf8')
        return content.includes('* hard core 0')
      } catch { return false }
    },
    async apply() {
      await sysctlApply('fs.suid_dumpable', '0')
      await mkdir('/etc/security/limits.d', { recursive: true })
      await writeFile('/etc/security/limits.d/99-kudu.conf', '* hard core 0\n', 'utf8')
    },
    async revert() {
      await sysctlRevert('fs.suid_dumpable', '0')
      await unlink('/etc/security/limits.d/99-kudu.conf').catch(() => {})
    },
  },
  {
    id: 'ssh-root-login',
    category: 'access',
    label: 'Disable SSH Root Login',
    description: 'Prevent direct root login over SSH — use sudo from a regular account instead',
    requiresAdmin: true,
    async check() {
      try {
        const content = await readFile('/etc/ssh/sshd_config', 'utf8')
        // Match uncommented PermitRootLogin no (allowing whitespace variants)
        return /^\s*PermitRootLogin\s+no\s*$/m.test(content)
      } catch { return false }
    },
    async apply() {
      await applySshdDirective('PermitRootLogin', 'no')
    },
    async revert() {
      await applySshdDirective('PermitRootLogin', 'prohibit-password')
    },
  },
  {
    id: 'ssh-password-auth',
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
    async revert() {
      await applySshdDirective('PasswordAuthentication', 'yes')
    },
  },
]

const KDE_PRIVACY_SETTINGS: PrivacySettingDef[] = [
  {
    id: 'kde-usage-stats',
    category: 'telemetry',
    label: 'Usage Statistics',
    description: 'Disable KDE Plasma user feedback',
    requiresAdmin: false,
    async check() {
      try {
        const val = await kdeConfigRead('PlasmaUserFeedback', 'Global', 'FeedbackLevel')
        return val === '0'
      } catch { return false }
    },
    async apply() {
      await kdeConfigWrite('PlasmaUserFeedback', 'Global', 'FeedbackLevel', '0')
    },
    async revert() {
      await kdeConfigWrite('PlasmaUserFeedback', 'Global', 'FeedbackLevel', '1')
    },
  },
  {
    id: 'kde-recent-files',
    category: 'services',
    label: 'Recent Files Tracking',
    description: 'Disable KDE activity history for recent files',
    requiresAdmin: false,
    async check() {
      try {
        const val = await kdeConfigRead('kactivitymanagerdrc', 'Plugins', 'org.kde.ActivityManager.ResourceScoringEnabled')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await kdeConfigWrite('kactivitymanagerdrc', 'Plugins', 'org.kde.ActivityManager.ResourceScoringEnabled', 'false')
    },
    async revert() {
      await kdeConfigWrite('kactivitymanagerdrc', 'Plugins', 'org.kde.ActivityManager.ResourceScoringEnabled', 'true')
    },
  },
  {
    id: 'kde-baloo',
    category: 'services',
    label: 'File Indexing (Baloo)',
    description: 'Disable Baloo file indexer',
    requiresAdmin: false,
    async check() {
      try {
        const val = await kdeConfigRead('baloofilerc', 'Basic Settings', 'Indexing-Enabled')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await kdeConfigWrite('baloofilerc', 'Basic Settings', 'Indexing-Enabled', 'false')
    },
    async revert() {
      await kdeConfigWrite('baloofilerc', 'Basic Settings', 'Indexing-Enabled', 'true')
    },
  },
  {
    id: 'kde-crash-reporting',
    category: 'telemetry',
    label: 'Crash Reporting (DrKonqi)',
    description: 'Disable KDE crash report handler',
    requiresAdmin: false,
    async check() {
      try {
        const val = await kdeConfigRead('drkonqirc', 'General', 'Enabled')
        return val === 'false'
      } catch { return false }
    },
    async apply() {
      await kdeConfigWrite('drkonqirc', 'General', 'Enabled', 'false')
    },
    async revert() {
      await kdeConfigWrite('drkonqirc', 'General', 'Enabled', 'true')
    },
  },
]

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, stat, readdir } from 'fs/promises'
import type { PlatformSecurity } from '../types'
import type { HealthReport } from '../../services/cloud-agent-types'

const execFileAsync = promisify(execFile)

let cachedIsServer: boolean | null = null
let cachedIsServerAt = 0
const IS_SERVER_TTL_MS = 24 * 60 * 60_000 // re-check daily

async function isServerMode(): Promise<boolean> {
  if (cachedIsServer !== null && Date.now() - cachedIsServerAt < IS_SERVER_TTL_MS) return cachedIsServer
  try {
    const { stdout } = await execFileAsync('systemctl', ['get-default'], { timeout: 5_000 })
    const target = stdout.trim()
    if (target === 'multi-user.target') {
      cachedIsServer = true
    } else if (target === 'graphical.target') {
      // graphical.target can be set even on headless servers (e.g. Ubuntu with
      // desktop packages installed but no display server running).  Check if a
      // graphical session is actually active via loginctl.
      cachedIsServer = !(await hasGraphicalSession())
    } else {
      cachedIsServer = true // rescue, emergency, etc.
    }
  } catch {
    cachedIsServer = !process.env.XDG_SESSION_TYPE || process.env.XDG_SESSION_TYPE === 'tty'
  }
  cachedIsServerAt = Date.now()
  return cachedIsServer
}

/** Return true if loginctl reports at least one x11 or wayland session. */
async function hasGraphicalSession(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'loginctl', ['list-sessions', '--no-legend', '--no-pager'],
      { timeout: 5_000 },
    )
    // Each line is: SESSION UID USER SEAT TTY
    // Fetch the Type property for each session id.
    for (const line of stdout.trim().split('\n')) {
      const sessionId = line.trim().split(/\s+/)[0]
      if (!sessionId) continue
      try {
        const { stdout: typeLine } = await execFileAsync(
          'loginctl', ['show-session', sessionId, '--property=Type', '--value'],
          { timeout: 3_000 },
        )
        const t = typeLine.trim()
        if (t === 'x11' || t === 'wayland') return true
      } catch { /* skip individual session errors */ }
    }
  } catch { /* loginctl not available — fall through */ }
  return false
}

/** Check multiple candidate paths and return the first that exists, or null. */
async function findBinary(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await stat(p)
      return p
    } catch { /* not at this path */ }
  }
  return null
}

export function createLinuxSecurity(): PlatformSecurity {
  return {
    isServer: isServerMode,
    async collectAntivirusStatus(): Promise<HealthReport['securityPosture']['antivirus']> {
      const products: HealthReport['securityPosture']['antivirus']['products'] = []
      let primary: string | null = null

      // Check for ClamAV by probing known install paths directly
      const clamscanPaths = ['/usr/bin/clamscan', '/usr/local/bin/clamscan', '/bin/clamscan']
      for (const clamscanPath of clamscanPaths) {
        try {
          const { stdout: version } = await execFileAsync(clamscanPath, ['--version'], { timeout: 5_000 })
          products.push({
            name: `ClamAV (${version.trim().split('\n')[0]})`,
            enabled: true,
            realTimeProtection: false,
            signatureUpToDate: true,
          })
          primary = 'ClamAV'
          break
        } catch { /* not at this path */ }
      }

      // SELinux detection
      try {
        const { stdout } = await execFileAsync('/usr/sbin/getenforce', [], { timeout: 5_000 })
        const mode = stdout.trim() // "Enforcing", "Permissive", or "Disabled"
        products.push({
          name: `SELinux (${mode})`,
          enabled: mode === 'Enforcing',
          realTimeProtection: mode === 'Enforcing',
          signatureUpToDate: true,
        })
      } catch { /* not installed */ }

      // AppArmor detection
      try {
        const { stdout } = await execFileAsync('/usr/sbin/aa-status', ['--json'], { timeout: 5_000 })
        const data = JSON.parse(stdout)
        const profiles = data.profiles ?? {}
        const enforced = Object.values(profiles).filter((v: unknown) => v === 'enforce').length
        products.push({
          name: `AppArmor (${enforced} profiles enforcing)`,
          enabled: enforced > 0,
          realTimeProtection: enforced > 0,
          signatureUpToDate: true,
        })
      } catch { /* not installed */ }

      return { products, primary }
    },

    async collectFirewallStatus(): Promise<HealthReport['securityPosture']['firewall']> {
      const noProfiles = { domain: false, private: false, public: false }

      // UFW (Ubuntu/Debian front-end)
      try {
        const { stdout } = await execFileAsync('/usr/sbin/ufw', ['status'], { timeout: 10_000 })
        const enabled = stdout.includes('Status: active')
        return { enabled, products: [{ name: 'UFW', enabled }], windowsProfiles: noProfiles }
      } catch { /* not available */ }

      // firewalld (Fedora/RHEL/CentOS)
      try {
        const { stdout } = await execFileAsync('/usr/bin/firewall-cmd', ['--state'], { timeout: 10_000 })
        const enabled = stdout.trim() === 'running'
        return { enabled, products: [{ name: 'firewalld', enabled }], windowsProfiles: noProfiles }
      } catch { /* not available */ }

      // nftables (modern default on Debian 11+, Ubuntu 22.04+, Fedora, RHEL 9+)
      try {
        const { stdout } = await execFileAsync('/usr/sbin/nft', ['list', 'ruleset'], { timeout: 10_000 })
        // If there are any tables defined, nftables is active
        const enabled = stdout.includes('table ')
        return { enabled, products: [{ name: 'nftables', enabled }], windowsProfiles: noProfiles }
      } catch { /* not available */ }

      // iptables (legacy fallback)
      try {
        const { stdout } = await execFileAsync('/usr/sbin/iptables', ['-L', '-n'], { timeout: 10_000 })
        // If there are rules beyond default ACCEPT policies, consider it enabled
        const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('Chain') && !l.startsWith('target'))
        const enabled = lines.length > 0
        return { enabled, products: [{ name: 'iptables', enabled }], windowsProfiles: noProfiles }
      } catch {
        return { enabled: false, products: [], windowsProfiles: noProfiles }
      }
    },

    async collectDiskEncryptionStatus(): Promise<HealthReport['securityPosture']['bitlocker']> {
      try {
        const { stdout } = await execFileAsync('/usr/bin/lsblk', [
          '-J', '-o', 'NAME,TYPE,FSTYPE,MOUNTPOINT',
        ], { timeout: 10_000 })

        const data = JSON.parse(stdout)
        const volumes: HealthReport['securityPosture']['bitlocker']['volumes'] = []

        function walk(devices: any[]): void {
          for (const dev of devices) {
            if (dev.type === 'crypt' || dev.fstype === 'crypto_LUKS') {
              volumes.push({
                mount: dev.mountpoint ?? dev.name ?? '',
                status: 'FullyEncrypted',
                protectionOn: true,
              })
            }
            if (dev.children) walk(dev.children)
          }
        }

        walk(data.blockdevices ?? [])
        return { volumes }
      } catch {
        return { volumes: [] }
      }
    },

    async collectUpdateStatus(): Promise<HealthReport['securityPosture']['windowsUpdate']> {
      type UpdateResult = HealthReport['securityPosture']['windowsUpdate']
      let result: UpdateResult = { recentPatches: [], lastPatchDate: null, daysSinceLastPatch: null }

      // Try to detect the last package update time
      try {
        // APT-based systems
        const aptLog = '/var/log/apt/history.log'
        const aptStat = await stat(aptLog).catch(() => null)
        if (aptStat) {
          const lastPatchDate = aptStat.mtime.toISOString().split('T')[0]
          const daysSinceLastPatch = Math.floor((Date.now() - aptStat.mtime.getTime()) / (1000 * 60 * 60 * 24))
          result = {
            recentPatches: [{ id: 'apt', installedOn: lastPatchDate, description: 'Last APT update' }],
            lastPatchDate,
            daysSinceLastPatch,
          }
        }
      } catch { /* try dnf */ }

      if (result.recentPatches.length === 0) {
        try {
          const { stdout } = await execFileAsync('/usr/bin/dnf', ['history', '--json'], { timeout: 15_000 })
          const history = JSON.parse(stdout)
          if (Array.isArray(history) && history.length > 0) {
            const latest = history[0]
            const date = latest.date ?? ''
            result = {
              recentPatches: [{ id: String(latest.id ?? ''), installedOn: date, description: latest.command ?? '' }],
              lastPatchDate: date,
              daysSinceLastPatch: date ? Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)) : null,
            }
          }
        } catch { /* try pacman */ }
      }

      if (result.recentPatches.length === 0) {
        try {
          const { stdout } = await execFileAsync('/usr/bin/tail', ['-1', '/var/log/pacman.log'], { timeout: 5_000 })
          const match = stdout.match(/\[(\d{4}-\d{2}-\d{2})/)
          if (match) {
            const lastPatchDate = match[1]
            const daysSinceLastPatch = Math.floor((Date.now() - new Date(lastPatchDate).getTime()) / (1000 * 60 * 60 * 24))
            result = {
              recentPatches: [{ id: 'pacman', installedOn: lastPatchDate, description: 'Last pacman transaction' }],
              lastPatchDate,
              daysSinceLastPatch,
            }
          }
        } catch { /* ignore */ }
      }

      // Check for automatic update configuration
      try {
        const content = await readFile('/etc/apt/apt.conf.d/20auto-upgrades', 'utf-8')
        const autoEnabled = content.includes('APT::Periodic::Unattended-Upgrade "1"')
        result.recentPatches.push({
          id: 'auto-updates',
          installedOn: '',
          description: autoEnabled ? 'Unattended upgrades: enabled' : 'Unattended upgrades: disabled',
        })
      } catch {
        // Try dnf-automatic
        try {
          const { stdout } = await execFileAsync('/usr/bin/systemctl', ['is-enabled', 'dnf-automatic.timer'], { timeout: 5_000 })
          const autoEnabled = stdout.trim() === 'enabled'
          result.recentPatches.push({
            id: 'auto-updates',
            installedOn: '',
            description: autoEnabled ? 'dnf-automatic: enabled' : 'dnf-automatic: disabled',
          })
        } catch { /* not available */ }
      }

      return result
    },

    async collectScreenLockStatus(): Promise<HealthReport['securityPosture']['screenLock']> {
      // GNOME settings
      try {
        const [lockResult, delayResult] = await Promise.allSettled([
          execFileAsync('/usr/bin/gsettings', ['get', 'org.gnome.desktop.screensaver', 'lock-enabled'], { timeout: 5_000 }),
          execFileAsync('/usr/bin/gsettings', ['get', 'org.gnome.desktop.session', 'idle-delay'], { timeout: 5_000 }),
        ])

        const lockEnabled = lockResult.status === 'fulfilled' && lockResult.value.stdout.trim() === 'true'
        let timeoutSec: number | null = null
        if (delayResult.status === 'fulfilled') {
          const match = delayResult.value.stdout.match(/uint32\s+(\d+)/)
          timeoutSec = match ? parseInt(match[1], 10) : null
        }

        return {
          screenSaverEnabled: timeoutSec !== null && timeoutSec > 0,
          lockOnResume: lockEnabled,
          timeoutSec,
          inactivityLockSec: null,
        }
      } catch {
        return { screenSaverEnabled: false, lockOnResume: false, timeoutSec: null, inactivityLockSec: null }
      }
    },

    async collectPasswordPolicy(): Promise<HealthReport['securityPosture']['passwordPolicy']> {
      let minLength = 0
      let maxAgeDays = 0
      let minAgeDays = 0
      let complexityRequired = false
      let lockoutThreshold = 0
      let lockoutDurationMin = 0

      // Parse /etc/login.defs
      try {
        const content = await readFile('/etc/login.defs', 'utf-8')
        const getVal = (key: string): number => {
          const match = content.match(new RegExp(`^${key}\\s+(\\d+)`, 'm'))
          return match ? parseInt(match[1], 10) : 0
        }
        minLength = getVal('PASS_MIN_LEN')
        maxAgeDays = getVal('PASS_MAX_DAYS')
        minAgeDays = getVal('PASS_MIN_DAYS')
      } catch { /* ignore */ }

      // Parse /etc/security/pwquality.conf for complexity rules
      try {
        const content = await readFile('/etc/security/pwquality.conf', 'utf-8')
        const getQVal = (key: string): number => {
          const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(-?\\d+)`, 'm'))
          return match ? parseInt(match[1], 10) : 0
        }
        const pwqMinLen = getQVal('minlen')
        if (pwqMinLen > minLength) minLength = pwqMinLen
        // Negative credit values mean that many characters of that class are required
        const dcredit = getQVal('dcredit')
        const ucredit = getQVal('ucredit')
        const lcredit = getQVal('lcredit')
        const ocredit = getQVal('ocredit')
        complexityRequired = dcredit < 0 || ucredit < 0 || lcredit < 0 || ocredit < 0
      } catch { /* pwquality not configured */ }

      // Parse /etc/security/faillock.conf for account lockout
      try {
        const content = await readFile('/etc/security/faillock.conf', 'utf-8')
        const getFlVal = (key: string): number => {
          const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))
          return match ? parseInt(match[1], 10) : 0
        }
        lockoutThreshold = getFlVal('deny')
        lockoutDurationMin = Math.ceil(getFlVal('unlock_time') / 60)
      } catch { /* not configured */ }

      return {
        minLength,
        maxAgeDays,
        minAgeDays,
        historyCount: 0,
        complexityRequired,
        lockoutThreshold,
        lockoutDurationMin,
        lockoutObservationMin: 0,
        windowsHello: { enrolled: false, faceEnabled: false, fingerprintEnabled: false, pinEnabled: false },
      }
    },

    async collectSshHardening(): Promise<HealthReport['securityPosture']['sshHardening']> {
      const isServer = await isServerMode()

      // Check if sshd is installed
      let sshdInstalled = false
      try {
        await stat('/usr/sbin/sshd')
        sshdInstalled = true
      } catch {
        try {
          await stat('/usr/bin/sshd')
          sshdInstalled = true
        } catch { /* not installed */ }
      }

      if (!sshdInstalled) {
        return {
          isServer,
          sshdInstalled: false,
          passwordAuthDisabled: false,
          rootLoginDisabled: false,
          pubkeyAuthEnabled: false,
          emptyPasswordsDisabled: false,
          protocol2Only: true,
        }
      }

      // Parse sshd_config and drop-ins (drop-ins override the main file)
      const config = new Map<string, string>()

      async function parseSshdConfig(path: string): Promise<void> {
        try {
          const content = await readFile(path, 'utf-8')
          for (const line of content.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            // Match directives with optional "Match" blocks — we only care about global scope
            if (/^match\s/i.test(trimmed)) break // stop at first Match block
            const match = trimmed.match(/^(\S+)\s+(.+)/)
            if (match) {
              config.set(match[1].toLowerCase(), match[2].trim())
            }
          }
        } catch { /* file not readable */ }
      }

      // Main config first
      await parseSshdConfig('/etc/ssh/sshd_config')

      // Then drop-ins (alphabetical order, later files override)
      try {
        const dropInDir = '/etc/ssh/sshd_config.d'
        const files = await readdir(dropInDir)
        const confFiles = files.filter(f => f.endsWith('.conf')).sort()
        for (const f of confFiles) {
          await parseSshdConfig(`${dropInDir}/${f}`)
        }
      } catch { /* no drop-in directory */ }

      const getVal = (key: string): string | undefined => config.get(key.toLowerCase())

      const passwordAuth = getVal('passwordauthentication')
      const rootLogin = getVal('permitrootlogin')
      const pubkeyAuth = getVal('pubkeyauthentication')
      const emptyPasswords = getVal('permitemptypasswords')
      const protocol = getVal('protocol')

      return {
        isServer,
        sshdInstalled: true,
        passwordAuthDisabled: passwordAuth === 'no',
        rootLoginDisabled: rootLogin === 'no' || rootLogin === 'prohibit-password',
        pubkeyAuthEnabled: pubkeyAuth !== 'no', // defaults to yes
        emptyPasswordsDisabled: emptyPasswords !== 'yes', // defaults to no
        protocol2Only: !protocol || protocol === '2', // modern sshd only supports 2
      }
    },

    async collectFail2ban(): Promise<HealthReport['securityPosture']['fail2ban']> {
      if (!(await isServerMode())) return null

      const f2bPath = await findBinary(['/usr/bin/fail2ban-client', '/usr/local/bin/fail2ban-client'])
      if (!f2bPath) {
        return { installed: false, active: false, jails: [], totalBannedIps: 0 }
      }

      // Check if service is active
      let active = false
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', 'fail2ban'], { timeout: 5_000 })
        active = stdout.trim() === 'active'
      } catch { /* not running */ }

      if (!active) {
        return { installed: true, active: false, jails: [], totalBannedIps: 0 }
      }

      // Get jail list and banned counts
      const jails: string[] = []
      let totalBannedIps = 0
      try {
        const { stdout } = await execFileAsync(f2bPath, ['status'], { timeout: 10_000 })
        const jailMatch = stdout.match(/Jail list:\s*(.+)/i)
        if (jailMatch) {
          const names = jailMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          jails.push(...names)
        }

        // Get banned count per jail (parallel)
        const jailResults = await Promise.allSettled(
          jails.map(jail =>
            execFileAsync(f2bPath, ['status', jail], { timeout: 5_000 })
          ),
        )
        for (const r of jailResults) {
          if (r.status !== 'fulfilled') continue
          const bannedMatch = r.value.stdout.match(/Currently banned:\s*(\d+)/i)
          if (bannedMatch) totalBannedIps += parseInt(bannedMatch[1], 10)
        }
      } catch { /* couldn't query jails */ }

      return { installed: true, active: true, jails, totalBannedIps }
    },

    async collectListeningPorts(): Promise<HealthReport['securityPosture']['listeningPorts']> {
      if (!(await isServerMode())) return null

      const result: NonNullable<HealthReport['securityPosture']['listeningPorts']> = []

      try {
        // ss -tlnp for TCP, ss -ulnp for UDP
        const [tcp, udp] = await Promise.allSettled([
          execFileAsync('ss', ['-tlnp'], { timeout: 10_000 }),
          execFileAsync('ss', ['-ulnp'], { timeout: 10_000 }),
        ])

        function parseLocalAddr(raw: string): { address: string; port: number } | null {
          // Formats: "0.0.0.0:22", "[::1]:22", ":::22" (IPv6 wildcard), "*:22"
          // Bracket-enclosed IPv6
          const bracketMatch = raw.match(/^\[(.+)\]:(\d+)$/)
          if (bracketMatch) return { address: bracketMatch[1], port: parseInt(bracketMatch[2], 10) }
          // IPv6 wildcard ":::port" — address is "::", port after last colon
          const ipv6Wild = raw.match(/^:::(\d+)$/)
          if (ipv6Wild) return { address: '::', port: parseInt(ipv6Wild[1], 10) }
          // IPv4 or "*:port" — split on last colon
          const lastColon = raw.lastIndexOf(':')
          if (lastColon === -1) return null
          const port = parseInt(raw.slice(lastColon + 1), 10)
          if (isNaN(port)) return null
          return { address: raw.slice(0, lastColon), port }
        }

        function parseSsOutput(output: string, protocol: 'tcp' | 'udp'): void {
          const lines = output.split('\n').slice(1) // skip header
          for (const line of lines) {
            if (!line.trim()) continue
            // Fields: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
            const parts = line.trim().split(/\s+/)
            // Local address is at index 3 for both TCP and UDP
            const localAddr = parts[3]
            if (!localAddr) continue
            const parsed = parseLocalAddr(localAddr)
            if (!parsed) continue

            // Parse process info — may span multiple whitespace-split parts
            let pid: number | null = null
            let process: string | null = null
            const fullLine = line.trim()
            const usersIdx = fullLine.indexOf('users:')
            if (usersIdx !== -1) {
              const usersStr = fullLine.slice(usersIdx)
              const pidMatch = usersStr.match(/pid=(\d+)/)
              const nameMatch = usersStr.match(/\("([^"]+)"/)
              if (pidMatch) pid = parseInt(pidMatch[1], 10)
              if (nameMatch) process = nameMatch[1]
            }

            result.push({ address: parsed.address, port: parsed.port, protocol, pid, process })
          }
        }

        if (tcp.status === 'fulfilled') parseSsOutput(tcp.value.stdout, 'tcp')
        if (udp.status === 'fulfilled') parseSsOutput(udp.value.stdout, 'udp')
      } catch { /* ss not available */ }

      return result
    },

    async collectAuditd(): Promise<HealthReport['securityPosture']['auditd']> {
      if (!(await isServerMode())) return null

      const auditdPath = await findBinary(['/usr/sbin/auditd', '/sbin/auditd'])
      if (!auditdPath) {
        return { installed: false, active: false, ruleCount: 0 }
      }

      let active = false
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', 'auditd'], { timeout: 5_000 })
        active = stdout.trim() === 'active'
      } catch { /* not running */ }

      let ruleCount = 0
      if (active) {
        // auditctl lives alongside auditd in the same directory
        const auditctlPath = await findBinary(['/usr/sbin/auditctl', '/sbin/auditctl'])
        if (auditctlPath) {
          try {
            const { stdout } = await execFileAsync(auditctlPath, ['-l'], { timeout: 10_000 })
            // Each non-empty line is a rule; "No rules" means 0
            const lines = stdout.split('\n').filter(l => l.trim() && !l.includes('No rules'))
            ruleCount = lines.length
          } catch { /* couldn't query rules */ }
        }
      }

      return { installed: true, active, ruleCount }
    },

    async collectSuidSgidBinaries(): Promise<HealthReport['securityPosture']['suidSgidBinaries']> {
      if (!(await isServerMode())) return null

      const MAX_RESULTS = 200

      // Known system binaries where suid/sgid is expected (both /usr and legacy paths)
      const knownSuidNames = [
        'sudo', 'su', 'passwd', 'chsh', 'chfn', 'newgrp', 'gpasswd',
        'mount', 'umount', 'pkexec', 'crontab', 'at', 'ssh-agent',
        'fusermount', 'fusermount3', 'wall', 'write', 'expiry', 'chage',
      ]
      const knownSuidPaths = new Set([
        // Generate both /usr/bin/ and /bin/ variants for merged/non-merged usr
        ...knownSuidNames.flatMap(n => [`/usr/bin/${n}`, `/bin/${n}`]),
        '/usr/sbin/unix_chkpwd', '/sbin/unix_chkpwd',
        '/usr/sbin/pam_timestamp_check', '/sbin/pam_timestamp_check',
        '/usr/lib/dbus-1.0/dbus-daemon-launch-helper',
        '/usr/lib/openssh/ssh-keysign',
        '/usr/libexec/openssh/ssh-keysign',
      ])

      const result: NonNullable<HealthReport['securityPosture']['suidSgidBinaries']> = []
      const seen = new Set<string>()

      // Two parallel scans:
      // 1) System binary dirs — flat scan, where legitimate suid lives (filter known-safe)
      // 2) Attacker hiding spots — deeper scan, any suid here is suspicious
      const suidPerm = ['(', '-perm', '-4000', '-o', '-perm', '-2000', ')']
      const [binScan, hidingScan] = await Promise.allSettled([
        execFileAsync('find', [
          '/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin',
          '/bin', '/sbin',
          '-xdev', '-maxdepth', '1',
          '-type', 'f',
          ...suidPerm,
        ], { timeout: 15_000 }),
        execFileAsync('find', [
          '/tmp', '/var/tmp', '/dev/shm',
          '/opt', '/home',
          '/var/www', '/srv',
          '-xdev', '-maxdepth', '3',
          '-type', 'f',
          ...suidPerm,
        ], { timeout: 15_000 }),
      ])

      // find exits non-zero if any listed dir doesn't exist, but still writes
      // valid results to stdout. Extract stdout from both fulfilled and rejected results.
      function extractFindOutput(r: PromiseSettledResult<{ stdout: string }>): string[] {
        if (r.status === 'fulfilled') return r.value.stdout.split('\n').filter(Boolean)
        const err = r.reason as { stdout?: string } | undefined
        if (err?.stdout) return err.stdout.split('\n').filter(Boolean)
        return []
      }

      const allPaths: string[] = [
        ...extractFindOutput(binScan),
        ...extractFindOutput(hidingScan),
      ]

      for (const filePath of allPaths) {
        if (result.length >= MAX_RESULTS) break

        // Resolve real path first for dedup and allowlist checks on merged-usr systems
        let resolved = filePath
        try {
          const { stdout: realPath } = await execFileAsync('realpath', [filePath], { timeout: 2_000 })
          resolved = realPath.trim()
        } catch { /* use original path */ }

        if (seen.has(resolved)) continue
        seen.add(resolved)
        if (knownSuidPaths.has(filePath) || knownSuidPaths.has(resolved)) continue

        try {
          const fileStat = await stat(filePath)
          const mode = fileStat.mode
          const suid = (mode & 0o4000) !== 0
          const sgid = (mode & 0o2000) !== 0
          if (!suid && !sgid) continue

          // Get owner name via stat -c '%U' (works with UIDs, unlike id -nu)
          let owner = String(fileStat.uid)
          try {
            const { stdout: statOut } = await execFileAsync('/usr/bin/stat', ['-c', '%U', filePath], { timeout: 2_000 })
            owner = statOut.trim()
          } catch { /* use numeric uid */ }

          result.push({ path: filePath, suid, sgid, owner })
        } catch { /* can't stat, skip */ }
      }

      return result
    },

    async collectLinuxFirewallStatus(): Promise<HealthReport['securityPosture']['firewallStatus']> {
      type FwTool = NonNullable<HealthReport['securityPosture']['firewallStatus']>['tool']
      const CMD_TIMEOUT = 5_000
      const RAW_RULES_MAX = 3_000

      /** Parse unique port numbers from matches. */
      function uniquePorts(ports: number[]): number[] {
        return [...new Set(ports)].sort((a, b) => a - b)
      }

      // ── 1. ufw (front-end) ──────────────────────────────
      // Only return when ufw is actively enforcing. An inactive ufw can mask
      // a backend firewall (nftables/iptables from Docker, k8s, cloud-init).
      const ufwPath = await findBinary(['/usr/sbin/ufw', '/usr/bin/ufw'])
      if (ufwPath) {
        try {
          const { stdout } = await execFileAsync(ufwPath, ['status', 'verbose'], { timeout: CMD_TIMEOUT })
          if (/^Status:\s*active/m.test(stdout)) {
            const rawRules = stdout.slice(0, RAW_RULES_MAX)
            const allowedPorts: number[] = []
            for (const m of stdout.matchAll(/^\s*(\d+)(?:\/\w+)?\s+ALLOW/gm)) {
              allowedPorts.push(parseInt(m[1], 10))
            }
            return { tool: 'ufw' as FwTool, active: true, allowedPorts: uniquePorts(allowedPorts), rawRules }
          }
        } catch { /* ufw failed — fall through */ }
      }

      // ── 2. firewalld (front-end) ──────────────────────────
      // Same fall-through logic: only return when firewalld is running.
      const fwCmdPath = await findBinary(['/usr/bin/firewall-cmd', '/usr/sbin/firewall-cmd'])
      if (fwCmdPath) {
        let active = false
        try {
          const { stdout } = await execFileAsync('systemctl', ['is-active', 'firewalld'], { timeout: CMD_TIMEOUT })
          active = stdout.trim() === 'active'
        } catch { /* not active */ }

        if (active) {
          let rawRules = ''
          const allowedPorts: number[] = []
          try {
            // Query all zones so interfaces/sources bound to non-default zones
            // are included.  Falls back to --list-all if --list-all-zones fails.
            let stdout: string
            try {
              ({ stdout } = await execFileAsync(fwCmdPath, ['--list-all-zones'], { timeout: CMD_TIMEOUT }))
            } catch {
              ({ stdout } = await execFileAsync(fwCmdPath, ['--list-all'], { timeout: CMD_TIMEOUT }))
            }
            rawRules = stdout.slice(0, RAW_RULES_MAX)

            // Parse "ports:" line — e.g. "ports: 8080/tcp 9090/udp"
            const portsLine = stdout.match(/^\s*ports:\s*(.+)/m)
            if (portsLine) {
              for (const m of portsLine[1].matchAll(/(\d+)\/\w+/g)) {
                allowedPorts.push(parseInt(m[1], 10))
              }
            }

            // Parse "services:" line — map common service names to ports
            const serviceMap: Record<string, number> = {
              ssh: 22, http: 80, https: 443, ftp: 21, smtp: 25, dns: 53,
              'imap': 143, 'imaps': 993, 'pop3': 110, 'pop3s': 995,
              'ntp': 123, 'mysql': 3306, 'postgresql': 5432, 'redis': 6379,
            }
            const servicesLine = stdout.match(/^\s*services:\s*(.+)/m)
            if (servicesLine) {
              for (const svc of servicesLine[1].trim().split(/\s+/)) {
                const port = serviceMap[svc]
                if (port) allowedPorts.push(port)
              }
            }
          } catch { /* couldn't list rules */ }

          return { tool: 'firewalld' as FwTool, active: true, allowedPorts: uniquePorts(allowedPorts), rawRules }
        }
      }

      // ── 3. nftables ───────────────────────────────────────
      // Detect from ruleset content, not systemd — rules may be loaded by
      // boot scripts or cloud-init while nftables.service is inactive.
      // Only consider the firewall active if there is a chain hooked into the
      // input path (type filter hook input); nat-only or dormant tables don't
      // count.  Parse allowed ports only from those input chains.
      const nftPath = await findBinary(['/usr/sbin/nft', '/usr/bin/nft'])
      if (nftPath) {
        let active = false
        let rawRules = ''
        const allowedPorts: number[] = []

        try {
          const { stdout } = await execFileAsync(nftPath, ['list', 'ruleset'], { timeout: CMD_TIMEOUT })
          rawRules = stdout.slice(0, RAW_RULES_MAX)

          // Split ruleset into per-chain blocks so we can scope parsing
          // to input-facing filter chains only.
          const chainBlocks: string[] = []
          let current = ''
          for (const line of stdout.split('\n')) {
            if (/\bchain\s+\w+\s*\{/.test(line)) {
              if (current) chainBlocks.push(current)
              current = ''
            }
            current += line + '\n'
          }
          if (current) chainBlocks.push(current)

          for (const block of chainBlocks) {
            if (!/type\s+filter\s+hook\s+input\b/.test(block)) continue
            // A filter chain hooked into input means nftables is actively filtering
            active = true

            for (const line of block.split('\n')) {
              if (!/\baccept\b/i.test(line)) continue
              // Set syntax: "tcp dport { 22, 80, 443 }" / "udp dport { 53, 123 }"
              for (const m of line.matchAll(/(?:tcp|udp)\s+dport\s*\{([^}]+)\}/g)) {
                for (const p of m[1].matchAll(/(\d+)/g)) {
                  allowedPorts.push(parseInt(p[1], 10))
                }
              }
              // Single-port syntax: "tcp dport 22" / "udp dport 51820"
              for (const m of line.matchAll(/(?:tcp|udp)\s+dport\s+(\d+)/g)) {
                allowedPorts.push(parseInt(m[1], 10))
              }
            }
          }
        } catch { /* nft not usable — skip */ }

        // Only return from the nftables branch if it is actually filtering
        // input.  Otherwise fall through to iptables — some hosts ship nft
        // by default but enforce ingress rules via iptables-legacy.
        if (active) {
          return { tool: 'nftables' as FwTool, active, allowedPorts: uniquePorts(allowedPorts), rawRules }
        }
      }

      // ── 4. iptables ───────────────────────────────────────
      const iptablesPath = await findBinary(['/usr/sbin/iptables', '/sbin/iptables'])
      if (iptablesPath) {
        let active = false
        let rawRules = ''
        const allowedPorts: number[] = []

        try {
          const { stdout } = await execFileAsync(iptablesPath, ['-L', 'INPUT', '-n', '--line-numbers'], { timeout: CMD_TIMEOUT })
          rawRules = stdout.slice(0, RAW_RULES_MAX)

          // A non-ACCEPT default policy means the firewall is filtering even without explicit rules
          const policyMatch = stdout.match(/^Chain INPUT \(policy (\w+)\)/m)
          const hasNonAcceptPolicy = policyMatch != null && policyMatch[1] !== 'ACCEPT'

          const ruleLines = stdout.split('\n').filter(l => {
            const trimmed = l.trim()
            return trimmed && !trimmed.startsWith('Chain ') && !trimmed.startsWith('num ')
              && !trimmed.startsWith('target ')
          })
          active = hasNonAcceptPolicy || ruleLines.length > 0

          if (active) {
            // Parse ACCEPT rules:
            //   single port  — "dpt:22"
            //   port range   — "dpts:80:443"
            //   multiport    — "multiport dports 80,443,8080"
            for (const line of ruleLines) {
              if (!/\bACCEPT\b/.test(line)) continue
              // Multiport comma list: "multiport dports 80,443,8080"
              const mpMatch = line.match(/multiport\s+dports\s+([\d,]+)/)
              if (mpMatch) {
                for (const p of mpMatch[1].split(',')) {
                  const n = parseInt(p, 10)
                  if (!isNaN(n)) allowedPorts.push(n)
                }
              }
              // Single port: dpt:22
              for (const m of line.matchAll(/dpt:(\d+)/g)) {
                allowedPorts.push(parseInt(m[1], 10))
              }
              // Port range: dpts:80:443
              for (const m of line.matchAll(/dpts:(\d+):(\d+)/g)) {
                const lo = parseInt(m[1], 10)
                const hi = parseInt(m[2], 10)
                for (let p = lo; p <= hi && p - lo < 100; p++) {
                  allowedPorts.push(p)
                }
              }
            }
          }
        } catch { /* iptables failed — treat as not found */ }

        return { tool: 'iptables' as FwTool, active, allowedPorts: uniquePorts(allowedPorts), rawRules }
      }

      // ── 5. none ────────────────────────────────────────────
      return { tool: 'none' as FwTool, active: false, allowedPorts: [], rawRules: '' }
    },
  }
}

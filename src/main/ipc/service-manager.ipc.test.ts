import { describe, it, expect } from 'vitest'

// ── Test the pure helper functions from service-manager.ipc.ts ──
// These are replicated here to avoid importing the Electron-dependent module.

// ── normalizeStartType (replica) ──

type ServiceStartType = 'Automatic' | 'AutomaticDelayed' | 'Manual' | 'Disabled' | 'Boot' | 'System'

function normalizeStartType(raw: string): ServiceStartType {
  const lower = raw.toLowerCase().trim()
  if (lower === 'auto' || lower === 'automatic') return 'Automatic'
  if (lower === 'autodelayed' || lower === 'automaticdelayed') return 'AutomaticDelayed'
  if (lower === 'manual') return 'Manual'
  if (lower === 'disabled') return 'Disabled'
  if (lower === 'boot') return 'Boot'
  if (lower === 'system') return 'System'
  return 'Manual'
}

describe('normalizeStartType', () => {
  it('normalizes "Auto" to "Automatic"', () => {
    expect(normalizeStartType('Auto')).toBe('Automatic')
  })

  it('normalizes "Automatic" to "Automatic"', () => {
    expect(normalizeStartType('Automatic')).toBe('Automatic')
  })

  it('normalizes "AutoDelayed" to "AutomaticDelayed"', () => {
    expect(normalizeStartType('AutoDelayed')).toBe('AutomaticDelayed')
  })

  it('normalizes "AutomaticDelayed" to "AutomaticDelayed"', () => {
    expect(normalizeStartType('AutomaticDelayed')).toBe('AutomaticDelayed')
  })

  it('normalizes "Manual" to "Manual"', () => {
    expect(normalizeStartType('Manual')).toBe('Manual')
  })

  it('normalizes "Disabled" to "Disabled"', () => {
    expect(normalizeStartType('Disabled')).toBe('Disabled')
  })

  it('normalizes "Boot" to "Boot"', () => {
    expect(normalizeStartType('Boot')).toBe('Boot')
  })

  it('normalizes "System" to "System"', () => {
    expect(normalizeStartType('System')).toBe('System')
  })

  it('is case-insensitive', () => {
    expect(normalizeStartType('AUTO')).toBe('Automatic')
    expect(normalizeStartType('MANUAL')).toBe('Manual')
    expect(normalizeStartType('DISABLED')).toBe('Disabled')
    expect(normalizeStartType('autodelayed')).toBe('AutomaticDelayed')
  })

  it('trims whitespace', () => {
    expect(normalizeStartType('  Auto  ')).toBe('Automatic')
    expect(normalizeStartType('\tManual\n')).toBe('Manual')
  })

  it('defaults to "Manual" for unknown values', () => {
    expect(normalizeStartType('unknown')).toBe('Manual')
    expect(normalizeStartType('')).toBe('Manual')
    expect(normalizeStartType('foobar')).toBe('Manual')
  })
})

// ── normalizeStatus (replica) ──

type ServiceStatus = 'Running' | 'Stopped' | 'StartPending' | 'StopPending' | 'Paused' | 'Unknown'

function normalizeStatus(raw: string): ServiceStatus {
  const lower = raw.toLowerCase().trim()
  if (lower === 'running') return 'Running'
  if (lower === 'stopped') return 'Stopped'
  if (lower === 'startpending') return 'StartPending'
  if (lower === 'stoppending') return 'StopPending'
  if (lower === 'paused') return 'Paused'
  return 'Unknown'
}

describe('normalizeStatus', () => {
  it('normalizes "Running"', () => {
    expect(normalizeStatus('Running')).toBe('Running')
  })

  it('normalizes "Stopped"', () => {
    expect(normalizeStatus('Stopped')).toBe('Stopped')
  })

  it('normalizes "StartPending"', () => {
    expect(normalizeStatus('StartPending')).toBe('StartPending')
  })

  it('normalizes "StopPending"', () => {
    expect(normalizeStatus('StopPending')).toBe('StopPending')
  })

  it('normalizes "Paused"', () => {
    expect(normalizeStatus('Paused')).toBe('Paused')
  })

  it('is case-insensitive', () => {
    expect(normalizeStatus('RUNNING')).toBe('Running')
    expect(normalizeStatus('stopped')).toBe('Stopped')
  })

  it('trims whitespace', () => {
    expect(normalizeStatus('  Running  ')).toBe('Running')
  })

  it('returns "Unknown" for unrecognized values', () => {
    expect(normalizeStatus('unknown')).toBe('Unknown')
    expect(normalizeStatus('')).toBe('Unknown')
    expect(normalizeStatus('bogus')).toBe('Unknown')
  })
})

// ── Service name validation (mirrors applyServiceChanges) ──

const SERVICE_NAME_RE = /^[A-Za-z0-9_.\-]{1,256}$/

describe('service name validation', () => {
  it('accepts simple service names', () => {
    expect(SERVICE_NAME_RE.test('WSearch')).toBe(true)
    expect(SERVICE_NAME_RE.test('SysMain')).toBe(true)
    expect(SERVICE_NAME_RE.test('wuauserv')).toBe(true)
  })

  it('accepts names with dots, underscores, hyphens', () => {
    expect(SERVICE_NAME_RE.test('My.Service_Name-1')).toBe(true)
  })

  it('rejects empty name', () => {
    expect(SERVICE_NAME_RE.test('')).toBe(false)
  })

  it('rejects names longer than 256 characters', () => {
    expect(SERVICE_NAME_RE.test('A'.repeat(257))).toBe(false)
  })

  it('accepts names at exactly 256 characters', () => {
    expect(SERVICE_NAME_RE.test('A'.repeat(256))).toBe(true)
  })

  it('rejects names with spaces', () => {
    expect(SERVICE_NAME_RE.test('My Service')).toBe(false)
  })

  it('rejects names with shell injection characters', () => {
    expect(SERVICE_NAME_RE.test('svc; rm -rf /')).toBe(false)
    expect(SERVICE_NAME_RE.test('svc|evil')).toBe(false)
    expect(SERVICE_NAME_RE.test('svc`cmd`')).toBe(false)
    expect(SERVICE_NAME_RE.test("svc' OR 1=1")).toBe(false)
    expect(SERVICE_NAME_RE.test('svc&evil')).toBe(false)
  })

  it('rejects names with path separators', () => {
    expect(SERVICE_NAME_RE.test('path\\svc')).toBe(false)
    expect(SERVICE_NAME_RE.test('path/svc')).toBe(false)
  })
})

// ── applyServiceChanges input validation logic ──

describe('applyServiceChanges input validation', () => {
  it('returns empty result for empty changes array', () => {
    const changes: { name: string; targetStartType: string }[] = []
    const result = !Array.isArray(changes) || changes.length === 0
      ? { succeeded: 0, failed: 0, errors: [] }
      : null
    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
  })

  it('returns empty result for non-array input', () => {
    const changes = 'not an array' as any
    const result = !Array.isArray(changes) || changes.length === 0
      ? { succeeded: 0, failed: 0, errors: [] }
      : null
    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
  })

  it('rejects invalid service name in changes', () => {
    const changes = [{ name: 'valid', targetStartType: 'Manual' }, { name: 'inv@lid!', targetStartType: 'Disabled' }]
    let error: string | null = null
    for (const c of changes) {
      if (typeof c.name !== 'string' || typeof c.targetStartType !== 'string') {
        error = 'Invalid change entry'
        break
      }
      if (!SERVICE_NAME_RE.test(c.name)) {
        error = 'Invalid service name'
        break
      }
    }
    expect(error).toBe('Invalid service name')
  })

  it('rejects non-string name in change entry', () => {
    const changes = [{ name: 123 as any, targetStartType: 'Manual' }]
    let error: string | null = null
    for (const c of changes) {
      if (typeof c.name !== 'string' || typeof c.targetStartType !== 'string') {
        error = 'Invalid change entry'
        break
      }
    }
    expect(error).toBe('Invalid change entry')
  })

  it('sanitizes targetStartType to Manual or Disabled only', () => {
    // The source coerces: Manual stays Manual, everything else becomes Disabled
    const safeType = (t: string) => t === 'Manual' ? 'Manual' : 'Disabled'
    expect(safeType('Manual')).toBe('Manual')
    expect(safeType('Disabled')).toBe('Disabled')
    expect(safeType('Automatic')).toBe('Disabled')
    expect(safeType('evil; rm -rf /')).toBe('Disabled')
  })
})

// ── PowerShell stdout parsing logic ──

describe('service scan stdout parsing', () => {
  it('parses SVC| prefixed lines from PowerShell output', () => {
    const stdout = [
      'SVC|WSearch|Windows Search|Running|Auto|Provides content indexing|True',
      'SVC|Spooler|Print Spooler|Stopped|Manual|Manages print jobs|True',
      'Some other output line',
      'SVC|incomplete'
    ].join('\n')

    const lines = stdout.split('\n').filter((l) => l.startsWith('SVC|'))
    expect(lines).toHaveLength(3) // includes incomplete

    const services: { name: string; displayName: string; status: ServiceStatus; startType: ServiceStartType }[] = []
    for (const line of lines) {
      const parts = line.trim().split('|')
      if (parts.length < 7) continue
      services.push({
        name: parts[1],
        displayName: parts[2],
        status: normalizeStatus(parts[3]),
        startType: normalizeStartType(parts[4])
      })
    }

    expect(services).toHaveLength(2)
    expect(services[0]).toEqual({
      name: 'WSearch',
      displayName: 'Windows Search',
      status: 'Running',
      startType: 'Automatic'
    })
    expect(services[1]).toEqual({
      name: 'Spooler',
      displayName: 'Print Spooler',
      status: 'Stopped',
      startType: 'Manual'
    })
  })

  it('parses dependency output lines', () => {
    const depOut = [
      'DEP|WSearch|RpcSs,RPCSS|SearchUI',
      'DEP|Spooler||',
      'Other line'
    ].join('\n')

    const depMap: Record<string, { dependsOn: string[]; dependents: string[] }> = {}
    for (const line of depOut.split('\n').filter((l) => l.startsWith('DEP|'))) {
      const parts = line.trim().split('|')
      if (parts.length >= 4) {
        depMap[parts[1]] = {
          dependsOn: parts[2] ? parts[2].split(',').filter(Boolean) : [],
          dependents: parts[3] ? parts[3].split(',').filter(Boolean) : []
        }
      }
    }

    expect(depMap['WSearch']).toEqual({
      dependsOn: ['RpcSs', 'RPCSS'],
      dependents: ['SearchUI']
    })
    expect(depMap['Spooler']).toEqual({
      dependsOn: [],
      dependents: []
    })
  })
})

// ── Apply result parsing logic ──

describe('apply result stdout parsing', () => {
  it('counts OK and FAIL lines correctly', () => {
    const stdout = [
      'OK|WSearch|Windows Search',
      'FAIL|Spooler|Print Spooler|Access denied',
      'OK|SysMain|SysMain',
      'some noise'
    ].join('\n')

    let succeeded = 0
    let failed = 0
    const errors: { name: string; displayName: string; reason: string }[] = []

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('OK|')) {
        succeeded++
      } else if (trimmed.startsWith('FAIL|')) {
        failed++
        const parts = trimmed.split('|')
        errors.push({
          name: parts[1] || '',
          displayName: parts[2] || '',
          reason: parts[3] || 'Unknown error'
        })
      }
    }

    expect(succeeded).toBe(2)
    expect(failed).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual({
      name: 'Spooler',
      displayName: 'Print Spooler',
      reason: 'Access denied'
    })
  })

  it('handles empty stdout gracefully', () => {
    const stdout = ''
    let succeeded = 0
    let failed = 0
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('OK|')) succeeded++
      else if (trimmed.startsWith('FAIL|')) failed++
    }
    expect(succeeded).toBe(0)
    expect(failed).toBe(0)
  })
})

// ── Scan result statistics calculation ──

describe('scan result statistics', () => {
  it('correctly calculates running, disabled, and safeToDisable counts', () => {
    const services = [
      { status: 'Running', startType: 'Automatic', safety: 'safe' },
      { status: 'Running', startType: 'Manual', safety: 'caution' },
      { status: 'Stopped', startType: 'Disabled', safety: 'safe' },
      { status: 'Stopped', startType: 'Manual', safety: 'safe' },
      { status: 'Running', startType: 'Automatic', safety: 'unsafe' },
    ]

    const runningCount = services.filter((s) => s.status === 'Running').length
    const disabledCount = services.filter((s) => s.startType === 'Disabled').length
    const safeToDisableCount = services.filter(
      (s) => s.safety === 'safe' && s.startType !== 'Disabled'
    ).length

    expect(runningCount).toBe(3)
    expect(disabledCount).toBe(1)
    expect(safeToDisableCount).toBe(2) // first safe + fourth safe (third is already disabled)
  })
})

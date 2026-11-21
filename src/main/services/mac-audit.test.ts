import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused' }, dialog: {} }))
vi.mock('./mac-tools', () => ({
  requireMacTools() {},
  batteryReport: async () => ({ readings: [] })
}))
vi.mock('../platform', () => ({
  getPlatform: () => ({
    commands: {
      getInstalledApps: async () => {
        throw new Error('Inventory unavailable')
      }
    },
    startup: { listItems: async () => [] },
    security: {
      collectFirewallStatus: async () => ({ enabled: true }),
      collectDiskEncryptionStatus: async () => ({ enabled: true }),
      collectAntivirusStatus: async () => ({ primary: 'XProtect' })
    }
  })
}))
vi.mock('./perf-monitor', () => ({
  PerfMonitorService: class {
    async getSystemInfo() {
      return { osVersion: 'macOS' }
    }
  }
}))
vi.mock('systeminformation', () => ({
  default: {
    fsSize: async () => [{ mount: '/Data', used: 75, size: 100 }],
    networkInterfaces: async () => []
  }
}))
import { auditHtml, createMacAudit } from './mac-audit'

describe('global Mac audit', () => {
  it('escapes all report data and creates bounded storage charts without remote resources', () => {
    const html = auditHtml(
      'Audit <script>',
      'today',
      [{ title: '<unsafe>', available: true, data: { name: '</pre><script>alert(1)</script>' } }],
      [{ label: '"><script>', used: 999, total: 10 }]
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('100.0 %')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('https://')
  })
  it('keeps a partial report when an inventory fails and returns a preview of all sections', async () => {
    const summary = await createMacAudit('fr')
    expect(summary.sections).toHaveLength(9)
    expect(summary.sections.find((section) => section.title === 'Applications')?.available).toBe(
      false
    )
    expect(summary.disks).toEqual([{ label: '/Data', used: 75, total: 100 }])
    expect(summary.id).toBeTruthy()
  })
})

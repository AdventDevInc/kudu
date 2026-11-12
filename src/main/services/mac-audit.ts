import { dialog } from 'electron'
import { randomUUID } from 'crypto'
import { writeFile, rename, rm } from 'fs/promises'
import si from 'systeminformation'
import { getPlatform } from '../platform'
import { PerfMonitorService } from './perf-monitor'
import { batteryReport, requireMacTools } from './mac-tools'

import type { MacAuditSummary } from '../../shared/mac-tools'
interface AuditSection {
  title: string
  available: boolean
  data: unknown
}
let snapshot: { summary: MacAuditSummary; html: string } | null = null

export function escapeAudit(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]!
  )
}

export function auditHtml(
  title: string,
  createdAt: string,
  sections: AuditSection[],
  disks: MacAuditSummary['disks'],
  language: 'fr' | 'en' = 'en'
): string {
  const graphs = disks
    .map((disk) => {
      const percent =
        disk.total > 0 ? Math.max(0, Math.min(100, (disk.used / disk.total) * 100)) : 0
      return `<div class="disk"><strong>${escapeAudit(disk.label)}</strong><p>${percent.toFixed(1)} %</p><div class="track" role="meter" aria-valuenow="${percent.toFixed(1)}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeAudit(disk.label)}"><div style="width:${percent}%"></div></div></div>`
    })
    .join('')
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeAudit(title)}</title><style>
body{font:15px system-ui,sans-serif;color:#202b36;background:#f3f5f7;margin:0;padding:32px}main{max-width:1100px;margin:auto}h1{font-size:32px}section,.disk{background:white;border:1px solid #dce2e8;border-radius:12px;margin:16px 0;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,monospace}.track{background:#e5ebf0;height:12px;border-radius:8px;overflow:hidden}.track>div{height:100%;background:#2363b6}.error{color:#9a3030}@media print{body{padding:0;background:white}section{break-inside:avoid}}
</style></head><body><main><h1>${escapeAudit(title)}</h1><p>${escapeAudit(createdAt)}</p>${graphs}${sections
    .map(
      (section) =>
        `<section><h2>${escapeAudit(section.title)}</h2><pre class="${section.available ? '' : 'error'}">${escapeAudit(JSON.stringify(section.data, null, 2))}</pre></section>`
    )
    .join('')}</main></body></html>`
}

export async function createMacAudit(language: unknown): Promise<MacAuditSummary> {
  requireMacTools()
  const french = typeof language === 'string' && language.startsWith('fr')
  const titles = french
    ? [
        'Système',
        'Stockage',
        'Applications',
        'Démarrage',
        'Réseau',
        'Pare-feu',
        'Chiffrement FileVault',
        'Protection XProtect',
        'Batterie'
      ]
    : [
        'System',
        'Storage',
        'Applications',
        'Startup',
        'Network',
        'Firewall',
        'FileVault encryption',
        'XProtect',
        'Battery'
      ]
  const platform = getPlatform()
  const results = await Promise.allSettled([
    new PerfMonitorService().getSystemInfo(),
    si.fsSize(),
    platform.commands.getInstalledApps(),
    platform.startup.listItems(),
    si.networkInterfaces(),
    platform.security.collectFirewallStatus(),
    platform.security.collectDiskEncryptionStatus(),
    platform.security.collectAntivirusStatus(),
    batteryReport()
  ])
  const sections = results.map((result, index) => ({
    title: titles[index],
    available: result.status === 'fulfilled',
    data: result.status === 'fulfilled' ? result.value : String(result.reason)
  }))
  const diskResult = results[1]
  const disks =
    diskResult.status === 'fulfilled' && Array.isArray(diskResult.value)
      ? (diskResult.value as si.Systeminformation.FsSizeData[]).map((disk) => ({
          label: disk.mount,
          used: disk.used,
          total: disk.size
        }))
      : []
  const createdAt = new Date().toISOString()
  const summary: MacAuditSummary = {
    id: randomUUID(),
    createdAt,
    sections: sections.map(({ title, available }) => ({ title, available })),
    disks
  }
  snapshot = {
    summary,
    html: auditHtml(
      french ? 'Kudu — Audit global du Mac' : 'Kudu — Global Mac audit',
      createdAt,
      sections,
      disks,
      french ? 'fr' : 'en'
    )
  }
  return summary
}

export async function exportMacAudit(id: unknown): Promise<string | null> {
  requireMacTools()
  const current = snapshot
  if (!current || id !== current.summary.id)
    throw new Error('Generate the audit again before exporting.')
  const choice = await dialog.showSaveDialog({
    defaultPath: 'Kudu-Mac-Audit-' + current.summary.createdAt.slice(0, 10) + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (choice.canceled || !choice.filePath) return null
  const temporary = choice.filePath + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, current.html, { mode: 0o600, flag: 'wx' })
    await rename(temporary, choice.filePath)
  } finally {
    await rm(temporary, { force: true })
  }
  return choice.filePath
}

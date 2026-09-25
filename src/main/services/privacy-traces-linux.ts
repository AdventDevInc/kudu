import { join } from 'path'
import {
  deletingTrace,
  listTraceFiles,
  statTraceFile,
  type PrivacyTraceGroup,
  type TraceScanContext
} from './privacy-traces'

/**
 * Desktop recent-file lists. GTK recreates recently-used.xbel when it next
 * records a file, and KDE keeps one .desktop entry per recent document.
 */
export async function findLinuxRecentFileTraces(
  ctx: TraceScanContext
): Promise<PrivacyTraceGroup[]> {
  if (ctx.platform !== 'linux') return []
  const share = join(ctx.home, '.local', 'share')
  const groups: PrivacyTraceGroup[] = []

  const xbelPath = join(share, 'recently-used.xbel')
  const xbel = await statTraceFile(xbelPath)
  if (xbel && xbel.size > 0n) {
    groups.push({
      subcategory: 'Recent files (GNOME/GTK)',
      descriptionKey: 'privacyGtkRecentNote',
      traces: [deletingTrace(xbelPath, xbel)]
    })
  }

  const kde = await listTraceFiles(join(share, 'RecentDocuments'), /\.desktop$/)
  if (kde.length > 0) {
    groups.push({
      subcategory: 'Recent documents (KDE)',
      descriptionKey: 'privacyKdeRecentNote',
      traces: kde.map((f) => deletingTrace(f.path, f.info))
    })
  }
  return groups
}

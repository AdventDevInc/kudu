import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * `Unknown` means reagentc did not report a status we could read — it needs
 * elevation, and its output is localised, so an unrecognised status line is
 * not evidence that WinRE is absent. `error` says why.
 */
export type WinReStatus = 'Enabled' | 'Disabled' | 'Unknown'

export interface WinReInfo {
  status: WinReStatus
  /** Partition / folder path when reported by reagentc; null if absent. */
  location: string | null
  bcdIdentifier: string | null
  /** Set when status is Unknown. */
  error?: string
}

const UNREADABLE =
  'reagentc /info did not report a recognisable status (needs an elevated, English-locale shell)'

/** Pure parser for `reagentc /info` stdout (#395). */
export function parseWinReInfo(stdout: string): WinReInfo {
  const statusMatch = stdout.match(/Windows RE status:\s*(\S+)/i)
  const raw = statusMatch?.[1] ?? ''

  const locationMatch = stdout.match(/Windows RE location:[ \t]*([^\r\n]*)/i)
  const location = locationMatch?.[1]?.trim() || null

  const bcdMatch = stdout.match(/Boot Configuration Data \(BCD\) identifier:\s*([0-9a-fA-F-]{36})/i)
  const bcdIdentifier = bcdMatch?.[1] ?? null

  if (raw === 'Enabled' || raw === 'Disabled') {
    return { status: raw, location, bcdIdentifier }
  }
  return { status: 'Unknown', location, bcdIdentifier, error: UNREADABLE }
}

/** Run reagentc /info. Needs elevation; non-Windows callers should not invoke this. */
export async function getWinReInfo(): Promise<WinReInfo> {
  try {
    const { stdout } = await execFileAsync('reagentc.exe', ['/info'], {
      windowsHide: true,
      timeout: 30_000
    })
    return parseWinReInfo(stdout)
  } catch (err: unknown) {
    const e =
      err && typeof err === 'object'
        ? (err as { stdout?: unknown; stderr?: unknown; message?: unknown })
        : {}
    const stdout = String(e.stdout ?? '')
    if (stdout.trim()) {
      const parsed = parseWinReInfo(stdout)
      if (parsed.status !== 'Unknown') return parsed
    }
    const detail =
      String(e.stderr ?? '').trim() || String(e.message ?? '').trim() || 'reagentc failed'
    return { status: 'Unknown', location: null, bcdIdentifier: null, error: detail }
  }
}

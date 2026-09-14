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
  'reagentc /info did not report a recognisable status (needs an elevated shell)'

/** Map reagentc status tokens (EN + common translations) to the CLI enum. */
const STATUS_BY_TOKEN: Record<string, WinReStatus> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  включено: 'Enabled',
  отключено: 'Disabled'
}

function parseStatusToken(raw: string): WinReStatus | null {
  return STATUS_BY_TOKEN[raw.trim().toLowerCase()] ?? null
}

/**
 * Prefer the value after a colon (`Enabled`/`Disabled` / translations) so
 * localised labels still parse (#444). Fall back to the English label form.
 */
function parseWinReStatus(stdout: string): WinReStatus | null {
  for (const line of stdout.split(/\r?\n/)) {
    const valueMatch = line.match(/:\s*(\S+)\s*$/)
    if (!valueMatch) continue
    const status = parseStatusToken(valueMatch[1])
    if (status) return status
  }

  const labelMatch = stdout.match(/Windows RE status:\s*(\S+)/i)
  return labelMatch ? parseStatusToken(labelMatch[1]) : null
}

/** Pure parser for `reagentc /info` stdout (#395 / #444). */
export function parseWinReInfo(stdout: string): WinReInfo {
  const status = parseWinReStatus(stdout)

  const locationMatch = stdout.match(/Windows RE location:[ \t]*([^\r\n]*)/i)
  const location = locationMatch?.[1]?.trim() || null

  const bcdMatch = stdout.match(/Boot Configuration Data \(BCD\) identifier:\s*([0-9a-fA-F-]{36})/i)
  const bcdIdentifier = bcdMatch?.[1] ?? null

  if (status === 'Enabled' || status === 'Disabled') {
    return { status, location, bcdIdentifier }
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

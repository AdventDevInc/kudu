import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execTracked, psUtf8 } from './exec-utf8'

// Paths per PowerShell process, so a single run stays inside its timeout.
const BATCH_SIZE = 200

// Paths travel through a UTF-8 JSON file rather than the command line, so no
// filename can break out of the script. -Encoding UTF8 matters: Windows
// PowerShell 5.1 otherwise reads the file as ANSI and mangles non-ASCII paths.
const AUTHENTICODE_SCRIPT = `$paths = [string[]](Get-Content -Raw -Encoding UTF8 -LiteralPath '__PATH_FILE__' | ConvertFrom-Json)
$out = @($paths | ForEach-Object {
  $path = [string]$_
  $status = 'UnknownError'
  try { $status = [string](Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop).Status } catch {}
  [PSCustomObject]@{ path = $path; status = $status }
})
ConvertTo-Json -InputObject $out -Compress`

interface VerifyResult {
  path?: unknown
  status?: unknown
}

/**
 * Lower-cased paths whose Authenticode status is `Valid`: signed, untampered,
 * and chaining to a trusted root that has not revoked the certificate.
 */
export function parseAuthenticodeResults(stdout: string): Set<string> {
  const valid = new Set<string>()
  let parsed: VerifyResult[]
  try {
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    parsed = Array.isArray(value) ? value : [value]
  } catch {
    return valid
  }

  for (const result of parsed) {
    if (typeof result?.path === 'string' && result.status === 'Valid') {
      valid.add(result.path.toLowerCase())
    }
  }
  return valid
}

/**
 * Which of `paths` carry a valid Authenticode signature (Windows only).
 * Fails closed: a batch that errors contributes nothing, so its files are
 * treated as unsigned rather than trusted by accident.
 */
export async function findValidlySignedFiles(paths: string[]): Promise<Set<string>> {
  const valid = new Set<string>()
  if (process.platform !== 'win32') return valid
  const uniquePaths = [...new Set(paths)]
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    for (const path of await verifyBatch(uniquePaths.slice(i, i + BATCH_SIZE))) valid.add(path)
  }
  return valid
}

async function verifyBatch(paths: string[]): Promise<Set<string>> {
  let tempDir: string | null = null
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'kudu-authenticode-'))
    const pathFile = join(tempDir, 'paths.json')
    await writeFile(pathFile, JSON.stringify(paths), 'utf8')
    // A replacer function, so a `$` in the temp path is not read as a pattern.
    const script = AUTHENTICODE_SCRIPT.replace('__PATH_FILE__', () => pathFile.replace(/'/g, "''"))
    // Revocation checks can wait on the network, hence the generous timeout.
    const { stdout } = await execTracked(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { windowsHide: true, timeout: 60_000 }
    )
    return parseAuthenticodeResults(stdout)
  } catch {
    return new Set()
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

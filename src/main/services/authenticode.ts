import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execTracked, psUtf8 } from './exec-utf8'

// Paths per PowerShell process, so a single run stays inside its timeout.
const BATCH_SIZE = 200

// Paths travel through a UTF-8 JSON file rather than the command line, so no
// filename can break out of the script. -Encoding UTF8 matters: Windows
// PowerShell 5.1 otherwise reads the file as ANSI and mangles non-ASCII paths.
//
// Each file is held open without FILE_SHARE_WRITE/DELETE while it is hashed
// and verified, so nothing can modify, replace or rename it in between. The
// hash therefore names exactly the bytes Authenticode accepted.
const AUTHENTICODE_SCRIPT = `$paths = [string[]](Get-Content -Raw -Encoding UTF8 -LiteralPath '__PATH_FILE__' | ConvertFrom-Json)
$out = @($paths | ForEach-Object {
  $path = [string]$_
  $status = 'UnknownError'
  $hash = ''
  $fs = $null
  try {
    $fs = [IO.File]::Open($path, 'Open', 'Read', 'Read')
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash($fs)).Replace('-', '').ToLowerInvariant()
    $status = [string](Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop).Status
  } catch {
  } finally {
    if ($fs) { $fs.Dispose() }
  }
  [PSCustomObject]@{ path = $path; status = $status; sha256 = $hash }
})
ConvertTo-Json -InputObject $out -Compress`

interface VerifyResult {
  path?: unknown
  status?: unknown
  sha256?: unknown
}

/**
 * Lower-cased path → SHA-256 of the content, for each file whose Authenticode
 * status is `Valid`: signed, untampered, and chaining to a trusted root that
 * has not revoked the certificate.
 */
export function parseAuthenticodeResults(stdout: string): Map<string, string> {
  const valid = new Map<string, string>()
  let parsed: VerifyResult[]
  try {
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    parsed = Array.isArray(value) ? value : [value]
  } catch {
    return valid
  }

  for (const result of parsed) {
    if (
      typeof result?.path === 'string' &&
      result.status === 'Valid' &&
      typeof result.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(result.sha256)
    ) {
      valid.set(result.path.toLowerCase(), result.sha256)
    }
  }
  return valid
}

/**
 * The files among `paths` that carry a valid Authenticode signature (Windows
 * only), keyed by lower-cased path with the SHA-256 of the verified content.
 * Callers compare that hash with the bytes they analyzed, so a file swapped
 * after analysis cannot borrow another binary's signature.
 *
 * Fails closed: a batch that errors contributes nothing, so its files are
 * treated as unsigned rather than trusted by accident.
 */
export async function findValidlySignedFiles(paths: string[]): Promise<Map<string, string>> {
  const valid = new Map<string, string>()
  if (process.platform !== 'win32') return valid
  const uniquePaths = [...new Set(paths)]
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = await verifyBatch(uniquePaths.slice(i, i + BATCH_SIZE))
    for (const [path, sha256] of batch) valid.set(path, sha256)
  }
  return valid
}

async function verifyBatch(paths: string[]): Promise<Map<string, string>> {
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
    return new Map()
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

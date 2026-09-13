import { scrypt } from 'crypto'
import { getMachineId, getSettings } from './settings-store'
import { diagnosticId, validDiagnosticReport } from '../../shared/performance-diagnostics'
import type {
  DiagnosticCapabilities,
  DiagnosticCloudResult
} from '../../shared/performance-diagnostics'

/** Fixed Kudu endpoint; never use a renderer URL, redirect, or log response bodies. */
export function diagnosticAccount(): Promise<string> {
  return accountFingerprint(getSettings().cloud.apiKey, getMachineId())
}
function accountFingerprint(apiKey: string, deviceId: string): Promise<string> {
  // A salted, purpose-specific credential fingerprint binds consent to the linked
  // account without persisting the API key. Run the KDF off the main thread.
  return new Promise((resolve, reject) => {
    scrypt(apiKey, `kudu-diagnostics-v1:${deviceId}`, 32, (error, key) => {
      if (error) reject(error)
      else resolve(key.toString('hex'))
    })
  })
}

export async function diagnosticsRequest(
  method: 'GET' | 'POST' | 'DELETE',
  id: string,
  body?: string,
  expectedAccount?: string
): Promise<unknown> {
  if (!(diagnosticId(id) || (id === 'capabilities' && method === 'GET')))
    throw new Error('Invalid diagnostic request')
  const key = getSettings().cloud.apiKey
  const deviceId = getMachineId()
  if (!key) throw new Error('Link Kudu Cloud in Settings to use diagnostics.')
  if (expectedAccount && (await accountFingerprint(key, deviceId)) !== expectedAccount)
    throw new Error('Cloud account changed. Review the upload again.')
  if (body && Buffer.byteLength(body) > 1048576)
    throw new Error('Recording exceeds the upload limit.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(
      `https://cloud.usekudu.com/api/devices/${encodeURIComponent(deviceId)}/performance-diagnostics/${id}`,
      {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body
      }
    )
    if (!response.ok) {
      await response.body?.cancel()
      const message =
        response.status === 403
          ? 'An active Cloud Pro subscription is required.'
          : response.status === 429
            ? 'Analysis limit reached. Try again later.'
            : response.status === 404 || response.status === 410
              ? 'Cloud report unavailable or expired.'
              : response.status === 401
                ? 'Cloud key is invalid or revoked. Relink in Settings.'
                : response.status === 409
                  ? 'This recording was already submitted with different sharing options.'
                  : 'Cloud diagnostics is unavailable. Please try again later.'
      throw new Error(message)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty Cloud response')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 262144) {
        await reader.cancel()
        throw new Error('Cloud response exceeds the size limit')
      }
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    clearTimeout(timer)
  }
}

export async function diagnosticCapabilities(): Promise<DiagnosticCapabilities> {
  const value = (await diagnosticsRequest('GET', 'capabilities')) as Partial<DiagnosticCapabilities>
  if (
    !value ||
    typeof value.available !== 'boolean' ||
    value.requiredPlan !== 'Pro' ||
    value.provider !== 'OpenAI' ||
    value.retentionDays !== 7
  )
    throw new Error('Unsupported Cloud diagnostics response')
  return value as DiagnosticCapabilities
}

export function diagnosticCloudResult(
  value: unknown,
  id: string,
  duration: number
): DiagnosticCloudResult {
  const v = value as Partial<DiagnosticCloudResult> | null
  if (
    !v ||
    v.recordId !== id ||
    !['queued', 'processing', 'complete', 'failed'].includes(String(v.status)) ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    !(v.errorCode === null || (typeof v.errorCode === 'string' && v.errorCode.length <= 80)) ||
    (v.status === 'complete' ? !validDiagnosticReport(v.report, duration) : v.report !== null)
  )
    throw new Error('Invalid Cloud analysis response')
  return v as DiagnosticCloudResult
}

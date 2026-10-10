export const APP_PRIVACY_CAPABILITIES = ['webcam', 'microphone', 'location'] as const
export type AppPrivacyCapability = (typeof APP_PRIVACY_CAPABILITIES)[number]
export type RecordedConsent = 'allow' | 'deny' | 'prompt' | 'unknown'
export interface AppPrivacyRecord {
  id: string
  capability: AppPrivacyCapability
  kind: 'desktop' | 'packaged'
  name: string
  identity: string
  consent: RecordedConsent
  lastAccess: string | null
  lastEnd: string | null
  usage: 'recorded' | 'unfinished' | 'unknown'
}
export interface AppPrivacyCapabilitySummary {
  capability: AppPrivacyCapability
  status: 'available' | 'missing' | 'partial' | 'unavailable'
  userConsent: RecordedConsent
  desktopConsent: RecordedConsent
  deviceConsent: RecordedConsent
  truncated: boolean
}
export interface AppPrivacyReport {
  supported: boolean
  scannedAt: string
  account: string
  capabilities: AppPrivacyCapabilitySummary[]
  records: AppPrivacyRecord[]
}

/** A completed session can overlap the recent window even if it began earlier. */
export function appPrivacyLastUse(record: AppPrivacyRecord): string | null {
  return record.lastEnd ?? record.lastAccess
}

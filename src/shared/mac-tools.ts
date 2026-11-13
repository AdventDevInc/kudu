export type MacToolTab =
  'spotlight' | 'associations' | 'path' | 'battery' | 'energy' | 'animations' | 'audit'
export interface MacReading {
  label: string
  value: string
  error?: boolean
}
export interface MacVolume {
  path: string
  name: string
}
export interface PathPart {
  value: string
  status: 'ok' | 'missing' | 'duplicate' | 'dynamic' | 'unknown'
}
export interface PathLine {
  number: number
  original: string
  prefix: string
  quote: string
  suffix: string
  parts: PathPart[]
}
export interface MacPathPlan {
  file: string
  hash: string
  lines: PathLine[]
  skipped: number
  canRestore: boolean
}
export interface MacToolReport {
  readings: MacReading[]
  volumes?: MacVolume[]
  canRestore?: boolean
}
export type MacToolAction =
  | { kind: 'spotlight'; volume: string }
  | { kind: 'associations' }
  | { kind: 'energy'; profile: 'eco' | 'balanced' | 'restore' }
  | { kind: 'animations'; profile: 'fast' | 'reduced' | 'restore' }

export interface MacAuditSummary {
  id: string
  createdAt: string
  sections: Array<{ title: string; available: boolean }>
  disks: Array<{ label: string; used: number; total: number }>
}

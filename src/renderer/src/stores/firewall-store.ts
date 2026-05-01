import { create } from 'zustand'
import type {
  FirewallRule,
  FirewallScanProgress,
  FirewallApplyResult,
  FirewallRiskLevel,
} from '@shared/types'

type RiskFilter = 'all' | FirewallRiskLevel
type ProgramFilter = 'all' | 'with-program' | 'no-program' | 'stale'

interface FirewallState {
  rules: FirewallRule[]
  scanning: boolean
  applying: boolean
  scanProgress: FirewallScanProgress | null
  applyResult: FirewallApplyResult | null
  error: string | null
  hasScanned: boolean

  searchQuery: string
  riskFilter: RiskFilter
  programFilter: ProgramFilter

  setRules: (rules: FirewallRule[]) => void
  setScanning: (scanning: boolean) => void
  setApplying: (applying: boolean) => void
  setScanProgress: (progress: FirewallScanProgress | null) => void
  setApplyResult: (result: FirewallApplyResult | null) => void
  setError: (error: string | null) => void
  setHasScanned: (hasScanned: boolean) => void

  setSearchQuery: (query: string) => void
  setRiskFilter: (filter: RiskFilter) => void
  setProgramFilter: (filter: ProgramFilter) => void

  toggleRule: (name: string) => void
  selectRecommended: () => void
  selectAll: () => void
  deselectAll: () => void
  reset: () => void
}

export const useFirewallStore = create<FirewallState>((set) => ({
  rules: [],
  scanning: false,
  applying: false,
  scanProgress: null,
  applyResult: null,
  error: null,
  hasScanned: false,

  searchQuery: '',
  riskFilter: 'all',
  programFilter: 'all',

  setRules: (rules) => set({ rules }),
  setScanning: (scanning) => set({ scanning }),
  setApplying: (applying) => set({ applying }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setApplyResult: (applyResult) => set({ applyResult }),
  setError: (error) => set({ error }),
  setHasScanned: (hasScanned) => set({ hasScanned }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setRiskFilter: (riskFilter) => set({ riskFilter }),
  setProgramFilter: (programFilter) => set({ programFilter }),

  toggleRule: (name) =>
    set((s) => ({
      rules: s.rules.map((r) => (r.name === name ? { ...r, selected: !r.selected } : r)),
    })),

  selectRecommended: () =>
    set((s) => ({
      rules: s.rules.map((r) => ({ ...r, selected: r.issues.includes('stale') })),
    })),

  selectAll: () =>
    set((s) => ({ rules: s.rules.map((r) => ({ ...r, selected: true })) })),

  deselectAll: () =>
    set((s) => ({ rules: s.rules.map((r) => ({ ...r, selected: false })) })),

  reset: () =>
    set({
      rules: [],
      scanning: false,
      applying: false,
      scanProgress: null,
      applyResult: null,
      error: null,
      hasScanned: false,
      searchQuery: '',
      riskFilter: 'all',
      programFilter: 'all',
    }),
}))

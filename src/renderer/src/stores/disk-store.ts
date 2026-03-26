import { create } from 'zustand'
import type { DiskNode, DriveInfo, FileTypeInfo, DiskRepairProgress, DiskRepairResult } from '@shared/types'

interface DiskState {
  drives: DriveInfo[]
  selectedDrive: string
  data: DiskNode | null
  analyzing: boolean
  breadcrumb: DiskNode[]
  error: string | null
  fileTypes: FileTypeInfo[]
  fileTypesLoading: boolean

  // Disk repair state
  repairRunning: boolean
  repairProgress: DiskRepairProgress | null
  sfcResult: DiskRepairResult | null
  dismResult: DiskRepairResult | null
  chkdskResult: DiskRepairResult | null

  setDrives: (drives: DriveInfo[]) => void
  setSelectedDrive: (drive: string) => void
  setData: (data: DiskNode | null) => void
  setAnalyzing: (analyzing: boolean) => void
  setBreadcrumb: (breadcrumb: DiskNode[]) => void
  pushBreadcrumb: (node: DiskNode) => void
  sliceBreadcrumb: (toIndex: number) => void
  setError: (error: string | null) => void
  setFileTypes: (fileTypes: FileTypeInfo[]) => void
  setFileTypesLoading: (loading: boolean) => void
  setRepairRunning: (running: boolean) => void
  setRepairProgress: (progress: DiskRepairProgress | null) => void
  setSfcResult: (result: DiskRepairResult | null) => void
  setDismResult: (result: DiskRepairResult | null) => void
  setChkdskResult: (result: DiskRepairResult | null) => void
  reset: () => void
}

export const useDiskStore = create<DiskState>((set) => ({
  drives: [],
  selectedDrive: 'C',
  data: null,
  analyzing: false,
  breadcrumb: [],
  error: null,
  fileTypes: [],
  fileTypesLoading: false,
  repairRunning: false,
  repairProgress: null,
  sfcResult: null,
  dismResult: null,
  chkdskResult: null,

  setDrives: (drives) => set({ drives }),
  setSelectedDrive: (selectedDrive) => set({ selectedDrive }),
  setData: (data) => set({ data }),
  setAnalyzing: (analyzing) => set({ analyzing }),
  setBreadcrumb: (breadcrumb) => set({ breadcrumb }),
  pushBreadcrumb: (node) =>
    set((s) => ({ breadcrumb: [...s.breadcrumb, node] })),
  sliceBreadcrumb: (toIndex) =>
    set((s) => ({ breadcrumb: s.breadcrumb.slice(0, toIndex + 1) })),
  setError: (error) => set({ error }),
  setFileTypes: (fileTypes) => set({ fileTypes }),
  setFileTypesLoading: (fileTypesLoading) => set({ fileTypesLoading }),
  setRepairRunning: (repairRunning) => set({ repairRunning }),
  setRepairProgress: (repairProgress) => set({ repairProgress }),
  setSfcResult: (sfcResult) => set({ sfcResult }),
  setDismResult: (dismResult) => set({ dismResult }),
  setChkdskResult: (chkdskResult) => set({ chkdskResult }),
  reset: () =>
    set({
      data: null,
      analyzing: false,
      breadcrumb: [],
      error: null,
      fileTypes: [],
      fileTypesLoading: false,
      repairRunning: false,
      repairProgress: null,
      sfcResult: null,
      dismResult: null,
      chkdskResult: null,
    })
}))

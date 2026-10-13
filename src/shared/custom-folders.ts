export interface CustomFolder {
  id: string
  name: string
  path: string
}

export interface CustomFolderScan {
  scanId: string
  folder: CustomFolder
  files: Array<{ id: string; path: string; size: number; modified: number }>
  skipped: number
  limited: boolean
}

export interface CustomFolderTrashResult {
  trashedIds: string[]
  skippedIds: string[]
  recoveryPaths?: string[]
}

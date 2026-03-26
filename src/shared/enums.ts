export enum CleanerType {
  System = 'system',
  Browser = 'browser',
  App = 'app',
  Gaming = 'gaming',
  RecycleBin = 'recycleBin',
  UninstallLeftovers = 'uninstallLeftovers',
  Shortcut = 'shortcut',
  Database = 'database',
  Environment = 'environment',
}

export enum ScanStatus {
  Idle = 'idle',
  Scanning = 'scanning',
  Complete = 'complete',
  Cleaning = 'cleaning',
  Error = 'error',
}

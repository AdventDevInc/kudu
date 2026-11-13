export const ICLOUD_SERVICES = [
  { id: 'photos', apps: ['Photos.app'] },
  { id: 'drive', apps: [] },
  { id: 'passwords', apps: ['Passwords.app'] },
  { id: 'notes', apps: ['Notes.app'] },
  { id: 'messages', apps: ['Messages.app'] },
  { id: 'mail', apps: ['Mail.app'] },
  { id: 'findMy', apps: ['FindMy.app'] },
  { id: 'contacts', apps: ['Contacts.app'] },
  { id: 'calendar', apps: ['Calendar.app'] },
  { id: 'reminders', apps: ['Reminders.app'] },
  { id: 'safari', apps: ['Safari.app'] },
  { id: 'stocks', apps: ['Stocks.app'] },
  { id: 'home', apps: ['Home.app'] },
  { id: 'maps', apps: ['Maps.app'] },
  { id: 'siri', apps: [] },
  { id: 'freeform', apps: ['Freeform.app'] },
  { id: 'facetime', apps: ['FaceTime.app'] },
  { id: 'journal', apps: ['Journal.app'] },
  { id: 'playground', apps: ['Image Playground.app'] },
  { id: 'books', apps: ['Books.app'] },
  { id: 'pages', apps: ['Pages.app'] },
  { id: 'numbers', apps: ['Numbers.app'] },
  { id: 'keynote', apps: ['Keynote.app'] },
  { id: 'voiceMemos', apps: ['VoiceMemos.app'] },
  { id: 'recognition', apps: ['Shazam.app'] },
  { id: 'shortcuts', apps: ['Shortcuts.app'] },
  { id: 'qrReader', apps: ['Code Reader.app', 'QR Reader.app'] },
  { id: 'goodnotes', apps: ['Goodnotes.app', 'GoodNotes.app'] },
  { id: 'mindnode', apps: ['MindNode Classic.app'] },
  { id: 'mweb', apps: ['MWeb.app', 'MWeb Pro.app'] },
  { id: 'orion', apps: ['Orion.app'] },
  { id: 'pastepal', apps: ['PastePal.app'] }
] as const

export type ICloudServiceId = (typeof ICLOUD_SERVICES)[number]['id']
export interface ICloudServiceStatus {
  id: ICloudServiceId
  canOpenApp: boolean
}
export interface DeviceBackupItem {
  id: string
  folder: string
  deviceName: string
  modified: number
  bytes: number
  files: number
  eligible: boolean
  reason?: string
}
export interface DeviceBackupScan {
  scanId: string
  root: string
  items: DeviceBackupItem[]
  missing: boolean
}
export interface DeviceBackupRemoval {
  removedIds: string[]
  skipped: Array<{ id: string; message: string }>
  recoveryPaths: string[]
}

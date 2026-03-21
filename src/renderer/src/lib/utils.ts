import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import i18next from 'i18next'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B'
  if (bytes < 0) return `-${formatBytes(-bytes, decimals)}`

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

export function formatNumber(num: number): string {
  return num.toLocaleString()
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s'
  const k = 1024
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytesPerSec) / Math.log(k)))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return i18next.t('common:justNow')
  if (minutes < 60) return i18next.t('common:minutesAgo', { minutes })
  if (hours < 24) return i18next.t('common:hoursAgo', { hours })
  if (days < 7) return i18next.t('common:daysAgo', { days })
  return d.toLocaleDateString()
}

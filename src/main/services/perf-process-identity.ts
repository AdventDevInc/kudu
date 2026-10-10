/** /proc stat field 22 is the kernel start tick, independent of sampling time. */
export function linuxBirthToken(stat: string): string {
  const end = stat.lastIndexOf(')')
  if (end < 0) return ''
  const ticks = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)[19]
  return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : ''
}

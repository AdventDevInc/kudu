import type { ScanResult } from '@shared/types'

/** Filter the complete scan inventory before applying display pagination. */
export function filterCleanerResults(
  results: ScanResult[],
  query: string,
  selected: Set<string>,
  selectedOnly: boolean,
  categoryLabel: (result: ScanResult) => string
): ScanResult[] {
  const needle = query.trim().toLowerCase()
  return results.flatMap((result) => {
    const groupMatches = [result.subcategory, result.group ?? '', categoryLabel(result)].some(
      (label) => label.toLowerCase().includes(needle)
    )
    const items = result.items.filter(
      (item) =>
        (!selectedOnly || selected.has(item.id)) &&
        (!needle || groupMatches || item.path.toLowerCase().includes(needle))
    )
    if (!items.length) return []
    return [
      {
        ...result,
        items,
        itemCount: items.length,
        totalSize: items.reduce((sum, item) => sum + item.size, 0)
      }
    ]
  })
}

export function splitSearchHighlight(
  text: string,
  query: string
): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let start = 0
  let index = lower.indexOf(needle)
  while (index !== -1) {
    if (index > start) parts.push({ text: text.slice(start, index), match: false })
    parts.push({ text: text.slice(index, index + needle.length), match: true })
    start = index + needle.length
    index = lower.indexOf(needle, start)
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false })
  return parts
}

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
  // Lowercasing can expand a source character (e.g. U+0130 becomes i + dot).
  // Map each folded UTF-16 unit to the entire original code point, while
  // searching the whole folded string to preserve context-sensitive casing.
  const sourceStarts: number[] = []
  const sourceEnds: number[] = []
  let sourceOffset = 0
  for (const character of text) {
    const end = sourceOffset + character.length
    for (let unit = 0; unit < character.toLowerCase().length; unit++) {
      sourceStarts.push(sourceOffset)
      sourceEnds.push(end)
    }
    sourceOffset = end
  }

  const matches: { start: number; end: number }[] = []
  let index = lower.indexOf(needle)
  while (index !== -1) {
    const start = sourceStarts[index]
    const end = sourceEnds[index + needle.length - 1]
    const previous = matches.at(-1)
    // Distinct folded matches can cover the same expanded source character.
    // Merge those ranges so rendering never duplicates the original text.
    if (previous && start < previous.end) previous.end = Math.max(previous.end, end)
    else matches.push({ start, end })
    index = lower.indexOf(needle, index + needle.length)
  }

  const parts: { text: string; match: boolean }[] = []
  let start = 0
  for (const match of matches) {
    if (match.start > start) parts.push({ text: text.slice(start, match.start), match: false })
    parts.push({ text: text.slice(match.start, match.end), match: true })
    start = match.end
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false })
  return parts
}

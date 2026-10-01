/**
 * Mention skim labels shared by land/dig and the full report.
 * The chip follows mention only. whoInstead names stay secondary.
 */

import type { ProductCopy } from './config/productConfig.ts'
import type { Framing, Mention } from './mentionFacts.ts'

export type MentionLabelCopy = Pick<ProductCopy, 'mentionYes' | 'mentionNo' | 'mentionUnclear'>

/** Unbranded names only, capped at 3. Branded rows stay empty. */
export function whoInsteadNames(whoInstead: string[], framing: Framing): string[] {
  if (framing !== 'unbranded') return []
  return whoInstead.filter((name) => name.trim()).slice(0, 3)
}

export type WhoInsteadBoardRow = {
  name: string
  /** Distinct unbranded questions this name appeared on. */
  questions: number
}

type BoardQuestion = {
  framing: Framing
  mention?: Mention
  whoInstead: string[]
}

/**
 * Substitutes for this run, most frequent first.
 * Unbranded rows only, and only when you were not mentioned — names already on the answers, never invented.
 */
export function whoInsteadBoard(
  themes: readonly { questions: readonly BoardQuestion[] }[],
): WhoInsteadBoardRow[] {
  const counts = new Map<string, WhoInsteadBoardRow>()
  for (const theme of themes) {
    for (const item of theme.questions) {
      if (item.framing !== 'unbranded' || !item.mention || item.mention === 'mentioned') continue
      const seen = new Set<string>()
      for (const raw of whoInsteadNames(item.whoInstead, 'unbranded')) {
        const name = raw.replace(/\s+/g, ' ').trim()
        const key = name.toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        const existing = counts.get(key)
        if (existing) existing.questions += 1
        else counts.set(key, { name, questions: 1 })
      }
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.questions - a.questions || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** `{n}` → how many questions. The template stays plural, including when n is 1. */
export function whoInsteadCountLabel(template: string, n: number): string {
  return template.replaceAll('{n}', String(n))
}

/** Chip text is Mentioned, Not mentioned, or Unclear. Names do not change it. */
export function mentionStatusLabel(mention: Mention, copy: MentionLabelCopy): string {
  if (mention === 'mentioned') return copy.mentionYes
  if (mention === 'unclear') return copy.mentionUnclear
  return copy.mentionNo
}

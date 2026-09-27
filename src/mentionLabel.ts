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

/** Chip text is Mentioned, Not mentioned, or Unclear. Names do not change it. */
export function mentionStatusLabel(mention: Mention, copy: MentionLabelCopy): string {
  if (mention === 'mentioned') return copy.mentionYes
  if (mention === 'unclear') return copy.mentionUnclear
  return copy.mentionNo
}

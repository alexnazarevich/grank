/**
 * Mention skim labels shared by land/dig and the full report.
 * Who instead only when an unbranded answer names someone else.
 */

import type { ProductCopy } from './config/productConfig.ts'
import type { Framing, Mention } from './mentionFacts.ts'

export type MentionLabelCopy = Pick<
  ProductCopy,
  'mentionYes' | 'mentionNo' | 'mentionUnclear' | 'mentionWhoInstead'
>

/** Unbranded names only, capped at 3. Branded rows stay empty. */
export function whoInsteadNames(whoInstead: string[], framing: Framing): string[] {
  if (framing !== 'unbranded') return []
  return whoInstead.filter((name) => name.trim()).slice(0, 3)
}

/** Same four labels as bet (11). A clear mention never flips to Who instead. */
export function mentionStatusLabel(
  mention: Mention,
  whoInstead: string[],
  framing: Framing,
  copy: MentionLabelCopy,
): string {
  if (whoInsteadNames(whoInstead, framing).length > 0 && mention !== 'mentioned') return copy.mentionWhoInstead
  if (mention === 'mentioned') return copy.mentionYes
  if (mention === 'unclear') return copy.mentionUnclear
  return copy.mentionNo
}

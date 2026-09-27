/**
 * Skim cutoff for a full-report answer already returned by the model.
 * About three lines in the report card. Expanding shows that same string.
 */

export const ANSWER_SKIM_CHARS = 220

const WORD_BREAK_FLOOR = Math.floor(ANSWER_SKIM_CHARS * 0.6)

export function splitAnswerSkim(text: string): { preview: string; long: boolean } {
  const clean = text.trim()
  if (clean.length <= ANSWER_SKIM_CHARS) return { preview: clean, long: false }
  const slice = clean.slice(0, ANSWER_SKIM_CHARS)
  const breakAt = slice.lastIndexOf(' ')
  const cut = (breakAt >= WORD_BREAK_FLOOR ? slice.slice(0, breakAt) : slice).trimEnd()
  return { preview: `${cut}…`, long: true }
}

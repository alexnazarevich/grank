import { STORY } from './story.ts'

export type GeminiRow = {
  label: typeof STORY.geminiLabel
  body: string
  miss: boolean
}

/**
 * Second block under the OpenAI answer for one unbranded question.
 * Null when this run has no Gemini slot. A blank slot is the miss line, not a cleared OpenAI answer.
 */
export function geminiRow(gemini: readonly string[] | undefined, index: number): GeminiRow | null {
  if (!gemini || index < 0 || index >= gemini.length) return null
  const text = gemini[index].replace(/\s+/g, ' ').trim()
  if (!text) return { label: STORY.geminiLabel, body: STORY.geminiMiss, miss: true }
  return { label: STORY.geminiLabel, body: text, miss: false }
}

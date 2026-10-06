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

const GEMINI_MISS_PLAIN = new Set(['missing_key', 'timeout', 'bad_json', 'empty'])

function httpStatusOnly(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) return null
  return value
}

/**
 * Signed-in miss line. The story sentence stays as written; the class is appended.
 * Anything outside the five codes, including a non-numeric status, is left off.
 */
export function geminiMissLine(miss: { class?: unknown; status?: unknown } | null | undefined): string {
  if (!miss || typeof miss.class !== 'string') return STORY.geminiMiss
  if (miss.class === 'http_reject') {
    const status = httpStatusOnly(miss.status)
    return status === null ? `${STORY.geminiMiss} (http_reject)` : `${STORY.geminiMiss} (http_reject ${status})`
  }
  if (GEMINI_MISS_PLAIN.has(miss.class)) return `${STORY.geminiMiss} (${miss.class})`
  return STORY.geminiMiss
}

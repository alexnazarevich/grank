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

export type ClaudeRow = {
  label: typeof STORY.claudeLabel
  body: string
  miss: boolean
}

/**
 * Third block under the ChatGPT answer for one unbranded question.
 * Null when this run has no Claude slot. A blank slot is the miss line.
 */
export function claudeRow(claude: readonly string[] | undefined, index: number): ClaudeRow | null {
  if (!claude || index < 0 || index >= claude.length) return null
  const text = claude[index].replace(/\s+/g, ' ').trim()
  if (!text) return { label: STORY.claudeLabel, body: STORY.claudeMiss, miss: true }
  return { label: STORY.claudeLabel, body: text, miss: false }
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

/** Signed-in Claude miss line. Same five classes as Gemini, on the Claude sentence. */
export function claudeMissLine(miss: { class?: unknown; status?: unknown } | null | undefined): string {
  if (!miss || typeof miss.class !== 'string') return STORY.claudeMiss
  if (miss.class === 'http_reject') {
    const status = httpStatusOnly(miss.status)
    return status === null ? `${STORY.claudeMiss} (http_reject)` : `${STORY.claudeMiss} (http_reject ${status})`
  }
  if (GEMINI_MISS_PLAIN.has(miss.class)) return `${STORY.claudeMiss} (${miss.class})`
  return STORY.claudeMiss
}

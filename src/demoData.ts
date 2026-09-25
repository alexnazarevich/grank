/** Sample questions are only a last resort when unbranded /api/visibility fails. Who-instead is never sampled. */

export type Answered = 'yes' | 'partial' | 'no'

export type VisibilityMode = 'unbranded' | 'branded'

/** One mode's read. Answered-by-you belongs to this set only — never a blend of both. */
export type ModeBeat = {
  mode: VisibilityMode
  questions: string[]
  /** Branded model replies aligned to questions. Empty string → no answer for that row. Unbranded is []. */
  answers: string[]
  /** True when questions came from the model, not the sample bank. */
  questionsGenerated: boolean
  /** Null when the model call failed — never invent a Yes. */
  answered: Answered | null
  answeredWhy: string
  answeredLive: boolean
  model: string | null
  /** Live alternate brand names. Unbranded only. Empty when the model named none. */
  whoInstead: string[]
  /** False when the unbranded call failed — say we couldn’t find alternatives, never invent competitors. */
  whoInsteadLive: boolean
}

export const EXAMPLES: { label: string; url: string }[] = [
  { label: 'notion.so', url: 'https://notion.so' },
  { label: 'linear.app', url: 'https://linear.app' },
]

export function normalizeUrl(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  try {
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`
    const u = new URL(withProto)
    if (!u.hostname.includes('.')) return null
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Last-resort questions when the unbranded call fails. Category / JTBD only —
 * they do not name the brand, and the UI still marks them Sample.
 */
export function stubQuestionsFor(domain: string): { questions: string[] } {
  void domain
  return {
    questions: [
      'What should I use to solve this kind of problem?',
      'Which tools do teams pick for this job?',
      'What do people compare when choosing in this category?',
    ],
  }
}

/** Sample questions are only a last resort when /api/visibility fails. Who-instead is never sampled. */

export type Answered = 'yes' | 'partial' | 'no'

export type AhaResult = {
  domain: string
  questions: string[]
  /** True when questions came from the model, not the sample bank. */
  questionsGenerated: boolean
  /** Null when the model call failed — never invent a Yes. */
  answered: Answered | null
  answeredWhy: string
  answeredLive: boolean
  model: string | null
  /** Live alternate brand names. Empty when the model named none. */
  whoInstead: string[]
  /** False when the visibility call failed — say we couldn’t find alternatives, never invent competitors. */
  whoInsteadLive: boolean
  /** Short supporting line from the homepage fetch. Not the primary verdict. */
  homepageSupport: string | null
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

/** Last-resort questions when /api/visibility fails. Always labeled Sample in the UI. */
export function stubQuestionsFor(domain: string): { questions: string[] } {
  const brand = domain.split('.')[0] || domain
  const Brand = brand.charAt(0).toUpperCase() + brand.slice(1)
  return {
    questions: [
      `What is ${Brand}?`,
      `Is ${Brand} worth it for small teams?`,
      `${Brand} vs alternatives — which should I pick?`,
      `How do I get started with ${Brand}?`,
    ],
  }
}

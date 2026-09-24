/** Who-instead stays a SAMPLE stub. Questions and answered-by-you come from /api/visibility. */

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
  whoInstead: { name: string; note: string }[]
  /** Short supporting line from the homepage fetch. Not the primary verdict. */
  homepageSupport: string | null
}

const STUB_WHO = [
  { name: 'Category leaders', note: 'Incumbents usually fill “best of” answers first (sample)' },
  { name: 'Review roundups', note: 'Listicles get cited more than thin brand pages (sample)' },
  { name: 'Wikipedia / docs hubs', note: 'High-trust sources AI leans on (sample)' },
]

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
export function stubQuestionsFor(domain: string): {
  questions: string[]
  whoInstead: { name: string; note: string }[]
} {
  const brand = domain.split('.')[0] || domain
  const Brand = brand.charAt(0).toUpperCase() + brand.slice(1)
  return {
    questions: [
      `What is ${Brand}?`,
      `Is ${Brand} worth it for small teams?`,
      `${Brand} vs alternatives — which should I pick?`,
      `How do I get started with ${Brand}?`,
    ],
    whoInstead: STUB_WHO,
  }
}

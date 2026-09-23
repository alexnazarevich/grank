/** Questions + who-instead remain SAMPLE stubs. Answered-by-you can be live. */

export type Answered = 'yes' | 'partial' | 'no'

export type AhaResult = {
  domain: string
  questions: string[]
  answered: Answered
  answeredWhy: string
  whoInstead: { name: string; note: string }[]
  enginesChecked: string[]
  /** true when questions/who are stubs; answered may still be live */
  stubQuestions: boolean
  answeredLive: boolean
}

const STUB_WHO = [
  { name: 'Category leaders', note: 'Incumbents usually fill “best of” answers first (stub)' },
  { name: 'Review roundups', note: 'Listicles get cited more than thin brand pages (stub)' },
  { name: 'Wikipedia / docs hubs', note: 'High-trust sources AI leans on (stub)' },
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

export function stubQuestionsFor(domain: string): Pick<AhaResult, 'questions' | 'whoInstead' | 'stubQuestions'> {
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
    stubQuestions: true,
  }
}

/** Example chips and labeled stubs for the blocks that are not live yet. */

export type Answered = 'yes' | 'partial' | 'no'

export type AhaResult = {
  domain: string
  questions: string[]
  answered: Answered
  answeredWhy: string
  whoInstead: { name: string; note: string }[]
  enginesChecked: string[]
}

/** URL chips only — every example runs the same live homepage check. */
export const EXAMPLES: { label: string; url: string }[] = [
  { label: 'notion.so', url: 'https://notion.so' },
  { label: 'linear.app', url: 'https://linear.app' },
]

export function brandToken(domain: string): string {
  return (domain.split('.').filter(Boolean)[0] ?? domain).toLowerCase()
}

function displayBrand(domain: string): string {
  const token = brandToken(domain)
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/** Homepage URL plus the display domain. Invalid input returns null. */
export function parseSite(raw: string): { domain: string; href: string } | null {
  const t = raw.trim()
  if (!t) return null
  try {
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`
    const u = new URL(withProto)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname.includes('.') || !/[a-z]/i.test(u.hostname)) return null
    const domain = u.hostname.replace(/^www\./i, '')
    return { domain, href: `${u.protocol}//${u.host}/` }
  } catch {
    return null
  }
}

/** Stub — sample questions, not a live model. */
export function stubQuestions(domain: string): string[] {
  const Brand = displayBrand(domain)
  return [
    `What is ${Brand}?`,
    `Is ${Brand} worth it for small teams?`,
    `${Brand} vs alternatives — which should I pick?`,
    `How do I get started with ${Brand}?`,
  ]
}

/** Stub — generic stand-ins, not a live “who is cited” check. */
export function stubWhoInstead(domain: string): { name: string; note: string }[] {
  const Brand = displayBrand(domain)
  return [
    { name: 'Category leaders', note: `Incumbents usually fill “best of” answers before ${Brand}` },
    { name: 'Review roundups', note: 'Listicles get cited more than thin brand pages' },
    { name: 'Wikipedia / docs hubs', note: 'High-trust sources AI leans on' },
  ]
}

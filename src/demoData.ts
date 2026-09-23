/** Labeled SAMPLE / DEMO stubs — not live LLM checks. */

export type Answered = 'yes' | 'partial' | 'no'

export type AhaResult = {
  domain: string
  questions: string[]
  answered: Answered
  answeredWhy: string
  whoInstead: { name: string; note: string }[]
  enginesChecked: string[]
  stub: true
}

export const EXAMPLES: { label: string; url: string; result: AhaResult }[] = [
  {
    label: 'notion.so',
    url: 'https://notion.so',
    result: {
      domain: 'notion.so',
      questions: [
        'What is the best note-taking app for teams?',
        'Notion vs Confluence for wikis?',
        'How do I build a project tracker in Notion?',
        'Is Notion good for startups?',
      ],
      answered: 'partial',
      answeredWhy:
        'Sample answers mention Notion on team-wiki questions, but category “best app” lists often lead with other brands. (Demo stub.)',
      whoInstead: [
        { name: 'Obsidian', note: 'Shows up on “best notes” style questions' },
        { name: 'Confluence', note: 'Shows up on enterprise wiki comparisons' },
        { name: 'Coda', note: 'Shows up on all-in-one workspace questions' },
      ],
      enginesChecked: ['Demo stub only — no live model call'],
      stub: true,
    },
  },
  {
    label: 'linear.app',
    url: 'https://linear.app',
    result: {
      domain: 'linear.app',
      questions: [
        'Best issue tracker for startups?',
        'Linear vs Jira for product teams?',
        'How do engineering teams run sprints in Linear?',
        'What tools replace Asana for eng?',
      ],
      answered: 'yes',
      answeredWhy:
        'Sample answers cite Linear as a default for fast eng teams on “best issue tracker” prompts. (Demo stub.)',
      whoInstead: [
        { name: 'Jira', note: 'Still dominates enterprise / Atlassian-shaped asks' },
        { name: 'Height', note: 'Appears on “modern PM tools” lists' },
      ],
      enginesChecked: ['Demo stub only — no live model call'],
      stub: true,
    },
  },
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

/** Heuristic stub generator for arbitrary URLs — always labeled sample. */
export function stubForDomain(domain: string): AhaResult {
  const brand = domain.split('.')[0] || domain
  const Brand = brand.charAt(0).toUpperCase() + brand.slice(1)
  return {
    domain,
    questions: [
      `What is ${Brand}?`,
      `Is ${Brand} worth it for small teams?`,
      `${Brand} vs alternatives — which should I pick?`,
      `How do I get started with ${Brand}?`,
    ],
    answered: 'no',
    answeredWhy: `Sample answers in this demo don’t cite ${Brand} on category questions yet — typical cold start. (Demo stub — not a live crawl.)`,
    whoInstead: [
      { name: 'Category leaders', note: 'Incumbents usually fill “best of” answers first' },
      { name: 'Review roundups', note: 'Listicles get cited more than thin brand pages' },
      { name: 'Wikipedia / docs hubs', note: 'High-trust sources AI leans on' },
    ],
    enginesChecked: ['Demo stub only — no live model call'],
    stub: true,
  }
}

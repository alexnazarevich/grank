/**
 * Full-report theme plan and model-output shaping.
 * Theme titles are fixed. Empty themes drop. Alternatives stay unbranded.
 * No search-engine theme names and no blended score.
 */

import {
  MENTION_FACT_RULES,
  SHARPER_Q_RULES,
  landThemeId,
  mentionFromAnswer,
  mentionsBrand,
  parseWhoInstead,
  type Framing,
  type Mention,
  type ThemeId,
} from './mentionFacts.ts'

export type { Framing, Mention, ThemeId }
export { mentionsBrand }

export type FullReportQuestion = {
  question: string
  answer: string
  framing: Framing
  /** Omitted when the answer is empty — no fake mention label. */
  mention?: Mention
  /** Unbranded only. Empty on branded and on a failed answer. */
  whoInstead: string[]
}

export type FullReportTheme = {
  id: ThemeId
  title: string
  questions: FullReportQuestion[]
}

export type FullReport = {
  domain: string
  model: string
  includesBranded: boolean
  themes: FullReportTheme[]
}

type Leaning = 'unbranded' | 'branded' | 'either'

type CatalogTheme = {
  id: ThemeId
  title: string
  leaning: Leaning
}

/** Skim order. Edge is last and is omitted unless the theme bounds need a sixth group. */
export const THEME_CATALOG: readonly CatalogTheme[] = [
  { id: 'problems', title: 'Problems you solve', leaning: 'unbranded' },
  { id: 'described', title: 'How you’re described', leaning: 'branded' },
  { id: 'trust', title: 'Trust & proof', leaning: 'branded' },
  { id: 'alternatives', title: 'Alternatives & who else', leaning: 'unbranded' },
  { id: 'buying', title: 'Buying & next step', leaning: 'either' },
  { id: 'edge', title: 'Edge cases', leaning: 'either' },
]

const THEME_KEYS: Record<string, ThemeId> = {
  problems: 'problems',
  'problems you solve': 'problems',
  described: 'described',
  "how you're described": 'described',
  'how you are described': 'described',
  trust: 'trust',
  'trust and proof': 'trust',
  'trust proof': 'trust',
  alternatives: 'alternatives',
  'alternatives and who else': 'alternatives',
  'who else': 'alternatives',
  buying: 'buying',
  'buying and next step': 'buying',
  'next step': 'buying',
  edge: 'edge',
  'edge cases': 'edge',
}

export type ThemeAsk = 'unbranded' | 'branded' | 'mixed'

export type PlannedTheme = {
  id: ThemeId
  title: string
  count: number
  ask: ThemeAsk
}

const QUESTION_MAX = 240
const ANSWER_MAX = 600

export function brandLabel(domain: string): string {
  const stem = domain.split('.')[0] || domain
  if (!stem) return domain
  return stem.charAt(0).toUpperCase() + stem.slice(1)
}

export type RunPin = {
  question: string
  framing: Framing
}

export function distributeCounts(total: number, buckets: number): number[] {
  if (buckets <= 0) return []
  const safe = Math.max(total, buckets)
  const base = Math.floor(safe / buckets)
  let extra = safe - base * buckets
  return Array.from({ length: buckets }, () => {
    const count = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    return count
  })
}

function askFor(leaning: Leaning, includesBranded: boolean): ThemeAsk {
  if (!includesBranded || leaning === 'unbranded') return 'unbranded'
  if (leaning === 'branded') return 'branded'
  return 'mixed'
}

/**
 * Prefer five themes so Edge cases stays empty unless min/max requires it.
 * Alternatives is unbranded even when branded dig questions are included.
 */
export function selectThemePlan(opts: {
  questionTarget: number
  themeMin: number
  themeMax: number
  includesBranded: boolean
}): PlannedTheme[] {
  const cap = THEME_CATALOG.length
  const max = Math.min(cap, Math.max(1, Math.floor(opts.themeMax)))
  const min = Math.min(max, Math.max(1, Math.floor(opts.themeMin)))
  let count = Math.min(max, 5)
  if (count < min) count = min
  const chosen = THEME_CATALOG.slice(0, count)
  const counts = distributeCounts(Math.max(Math.floor(opts.questionTarget), count), count)
  return chosen.map((theme, index) => ({
    id: theme.id,
    title: theme.title,
    count: counts[index] ?? 1,
    ask: askFor(theme.leaning, opts.includesBranded),
  }))
}

export function questionFloor(target: number, themeMin: number): number {
  const goal = Math.max(1, Math.floor(target))
  const minThemes = Math.max(1, Math.floor(themeMin))
  return Math.min(goal, Math.max(minThemes, Math.ceil(goal * 0.5)))
}

function normalizeThemeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function resolveThemeId(value: unknown): ThemeId | null {
  if (typeof value !== 'string') return null
  const key = normalizeThemeKey(value)
  if (!key) return null
  return THEME_KEYS[key] ?? null
}

function cleanQuestion(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.length > QUESTION_MAX) return ''
  return text
}

function cleanAnswer(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX)
}

/** A question is branded only when it names the brand. The badge stays honest. */
function inferFraming(question: string, domain: string): Framing {
  return mentionsBrand(question, domain) ? 'branded' : 'unbranded'
}

type DraftQuestion = FullReportQuestion

function dedupe(questions: DraftQuestion[]): DraftQuestion[] {
  const seen = new Set<string>()
  const out: DraftQuestion[] = []
  for (const item of questions) {
    const key = item.question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function trimToTarget(themes: FullReportTheme[], target: number): FullReportTheme[] {
  const copy = themes.map((theme) => ({ ...theme, questions: [...theme.questions] }))
  const total = () => copy.reduce((sum, theme) => sum + theme.questions.length, 0)
  while (total() > target) {
    let idx = -1
    let most = 1
    for (let i = 0; i < copy.length; i++) {
      const count = copy[i].questions.length
      if (count > most) {
        most = count
        idx = i
      } else if (count === most && count > 1) {
        idx = i
      }
    }
    if (idx < 0) break
    copy[idx].questions.pop()
  }
  return copy.filter((theme) => theme.questions.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Map model JSON onto the locked themes.
 * Branded questions never stay in Alternatives. Problems stays unbranded-first.
 * Returns null when the set is too thin to be a report — callers show an honest failure.
 */
export function shapeFullReport(
  raw: unknown,
  opts: {
    domain: string
    plan: PlannedTheme[]
    includesBranded: boolean
    themeMin: number
    questionTarget: number
  },
): FullReportTheme[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.themes)) return null
  const allowed = new Set(opts.plan.map((theme) => theme.id))
  const buckets = new Map<ThemeId, DraftQuestion[]>()
  for (const theme of opts.plan) buckets.set(theme.id, [])
  const rehome: DraftQuestion[] = []

  for (const entry of raw.themes) {
    if (!isRecord(entry)) continue
    const id = resolveThemeId(entry.id) ?? resolveThemeId(entry.title)
    if (!id || !allowed.has(id)) continue
    const list = Array.isArray(entry.questions) ? entry.questions : []
    for (const item of list) {
      let question = ''
      let answer: unknown = ''
      if (typeof item === 'string') {
        question = item
      } else if (isRecord(item)) {
        question = cleanQuestion(item.question)
        answer = item.answer
      }
      question = cleanQuestion(question)
      if (!question) continue
      const framing = inferFraming(question, opts.domain)
      if (framing === 'branded' && !opts.includesBranded) continue
      const answerText = cleanAnswer(answer)
      const mention = mentionFromAnswer(answerText, opts.domain, isRecord(item) ? item.mention : undefined)
      const draft: DraftQuestion = {
        question,
        answer: answerText,
        framing,
        whoInstead: framing === 'unbranded' && mention ? parseWhoInstead(isRecord(item) ? item.whoInstead : [], opts.domain) : [],
      }
      if (mention) draft.mention = mention
      if (framing === 'branded' && (id === 'alternatives' || id === 'problems')) {
        rehome.push(draft)
        continue
      }
      buckets.get(id)?.push(draft)
    }
  }

  if (opts.includesBranded && rehome.length > 0) {
    const home = (['described', 'trust', 'buying', 'edge'] as const).find((id) => buckets.has(id))
    if (home) buckets.get(home)?.push(...rehome)
  }

  const seen = new Set<string>()
  const ordered: FullReportTheme[] = []
  for (const theme of opts.plan) {
    const questions = dedupe(buckets.get(theme.id) ?? []).filter((item) => {
      const key = item.question.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (questions.length === 0) continue
    ordered.push({ id: theme.id, title: theme.title, questions })
  }
  const trimmed = trimToTarget(ordered, Math.max(1, opts.questionTarget))
  const count = trimmed.reduce((sum, theme) => sum + theme.questions.length, 0)
  if (trimmed.length < Math.max(1, opts.themeMin)) return null
  if (count < questionFloor(opts.questionTarget, opts.themeMin)) return null
  for (const theme of trimmed) {
    if (theme.id !== 'alternatives') continue
    if (theme.questions.some((item) => item.framing === 'branded' || mentionsBrand(item.question, opts.domain))) {
      return null
    }
  }
  return trimmed
}

export function parseModelJson(raw: string): unknown | null {
  let text = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

export function mergeThemePayloads(parts: unknown[]): { themes: unknown[] } {
  const themes: unknown[] = []
  for (const part of parts) {
    if (!isRecord(part) || !Array.isArray(part.themes)) continue
    themes.push(...part.themes)
  }
  return { themes }
}

export function fullReportPrompt(
  domain: string,
  plan: PlannedTheme[],
  excerpt: string | null,
  pins: RunPin[] = [],
): string {
  const brand = brandLabel(domain)
  const lines = [
    `Brand domain: ${domain}`,
    `Brand name: ${brand}`,
    'Write only the themes listed below. Use these ids exactly.',
    'Do not add a theme about Google, Bing, Perplexity, Gemini, or any search-results page.',
    'Do not return a score, rank, or visibility percentage.',
    'The alternatives theme is unbranded-framed only. Never put a branded question there.',
  ]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  for (const theme of plan) {
    if (theme.ask === 'unbranded') {
      lines.push(
        `Theme id "${theme.id}" (${theme.title}): write ${theme.count} questions that do not name ${brand} or ${domain}. framing must be "unbranded".`,
      )
    } else if (theme.ask === 'branded') {
      lines.push(
        `Theme id "${theme.id}" (${theme.title}): write ${theme.count} questions that name ${brand}. framing must be "branded".`,
      )
    } else {
      lines.push(
        `Theme id "${theme.id}" (${theme.title}): write ${theme.count} questions. About half name ${brand} (framing "branded") and half do not (framing "unbranded").`,
      )
    }
    if (theme.id === 'alternatives') {
      lines.push(
        `For "${theme.id}", ask who else shows up in the category. Do not mention ${brand}. Do not write branded dig questions in this theme.`,
      )
    }
    if (theme.id === 'problems') {
      lines.push(`For "${theme.id}", ask category or job-to-be-done questions only. Do not name ${brand}.`)
    }
  }
  if (pins.length > 0) {
    lines.push(
      'Pinned questions for this run only. Include each one with this wording, in the matching theme, and answer it. This is not a saved prompt library.',
    )
    for (const pin of pins) lines.push(`Pinned ${pin.framing} question: ${pin.question}`)
  }
  lines.push(
    'Each item is {"question","answer","framing","mention","whoInstead"}. mention is "mentioned", "not_mentioned", or "unclear". whoInstead is an array of at most 3 real names on unbranded questions and an empty array on branded questions. Never invent competitors. Each answer is one or two conservative sentences. If you cannot answer, use an empty string and do not invent a mention.',
  )
  return lines.join('\n')
}

export const FULL_REPORT_SYSTEM_PROMPT = `You write a labeled visibility question set for one brand. This is a generated model exercise, not a live web crawl and not a multi-engine scrape.
Do not invent citations, rankings, traffic, or a visibility percentage. Do not blend themes into a score.
Do not name any theme after a search engine or a results page.
Return JSON only:
{"themes":[{"id":"problems","questions":[{"question":"...","answer":"...","framing":"unbranded"}]}]}
Each answer is 1 or 2 conservative sentences from public knowledge. If unsure, say so. Do not invent praise. If you cannot answer, use an empty string.
framing "branded" means the question names the brand. framing "unbranded" means it does not.
The theme id "alternatives" is unbranded only: who else shows up in the category. Never put a branded question in alternatives. Never use the brand name, product name, or domain in that theme.
The theme id "problems" is unbranded-first: category or job-to-be-done questions that do not name the brand.
${SHARPER_Q_RULES}
${MENTION_FACT_RULES}`

export function isFullReportResult(result: unknown): boolean {
  return isRecord(result) && result.report === 'full'
}

/** Rebuild a saved full report. Unknown theme ids and engine-named groups are dropped. */
export function fullReportFromStored(result: unknown): FullReport | null {
  if (!isRecord(result) || result.report !== 'full' || !isRecord(result.fullReport)) return null
  const blob = result.fullReport
  const domain = typeof blob.domain === 'string' ? blob.domain : ''
  const model = typeof blob.model === 'string' ? blob.model : ''
  if (!domain || !model || !Array.isArray(blob.themes)) return null
  const includesBranded = blob.includesBranded === true
  const themes: FullReportTheme[] = []
  for (const entry of blob.themes) {
    if (!isRecord(entry)) continue
    const id = resolveThemeId(entry.id)
    const catalog = id ? THEME_CATALOG.find((theme) => theme.id === id) : undefined
    if (!id || !catalog || !Array.isArray(entry.questions)) continue
    const questions: FullReportQuestion[] = []
    for (const item of entry.questions) {
      if (!isRecord(item)) continue
      const question = cleanQuestion(item.question)
      if (!question) continue
      const framing = inferFraming(question, domain)
      if (id === 'alternatives' && (framing === 'branded' || mentionsBrand(question, domain))) continue
      if (!includesBranded && framing === 'branded') continue
      const answerText = cleanAnswer(item.answer)
      const mention = mentionFromAnswer(answerText, domain, item.mention)
      const stored: FullReportQuestion = {
        question,
        answer: answerText,
        framing,
        whoInstead: framing === 'unbranded' && mention ? parseWhoInstead(item.whoInstead, domain) : [],
      }
      if (mention) stored.mention = mention
      questions.push(stored)
    }
    if (questions.length === 0) continue
    themes.push({ id, title: catalog.title, questions })
  }
  if (themes.length === 0) return null
  return { domain, model, includesBranded, themes }
}

/** This-run pins only. Framing follows the question text, not the client’s claim. */
export function cleanRunPins(value: unknown, domain: string, max: number): RunPin[] {
  if (!Array.isArray(value)) return []
  const cap = Math.min(8, Math.max(1, Math.floor(max)))
  const seen = new Set<string>()
  const out: RunPin[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const question = typeof item.question === 'string' ? item.question.replace(/\s+/g, ' ').trim() : ''
    if (!question || question.length > QUESTION_MAX) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ question, framing: mentionsBrand(question, domain) ? 'branded' : 'unbranded' })
    if (out.length >= cap) break
  }
  return out
}

function themeById(themes: FullReportTheme[], id: ThemeId): FullReportTheme | undefined {
  return themes.find((theme) => theme.id === id)
}

function ensureTheme(themes: FullReportTheme[], id: ThemeId): FullReportTheme {
  const found = themeById(themes, id)
  if (found) return found
  const catalog = THEME_CATALOG.find((theme) => theme.id === id)
  const created: FullReportTheme = { id, title: catalog?.title || id, questions: [] }
  themes.push(created)
  themes.sort(
    (a, b) =>
      THEME_CATALOG.findIndex((theme) => theme.id === a.id) - THEME_CATALOG.findIndex((theme) => theme.id === b.id),
  )
  return created
}

/**
 * Keep pinned wording in the report when the model drops it.
 * Branded pins never land in Alternatives. A pin with an empty answer has no mention label.
 */
export function applyRunPins(
  themes: FullReportTheme[],
  pins: RunPin[],
  opts: { domain: string; includesBranded: boolean },
): FullReportTheme[] {
  if (pins.length === 0) return themes
  const copy = themes.map((theme) => ({ ...theme, questions: [...theme.questions] }))
  const have = (question: string) =>
    copy.some((theme) => theme.questions.some((item) => item.question.toLowerCase() === question.toLowerCase()))
  for (const pin of pins) {
    if (have(pin.question)) continue
    const branded = pin.framing === 'branded' || mentionsBrand(pin.question, opts.domain)
    if (branded && !opts.includesBranded) continue
    const id: ThemeId = branded ? 'described' : landThemeId(pin.question, 'unbranded')
    let theme = branded
      ? themeById(copy, 'described') ||
        themeById(copy, 'trust') ||
        themeById(copy, 'buying') ||
        themeById(copy, 'edge')
      : themeById(copy, id)
    if (!theme) theme = ensureTheme(copy, branded ? 'described' : id)
    if (theme.id === 'alternatives' && branded) continue
    theme.questions.push({
      question: pin.question,
      answer: '',
      framing: branded ? 'branded' : 'unbranded',
      whoInstead: [],
    })
  }
  return copy.filter((theme) => theme.questions.length > 0)
}

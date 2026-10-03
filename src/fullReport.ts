/**
 * Full-report theme plan and model-output shaping.
 * Theme titles are fixed. Empty themes drop. Alternatives stay unbranded.
 * Each theme is branded-only or unbranded-only. Buying and edge may appear
 * twice — same stable id, one framing each — so the mention % is not blended.
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
  /**
   * Unbranded Gemini reply beside `answer`. "" is a miss.
   * Absent on branded. Not a mention and not a who-instead list.
   */
  gemini?: string
}

export type FullReportTheme = {
  id: ThemeId
  title: string
  /** Every question in this theme uses this framing. */
  framing: Framing
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

/** `split` keeps one catalog id and emits two homogeneous themes, one framing each. */
export type ThemeAsk = 'unbranded' | 'branded' | 'split'

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
  return 'split'
}

/** Catalog lock for one stable theme id. */
export function themeAsk(id: ThemeId, includesBranded: boolean): ThemeAsk {
  const leaning = THEME_CATALOG.find((theme) => theme.id === id)?.leaning ?? 'unbranded'
  return askFor(leaning, includesBranded)
}

const BRANDED_HOME: readonly ThemeId[] = ['described', 'trust', 'buying', 'edge']
const UNBRANDED_HOME: readonly ThemeId[] = ['problems', 'alternatives', 'buying', 'edge']

/** Locked themes do not keep the other framing. Split ids keep both, apart. */
export function homeTheme(id: ThemeId, framing: Framing, includesBranded: boolean): ThemeId {
  const ask = themeAsk(id, includesBranded)
  if (ask === 'split' || ask === framing) return id
  const order = framing === 'branded' ? BRANDED_HOME : UNBRANDED_HOME
  const home = order.find((candidate) => {
    const next = themeAsk(candidate, includesBranded)
    return next === framing || next === 'split'
  })
  return home ?? (framing === 'branded' ? 'described' : 'problems')
}

/**
 * One framing per theme object. Buying and edge may appear twice under the same id.
 * A branded question never stays on an unbranded-only theme, and the reverse.
 */
export function assembleThemes(
  groups: { id: ThemeId; questions: FullReportQuestion[] }[],
  includesBranded: boolean,
): FullReportTheme[] {
  const seen = new Set<string>()
  const buckets = new Map<string, FullReportQuestion[]>()
  const put = (id: ThemeId, question: FullReportQuestion) => {
    if (question.framing === 'branded' && !includesBranded) return
    const key = question.question.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const home = homeTheme(id, question.framing, includesBranded)
    const bucketKey = `${home}:${question.framing}`
    const list = buckets.get(bucketKey) ?? []
    list.push(question)
    buckets.set(bucketKey, list)
  }
  for (const group of groups) {
    for (const question of group.questions) put(group.id, question)
  }
  const themes: FullReportTheme[] = []
  for (const catalog of THEME_CATALOG) {
    for (const framing of ['unbranded', 'branded'] as const) {
      const questions = buckets.get(`${catalog.id}:${framing}`)
      if (!questions || questions.length === 0) continue
      themes.push({ id: catalog.id, title: catalog.title, framing, questions })
    }
  }
  return themes
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

const GEMINI_MAX = 900

/** Gemini reply text. A missing or blank value is a miss, not a cleared OpenAI answer. */
export function cleanGeminiText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, GEMINI_MAX)
}

/** Unbranded question strings, in report order. Branded rows are skipped. */
export function unbrandedQuestionTexts(themes: readonly FullReportTheme[]): string[] {
  const questions: string[] = []
  for (const theme of themes) {
    for (const item of theme.questions) {
      if (item.framing === 'unbranded') questions.push(item.question)
    }
  }
  return questions
}

/**
 * Zip Gemini replies onto unbranded questions only.
 * Does not change `answer`, mention, or whoInstead. A short reply list leaves a miss.
 */
export function attachUnbrandedGemini(
  themes: readonly FullReportTheme[],
  replies: readonly string[],
): FullReportTheme[] {
  let cursor = 0
  return themes.map((theme) => ({
    ...theme,
    questions: theme.questions.map((item) => {
      if (item.framing !== 'unbranded') {
        if (item.gemini === undefined) return item
        const { gemini: _drop, ...rest } = item
        return rest
      }
      const gemini = cleanGeminiText(replies[cursor])
      cursor += 1
      return { ...item, gemini }
    }),
  }))
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
 * Each theme is one framing. Branded questions never stay in Alternatives or Problems.
 * Buying and edge keep both framings as separate themes with the same id.
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
      buckets.get(id)?.push(draft)
    }
  }

  const groups: { id: ThemeId; questions: DraftQuestion[] }[] = []
  for (const theme of opts.plan) {
    const questions = dedupe(buckets.get(theme.id) ?? [])
    if (questions.length === 0) continue
    groups.push({ id: theme.id, questions })
  }
  const ordered = assembleThemes(groups, opts.includesBranded)
  const trimmed = trimToTarget(ordered, Math.max(1, opts.questionTarget))
  const count = trimmed.reduce((sum, theme) => sum + theme.questions.length, 0)
  if (trimmed.length < Math.max(1, opts.themeMin)) return null
  if (count < questionFloor(opts.questionTarget, opts.themeMin)) return null
  for (const theme of trimmed) {
    if (theme.questions.some((item) => item.framing !== theme.framing)) return null
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
    'Every theme is unbranded-only or branded-only. Never mix both framings in one theme.',
    'The alternatives theme is unbranded-framed only. Never put a branded question there.',
  ]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  for (const theme of plan) {
    if (theme.ask === 'split') {
      const brandedCount = Math.floor(theme.count / 2)
      const unbrandedCount = theme.count - brandedCount
      if (unbrandedCount > 0) {
        lines.push(
          `Theme id "${theme.id}" (${theme.title}): write ${unbrandedCount} questions that do not name ${brand} or ${domain}. framing must be "unbranded". Return this framing alone.`,
        )
      }
      if (brandedCount > 0) {
        lines.push(
          `Theme id "${theme.id}" (${theme.title}): write ${brandedCount} questions that name ${brand}. framing must be "branded". Return this framing alone.`,
        )
      }
    } else if (theme.ask === 'branded') {
      lines.push(
        `Theme id "${theme.id}" (${theme.title}): write ${theme.count} questions that name ${brand}. framing must be "branded".`,
      )
    } else {
      lines.push(
        `Theme id "${theme.id}" (${theme.title}): write ${theme.count} questions that do not name ${brand} or ${domain}. framing must be "unbranded".`,
      )
    }
    if (theme.id === 'alternatives') {
      lines.push(
        `For "${theme.id}", ask who else shows up in the category. Do not mention ${brand}. Do not write branded dig questions in this theme.`,
      )
    }
    if (theme.id === 'problems') {
      lines.push(
        `For "${theme.id}", ask recommendation-shaped questions only: what tools, platforms, or software for the job, or what teams use for the job. Take the job from the homepage excerpt. Do not name ${brand}, the product, or ${domain}. Do not ask abstract how-do-I-solve questions.`,
      )
      lines.push(
        'On problems answers, you may name real products you already know; if unsure, say so plainly and leave whoInstead empty — never invent names, and do not force a company roster.',
      )
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

export const FULL_REPORT_SYSTEM_PROMPT = `You write a labeled visibility question set for one brand. This is a generated model exercise, not a live web crawl.
Do not invent citations, rankings, traffic, or a visibility percentage. Do not blend themes into a score.
Do not name any theme after a search engine or a results page.
Return JSON only:
{"themes":[{"id":"problems","questions":[{"question":"...","answer":"...","framing":"unbranded"}]}]}
Each answer is 1 or 2 conservative sentences from public knowledge. If unsure, say so. Do not invent praise. If you cannot answer, use an empty string.
framing "branded" means the question names the brand. framing "unbranded" means it does not.
The theme id "alternatives" is unbranded only: who else shows up in the category. Never put a branded question in alternatives. Never use the brand name, product name, or domain in that theme.
Each theme is unbranded-only or branded-only. Never mix both framings in one questions list. The ids "buying" and "edge" may be two theme objects with the same id, one framing each.
The theme id "problems" is unbranded only: recommendation-shaped questions that do not name the brand, product, or domain. Ask what tools, platforms, or software for the job, or what teams use for the job, using the homepage excerpt for the job. Do not ask abstract how-do-I-solve questions.
On problems answers, you may name real products you already know; if unsure, say so plainly and leave whoInstead empty — never invent names, and do not force a company roster.
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
  const groups: { id: ThemeId; questions: FullReportQuestion[] }[] = []
  for (const entry of blob.themes) {
    if (!isRecord(entry)) continue
    const id = resolveThemeId(entry.id)
    if (!id || !Array.isArray(entry.questions)) continue
    const questions: FullReportQuestion[] = []
    for (const item of entry.questions) {
      if (!isRecord(item)) continue
      const question = cleanQuestion(item.question)
      if (!question) continue
      const framing = inferFraming(question, domain)
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
      if (framing === 'unbranded') stored.gemini = cleanGeminiText(item.gemini)
      questions.push(stored)
    }
    if (questions.length === 0) continue
    groups.push({ id, questions })
  }
  const themes = assembleThemes(groups, includesBranded)
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

function themeSort(a: FullReportTheme, b: FullReportTheme): number {
  const ai = THEME_CATALOG.findIndex((theme) => theme.id === a.id)
  const bi = THEME_CATALOG.findIndex((theme) => theme.id === b.id)
  if (ai !== bi) return ai - bi
  if (a.framing === b.framing) return 0
  return a.framing === 'unbranded' ? -1 : 1
}

/**
 * Keep pinned wording in the report when the model drops it.
 * A pin joins the homogeneous theme for its framing. An empty answer has no mention label.
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
    const framing: Framing = mentionsBrand(pin.question, opts.domain) ? 'branded' : 'unbranded'
    if (framing === 'branded' && !opts.includesBranded) continue
    const preferred: ThemeId = framing === 'branded' ? 'described' : landThemeId(pin.question, 'unbranded')
    const id = homeTheme(preferred, framing, opts.includesBranded)
    let theme = copy.find((entry) => entry.id === id && entry.framing === framing)
    if (!theme) {
      const catalog = THEME_CATALOG.find((entry) => entry.id === id)
      theme = { id, title: catalog?.title || id, framing, questions: [] }
      copy.push(theme)
      copy.sort(themeSort)
    }
    theme.questions.push({
      question: pin.question,
      answer: '',
      framing,
      whoInstead: [],
    })
  }
  return copy.filter((theme) => theme.questions.length > 0)
}

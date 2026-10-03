/**
 * Durable question set on a saved check.
 * Theme ids stay the catalog ids. Pin/edit for one run is a different path.
 */

import type { ModeBeat } from './demoData.ts'
import {
  assembleThemes,
  brandLabel,
  THEME_CATALOG,
  resolveThemeId,
  type FullReport,
  type FullReportQuestion,
  type FullReportTheme,
} from './fullReport.ts'
import {
  isThemeId,
  landThemeId,
  mentionFromAnswer,
  mentionsBrand,
  parseWhoInstead,
  type ThemeId,
} from './mentionFacts.ts'
import type { CheckMode, StoredResult } from './savedResult.ts'

export const OWNED_QUESTION_MAX = 80
export const SHORT_OWNED_MAX = 8

export type OwnedQuestion = {
  question: string
  themeId: ThemeId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** How many usable questions are in the payload, ignoring the cap. */
export function countOwnedQuestions(value: unknown): number {
  if (!Array.isArray(value)) return 0
  const seen = new Set<string>()
  let count = 0
  for (const item of value) {
    const question = cleanText(typeof item === 'string' ? item : isRecord(item) ? item.question : '')
    if (!question || question.length > 240) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    count += 1
  }
  return count
}

/**
 * Normalize an edited set. Unknown theme ids fall back to the land/dig id.
 * A branded question never stays on Problems or Alternatives.
 */
export function cleanOwnedQuestions(value: unknown, domain: string, max = OWNED_QUESTION_MAX): OwnedQuestion[] {
  if (!Array.isArray(value)) return []
  const cap = Math.min(OWNED_QUESTION_MAX, Math.max(1, Math.floor(max)))
  const seen = new Set<string>()
  const out: OwnedQuestion[] = []
  for (const item of value) {
    let question = ''
    let themeRaw: unknown
    if (typeof item === 'string') {
      question = item
    } else if (isRecord(item)) {
      question = cleanText(item.question)
      themeRaw = item.themeId ?? item.id
    }
    question = cleanText(question)
    if (!question || question.length > 240) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const branded = mentionsBrand(question, domain)
    let themeId = resolveThemeId(themeRaw) ?? landThemeId(question, branded ? 'branded' : 'unbranded')
    if (!isThemeId(themeId)) themeId = landThemeId(question, branded ? 'branded' : 'unbranded')
    if (branded && (themeId === 'alternatives' || themeId === 'problems')) themeId = 'described'
    out.push({ question, themeId })
    if (out.length >= cap) break
  }
  return out
}

export function ownedFromReport(report: FullReport): OwnedQuestion[] {
  return report.themes.flatMap((theme) =>
    theme.questions.map((item) => ({ question: item.question, themeId: theme.id })),
  )
}

function priorQuestion(report: FullReport, question: string): FullReportQuestion | undefined {
  const key = question.toLowerCase()
  for (const theme of report.themes) {
    const found = theme.questions.find((item) => item.question.toLowerCase() === key)
    if (found) return found
  }
  return undefined
}

/** Replace the report roster with the owned list. Unchanged text keeps its answer and mention. */
export function applyOwnedToReport(report: FullReport, owned: OwnedQuestion[]): FullReport {
  const buckets = new Map<ThemeId, FullReportQuestion[]>()
  for (const item of owned) {
    const prior = priorQuestion(report, item.question)
    const framing = mentionsBrand(item.question, report.domain) ? 'branded' : 'unbranded'
    if (framing === 'branded' && !report.includesBranded) continue
    const same = prior && prior.question.toLowerCase() === item.question.toLowerCase()
    const next: FullReportQuestion = same
      ? {
          question: item.question,
          answer: prior.answer,
          framing,
          whoInstead: framing === 'unbranded' ? prior.whoInstead : [],
        }
      : {
          question: item.question,
          answer: '',
          framing,
          whoInstead: [],
        }
    if (same && prior.mention && prior.answer.trim()) next.mention = prior.mention
    const list = buckets.get(item.themeId) ?? []
    list.push(next)
    buckets.set(item.themeId, list)
  }
  const groups: { id: ThemeId; questions: FullReportQuestion[] }[] = []
  for (const theme of THEME_CATALOG) {
    const questions = buckets.get(theme.id)
    if (!questions || questions.length === 0) continue
    groups.push({ id: theme.id, questions })
  }
  return { ...report, themes: assembleThemes(groups, report.includesBranded) }
}

function replyAt(questions: string[], replies: string[], question: string): string {
  const at = questions.findIndex((item) => item.toLowerCase() === question.toLowerCase())
  if (at < 0) return ''
  return replies[at] || ''
}

/** Short-check question list. Same text keeps its reply and mention; theme id is the one given. */
export function applyOwnedToStoredShort(
  result: StoredResult,
  mode: CheckMode,
  owned: OwnedQuestion[],
): StoredResult {
  const beat = mode === 'branded' ? result.branded : result.unbranded
  const beatRec = beat && typeof beat === 'object' ? beat : null
  const priorQuestions = (beatRec?.questions ?? result.questions ?? []).filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  const priorReplies = (beatRec?.replies ?? result.answers?.replies ?? []).map((item) =>
    typeof item === 'string' ? item : '',
  )
  const priorFacts = beatRec?.facts ?? result.facts ?? []
  const questions = owned.map((item) => item.question)
  const replies = owned.map((item) => replyAt(priorQuestions, priorReplies, item.question))
  const facts = owned.map((item) => {
    const prior = priorFacts.find(
      (fact) => fact.question.toLowerCase() === item.question.toLowerCase(),
    )
    if (prior) {
      return {
        ...prior,
        question: item.question,
        id: item.themeId,
        framing: mode,
        whoInstead: mode === 'unbranded' ? prior.whoInstead : [],
      }
    }
    return { question: item.question, framing: mode, id: item.themeId, whoInstead: [] as string[] }
  })
  const generated = result.questionsGenerated !== false
  const next: StoredResult = {
    ...result,
    questions,
    questionsGenerated: generated,
    questionSetOwned: true,
    facts,
  }
  if (mode === 'branded') {
    next.answers = {
      answered: result.answers?.answered ?? null,
      why: result.answers?.why ?? '',
      live: result.answers?.live ?? false,
      replies,
    }
    next.branded = {
      ...(beatRec ?? {}),
      questions,
      questionsGenerated: generated,
      replies,
      facts,
    }
  } else {
    next.unbranded = {
      ...(beatRec ?? {}),
      questions,
      questionsGenerated: generated,
      facts,
    }
    const storedGemini = beatRec && Array.isArray(beatRec.gemini) ? beatRec.gemini : result.gemini
    const priorGemini = Array.isArray(storedGemini)
      ? storedGemini.map((item) => (typeof item === 'string' ? item : ''))
      : null
    if (priorGemini) {
      const gemini = owned.map((item) => replyAt(priorQuestions, priorGemini, item.question))
      next.gemini = gemini
      next.unbranded = { ...next.unbranded, gemini }
    }
  }
  return next
}

/** Keep answers aligned when the question text is unchanged. A rename clears that row’s answer. */
export function applyOwnedToBeat(beat: ModeBeat, owned: OwnedQuestion[]): ModeBeat {
  const facts = beat.facts ?? []
  const questions = owned.map((item) => item.question)
  const answers =
    beat.mode === 'branded'
      ? owned.map((item) => replyAt(beat.questions, beat.answers, item.question))
      : []
  const nextFacts = owned.map((item) => {
    const prior =
      facts.find((fact) => fact.question.toLowerCase() === item.question.toLowerCase()) ?? null
    if (prior) {
      return {
        ...prior,
        question: item.question,
        id: item.themeId,
        framing: beat.mode,
        whoInstead: beat.mode === 'unbranded' ? prior.whoInstead : [],
      }
    }
    return { question: item.question, framing: beat.mode, id: item.themeId, whoInstead: [] as string[] }
  })
  const next: ModeBeat = { ...beat, questions, answers, facts: nextFacts }
  if (beat.mode === 'unbranded' && beat.gemini) {
    next.gemini = owned.map((item) => replyAt(beat.questions, beat.gemini ?? [], item.question))
  }
  return next
}

export function groupOwned(owned: OwnedQuestion[]): { id: ThemeId; title: string; questions: string[] }[] {
  const buckets = new Map<ThemeId, string[]>()
  for (const item of owned) {
    const list = buckets.get(item.themeId) ?? []
    list.push(item.question)
    buckets.set(item.themeId, list)
  }
  const groups: { id: ThemeId; title: string; questions: string[] }[] = []
  for (const theme of THEME_CATALOG) {
    const questions = buckets.get(theme.id)
    if (!questions || questions.length === 0) continue
    groups.push({ id: theme.id, title: theme.title, questions })
  }
  return groups
}

/** Ask for answers to this set. The model must not invent a new roster. */
export function ownedAnswerPrompt(
  domain: string,
  groups: { id: ThemeId; title: string; questions: string[] }[],
  excerpt: string | null,
): string {
  const brand = brandLabel(domain)
  const lines = [
    `Brand domain: ${domain}`,
    `Brand name: ${brand}`,
    'Answer only the questions listed below. Do not add questions. Do not drop questions. Do not rewrite question text. Return each question string exactly.',
    'Do not return a score, rank, or visibility percentage.',
    'The alternatives theme is unbranded-framed only. Never put a branded question there.',
  ]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  for (const group of groups) {
    lines.push(`Theme id "${group.id}" (${group.title}):`)
    for (const question of group.questions) lines.push(`- ${question}`)
  }
  lines.push(
    'Each item is {"question","answer","framing","mention","whoInstead"}. mention is "mentioned", "not_mentioned", or "unclear". whoInstead is an array of at most 3 real names on unbranded questions and an empty array on branded questions. Never invent competitors. Each answer is one or two conservative sentences. If you cannot answer, use an empty string and do not invent a mention.',
  )
  return lines.join('\n')
}

function cleanAnswer(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 600)
}

type ModelAnswer = {
  question: string
  answer: string
  mention: unknown
  whoInstead: unknown
}

function readModelAnswers(raw: unknown): Map<ThemeId, ModelAnswer[]> {
  const byTheme = new Map<ThemeId, ModelAnswer[]>()
  if (!isRecord(raw) || !Array.isArray(raw.themes)) return byTheme
  for (const entry of raw.themes) {
    if (!isRecord(entry) || !Array.isArray(entry.questions)) continue
    const id = resolveThemeId(entry.id) ?? resolveThemeId(entry.title)
    if (!id) continue
    const list = byTheme.get(id) ?? []
    for (const item of entry.questions) {
      if (!isRecord(item)) continue
      const question = cleanText(item.question)
      if (!question) continue
      list.push({
        question,
        answer: cleanAnswer(item.answer),
        mention: item.mention,
        whoInstead: item.whoInstead,
      })
    }
    byTheme.set(id, list)
  }
  return byTheme
}

/**
 * Build themes from the owned list only.
 * Question text is the saved wording. Mention is omitted when the answer is empty.
 */
export function mergeOwnedAnswers(
  owned: OwnedQuestion[],
  raw: unknown,
  opts: { domain: string; includesBranded?: boolean },
): FullReportTheme[] | null {
  if (owned.length === 0) return null
  const byTheme = readModelAnswers(raw)
  const textIndex = new Map<string, ModelAnswer>()
  for (const list of byTheme.values()) {
    for (const item of list) textIndex.set(item.question.toLowerCase(), item)
  }
  const buckets = new Map<ThemeId, FullReportQuestion[]>()
  const pending = new Map<ThemeId, OwnedQuestion[]>()
  for (const item of owned) {
    const list = pending.get(item.themeId) ?? []
    list.push(item)
    pending.set(item.themeId, list)
  }
  for (const [themeId, items] of pending) {
    const modelRows = byTheme.get(themeId) ?? []
    const sameCount = modelRows.length === items.length
    items.forEach((item, index) => {
      const branded = mentionsBrand(item.question, opts.domain)
      const fromText = textIndex.get(item.question.toLowerCase())
      const fromIndex = sameCount ? modelRows[index] : undefined
      const picked = fromText ?? fromIndex
      const answer = picked?.answer ?? ''
      const framing = branded ? 'branded' : 'unbranded'
      const mention = mentionFromAnswer(answer, opts.domain, picked?.mention)
      const row: FullReportQuestion = {
        question: item.question,
        answer,
        framing,
        whoInstead:
          framing === 'unbranded' && mention ? parseWhoInstead(picked?.whoInstead, opts.domain) : [],
      }
      if (mention) row.mention = mention
      const list = buckets.get(themeId) ?? []
      list.push(row)
      buckets.set(themeId, list)
    })
  }
  const groups: { id: ThemeId; questions: FullReportQuestion[] }[] = []
  for (const theme of THEME_CATALOG) {
    const questions = buckets.get(theme.id)
    if (!questions || questions.length === 0) continue
    groups.push({ id: theme.id, questions })
  }
  const themes = assembleThemes(groups, opts.includesBranded !== false)
  return themes.length > 0 ? themes : null
}

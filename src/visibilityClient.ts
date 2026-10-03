/** Same-origin call to the Pages Function. Unbranded is the default; branded adds OpenAI answers and omits who-instead. Unbranded may include Gemini text beside the OpenAI result. */

import { readAnonKey } from './authClient.ts'
import type { Answered } from './demoData'
import { cleanAnswerFacts, factsFromVisibility, parseWhoInstead, type AnswerFact } from './mentionFacts.ts'

export type VisibilityMode = 'unbranded' | 'branded'

export type VisibilityOk = {
  ok: true
  mode: VisibilityMode
  questions: string[]
  /** Branded replies aligned to questions. "" means that row had no answer. Unbranded is []. */
  answers: string[]
  /** Unbranded Gemini replies aligned to questions. "" is a miss. Empty when this payload has no Gemini slot. */
  gemini: string[]
  answered: Answered
  why: string
  model: string
  whoInstead: string[]
  /** Per-question mention facts. Branded whoInstead is empty. Failed rows omit mention. */
  facts: AnswerFact[]
}

const ANSWER_MAX = 900

function normalizeAnswer(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX)
}

/**
 * Accepts string questions plus a parallel `answers` array, or `{ question, answer }` objects.
 * Branded only — callers drop the answers on unbranded.
 */
export function parseClientAnswers(
  questionsField: unknown,
  answersField: unknown,
  max = 5,
): { questions: string[]; answers: string[] } {
  if (!Array.isArray(questionsField)) return { questions: [], answers: [] }
  const cap = Math.min(8, Math.max(1, Math.floor(max)))
  const parallel = Array.isArray(answersField) ? answersField : []
  const questions: string[] = []
  const answers: string[] = []
  for (let i = 0; i < questionsField.length && questions.length < cap; i++) {
    const item = questionsField[i]
    let question = ''
    let answer: unknown = parallel[i]
    if (typeof item === 'string') {
      question = item
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      if (typeof rec.question === 'string') question = rec.question
      if (typeof rec.answer === 'string') answer = rec.answer
    }
    const q = question.replace(/\s+/g, ' ').trim()
    if (!q || q.length > 240) continue
    const fromItem = normalizeAnswer(answer)
    questions.push(q)
    answers.push(fromItem || normalizeAnswer(parallel[i]))
  }
  return { questions, answers }
}

/** Same rules as the Pages Function: trim, drop blanks, skip this brand, cap at 3. */
export function parseClientWhoInstead(value: unknown, domain?: string): string[] {
  return parseWhoInstead(value, domain)
}

export type VisibilityFail = {
  ok: false
  error: string
  code?: 'quota_exceeded'
  plan?: 'free' | 'paid'
}

function planOf(value: unknown): 'free' | 'paid' | undefined {
  if (value === 'paid' || value === 'free') return value
  return undefined
}

function scrubPublic(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function interpretVisibilityResponse(
  status: number,
  data: unknown,
  unusableBody: boolean,
  domain?: string,
  expectedMode?: VisibilityMode,
  ownedQuestions?: string[],
): VisibilityOk | VisibilityFail {
  if (status === 404 || unusableBody) {
    return {
      ok: false,
      error: 'Question generation is unavailable (/api/visibility is not running).',
    }
  }

  const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const serverError = rec && typeof rec.error === 'string' ? scrubPublic(rec.error) : ''

  if (status === 503) {
    return { ok: false, error: serverError || 'OPENAI_API_KEY not configured' }
  }

  if (status === 402 || rec?.code === 'quota_exceeded') {
    return {
      ok: false,
      error: serverError || 'Check limit reached.',
      code: 'quota_exceeded',
      plan: planOf(rec?.plan),
    }
  }

  if (!rec || status < 200 || status >= 300 || rec.ok !== true) {
    return {
      ok: false,
      error: serverError || `Question generation failed (HTTP ${status}).`,
    }
  }

  const owned = ownedQuestions && ownedQuestions.length > 0 ? ownedQuestions : null
  const parsedQa = parseClientAnswers(rec.questions, rec.answers, owned ? 8 : 5)
  const questions = parsedQa.questions
  const answered = rec.answered
  const why = typeof rec.why === 'string' ? rec.why.trim() : ''
  const model = typeof rec.model === 'string' ? rec.model.trim() : ''
  const answeredOk = answered === 'yes' || answered === 'partial' || answered === 'no'
  const modeRaw = rec.mode
  const mode: VisibilityMode | 'invalid' =
    modeRaw == null || modeRaw === ''
      ? 'unbranded'
      : modeRaw === 'unbranded' || modeRaw === 'branded'
        ? modeRaw
        : 'invalid'
  const ownedMatches =
    !!owned &&
    questions.length === owned.length &&
    questions.every((question, index) => question.toLowerCase() === owned[index].toLowerCase())
  if (owned && !ownedMatches) {
    return { ok: false, error: 'The check didn’t answer this question set.' }
  }
  if (
    (!owned && (questions.length < 3 || questions.length > 5)) ||
    (owned && (questions.length < 1 || questions.length > 8)) ||
    !answeredOk ||
    !why ||
    !model ||
    mode === 'invalid'
  ) {
    return { ok: false, error: 'Question generation returned an unusable result.' }
  }
  if (expectedMode && mode !== expectedMode) {
    return { ok: false, error: 'Question generation returned an unusable result.' }
  }

  const answers = mode === 'branded' ? parsedQa.answers : []
  const geminiField = rec.gemini
  const gemini =
    mode === 'unbranded' && Array.isArray(geminiField)
      ? questions.map((_, index) => normalizeAnswer(geminiField[index]))
      : []
  const whoInstead = mode === 'branded' ? [] : parseClientWhoInstead(rec.whoInstead, domain)
  const hosted = domain || (typeof rec.domain === 'string' ? rec.domain : '')
  const cleaned = Array.isArray(rec.facts) ? cleanAnswerFacts(rec.facts, hosted, mode) : []
  const facts =
    cleaned.length === questions.length
      ? cleaned
      : factsFromVisibility({
          domain: hosted,
          mode,
          questions,
          answers,
          answered,
          whoInstead,
          mentions: rec.mentions,
        })
  return {
    ok: true,
    mode,
    questions,
    answered,
    why,
    model,
    // OpenAI prose is the branded dig only. Unbranded keeps that list empty.
    answers,
    // Gemini text is unbranded-only and is not a mention or a who-instead list.
    gemini,
    // Who-instead is the unbranded beat only, even if a branded payload includes names.
    whoInstead,
    facts,
  }
}

export async function fetchVisibility(
  domain: string,
  mode: VisibilityMode = 'unbranded',
  accessToken?: string | null,
  questions?: string[],
): Promise<VisibilityOk | VisibilityFail> {
  const owned = questions && questions.length > 0 ? questions : undefined
  const headers = new Headers({ Accept: 'application/json' })
  const anon = readAnonKey()
  if (anon) headers.set('x-grank-anon', anon)
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
  if (owned) headers.set('content-type', 'application/json')
  let res: Response
  try {
    res = await fetch(owned ? '/api/visibility' : `/api/visibility?domain=${encodeURIComponent(domain)}&mode=${mode}`, {
      method: owned ? 'POST' : 'GET',
      headers,
      body: owned ? JSON.stringify({ domain, mode, questions: owned }) : undefined,
    })
  } catch {
    return { ok: false, error: 'Could not reach question generation. Try again.' }
  }

  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretVisibilityResponse(res.status, null, true, domain, mode, owned)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Question generation failed (HTTP ${res.status}).` }
  }

  return interpretVisibilityResponse(res.status, data, false, domain, mode, owned)
}

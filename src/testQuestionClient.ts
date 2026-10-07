import { cleanGeminiText, type FullReport } from './fullReport.ts'
import type { ThemeId } from './mentionFacts.ts'

export type TestEngine = 'openai' | 'gemini'

export type TestQuestionInput = {
  question: string
  engine: TestEngine
  themeId: ThemeId
}

/** What the open question does after the request. The answer text is applied by the caller. */
export type TestQuestionOutcome = { ok: true; openaiPaused?: boolean } | { ok: false; error: string }

export type TestQuestionOk =
  | { ok: true; engine: 'openai'; openaiPaused: true }
  | { ok: true; engine: 'openai'; answer: string }
  | { ok: true; engine: 'gemini'; gemini: string }

export type TestQuestionFail = { ok: false; error: string }

const ANSWER_MAX = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function scrubPublic(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function questionKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function cleanAnswerText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX)
}

/**
 * Replace one engine’s text on the matching question.
 * Mention, who-instead, and the other engine stay as they were.
 * A Gemini patch does not attach a reply to a branded row.
 */
export function patchTestAnswer(
  report: FullReport,
  question: string,
  patch: { engine: 'openai'; answer: string } | { engine: 'gemini'; gemini: string },
): FullReport {
  const key = questionKey(question)
  let changed = false
  const themes = report.themes.map((theme) => {
    let themeChanged = false
    const questions = theme.questions.map((item) => {
      if (questionKey(item.question) !== key) return item
      if (patch.engine === 'gemini') {
        if (item.framing !== 'unbranded') return item
        const gemini = cleanGeminiText(patch.gemini)
        if ((item.gemini ?? '') === gemini) return item
        themeChanged = true
        changed = true
        return { ...item, gemini }
      }
      const answer = cleanAnswerText(patch.answer)
      if (item.answer === answer) return item
      themeChanged = true
      changed = true
      return { ...item, answer }
    })
    return themeChanged ? { ...theme, questions } : theme
  })
  return changed ? { ...report, themes } : report
}

export function interpretTestQuestionResponse(
  status: number,
  data: unknown,
  unusableBody: boolean,
): TestQuestionOk | TestQuestionFail {
  if (status === 404 || unusableBody) {
    return { ok: false, error: 'Test question is unavailable (/api/test-question is not running).' }
  }
  const rec = isRecord(data) ? data : null
  const serverError = rec && typeof rec.error === 'string' ? scrubPublic(rec.error) : ''
  if (status === 401) return { ok: false, error: serverError || 'Sign in to run a test question.' }
  if (!rec || rec.ok !== true || status < 200 || status >= 300) {
    return { ok: false, error: serverError || `Test question failed (HTTP ${status}).` }
  }
  if (rec.engine === 'openai' && rec.openaiPaused === true) {
    return { ok: true, engine: 'openai', openaiPaused: true }
  }
  if (rec.engine === 'gemini' && typeof rec.gemini === 'string') {
    return { ok: true, engine: 'gemini', gemini: rec.gemini }
  }
  if (rec.engine === 'openai' && typeof rec.answer === 'string') {
    return { ok: true, engine: 'openai', answer: rec.answer }
  }
  return { ok: false, error: serverError || `Test question failed (HTTP ${status}).` }
}

/** One signed-in question, one engine. Does not call the full-report route. */
export async function fetchTestQuestion(
  domain: string,
  accessToken: string,
  input: TestQuestionInput,
): Promise<TestQuestionOk | TestQuestionFail> {
  let res: Response
  try {
    res = await fetch('/api/test-question', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        domain,
        question: input.question,
        engine: input.engine,
        themeId: input.themeId,
      }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the test question. Try again.' }
  }
  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretTestQuestionResponse(res.status, null, true)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Test question failed (HTTP ${res.status}).` }
  }
  return interpretTestQuestionResponse(res.status, data, false)
}

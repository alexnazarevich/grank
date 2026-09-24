/** Same-origin call to the Pages Function that generates questions and answered-by-you. */

import type { Answered } from './demoData'

export type VisibilityOk = {
  ok: true
  questions: string[]
  answered: Answered
  why: string
  model: string
}

export type VisibilityFail = {
  ok: false
  error: string
}

function scrubPublic(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function interpretVisibilityResponse(
  status: number,
  data: unknown,
  unusableBody: boolean,
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

  if (!rec || status < 200 || status >= 300 || rec.ok !== true) {
    return {
      ok: false,
      error: serverError || `Question generation failed (HTTP ${status}).`,
    }
  }

  const questions = Array.isArray(rec.questions)
    ? rec.questions
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim())
        .filter(Boolean)
    : []
  const answered = rec.answered
  const why = typeof rec.why === 'string' ? rec.why.trim() : ''
  const model = typeof rec.model === 'string' ? rec.model.trim() : ''
  const answeredOk = answered === 'yes' || answered === 'partial' || answered === 'no'
  if (questions.length < 3 || questions.length > 5 || !answeredOk || !why || !model) {
    return { ok: false, error: 'Question generation returned an unusable result.' }
  }

  return { ok: true, questions, answered, why, model }
}

export async function fetchVisibility(domain: string): Promise<VisibilityOk | VisibilityFail> {
  let res: Response
  try {
    res = await fetch(`/api/visibility?domain=${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { ok: false, error: 'Could not reach question generation. Try again.' }
  }

  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretVisibilityResponse(res.status, null, true)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Question generation failed (HTTP ${res.status}).` }
  }

  return interpretVisibilityResponse(res.status, data, false)
}

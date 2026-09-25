/** Same-origin call to the Pages Function. Unbranded is the default; branded omits who-instead. */

import type { Answered } from './demoData'

export type VisibilityMode = 'unbranded' | 'branded'

export type VisibilityOk = {
  ok: true
  mode: VisibilityMode
  questions: string[]
  answered: Answered
  why: string
  model: string
  whoInstead: string[]
}

const WHO_INSTEAD_MAX = 3
const WHO_INSTEAD_NAME_MAX = 80

/** Same rules as the Pages Function: trim, drop blanks, skip this brand, cap at 3. */
export function parseClientWhoInstead(value: unknown, domain?: string): string[] {
  if (!Array.isArray(value)) return []
  const blocked = new Set<string>()
  if (domain) {
    const host = domain.toLowerCase()
    const stem = host.split('.')[0] || host
    blocked.add(stem.replace(/[^a-z0-9]+/g, ''))
    blocked.add(host.replace(/[^a-z0-9]+/g, ''))
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim()
    if (!name || name.length > WHO_INSTEAD_NAME_MAX) continue
    const key = name.toLowerCase()
    const compact = key.replace(/[^a-z0-9]+/g, '')
    if (!compact || blocked.has(compact) || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= WHO_INSTEAD_MAX) break
  }
  return out
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
  domain?: string,
  expectedMode?: VisibilityMode,
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
  const modeRaw = rec.mode
  const mode: VisibilityMode | 'invalid' =
    modeRaw == null || modeRaw === ''
      ? 'unbranded'
      : modeRaw === 'unbranded' || modeRaw === 'branded'
        ? modeRaw
        : 'invalid'
  if (questions.length < 3 || questions.length > 5 || !answeredOk || !why || !model || mode === 'invalid') {
    return { ok: false, error: 'Question generation returned an unusable result.' }
  }
  if (expectedMode && mode !== expectedMode) {
    return { ok: false, error: 'Question generation returned an unusable result.' }
  }

  return {
    ok: true,
    mode,
    questions,
    answered,
    why,
    model,
    // Who-instead is the unbranded beat only, even if a branded payload includes names.
    whoInstead: mode === 'branded' ? [] : parseClientWhoInstead(rec.whoInstead, domain),
  }
}

export async function fetchVisibility(
  domain: string,
  mode: VisibilityMode = 'unbranded',
): Promise<VisibilityOk | VisibilityFail> {
  let res: Response
  try {
    res = await fetch(
      `/api/visibility?domain=${encodeURIComponent(domain)}&mode=${mode}`,
      { headers: { Accept: 'application/json' } },
    )
  } catch {
    return { ok: false, error: 'Could not reach question generation. Try again.' }
  }

  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretVisibilityResponse(res.status, null, true, domain, mode)
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Question generation failed (HTTP ${res.status}).` }
  }

  return interpretVisibilityResponse(res.status, data, false, domain, mode)
}

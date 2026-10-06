import { readAnonKey } from './authClient.ts'
import { fullReportFromStored, type FullReport, type RunPin } from './fullReport.ts'
import type { OwnedQuestion } from './ownedQuestions.ts'
import { cleanRuns, type CheckRun } from './runHistory.ts'

export type FullReportFail = {
  ok: false
  error: string
  code?: 'full_report_limit' | 'quota_exceeded'
  plan?: 'free' | 'paid'
  /** Paywall is on: the upgrade wall should open, not only the limit sentence. */
  upgrade?: boolean
}

/** Second full report (upgrade flag) and check-quota 402 both open the existing pay gate. */
export function fullReportOpensPayGate(fail: { code?: string; upgrade?: boolean }): boolean {
  return fail.code === 'quota_exceeded' || (fail.code === 'full_report_limit' && fail.upgrade === true)
}

export type FullReportOk = {
  ok: true
  report: FullReport
  checkId: string | null
  runs: CheckRun[]
  /** In memory for this response only. Never part of the stored report. */
  geminiMiss?: SignedGeminiMiss
  /** This Run again skipped OpenAI and was not saved. */
  openaiPaused?: boolean
}

/** The five locked classes. http_reject may carry a numeric status and nothing else. */
export type SignedGeminiMiss =
  | { class: 'missing_key' | 'timeout' | 'bad_json' | 'empty' }
  | { class: 'http_reject'; status?: number }

const SIGNED_GEMINI_MISS = new Set(['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'])

function missStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) return undefined
  return value
}

/** Drop anything that is not a locked class. A status is kept only for http_reject. */
export function geminiMissFromPayload(value: unknown): SignedGeminiMiss | undefined {
  if (!isRecord(value) || typeof value.class !== 'string' || !SIGNED_GEMINI_MISS.has(value.class)) return undefined
  if (value.class === 'http_reject') {
    const status = missStatus(value.status)
    return status === undefined ? { class: 'http_reject' } : { class: 'http_reject', status }
  }
  if (value.class === 'missing_key' || value.class === 'timeout' || value.class === 'bad_json' || value.class === 'empty') {
    return { class: value.class }
  }
  return undefined
}

function scrubPublic(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function planOf(value: unknown): 'free' | 'paid' | undefined {
  if (value === 'paid' || value === 'free') return value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Trust the server shape, but drop anything that is not a locked theme. */
export function reportFromPayload(data: unknown): FullReport | null {
  if (!isRecord(data) || data.ok !== true || data.report !== 'full') return null
  return fullReportFromStored({
    report: 'full',
    fullReport: {
      domain: data.domain,
      model: data.model,
      includesBranded: data.includesBranded === true,
      themes: data.themes,
    },
  })
}

export function interpretFullReportResponse(status: number, data: unknown, unusableBody: boolean): FullReportOk | FullReportFail {
  if (status === 404 || unusableBody) {
    return { ok: false, error: 'Full report is unavailable (/api/full-report is not running).' }
  }
  const rec = isRecord(data) ? data : null
  const serverError = rec && typeof rec.error === 'string' ? scrubPublic(rec.error) : ''
  if (status === 401) return { ok: false, error: serverError || 'Sign in to unlock your full report.' }
  if (status === 403 || rec?.code === 'full_report_limit') {
    return {
      ok: false,
      error: serverError || 'You’ve used your free full report.',
      code: 'full_report_limit',
      upgrade: rec?.upgrade === true,
      plan: planOf(rec?.plan),
    }
  }
  if (status === 402 || rec?.code === 'quota_exceeded') {
    return {
      ok: false,
      error: serverError || 'Check limit reached.',
      code: 'quota_exceeded',
      plan: planOf(rec?.plan),
    }
  }
  if (status === 503) return { ok: false, error: serverError || 'OPENAI_API_KEY not configured' }
  const report = reportFromPayload(data)
  if (!rec || status < 200 || status >= 300 || !report) {
    return { ok: false, error: serverError || `Full report failed (HTTP ${status}).` }
  }
  const check = isRecord(rec.check) && typeof rec.check.id === 'string' ? rec.check.id : null
  const geminiMiss = geminiMissFromPayload(rec.geminiMiss)
  const openaiPaused = rec.openaiPaused === true
  return {
    ok: true,
    report,
    checkId: check,
    runs: cleanRuns(rec.runs),
    ...(geminiMiss ? { geminiMiss } : {}),
    ...(openaiPaused ? { openaiPaused: true as const } : {}),
  }
}

export async function fetchFullReport(
  domain: string,
  accessToken: string,
  pins: RunPin[] = [],
): Promise<FullReportOk | FullReportFail> {
  const headers = new Headers({
    Accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  })
  const anon = readAnonKey()
  if (anon) headers.set('x-grank-anon', anon)
  let res: Response
  try {
    res = await fetch('/api/full-report', {
      method: 'POST',
      headers,
      body: JSON.stringify(pins.length > 0 ? { domain, pins } : { domain }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the full report. Try again.' }
  }
  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretFullReportResponse(res.status, null, true)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Full report failed (HTTP ${res.status}).` }
  }
  return interpretFullReportResponse(res.status, data, false)
}

/** Answer a saved question set. The server must not replace it with a generated roster. */
export async function fetchOwnedReport(
  domain: string,
  accessToken: string,
  owned: OwnedQuestion[],
  checkId?: string | null,
): Promise<FullReportOk | FullReportFail> {
  const headers = new Headers({
    Accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  })
  const anon = readAnonKey()
  if (anon) headers.set('x-grank-anon', anon)
  let res: Response
  try {
    res = await fetch('/api/full-report', {
      method: 'POST',
      headers,
      body: JSON.stringify(checkId ? { domain, owned, checkId } : { domain, owned }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the full report. Try again.' }
  }
  const raw = await res.text()
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) {
    return interpretFullReportResponse(res.status, null, true)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Full report failed (HTTP ${res.status}).` }
  }
  return interpretFullReportResponse(res.status, data, false)
}

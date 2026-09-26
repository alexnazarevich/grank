import { readAnonKey } from './authClient.ts'
import type { CheckDraft, CheckMode, SavedCheck, StoredResult } from './savedResult.ts'

export const SAVE_UNAVAILABLE = 'Save is unavailable (/api/checks is not running).'

type SaveOk = { ok: true; check: SavedCheck }
type ListOk = { ok: true; checks: SavedCheck[] }
type Fail = { ok: false; error: string; code?: string; plan?: 'free' | 'paid' }

function planOf(value: unknown): 'free' | 'paid' | undefined {
  if (value === 'paid' || value === 'free') return value
  return undefined
}

function asMode(value: unknown): CheckMode {
  return value === 'branded' ? 'branded' : 'unbranded'
}

function asSaved(value: unknown): SavedCheck | null {
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const id = typeof rec.id === 'string' ? rec.id : ''
  const domain = typeof rec.domain === 'string' ? rec.domain : ''
  const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : ''
  const result = rec.result
  if (!id || !domain || !createdAt || !result || typeof result !== 'object') return null
  return {
    id,
    domain,
    mode: asMode(rec.mode),
    createdAt,
    result: result as StoredResult,
  }
}

async function interpret(res: Response): Promise<SaveOk | ListOk | Fail | 'html'> {
  const type = res.headers.get('content-type') || ''
  const raw = await res.text()
  if (type.includes('text/html') || raw.trimStart().startsWith('<')) return 'html'
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: `Save failed (HTTP ${res.status}).` }
  }
  const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const serverError = rec && typeof rec.error === 'string' ? rec.error : ''
  if (!res.ok || !rec || rec.ok !== true) {
    return {
      ok: false,
      error: serverError || `Save failed (HTTP ${res.status}).`,
      code: rec && typeof rec.code === 'string' ? rec.code : undefined,
      plan: planOf(rec?.plan),
    }
  }
  if (Array.isArray(rec.checks)) {
    return {
      ok: true,
      checks: rec.checks.map(asSaved).filter((item): item is SavedCheck => item !== null),
    }
  }
  const check = asSaved(rec.check)
  if (!check) return { ok: false, error: 'Save returned an unusable result.' }
  return { ok: true, check }
}

export async function saveCheck(accessToken: string, draft: CheckDraft): Promise<SaveOk | Fail> {
  const headers = new Headers({
    Accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  })
  const anon = readAnonKey()
  if (anon) headers.set('x-grank-anon', anon)
  let res: Response
  try {
    res = await fetch('/api/checks', {
      method: 'POST',
      headers,
      body: JSON.stringify(draft),
    })
  } catch {
    return { ok: false, error: 'Could not reach save. Try again.' }
  }
  const parsed = await interpret(res)
  if (parsed === 'html') return { ok: false, error: SAVE_UNAVAILABLE }
  if (!parsed.ok) return parsed
  if (!('check' in parsed)) return { ok: false, error: 'Save returned an unusable result.' }
  return parsed
}

export async function listChecks(accessToken: string): Promise<ListOk | Fail> {
  let res: Response
  try {
    res = await fetch('/api/checks', {
      headers: { Accept: 'application/json', authorization: `Bearer ${accessToken}` },
    })
  } catch {
    return { ok: false, error: 'Could not reach history. Try again.' }
  }
  const parsed = await interpret(res)
  if (parsed === 'html') return { ok: false, error: SAVE_UNAVAILABLE }
  if (!parsed.ok) return parsed
  if (!('checks' in parsed)) return { ok: false, error: 'History returned an unusable result.' }
  return parsed
}

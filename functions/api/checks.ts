/**
 * GET /api/checks — list the signed-in user's saved checks.
 * POST /api/checks — insert a new check, then trim to the history cap.
 * PATCH /api/checks — replace the question list on one saved check.
 * Writes use SUPABASE_SERVICE_ROLE_KEY. The browser only sends the user access token.
 */

import { historyCapForPlan, productConfigFromEnv, type ProductConfig } from '../../src/config/productConfig.ts'
import { fullReportFromStored } from '../../src/fullReport.ts'
import {
  OWNED_QUESTION_MAX,
  SHORT_OWNED_MAX,
  applyOwnedToReport,
  applyOwnedToStoredShort,
  cleanOwnedQuestions,
  countOwnedQuestions,
} from '../../src/ownedQuestions.ts'
import type { StoredResult } from '../../src/savedResult.ts'
import { json, scrubSecret } from './http.ts'
import { admitUsage, anonKeyFromRequest, linkAnonUsage } from './quota.ts'
import { idsBeyondCap, retentionCutoffIso, shapeStoredCheck, type CheckRow } from './shapeCheck.ts'
import {
  bearer,
  ensureProfile,
  readPlan,
  sbConfig,
  sbFetch,
  SERVER_AUTH_NOT_CONFIGURED,
  serviceHeaders,
  userFromToken,
  UUID_RE,
  type ServiceDb,
} from './supabaseAuth.ts'

export { SERVER_AUTH_NOT_CONFIGURED }

type ChecksEnv = Record<string, string | undefined>

async function listIds(sb: ServiceDb, userId: string): Promise<CheckRow[]> {
  const res = await sbFetch(
    sb,
    `/rest/v1/checks?user_id=eq.${userId}&select=id,created_at&order=created_at.desc`,
    { headers: serviceHeaders(sb.serviceRole) },
  )
  if (!res.ok) return []
  const rows = (await res.json()) as { id?: string; created_at?: string }[]
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is CheckRow =>
      typeof row.id === 'string' && UUID_RE.test(row.id) && typeof row.created_at === 'string',
  )
}

async function deleteIds(sb: ServiceDb, userId: string, ids: string[]): Promise<void> {
  const safe = ids.filter((id) => UUID_RE.test(id))
  if (safe.length === 0) return
  await sbFetch(sb, `/rest/v1/checks?user_id=eq.${userId}&id=in.(${safe.join(',')})`, {
    method: 'DELETE',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
  })
}

async function deleteExpired(sb: ServiceDb, userId: string, cutoffIso: string): Promise<void> {
  await sbFetch(sb, `/rest/v1/checks?user_id=eq.${userId}&created_at=lt.${encodeURIComponent(cutoffIso)}`, {
    method: 'DELETE',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
  })
}

async function recordSave(sb: ServiceDb, userId: string): Promise<void> {
  await sbFetch(sb, '/rest/v1/usage_events', {
    method: 'POST',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
    body: JSON.stringify({ user_id: userId, kind: 'save' }),
  }).catch(() => {})
}

function publicError(message: string, secret: string): string {
  return scrubSecret(message, secret).slice(0, 240) || 'Save failed.'
}

export async function onRequest(context: { request: Request; env?: ChecksEnv }): Promise<Response> {
  const { request } = context
  if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PATCH') {
    return json(405, { error: 'Use GET, POST, or PATCH' })
  }
  const sb = sbConfig(context.env)
  if (!sb) return json(503, { error: SERVER_AUTH_NOT_CONFIGURED })

  const accessToken = bearer(request)
  if (!accessToken) return json(401, { error: 'Sign in to save this check.' })

  const config = productConfigFromEnv(context.env)
  const authed = await userFromToken(sb, accessToken)
  if (!authed.ok) return json(authed.status, { error: publicError(authed.error, sb.serviceRole) })

  if (request.method === 'GET') return listChecks(sb, authed.user.id, config)
  if (request.method === 'PATCH') return updateQuestions(sb, authed.user.id, request)

  const raw = await request.text()
  if (raw.length > 100_000) return json(413, { error: 'Check body is too large.' })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'Check body must be JSON' })
  }
  return insertCheck(sb, authed.user.id, body, config, request)
}

async function listChecks(sb: ServiceDb, userId: string, config: ProductConfig): Promise<Response> {
  const cutoff = retentionCutoffIso(config.checkRetentionDays)
  if (cutoff) await deleteExpired(sb, userId, cutoff).catch(() => {})
  let res: Response
  try {
    res = await sbFetch(
      sb,
      `/rest/v1/checks?user_id=eq.${userId}&select=id,domain,mode,result,created_at&order=created_at.desc&limit=100`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
  } catch {
    return json(502, { error: 'Could not load history.' })
  }
  if (!res.ok) return json(502, { error: 'Could not load history.' })
  let rows: unknown
  try {
    rows = await res.json()
  } catch {
    return json(502, { error: 'Could not load history.' })
  }
  const checks = Array.isArray(rows)
    ? rows.map((row) => {
        const rec = row as Record<string, unknown>
        return {
          id: rec.id,
          domain: rec.domain,
          mode: rec.mode === 'branded' ? 'branded' : 'unbranded',
          createdAt: rec.created_at,
          result: rec.result ?? {},
        }
      })
    : []
  return json(200, { ok: true, checks })
}

async function insertCheck(
  sb: ServiceDb,
  userId: string,
  body: unknown,
  config: ProductConfig,
  request: Request,
): Promise<Response> {
  const shaped = shapeStoredCheck(body, config, sb.serviceRole)
  if (!shaped.ok) return json(400, { error: shaped.error })

  await ensureProfile(sb, userId).catch(() => {})
  const plan = await readPlan(sb, userId, config)
  const anon = anonKeyFromRequest(request)
  if (config.paywallEnabled && anon) {
    const linked = await linkAnonUsage(sb, anon, userId)
    if (!linked) return json(503, { error: 'Could not check the save limit.' })
  }
  const admitted = await admitUsage({
    sb,
    userId,
    anonKey: anon,
    plan,
    config,
    kind: 'save',
  })
  if (!admitted.ok) return admitted.response
  const cap = historyCapForPlan(config, plan)

  let res: Response
  try {
    res = await sbFetch(sb, '/rest/v1/checks', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=representation'),
      body: JSON.stringify({
        user_id: userId,
        domain: shaped.domain,
        mode: shaped.mode,
        result: shaped.result,
      }),
    })
  } catch {
    await admitted.release()
    return json(502, { error: 'Could not save this check.' })
  }
  if (!res.ok) {
    await admitted.release()
    return json(502, { error: 'Could not save this check.' })
  }

  let created: unknown
  try {
    created = await res.json()
  } catch {
    await admitted.release()
    return json(502, { error: 'Could not save this check.' })
  }
  const row = Array.isArray(created) ? (created[0] as Record<string, unknown>) : null
  const id = row && typeof row.id === 'string' ? row.id : ''
  if (!id) {
    await admitted.release()
    return json(502, { error: 'Could not save this check.' })
  }

  try {
    const rows = await listIds(sb, userId)
    await deleteIds(sb, userId, idsBeyondCap(rows, cap))
    const cutoff = retentionCutoffIso(config.checkRetentionDays)
    if (cutoff) await deleteExpired(sb, userId, cutoff)
  } catch {
    // The row is saved. Trim is best-effort on a flaky round trip.
  }
  if (!admitted.recorded) await recordSave(sb, userId)

  const text = JSON.stringify({
    ok: true,
    check: {
      id,
      domain: shaped.domain,
      mode: shaped.mode,
      createdAt: row && typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
      result: shaped.result,
    },
  })
  if (text.includes(sb.serviceRole)) {
    return json(500, { error: 'Save failed.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function publicCheck(row: Record<string, unknown>, result: StoredResult) {
  return {
    id: row.id,
    domain: row.domain,
    mode: row.mode === 'branded' ? 'branded' : 'unbranded',
    createdAt: row.created_at,
    result,
  }
}

/** Replace the question list on a check the user already owns. Does not insert a row. */
async function updateQuestions(sb: ServiceDb, userId: string, request: Request): Promise<Response> {
  const raw = await request.text()
  if (raw.length > 100_000) return json(413, { error: 'Check body is too large.' })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'Check body must be JSON' })
  }
  if (!isRecord(body) || typeof body.id !== 'string' || !UUID_RE.test(body.id)) {
    return json(400, { error: 'Check id is required.' })
  }
  const id = body.id

  let loaded: Response
  try {
    loaded = await sbFetch(
      sb,
      `/rest/v1/checks?id=eq.${id}&user_id=eq.${userId}&select=id,domain,mode,result,created_at`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
  } catch {
    return json(502, { error: 'Could not save these questions.' })
  }
  if (!loaded.ok) return json(502, { error: 'Could not save these questions.' })
  let rows: unknown
  try {
    rows = await loaded.json()
  } catch {
    return json(502, { error: 'Could not save these questions.' })
  }
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!row || !isRecord(row.result) || typeof row.domain !== 'string') {
    return json(404, { error: 'That check is not in your history.' })
  }

  const stored = row.result as StoredResult
  const full = stored.report === 'full'
  const cap = full ? OWNED_QUESTION_MAX : SHORT_OWNED_MAX
  if (countOwnedQuestions(body.questions) > cap) {
    return json(400, { error: `This check can hold ${cap} questions.` })
  }
  const owned = cleanOwnedQuestions(body.questions, row.domain, cap).map((item) => ({
    ...item,
    question: scrubSecret(item.question, sb.serviceRole),
  }))
  if (owned.length < 1) return json(400, { error: 'Keep at least one question.' })

  let result: StoredResult
  if (full) {
    const report = fullReportFromStored(stored)
    if (!report) return json(400, { error: 'This check has no question list to edit.' })
    const nextReport = applyOwnedToReport(report, owned)
    if (nextReport.themes.length < 1) return json(400, { error: 'Keep at least one question.' })
    result = {
      ...stored,
      questionSetOwned: true,
      report: 'full',
      fullReport: {
        domain: nextReport.domain,
        model: nextReport.model,
        includesBranded: nextReport.includesBranded,
        themes: nextReport.themes,
      },
    }
  } else {
    const mode = body.mode === 'branded' || body.mode === 'unbranded' ? body.mode : row.mode === 'branded' ? 'branded' : 'unbranded'
    result = applyOwnedToStoredShort(stored, mode, owned)
  }

  let updated: Response
  try {
    updated = await sbFetch(sb, `/rest/v1/checks?id=eq.${id}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: serviceHeaders(sb.serviceRole, 'return=representation'),
      body: JSON.stringify({ result }),
    })
  } catch {
    return json(502, { error: 'Could not save these questions.' })
  }
  if (!updated.ok) return json(502, { error: 'Could not save these questions.' })

  const text = JSON.stringify({ ok: true, check: publicCheck(row, result) })
  if (text.includes(sb.serviceRole)) return json(500, { error: 'Could not save these questions.' })
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

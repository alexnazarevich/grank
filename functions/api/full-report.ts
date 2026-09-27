/**
 * POST /api/full-report { domain }
 * One signed-in full report: themed questions, each labeled Generated · OpenAI.
 * The first freeFullReports runs are complimentary. Later runs use the (9)
 * check quota while the paywall is on. No second report SKU.
 * OPENAI_API_KEY and SUPABASE_SERVICE_ROLE_KEY stay on the server.
 */

import { historyCapForPlan, productConfigFromEnv, type ProductConfig } from '../../src/config/productConfig.ts'
import {
  FULL_REPORT_SYSTEM_PROMPT,
  applyRunPins,
  cleanRunPins,
  fullReportPrompt,
  mergeThemePayloads,
  parseModelJson,
  selectThemePlan,
  shapeFullReport,
  type FullReportTheme,
  type PlannedTheme,
  type RunPin,
} from '../../src/fullReport.ts'
import { LABEL_GENERATED } from '../../src/savedResult.ts'
import { canonicalHostname, pageTextFromHtml } from './homepage.ts'
import { json, scrubSecret } from './http.ts'
import { admitUsage, anonKeyFromRequest, linkAnonUsage, rankInWindow } from './quota.ts'
import { idsBeyondCap, retentionCutoffIso, type CheckRow } from './shapeCheck.ts'
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

const MODEL = 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 22_000
const EXCERPT_TIMEOUT_MS = 3_000
const USER_AGENT = 'GrankBot/0.1 (+https://grank.pages.dev)'
const FULL_REPORT_KIND = 'full_report'

export const FULL_REPORT_LIMIT_CODE = 'full_report_limit'
export const SIGN_IN_FOR_REPORT = 'Sign in to unlock your full report.'

type ReportEnv = Record<string, string | undefined>

type Reserved =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; response: Response }

function batches(plan: PlannedTheme[]): PlannedTheme[][] {
  if (plan.length <= 3) return [plan]
  const mid = Math.ceil(plan.length / 2)
  return [plan.slice(0, mid), plan.slice(mid)].filter((batch) => batch.length > 0)
}

function maxTokens(batch: PlannedTheme[]): number {
  const questions = batch.reduce((sum, theme) => sum + theme.count, 0)
  return Math.min(4500, 350 + questions * 130)
}

async function domainFromRequest(request: Request): Promise<{
  domain: string | null | 'too-large'
  pins: unknown
}> {
  const url = new URL(request.url)
  const query = url.searchParams.get('domain')
  if (query) return { domain: canonicalHostname(query), pins: [] }
  const raw = await request.text()
  if (raw.length > 10_000) return { domain: 'too-large', pins: [] }
  if (!raw.trim()) return { domain: null, pins: [] }
  try {
    const body = JSON.parse(raw) as { domain?: unknown; pins?: unknown }
    return { domain: canonicalHostname(body.domain), pins: body.pins }
  } catch {
    return { domain: null, pins: [] }
  }
}

async function homepageExcerpt(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(EXCERPT_TIMEOUT_MS),
    })
    if (!res.ok) return null
    let finalHost: string | null = null
    try {
      finalHost = canonicalHostname(new URL(res.url || `https://${domain}/`).hostname)
    } catch {
      finalHost = null
    }
    if (finalHost !== domain && finalHost !== `www.${domain}`) return null
    const html = (await res.text()).slice(0, 200_000)
    const text = pageTextFromHtml(html).slice(0, 2_500).trim()
    return text.length >= 40 ? text : null
  } catch {
    return null
  }
}

async function insertFullReportUsage(sb: ServiceDb, userId: string): Promise<string | null> {
  try {
    const res = await sbFetch(sb, '/rest/v1/usage_events', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=representation'),
      body: JSON.stringify({ user_id: userId, kind: FULL_REPORT_KIND }),
    })
    if (!res.ok) return null
    const created = (await res.json()) as { id?: string } | { id?: string }[]
    const row = Array.isArray(created) ? created[0] : created
    const id = row && typeof row.id === 'string' ? row.id : ''
    return UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

async function listFullReportUsage(sb: ServiceDb, userId: string, limit: number): Promise<{ id: string }[] | null> {
  try {
    const res = await sbFetch(
      sb,
      `/rest/v1/usage_events?user_id=eq.${userId}&kind=eq.${FULL_REPORT_KIND}&select=id&order=created_at.asc,id.asc&limit=${limit}`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as { id?: string }[]
    if (!Array.isArray(rows)) return null
    return rows.filter((row): row is { id: string } => typeof row.id === 'string')
  } catch {
    return null
  }
}

async function deleteUsage(sb: ServiceDb, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false
  try {
    const res = await sbFetch(sb, `/rest/v1/usage_events?id=eq.${id}`, {
      method: 'DELETE',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
    })
    return res.ok
  } catch {
    return false
  }
}

async function meterExtra(opts: {
  sb: ServiceDb
  userId: string
  anonKey: string | null
  plan: string
  config: ProductConfig
}): Promise<Reserved> {
  if (!opts.config.paywallEnabled) {
    return {
      ok: false,
      response: json(403, {
        ok: false,
        code: FULL_REPORT_LIMIT_CODE,
        error: opts.config.copy.fullReportLimitHit,
      }),
    }
  }
  if (opts.anonKey) {
    const linked = await linkAnonUsage(opts.sb, opts.anonKey, opts.userId)
    if (!linked) return { ok: false, response: json(503, { error: 'Could not check the full report limit.' }) }
  }
  const admitted = await admitUsage({
    sb: opts.sb,
    userId: opts.userId,
    anonKey: opts.anonKey,
    plan: opts.plan,
    config: opts.config,
    kind: 'check',
  })
  if (!admitted.ok) return admitted
  return { ok: true, release: admitted.release }
}

/** Reserve a free full report, or fall through to the existing check quota. */
async function reserveReport(opts: {
  sb: ServiceDb
  userId: string
  anonKey: string | null
  plan: string
  config: ProductConfig
}): Promise<Reserved> {
  const free = opts.config.freeFullReports
  if (free <= 0) return meterExtra(opts)

  const id = await insertFullReportUsage(opts.sb, opts.userId)
  if (!id) return { ok: false, response: json(503, { error: 'Could not check the full report limit.' }) }

  const limit = Math.min(Math.max(free, 0) + 1, 2001)
  const rows = await listFullReportUsage(opts.sb, opts.userId, limit)
  const rank = rows ? rankInWindow(rows, id, limit) : null
  if (rank === null) {
    await deleteUsage(opts.sb, id)
    return { ok: false, response: json(503, { error: 'Could not check the full report limit.' }) }
  }
  if (rank <= free) {
    return { ok: true, release: async () => { await deleteUsage(opts.sb, id) } }
  }

  const removed = await deleteUsage(opts.sb, id)
  if (!removed) return { ok: false, response: json(503, { error: 'Could not check the full report limit.' }) }
  return meterExtra(opts)
}

function failureDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out'
  return 'network error'
}

async function completeBatch(
  apiKey: string,
  domain: string,
  excerpt: string | null,
  batch: PlannedTheme[],
  pins: RunPin[],
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: maxTokens(batch),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FULL_REPORT_SYSTEM_PROMPT },
          { role: 'user', content: fullReportPrompt(domain, batch, excerpt, pins) },
        ],
      }),
    })
  } catch (err) {
    return { ok: false, error: `OpenAI request failed: ${failureDetail(err)}` }
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const errBody = (await res.json()) as { error?: { message?: string } }
      const message = errBody?.error?.message
      if (typeof message === 'string' && message.trim()) detail = message
    } catch {
      // Keep the status.
    }
    return { ok: false, error: `OpenAI request failed: ${scrubSecret(detail, apiKey).slice(0, 180)}` }
  }

  try {
    const payload = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    const raw = payload.choices?.[0]?.message?.content
    const content = typeof raw === 'string' ? raw : ''
    const parsed = parseModelJson(scrubSecret(content, apiKey))
    if (!parsed) return { ok: false, error: 'OpenAI request failed: model output was not usable JSON' }
    return { ok: true, json: parsed }
  } catch {
    return { ok: false, error: 'OpenAI request failed: unreadable response' }
  }
}

async function listCheckIds(sb: ServiceDb, userId: string): Promise<CheckRow[]> {
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

async function deleteCheckIds(sb: ServiceDb, userId: string, ids: string[]): Promise<void> {
  const safe = ids.filter((id) => UUID_RE.test(id))
  if (safe.length === 0) return
  await sbFetch(sb, `/rest/v1/checks?user_id=eq.${userId}&id=in.(${safe.join(',')})`, {
    method: 'DELETE',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
  })
}

async function saveReport(
  sb: ServiceDb,
  userId: string,
  domain: string,
  themes: FullReportTheme[],
  includesBranded: boolean,
  config: ProductConfig,
  plan: string,
): Promise<{ id: string; createdAt: string } | null> {
  const result = {
    report: 'full',
    labels: {
      questions: LABEL_GENERATED,
      answered: LABEL_GENERATED,
      whoInstead: LABEL_GENERATED,
      mode: 'Full report',
    },
    model: MODEL,
    questionsGenerated: true,
    fullReport: {
      domain,
      model: MODEL,
      includesBranded,
      themes,
    },
  }
  let res: Response
  try {
    res = await sbFetch(sb, '/rest/v1/checks', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=representation'),
      body: JSON.stringify({
        user_id: userId,
        domain,
        mode: 'unbranded',
        result,
      }),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let created: unknown
  try {
    created = await res.json()
  } catch {
    return null
  }
  const row = Array.isArray(created) ? (created[0] as Record<string, unknown>) : null
  const id = row && typeof row.id === 'string' ? row.id : ''
  if (!UUID_RE.test(id)) return null
  const createdAt = row && typeof row.created_at === 'string' ? row.created_at : new Date().toISOString()
  try {
    const rows = await listCheckIds(sb, userId)
    await deleteCheckIds(sb, userId, idsBeyondCap(rows, historyCapForPlan(config, plan)))
    const cutoff = retentionCutoffIso(config.checkRetentionDays)
    if (cutoff) {
      await sbFetch(sb, `/rest/v1/checks?user_id=eq.${userId}&created_at=lt.${encodeURIComponent(cutoff)}`, {
        method: 'DELETE',
        headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      })
    }
  } catch {
    // The row is saved. Trim is best-effort.
  }
  return { id, createdAt }
}

export async function onRequest(context: { request: Request; env?: ReportEnv }): Promise<Response> {
  const { request } = context
  if (request.method !== 'POST') return json(405, { error: 'Use POST' })

  const incoming = await domainFromRequest(request)
  const domain = incoming.domain
  if (domain === 'too-large') return json(413, { error: 'Request body is too large.' })
  if (!domain) return json(400, { error: 'domain must be a simple public hostname' })

  const sb = sbConfig(context.env)
  if (!sb) return json(503, { error: SERVER_AUTH_NOT_CONFIGURED })

  const accessToken = bearer(request)
  if (!accessToken) return json(401, { error: SIGN_IN_FOR_REPORT })

  const config = productConfigFromEnv(context.env)
  const authed = await userFromToken(sb, accessToken, SIGN_IN_FOR_REPORT)
  if (!authed.ok) return json(authed.status, { error: scrubSecret(authed.error, sb.serviceRole).slice(0, 240) })

  const apiKey = typeof context.env?.OPENAI_API_KEY === 'string' ? context.env.OPENAI_API_KEY.trim() : ''
  if (!apiKey) return json(503, { error: 'OPENAI_API_KEY not configured' })

  await ensureProfile(sb, authed.user.id).catch(() => {})
  const planName = await readPlan(sb, authed.user.id, config)
  const reserved = await reserveReport({
    sb,
    userId: authed.user.id,
    anonKey: anonKeyFromRequest(request),
    plan: planName,
    config,
  })
  if (!reserved.ok) return reserved.response

  const plan = selectThemePlan({
    questionTarget: config.fullReportQuestionTarget,
    themeMin: config.fullReportThemeMin,
    themeMax: config.fullReportThemeMax,
    includesBranded: config.fullReportIncludesBranded,
  })
  const pins = cleanRunPins(incoming.pins, domain, config.pinnedQuestionMax).map((pin) => ({
    ...pin,
    question: scrubSecret(pin.question, apiKey),
  }))
  const excerpt = await homepageExcerpt(domain)
  const safeExcerpt = excerpt ? scrubSecret(excerpt, apiKey) : null
  const parts = await Promise.all(
    batches(plan).map((batch) => completeBatch(apiKey, domain, safeExcerpt, batch, pins)),
  )
  const failed = parts.find((part) => !part.ok)
  if (failed && !failed.ok) {
    await reserved.release()
    return json(502, { error: failed.error })
  }
  const shaped = shapeFullReport(mergeThemePayloads(parts.map((part) => (part.ok ? part.json : null))), {
    domain,
    plan,
    includesBranded: config.fullReportIncludesBranded,
    themeMin: config.fullReportThemeMin,
    questionTarget: config.fullReportQuestionTarget,
  })
  const themes = shaped
    ? applyRunPins(shaped, pins, { domain, includesBranded: config.fullReportIncludesBranded })
    : null
  if (!themes) {
    await reserved.release()
    return json(502, { error: 'Couldn’t build the full report — try again.' })
  }

  const saved = await saveReport(
    sb,
    authed.user.id,
    domain,
    themes,
    config.fullReportIncludesBranded,
    config,
    planName,
  )
  if (!saved) {
    await reserved.release()
    return json(502, { error: 'Could not save this full report.' })
  }

  const body = {
    ok: true,
    report: 'full',
    domain,
    model: MODEL,
    includesBranded: config.fullReportIncludesBranded,
    themes,
    check: {
      id: saved.id,
      domain,
      createdAt: saved.createdAt,
    },
  }
  const text = JSON.stringify(body)
  if (text.includes(apiKey) || text.includes(sb.serviceRole)) {
    return json(500, { error: 'Could not build the full report.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

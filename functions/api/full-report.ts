/**
 * POST /api/full-report { domain }
 * One signed-in full report. OpenAI writes the questions and the answer on each row.
 * Unbranded rows also carry a Gemini reply in `gemini`. A miss is an empty string.
 * When every unbranded reply is blank, the response also has `geminiMiss`
 * (`missing_key`, `http_reject` plus status, `timeout`, `bad_json`, or `empty`).
 * That field is not stored on the check. This route requires sign-in.
 * Branded rows stay OpenAI only. Mention and who-instead stay on the OpenAI answer.
 * The first freeFullReports runs are complimentary. A further run needs a paid
 * plan, then uses that plan's check quota. Free check quota cannot buy another
 * full report. No second report SKU.
 * OPENAI_API_KEY, GEMINI_API_KEY, and SUPABASE_SERVICE_ROLE_KEY stay on the server.
 */

import { historyCapForPlan, productConfigFromEnv, type ProductConfig } from '../../src/config/productConfig.ts'
import {
  FULL_REPORT_SYSTEM_PROMPT,
  applyRunPins,
  attachUnbrandedGemini,
  cleanRunPins,
  fullReportPrompt,
  mergeThemePayloads,
  parseModelJson,
  selectThemePlan,
  shapeFullReport,
  unbrandedQuestionTexts,
  type FullReportTheme,
  type PlannedTheme,
  type RunPin,
} from '../../src/fullReport.ts'
import { geminiMissForResponse, geminiModelFromEnv, geminiReplies, type GeminiMiss } from './visibility.ts'
import { mentionsBrand } from '../../src/mentionFacts.ts'
import {
  cleanOwnedQuestions,
  countOwnedQuestions,
  groupOwned,
  mergeOwnedAnswers,
  ownedAnswerPrompt,
  OWNED_QUESTION_MAX,
  type OwnedQuestion,
} from '../../src/ownedQuestions.ts'
import { appendRunHistory, mentionsFromReport, mentionsFromStored, type CheckRun } from '../../src/runHistory.ts'
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

/** Gemini text for unbranded rows. A missing key or a failed call is empty strings and one miss class. */
async function withUnbrandedGemini(
  themes: FullReportTheme[],
  env: ReportEnv | undefined,
  scrub: string[],
): Promise<{ themes: FullReportTheme[]; geminiMiss?: GeminiMiss }> {
  const secret = typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : ''
  const result = await geminiReplies({
    apiKey: secret,
    model: geminiModelFromEnv(env),
    questions: unbrandedQuestionTexts(themes),
    scrub: secret ? [...scrub, secret] : scrub,
  })
  return {
    themes: attachUnbrandedGemini(themes, result.replies),
    ...(result.miss ? { geminiMiss: result.miss } : {}),
  }
}

function withGeminiMiss(body: Record<string, unknown>, miss?: GeminiMiss): Record<string, unknown> {
  if (!miss) return body
  return { ...body, geminiMiss: geminiMissForResponse(miss) }
}

function batches(plan: PlannedTheme[]): PlannedTheme[][] {
  if (plan.length <= 3) return [plan]
  const mid = Math.ceil(plan.length / 2)
  return [plan.slice(0, mid), plan.slice(mid)].filter((batch) => batch.length > 0)
}

function maxTokens(batch: PlannedTheme[]): number {
  const questions = batch.reduce((sum, theme) => sum + theme.count, 0)
  return Math.min(4500, 350 + questions * 130)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function domainFromRequest(request: Request): Promise<{
  domain: string | null | 'too-large'
  pins: unknown
  owned: unknown
  checkId: string | null
}> {
  const url = new URL(request.url)
  const query = url.searchParams.get('domain')
  if (query) return { domain: canonicalHostname(query), pins: [], owned: undefined, checkId: null }
  const raw = await request.text()
  if (raw.length > 80_000) return { domain: 'too-large', pins: [], owned: undefined, checkId: null }
  if (!raw.trim()) return { domain: null, pins: [], owned: undefined, checkId: null }
  try {
    const body = JSON.parse(raw) as { domain?: unknown; pins?: unknown; owned?: unknown; checkId?: unknown }
    const checkId = typeof body.checkId === 'string' && UUID_RE.test(body.checkId) ? body.checkId : null
    return { domain: canonicalHostname(body.domain), pins: body.pins, owned: body.owned, checkId }
  } catch {
    return { domain: null, pins: [], owned: undefined, checkId: null }
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

function complimentaryLimit(config: ProductConfig, upgrade: boolean): Response {
  return json(upgrade ? 402 : 403, {
    ok: false,
    code: FULL_REPORT_LIMIT_CODE,
    error: config.copy.fullReportLimitHit,
    ...(upgrade ? { upgrade: true, plan: 'free' } : {}),
  })
}

async function meterExtra(opts: {
  sb: ServiceDb
  userId: string
  anonKey: string | null
  plan: string
  config: ProductConfig
}): Promise<Reserved> {
  // Free accounts stop here. Leftover freeQuotaAmount must not buy another full report.
  if (!opts.config.paywallEnabled || opts.plan !== 'paid') {
    return { ok: false, response: complimentaryLimit(opts.config, opts.config.paywallEnabled) }
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

/** Reserve a complimentary full report. Further free runs open the pay gate. */
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
  questionSetOwned = false,
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
    ...(questionSetOwned ? { questionSetOwned: true } : {}),
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

function ownedBatches(owned: OwnedQuestion[], size = 20): OwnedQuestion[][] {
  const batches: OwnedQuestion[][] = []
  for (let i = 0; i < owned.length; i += size) batches.push(owned.slice(i, i + size))
  return batches.filter((batch) => batch.length > 0)
}

async function completeOwnedBatch(
  apiKey: string,
  domain: string,
  excerpt: string | null,
  owned: OwnedQuestion[],
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const prompt = ownedAnswerPrompt(domain, groupOwned(owned), excerpt)
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
        max_tokens: Math.min(4500, 350 + owned.length * 130),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FULL_REPORT_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
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

/** Answer a saved question set. Does not generate a new theme roster. */
async function updateOwnedReport(
  sb: ServiceDb,
  userId: string,
  checkId: string,
  domain: string,
  themes: FullReportTheme[],
  includesBranded: boolean,
  config: ProductConfig,
): Promise<{ id: string; createdAt: string; runs: CheckRun[] } | { error: string; status: number } | null> {
  let loaded: Response
  try {
    loaded = await sbFetch(
      sb,
      `/rest/v1/checks?id=eq.${checkId}&user_id=eq.${userId}&select=id,domain,mode,result,created_at`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
  } catch {
    return null
  }
  if (!loaded.ok) return null
  let rows: unknown
  try {
    rows = await loaded.json()
  } catch {
    return null
  }
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!row || !isRecord(row.result)) return { error: 'That check is not in your history.', status: 404 }
  if (row.result.report !== 'full') return { error: 'That check is not an owned report.', status: 400 }
  const now = new Date().toISOString()
  const runs = appendRunHistory({
    runs: row.result.runs,
    prior: mentionsFromStored(row.result, domain, 'full'),
    next: mentionsFromReport({ domain, themes }, domain),
    at: now,
    priorAt: typeof row.created_at === 'string' ? row.created_at : now,
    limit: config.trackingHistoryLimit,
    mode: 'full',
    priorMode: 'full',
  })
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
    questionSetOwned: true,
    tracking: { cadence: config.trackingCadence },
    runs,
    fullReport: {
      domain,
      model: MODEL,
      includesBranded,
      themes,
    },
  }
  let updated: Response
  try {
    updated = await sbFetch(sb, `/rest/v1/checks?id=eq.${checkId}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      body: JSON.stringify({ result }),
    })
  } catch {
    return null
  }
  if (!updated.ok) return null
  return {
    id: checkId,
    createdAt: typeof row.created_at === 'string' ? row.created_at : now,
    runs,
  }
}

async function answerOwnedReport(opts: {
  sb: ServiceDb
  userId: string
  domain: string
  owned: OwnedQuestion[]
  apiKey: string
  config: ProductConfig
  request: Request
  checkId: string | null
  env?: ReportEnv
}): Promise<Response> {
  await ensureProfile(opts.sb, opts.userId).catch(() => {})
  const planName = await readPlan(opts.sb, opts.userId, opts.config)
  const anon = anonKeyFromRequest(opts.request)
  if (opts.config.paywallEnabled && anon) {
    const linked = await linkAnonUsage(opts.sb, anon, opts.userId)
    if (!linked) return json(503, { error: 'Could not check the check limit.' })
  }
  const admitted = await admitUsage({
    sb: opts.sb,
    userId: opts.userId,
    anonKey: anon,
    plan: planName,
    config: opts.config,
    kind: 'check',
  })
  if (!admitted.ok) return admitted.response

  const excerpt = await homepageExcerpt(opts.domain)
  const safeExcerpt = excerpt ? scrubSecret(excerpt, opts.apiKey) : null
  const parts = await Promise.all(
    ownedBatches(opts.owned).map((batch) => completeOwnedBatch(opts.apiKey, opts.domain, safeExcerpt, batch)),
  )
  const failed = parts.find((part) => !part.ok)
  if (failed && !failed.ok) {
    await admitted.release()
    return json(502, { error: failed.error })
  }
  const includesBranded =
    opts.config.fullReportIncludesBranded || opts.owned.some((item) => mentionsBrand(item.question, opts.domain))
  const merged = mergeOwnedAnswers(
    opts.owned,
    mergeThemePayloads(parts.map((part) => (part.ok ? part.json : null))),
    { domain: opts.domain, includesBranded },
  )
  if (!merged) {
    await admitted.release()
    return json(502, { error: 'Couldn’t answer this question set — try again.' })
  }
  const gemini = await withUnbrandedGemini(merged, opts.env, [opts.apiKey, opts.sb.serviceRole])
  const themes = gemini.themes
  const saved = opts.checkId
    ? await updateOwnedReport(
        opts.sb,
        opts.userId,
        opts.checkId,
        opts.domain,
        themes,
        includesBranded,
        opts.config,
      )
    : await saveReport(
        opts.sb,
        opts.userId,
        opts.domain,
        themes,
        includesBranded,
        opts.config,
        planName,
        true,
      )
  if (!saved) {
    await admitted.release()
    return json(502, { error: 'Could not save this full report.' })
  }
  if ('error' in saved) {
    await admitted.release()
    return json(saved.status, { error: saved.error })
  }
  const body = withGeminiMiss(
    {
      ok: true,
      report: 'full',
      domain: opts.domain,
      model: MODEL,
      includesBranded,
      themes,
      check: { id: saved.id, domain: opts.domain, createdAt: saved.createdAt },
      ...('runs' in saved ? { runs: saved.runs } : {}),
    },
    gemini.geminiMiss,
  )
  const text = JSON.stringify(body)
  const geminiKey = typeof opts.env?.GEMINI_API_KEY === 'string' ? opts.env.GEMINI_API_KEY.trim() : ''
  if (
    text.includes(opts.apiKey) ||
    text.includes(opts.sb.serviceRole) ||
    (geminiKey !== '' && text.includes(geminiKey))
  ) {
    return json(500, { error: 'Could not build the full report.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
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

  if (incoming.owned !== undefined) {
    if (countOwnedQuestions(incoming.owned) > OWNED_QUESTION_MAX) {
      return json(400, { error: `This check can hold ${OWNED_QUESTION_MAX} questions.` })
    }
    const owned = cleanOwnedQuestions(incoming.owned, domain, OWNED_QUESTION_MAX).map((item) => ({
      ...item,
      question: scrubSecret(item.question, apiKey),
    }))
    if (owned.length < 1) return json(400, { error: 'Keep at least one question.' })
    return answerOwnedReport({
      sb,
      userId: authed.user.id,
      domain,
      owned,
      apiKey,
      config,
      request,
      checkId: incoming.checkId,
      env: context.env,
    })
  }

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
  const shapedThemes = shaped
    ? applyRunPins(shaped, pins, { domain, includesBranded: config.fullReportIncludesBranded })
    : null
  if (!shapedThemes) {
    await reserved.release()
    return json(502, { error: 'Couldn’t build the full report — try again.' })
  }
  const gemini = await withUnbrandedGemini(shapedThemes, context.env, [apiKey, sb.serviceRole])
  const themes = gemini.themes

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

  const body = withGeminiMiss(
    {
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
    },
    gemini.geminiMiss,
  )
  const text = JSON.stringify(body)
  const geminiKey = typeof context.env?.GEMINI_API_KEY === 'string' ? context.env.GEMINI_API_KEY.trim() : ''
  if (text.includes(apiKey) || text.includes(sb.serviceRole) || (geminiKey !== '' && text.includes(geminiKey))) {
    return json(500, { error: 'Could not build the full report.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

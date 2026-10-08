/**
 * POST /api/test-question { domain, question, engine, themeId? }
 * Signed-in smoke of one question on one engine (openai, gemini, or claude).
 * Patches nothing on the server. The client updates that answer block only.
 * Does not write a usage event, a check, or run history, and does not meter a full report.
 * FULL_REPORT_OPENAI=off: an OpenAI test does not call the model and returns openaiPaused.
 * Gemini and Claude still run. Keys stay server-side.
 */

import { FULL_REPORT_SYSTEM_PROMPT, parseModelJson, resolveThemeId, type ThemeId } from '../../src/fullReport.ts'
import { groupOwned, mergeOwnedAnswers, ownedAnswerPrompt } from '../../src/ownedQuestions.ts'
import { canonicalHostname } from './homepage.ts'
import { json, scrubSecret } from './http.ts'
import { fullReportOpenAIPaused } from './full-report.ts'
import {
  geminiApiKeyFromEnv,
  geminiModelFromEnv,
  geminiReplies,
  geminiTimeoutFromEnv,
} from './visibility.ts'
import {
  CLAUDE_TIMEOUT_CAP_MS,
  claudeApiKeyFromEnv,
  claudeMissForResponse,
  claudeModelFromEnv,
  claudeReplies,
} from './claude.ts'
import {
  bearer,
  sbConfig,
  SERVER_AUTH_NOT_CONFIGURED,
  userFromToken,
} from './supabaseAuth.ts'

const MODEL = 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 20_000

export const TEST_QUESTION_SIGN_IN = 'Sign in to run a test question.'

type TestEngine = 'openai' | 'gemini' | 'claude'
type TestEnv = Record<string, string | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function failureDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out'
  return 'network error'
}

function respond(body: Record<string, unknown>, secrets: string[]): Response {
  const text = JSON.stringify(body)
  if (secrets.some((secret) => secret !== '' && text.includes(secret))) {
    return json(500, { error: 'Could not run this test question.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readBody(request: Request): Promise<
  | { ok: true; domain: string; question: string; engine: TestEngine; themeId: ThemeId }
  | { ok: false; status: number; error: string }
> {
  const raw = await request.text()
  if (raw.length > 8_000) return { ok: false, status: 413, error: 'Request body is too large.' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, error: 'Expected a JSON body.' }
  }
  if (!isRecord(data)) return { ok: false, status: 400, error: 'Expected a JSON body.' }
  const domain = canonicalHostname(data.domain)
  if (!domain) return { ok: false, status: 400, error: 'domain must be a simple public hostname' }
  const question = typeof data.question === 'string' ? data.question.replace(/\s+/g, ' ').trim() : ''
  if (!question || question.length > 240) return { ok: false, status: 400, error: 'Send one question.' }
  const engine = typeof data.engine === 'string' ? data.engine.trim().toLowerCase() : ''
  if (engine !== 'openai' && engine !== 'gemini' && engine !== 'claude') {
    return { ok: false, status: 400, error: 'engine must be openai, gemini, or claude' }
  }
  return { ok: true, domain, question, engine, themeId: resolveThemeId(data.themeId) ?? 'problems' }
}

/** One OpenAI answer. Mention and who-instead from the model are discarded. */
async function openAIAnswer(
  apiKey: string,
  domain: string,
  question: string,
  themeId: ThemeId,
): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const safeQuestion = scrubSecret(question, apiKey)
  const owned = [{ question: safeQuestion, themeId }]
  const prompt = ownedAnswerPrompt(domain, groupOwned(owned), null)
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
        max_tokens: 480,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FULL_REPORT_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    })
  } catch (err) {
    return { ok: false, error: `ChatGPT request failed: ${failureDetail(err)}` }
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
    return { ok: false, error: `ChatGPT request failed: ${scrubSecret(detail, apiKey).slice(0, 180)}` }
  }
  try {
    const payload = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    const raw = payload.choices?.[0]?.message?.content
    const content = typeof raw === 'string' ? raw : ''
    const parsed = parseModelJson(scrubSecret(content, apiKey))
    if (!parsed) return { ok: false, error: 'ChatGPT request failed: model output was not usable JSON' }
    const merged = mergeOwnedAnswers(owned, parsed, { domain, includesBranded: true })
    const answer =
      merged?.flatMap((theme) => theme.questions).find((item) => item.question.toLowerCase() === safeQuestion.toLowerCase())
        ?.answer ?? ''
    return { ok: true, answer: scrubSecret(answer, apiKey) }
  } catch {
    return { ok: false, error: 'ChatGPT request failed: unreadable response' }
  }
}

export async function onRequest(context: { request: Request; env?: TestEnv }): Promise<Response> {
  const { request } = context
  if (request.method !== 'POST') return json(405, { error: 'Use POST' })

  const sb = sbConfig(context.env)
  if (!sb) return json(503, { error: SERVER_AUTH_NOT_CONFIGURED })
  const accessToken = bearer(request)
  if (!accessToken) return json(401, { error: TEST_QUESTION_SIGN_IN })
  const authed = await userFromToken(sb, accessToken, TEST_QUESTION_SIGN_IN)
  if (!authed.ok) return json(authed.status, { error: scrubSecret(authed.error, sb.serviceRole).slice(0, 240) })

  const incoming = await readBody(request)
  if (!incoming.ok) return json(incoming.status, { error: incoming.error })

  const apiKey = typeof context.env?.OPENAI_API_KEY === 'string' ? context.env.OPENAI_API_KEY.trim() : ''
  const geminiKey = geminiApiKeyFromEnv(context.env)
  const claudeKey = claudeApiKeyFromEnv(context.env)
  const secrets = [apiKey, geminiKey, claudeKey, sb.serviceRole].filter((secret) => secret !== '')

  if (incoming.engine === 'openai' && fullReportOpenAIPaused(context.env)) {
    return respond({ ok: true, engine: 'openai', openaiPaused: true }, secrets)
  }
  if (incoming.engine === 'openai') {
    if (!apiKey) return json(503, { error: 'OPENAI_API_KEY not configured' })
    const answered = await openAIAnswer(apiKey, incoming.domain, incoming.question, incoming.themeId)
    if (!answered.ok) return json(502, { error: answered.error })
    return respond({ ok: true, engine: 'openai', answer: answered.answer }, secrets)
  }

  if (incoming.engine === 'claude') {
    const result = await claudeReplies({
      apiKey: claudeKey,
      model: claudeModelFromEnv(context.env),
      questions: [incoming.question],
      scrub: secrets,
      timeoutMs: CLAUDE_TIMEOUT_CAP_MS,
    })
    const claude = secrets.reduce((text, secret) => scrubSecret(text, secret), result.replies[0] ?? '')
    const body: Record<string, unknown> = { ok: true, engine: 'claude', claude }
    if (!claude.trim()) body.claudeMiss = claudeMissForResponse(result.miss ?? { class: 'empty' })
    return respond(body, secrets)
  }

  const result = await geminiReplies({
    apiKey: geminiKey,
    model: geminiModelFromEnv(context.env),
    questions: [incoming.question],
    scrub: secrets,
    timeoutMs: geminiTimeoutFromEnv(context.env),
  })
  const gemini = secrets.reduce((text, secret) => scrubSecret(text, secret), result.replies[0] ?? '')
  return respond({ ok: true, engine: 'gemini', gemini }, secrets)
}

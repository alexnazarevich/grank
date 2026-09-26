/**
 * Cloudflare Pages Function: GET or POST /api/visibility?domain=linear.app&mode=unbranded
 * Live questions and answered-by-you via OpenAI gpt-4o-mini.
 * mode=unbranded (default): category / JTBD questions, plus who-instead.
 * mode=branded: questions that name the brand, each with a short model answer.
 * No who-instead on branded. No blended score. Missing answers stay empty.
 * OPENAI_API_KEY is read from the Pages env only. Never returned.
 */

import { productConfigFromEnv } from '../../src/config/productConfig.ts'
import { canonicalHostname, pageTextFromHtml } from './homepage.ts'
import { gateModelCall } from './quota.ts'

const MODEL = 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 20_000
const EXCERPT_TIMEOUT_MS = 4_000
const USER_AGENT = 'GrankBot/0.1 (+https://grank.pages.dev)'

const SHARED_RULES = `Use public brand knowledge only. Be conservative: obscure or thin brands are "no" or "partial", not "yes".
Do not invent citations, rankings, traffic, or claims that you queried other engines.
Do not return a visibility percentage or a score that blends question types.`

/** Category / JTBD questions. The brand is known, but it must not appear in the question text. */
const UNBRANDED_SYSTEM_PROMPT = `You estimate whether a brand is likely cited when people ask an AI assistant category or job-to-be-done questions. Those questions must not name the brand.
${SHARED_RULES}
Return JSON only:
{
  "questions": ["3 to 5 natural category or job-to-be-done questions a buyer might ask without naming this brand"],
  "answered": "yes" | "partial" | "no",
  "why": "one honest sentence",
  "whoInstead": ["1 to 3 real alternate brand or product names"]
}
Questions are unbranded: category or job-to-be-done only. Do not put the brand name, product name, or domain in the question text.
"answered" means whether THIS brand is likely cited when those unbranded questions are asked of an AI assistant.
"why" must be one honest sentence and must not overclaim.
"whoInstead" is required. Name 1 to 3 real alternate brands or products that an AI assistant might cite instead of this brand when answering those unbranded questions. Specific product or company names only — not this brand, not categories, not listicles, not placeholders. If you cannot name a real alternative, return an empty array. Never invent competitors.`

/** Questions that name the brand, plus a short reply under each. No competitor list. */
const BRANDED_SYSTEM_PROMPT = `You estimate how an AI assistant describes a brand when people ask questions that name it.
${SHARED_RULES}
Return JSON only:
{
  "questions": ["3 to 5 natural questions that name this brand"],
  "answers": ["one brief assistant reply for each question, same order and same length as questions"],
  "answered": "yes" | "partial" | "no",
  "why": "one honest sentence"
}
Questions are branded: every question must include the brand name. Ask about tone, claims, and how the brand is described. Do not ask generic category questions that omit the name.
"answers" must align 1:1 with "questions". Each answer is a plausible assistant reply about this brand in 2 to 4 sentences, conservative and based on public knowledge. If you are unsure, say so plainly in that answer. Do not invent praise, quotes, citations, or URLs. Do not write "ChatGPT said", "Perplexity said", or "Gemini said", and do not claim you scraped a live engine. If you cannot answer a question, use an empty string for that item.
"answered" means whether an AI assistant is likely to describe THIS brand when those branded questions are asked.
"why" must be one honest sentence and must not overclaim.
Do not name competitors or alternate brands. Do not return a competitor list.`

export type VisibilityMode = 'unbranded' | 'branded'

/** Missing or blank → unbranded. Anything else that is not branded|unbranded is invalid. */
export function parseVisibilityMode(value: unknown): VisibilityMode | 'invalid' | 'absent' {
  if (value == null) return 'absent'
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return 'absent'
  if (trimmed === 'unbranded' || trimmed === 'branded') return trimmed
  return 'invalid'
}

export type VisibilityEnv = Record<string, string | undefined>

type Answered = 'yes' | 'partial' | 'no'

export type ParsedVisibility = {
  questions: string[]
  /** Aligned to questions. Empty string means that question had no usable answer. */
  answers: string[]
  answered: Answered
  why: string
  whoInstead: string[]
}

const ANSWER_MAX = 900

/** Trim a model reply. Non-strings and blanks become "" — never a filled-in compliment. */
export function normalizeAnswer(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX)
}

/**
 * Questions may be strings (with a parallel answers array) or `{ question, answer }` objects.
 * Dropped questions drop their answer so the lists stay aligned. Cap at 5.
 */
export function readQuestionAnswers(
  questionsField: unknown,
  answersField: unknown,
): { questions: string[]; answers: string[] } {
  if (!Array.isArray(questionsField)) return { questions: [], answers: [] }
  const parallel = Array.isArray(answersField) ? answersField : []
  const questions: string[] = []
  const answers: string[] = []
  for (let i = 0; i < questionsField.length && questions.length < 5; i++) {
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

const WHO_INSTEAD_MAX = 3
const WHO_INSTEAD_NAME_MAX = 80

/** Trim, drop blanks and non-names, skip this brand, cap at 3. Missing → []. */
export function parseWhoInstead(value: unknown, domain?: string): string[] {
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

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Strip secrets from anything we might send back to the browser. */
export function scrubSecret(value: string, secret: string): string {
  let out = value
  if (secret) out = out.split(secret).join('[redacted]')
  out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
  return out.replace(/\s+/g, ' ').trim()
}

export function parseVisibilityContent(raw: string, domain?: string): ParsedVisibility | null {
  let text = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  const { questions, answers } = readQuestionAnswers(rec.questions, rec.answers)
  if (questions.length < 3) return null
  const answered = rec.answered
  if (answered !== 'yes' && answered !== 'partial' && answered !== 'no') return null
  if (typeof rec.why !== 'string') return null
  const why = rec.why.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!why) return null
  return {
    questions,
    answers,
    answered,
    why,
    whoInstead: parseWhoInstead(rec.whoInstead, domain),
  }
}

async function fieldsFromRequest(request: Request): Promise<{
  domain: string | null
  mode: VisibilityMode | 'invalid'
}> {
  const url = new URL(request.url)
  const queryDomain = url.searchParams.get('domain')
  const queryMode = url.searchParams.has('mode')
    ? parseVisibilityMode(url.searchParams.get('mode'))
    : 'absent'

  let bodyDomain: unknown
  let bodyMode: VisibilityMode | 'invalid' | 'absent' = 'absent'
  const domainMissing = queryDomain === null || queryDomain === ''
  const modeMissing = queryMode === 'absent'
  if (request.method === 'POST' && (domainMissing || modeMissing)) {
    const type = request.headers.get('content-type') || ''
    if (type.includes('application/json')) {
      try {
        const body = (await request.json()) as { domain?: unknown; mode?: unknown }
        bodyDomain = body?.domain
        bodyMode = parseVisibilityMode(body?.mode)
      } catch {
        if (domainMissing) return { domain: null, mode: 'unbranded' }
      }
    }
  }

  const modeSource = queryMode === 'absent' ? bodyMode : queryMode
  return {
    domain: canonicalHostname(domainMissing ? bodyDomain : queryDomain),
    mode: modeSource === 'absent' ? 'unbranded' : modeSource,
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

function failureDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out'
  return 'network error'
}

function systemPromptFor(mode: VisibilityMode): string {
  return mode === 'branded' ? BRANDED_SYSTEM_PROMPT : UNBRANDED_SYSTEM_PROMPT
}

async function completeVisibility(
  apiKey: string,
  domain: string,
  excerpt: string | null,
  mode: VisibilityMode,
): Promise<Response> {
  const lines = [`Mode: ${mode}`, `Brand domain: ${domain}`]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  const user = lines.join('\n')

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
        temperature: 0.2,
        max_tokens: mode === 'branded' ? 1400 : 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPromptFor(mode) },
          { role: 'user', content: user },
        ],
      }),
    })
  } catch (err) {
    return json(502, { error: `OpenAI request failed: ${failureDetail(err)}` })
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const errBody = (await res.json()) as { error?: { message?: string } }
      const message = errBody?.error?.message
      if (typeof message === 'string' && message.trim()) detail = message
    } catch {
      // Keep the status. Do not forward a raw body.
    }
    const safe = scrubSecret(detail, apiKey).slice(0, 180)
    return json(502, { error: `OpenAI request failed: ${safe || 'HTTP ' + res.status}` })
  }

  let content = ''
  try {
    const payload = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[]
    }
    const raw = payload.choices?.[0]?.message?.content
    content = typeof raw === 'string' ? raw : ''
  } catch {
    return json(502, { error: 'OpenAI request failed: unreadable response' })
  }

  const parsed = parseVisibilityContent(scrubSecret(content, apiKey), domain)
  if (!parsed) {
    return json(502, { error: 'OpenAI request failed: model output was not usable JSON' })
  }

  const body: Record<string, unknown> = {
    ok: true,
    domain,
    model: MODEL,
    mode,
    questions: parsed.questions,
    answered: parsed.answered,
    why: parsed.why,
  }
  // Who-instead stays on the unbranded beat. Answers stay on the branded beat.
  if (mode === 'unbranded') body.whoInstead = parsed.whoInstead
  if (mode === 'branded') body.answers = parsed.answers
  return json(200, body)
}

export async function onRequest(context: {
  request: Request
  env?: VisibilityEnv
}): Promise<Response> {
  const { request } = context
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Use GET or POST' })
  }

  const { domain, mode } = await fieldsFromRequest(request)
  if (!domain) return json(400, { error: 'domain must be a simple public hostname' })
  if (mode === 'invalid') return json(400, { error: 'mode must be unbranded or branded' })

  const secret = context.env?.OPENAI_API_KEY
  const apiKey = typeof secret === 'string' ? secret.trim() : ''
  if (!apiKey) return json(503, { error: 'OPENAI_API_KEY not configured' })

  const gate = await gateModelCall({
    request,
    env: context.env,
    config: productConfigFromEnv(context.env),
  })
  if (!gate.ok) return gate.response

  const excerpt = await homepageExcerpt(domain)
  const safeExcerpt = excerpt ? scrubSecret(excerpt, apiKey) : null
  const result = await completeVisibility(apiKey, domain, safeExcerpt, mode)
  if (result.status !== 200) {
    try {
      await gate.release()
    } catch {
      // Keep the model error. A failed release may count a check that did not finish.
    }
  }
  return result
}

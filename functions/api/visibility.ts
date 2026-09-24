/**
 * Cloudflare Pages Function: GET or POST /api/visibility?domain=linear.app
 * Live questions + answered-by-you via OpenAI gpt-4o-mini.
 * OPENAI_API_KEY is read from the Pages env only. Never returned.
 */

import { canonicalHostname, pageTextFromHtml } from './homepage.ts'

const MODEL = 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 20_000
const EXCERPT_TIMEOUT_MS = 4_000
const USER_AGENT = 'GrankBot/0.1 (+https://grank.pages.dev)'

const SYSTEM_PROMPT = `You estimate whether a brand is likely cited when people ask an AI assistant about it.
Use public brand knowledge only. Be conservative: obscure or thin brands are "no" or "partial", not "yes".
Do not invent citations, rankings, traffic, or claims that you queried other engines.
Return JSON only:
{
  "questions": ["3 to 5 natural questions a buyer might ask an AI assistant about this brand or its category"],
  "answered": "yes" | "partial" | "no",
  "why": "one honest sentence",
  "whoInstead": ["optional other names that might be cited instead"]
}
"answered" means whether THIS brand is likely cited when those questions are asked of an AI assistant.
"why" must be one honest sentence and must not overclaim.`

export type VisibilityEnv = {
  OPENAI_API_KEY?: string
}

type Answered = 'yes' | 'partial' | 'no'

export type ParsedVisibility = {
  questions: string[]
  answered: Answered
  why: string
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

export function parseVisibilityContent(raw: string): ParsedVisibility | null {
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
  const questions = Array.isArray(rec.questions)
    ? rec.questions
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.replace(/\s+/g, ' ').trim())
        .filter((q) => q.length > 0 && q.length <= 240)
        .slice(0, 5)
    : []
  if (questions.length < 3) return null
  const answered = rec.answered
  if (answered !== 'yes' && answered !== 'partial' && answered !== 'no') return null
  if (typeof rec.why !== 'string') return null
  const why = rec.why.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!why) return null
  return { questions, answered, why }
}

async function domainFromRequest(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get('domain')
  if (fromQuery !== null && fromQuery !== '') return canonicalHostname(fromQuery)
  if (request.method !== 'POST') return null
  const type = request.headers.get('content-type') || ''
  if (!type.includes('application/json')) return null
  try {
    const body = (await request.json()) as { domain?: unknown }
    return canonicalHostname(body?.domain)
  } catch {
    return null
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

async function completeVisibility(
  apiKey: string,
  domain: string,
  excerpt: string | null,
): Promise<Response> {
  const user = excerpt
    ? `Brand domain: ${domain}\nHomepage excerpt (may be incomplete):\n${excerpt}`
    : `Brand domain: ${domain}`

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
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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

  const parsed = parseVisibilityContent(scrubSecret(content, apiKey))
  if (!parsed) {
    return json(502, { error: 'OpenAI request failed: model output was not usable JSON' })
  }

  return json(200, {
    ok: true,
    domain,
    model: MODEL,
    questions: parsed.questions,
    answered: parsed.answered,
    why: parsed.why,
  })
}

export async function onRequest(context: {
  request: Request
  env?: VisibilityEnv
}): Promise<Response> {
  const { request } = context
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Use GET or POST' })
  }

  const domain = await domainFromRequest(request)
  if (!domain) return json(400, { error: 'domain must be a simple public hostname' })

  const secret = context.env?.OPENAI_API_KEY
  const apiKey = typeof secret === 'string' ? secret.trim() : ''
  if (!apiKey) return json(503, { error: 'OPENAI_API_KEY not configured' })

  const excerpt = await homepageExcerpt(domain)
  const safeExcerpt = excerpt ? scrubSecret(excerpt, apiKey) : null
  return completeVisibility(apiKey, domain, safeExcerpt)
}

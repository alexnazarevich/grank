/**
 * Cloudflare Pages Function: GET or POST /api/visibility?domain=linear.app&mode=unbranded
 * Live questions and answered-by-you via OpenAI gpt-4o-mini.
 * mode=unbranded (default): category / JTBD questions, plus who-instead.
 * The same unbranded questions also get a Gemini reply, stored beside the OpenAI result.
 * A Gemini miss is empty strings. This route is also used by guests, so the miss class
 * is logged (`gemini miss …`) and is not included on the response.
 * mode=branded: questions that name the brand, each with a short OpenAI answer. No Gemini.
 * No who-instead on branded. Missing answers stay empty.
 * OPENAI_API_KEY and GEMINI_API_KEY are read from the Pages env only. Never returned.
 */

import { productConfigFromEnv } from '../../src/config/productConfig.ts'
import {
  DIG_MENTION_RULES,
  LAND_MENTION_RULES,
  SHARPER_Q_RULES,
  factsFromVisibility,
  parseWhoInstead,
} from '../../src/mentionFacts.ts'
import { canonicalHostname, pageTextFromHtml } from './homepage.ts'
import { gateModelCall } from './quota.ts'

export { parseWhoInstead }

const MODEL = 'gpt-4o-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
/** Default flash model. Override with GEMINI_MODEL. Not a Vertex host. */
export const GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash-lite'
const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com'
const TIMEOUT_MS = 20_000
const EXCERPT_TIMEOUT_MS = 4_000
const USER_AGENT = 'GrankBot/0.1 (+https://grank.pages.dev)'

const SHARED_RULES = `Use public brand knowledge only. Be conservative: obscure or thin brands are "no" or "partial", not "yes".
Do not invent citations, rankings, traffic, or claims that you queried other engines.
Do not return a visibility percentage or a score that blends question types.`

/** Category / JTBD questions. The brand is known, but it must not appear in the question text. */
export const UNBRANDED_SYSTEM_PROMPT = `You estimate whether a brand is likely cited when people ask an AI assistant category or job-to-be-done questions. Those questions must not name the brand.
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
"whoInstead" is required. Name 1 to 3 real alternate brands or products that an AI assistant might cite instead of this brand when answering those unbranded questions. Specific product or company names only — not this brand, not categories, not listicles, not placeholders. If you cannot name a real alternative, return an empty array. Never invent competitors.
${SHARPER_Q_RULES}
${LAND_MENTION_RULES}`

/** Questions that name the brand, plus a short reply under each. No competitor list. */
export const BRANDED_SYSTEM_PROMPT = `You estimate how an AI assistant describes a brand when people ask questions that name it.
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
Do not name competitors or alternate brands. Do not return a competitor list.
${SHARPER_Q_RULES}
${DIG_MENTION_RULES}`

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
  /** Parallel to questions when the model sent them. Missing slots stay unset. */
  mentions: unknown[]
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
  max = 5,
): { questions: string[]; answers: string[] } {
  if (!Array.isArray(questionsField)) return { questions: [], answers: [] }
  const cap = Math.min(8, Math.max(1, Math.floor(max)))
  const parallel = Array.isArray(answersField) ? answersField : []
  const questions: string[] = []
  const answers: string[] = []
  for (let i = 0; i < questionsField.length && questions.length < cap; i++) {
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

export function parseVisibilityContent(raw: string, domain?: string, minQuestions = 3): ParsedVisibility | null {
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
  const cap = minQuestions < 3 ? 8 : 5
  const { questions, answers } = readQuestionAnswers(rec.questions, rec.answers, cap)
  if (questions.length < minQuestions) return null
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
    mentions: Array.isArray(rec.mentions) ? rec.mentions : [],
  }
}

function cleanOwnedStrings(value: unknown): { questions: string[]; overflow: boolean } | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const questions: string[] = []
  let overflow = false
  for (const item of value) {
    if (typeof item !== 'string') continue
    const question = item.replace(/\s+/g, ' ').trim()
    if (!question || question.length > 240) continue
    const key = question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (questions.length >= 8) {
      overflow = true
      break
    }
    questions.push(question)
  }
  return { questions, overflow }
}

async function fieldsFromRequest(request: Request): Promise<{
  domain: string | null
  mode: VisibilityMode | 'invalid'
  questions: string[] | null
  questionsOverflow: boolean
}> {
  const url = new URL(request.url)
  const queryDomain = url.searchParams.get('domain')
  const queryMode = url.searchParams.has('mode')
    ? parseVisibilityMode(url.searchParams.get('mode'))
    : 'absent'

  let bodyDomain: unknown
  let bodyMode: VisibilityMode | 'invalid' | 'absent' = 'absent'
  let bodyQuestions: string[] | null = null
  let questionsOverflow = false
  const domainMissing = queryDomain === null || queryDomain === ''
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || ''
    if (type.includes('application/json')) {
      try {
        const body = (await request.json()) as { domain?: unknown; mode?: unknown; questions?: unknown }
        bodyDomain = body?.domain
        bodyMode = parseVisibilityMode(body?.mode)
        const cleaned = cleanOwnedStrings(body?.questions)
        bodyQuestions = cleaned ? cleaned.questions : null
        questionsOverflow = cleaned?.overflow === true
      } catch {
        if (domainMissing) return { domain: null, mode: 'unbranded', questions: null, questionsOverflow: false }
      }
    }
  }

  const modeSource = queryMode === 'absent' ? bodyMode : queryMode
  return {
    domain: canonicalHostname(domainMissing ? bodyDomain : queryDomain),
    mode: modeSource === 'absent' ? 'unbranded' : modeSource,
    questions: bodyQuestions,
    questionsOverflow,
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

function alignOwned(
  owned: string[],
  parsed: ParsedVisibility,
): { answers: string[]; mentions: unknown[] } {
  const byText = new Map<string, number>()
  parsed.questions.forEach((question, index) => byText.set(question.toLowerCase(), index))
  const sameCount = parsed.questions.length === owned.length
  const indexFor = (question: string, index: number) => {
    const at = byText.get(question.toLowerCase())
    if (at !== undefined) return at
    return sameCount ? index : -1
  }
  return {
    answers: owned.map((question, index) => {
      const at = indexFor(question, index)
      return at >= 0 ? parsed.answers[at] || '' : ''
    }),
    mentions: owned.map((question, index) => {
      const at = indexFor(question, index)
      return at >= 0 ? parsed.mentions[at] : undefined
    }),
  }
}

/** Flash model id only. Anything else, including a Vertex path, stays on the default. */
export function geminiModelFromEnv(env: VisibilityEnv | undefined): string {
  const raw = typeof env?.GEMINI_MODEL === 'string' ? env.GEMINI_MODEL.trim() : ''
  if (/^gemini-[a-z0-9.-]*flash[a-z0-9.-]*$/i.test(raw)) return raw
  return GEMINI_MODEL_DEFAULT
}

/** Pages binding `GEMINI_API_KEY` only. Whitespace is missing. A client-prefixed name is not read. */
export function geminiApiKeyFromEnv(env: VisibilityEnv | undefined): string {
  const raw = env?.GEMINI_API_KEY
  return typeof raw === 'string' ? raw.trim() : ''
}

export function geminiGenerateUrl(model: string): string {
  return `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

/**
 * Body for `models/{model}:generateContent` on v1beta.
 * `thinkingConfig` sits inside `generationConfig`. There is no `responseSchema`.
 */
export function geminiGenerateBody(
  model: string,
  prompt: string,
  questionCount: number,
): {
  contents: [{ role: 'user'; parts: [{ text: string }] }]
  generationConfig: ReturnType<typeof geminiGenerationConfig>
} {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: geminiGenerationConfig(model, questionCount),
  }
}

/** Ask Gemini to answer the questions OpenAI already wrote. No mention and no who-instead. */
export function geminiAnswerPrompt(questions: string[]): string {
  return [
    'Answer each question below as a careful assistant would.',
    'Return JSON only: {"answers":["one reply per question, same order and same length as the list"]}.',
    'Each reply is 2 to 4 sentences from public knowledge. If you cannot answer, use an empty string.',
    'Do not invent quotes or URLs.',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
  ].join('\n')
}

function geminiAnswerText(value: unknown): string {
  if (typeof value === 'string') return normalizeAnswer(value)
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).answer === 'string') {
    return normalizeAnswer((value as Record<string, unknown>).answer)
  }
  return ''
}

/** Parallel replies. A bad payload is a miss for every question — never a partial parse of names. */
export function parseGeminiAnswers(raw: string, count: number): string[] {
  const blank = () => Array.from({ length: Math.max(0, count) }, () => '')
  if (count <= 0) return []
  let text = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return blank()
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return blank()
  }
  if (!data || typeof data !== 'object') return blank()
  const answers = (data as Record<string, unknown>).answers
  if (!Array.isArray(answers)) return blank()
  return Array.from({ length: count }, (_, index) => geminiAnswerText(answers[index]))
}

function scrubKeys(value: string, keys: string[]): string {
  return keys.reduce((out, key) => scrubSecret(out, key), value)
}

function geminiPayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = (payload as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== 'object') return ''
  const content = (candidates[0] as { content?: { parts?: unknown } }).content
  const parts = content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const rec = part as { text?: unknown; thought?: unknown }
      // A thought summary is not the answer. Joining it onto the JSON blanks every reply.
      if (rec.thought === true) return ''
      return typeof rec.text === 'string' ? rec.text : ''
    })
    .join('')
}

export const GEMINI_MISS_CLASSES = ['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'] as const

export type GeminiMissClass = (typeof GEMINI_MISS_CLASSES)[number]

/** One class for the single Gemini call. `status` is set only for http_reject. */
export type GeminiMiss = {
  class: GeminiMissClass
  status?: number
}

export type GeminiReplySet = {
  replies: string[]
  miss?: GeminiMiss
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) return undefined
  return value
}

/** Signed-in response shape. Class, plus the HTTP status for http_reject. No body, prompt, or key. */
export function geminiMissForResponse(miss: GeminiMiss): { class: GeminiMissClass; status?: number } {
  switch (miss.class) {
    case 'http_reject': {
      const status = httpStatus(miss.status)
      return status === undefined ? { class: 'http_reject' } : { class: 'http_reject', status }
    }
    case 'missing_key':
    case 'timeout':
    case 'bad_json':
    case 'empty':
      return { class: miss.class }
  }
}

/**
 * Pages Function log line. Same vocabulary as geminiMiss.
 * `bad_json` may add a server-only reason: `max_tokens` or `parse`.
 * The reason is not part of the response. Never a body, prompt, or key.
 */
export function geminiMissLogLine(miss: GeminiMiss, reason?: 'max_tokens' | 'parse'): string {
  const safe = geminiMissForResponse(miss)
  if (safe.class === 'http_reject' && typeof safe.status === 'number') return `gemini miss http_reject ${safe.status}`
  if (safe.class === 'bad_json' && (reason === 'max_tokens' || reason === 'parse')) {
    return `gemini miss bad_json ${reason}`
  }
  return `gemini miss ${safe.class}`
}

/**
 * Answer tokens only. Kept small so a 2.5 Flash reply can finish inside
 * GEMINI_TIMEOUT_CAP_MS. The previous 8192 cap ran long enough that Pages
 * dropped the whole report.
 */
export function geminiMaxOutputTokens(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  return Math.min(1_200, 400 + count * 160)
}

/** Hard ceiling. Callers cannot wait longer than this. */
export const GEMINI_TIMEOUT_CAP_MS = 8_000

/**
 * OpenAI batches may use 22s after a short homepage fetch.
 * Leave slack so Gemini plus that work still returns before Pages
 * drops an invocation that has run too long.
 */
export const GEMINI_REPORT_BUDGET_MS = 26_000
const GEMINI_BUDGET_SLACK_MS = 2_000

/** A lower GEMINI_TIMEOUT_MS is honored. Anything above the cap is ignored. */
export function geminiTimeoutFromEnv(env: { GEMINI_TIMEOUT_MS?: string } | undefined): number {
  const raw = typeof env?.GEMINI_TIMEOUT_MS === 'string' ? Number(env.GEMINI_TIMEOUT_MS.trim()) : NaN
  if (Number.isInteger(raw) && raw >= 50 && raw <= GEMINI_TIMEOUT_CAP_MS) return raw
  return GEMINI_TIMEOUT_CAP_MS
}

/** How long this report can still wait on Gemini. Zero means do not call. */
export function geminiWaitMs(opts: { capMs: number; budgetMs: number; startedAt: number; now: number }): number {
  const left = opts.budgetMs - (opts.now - opts.startedAt) - GEMINI_BUDGET_SLACK_MS
  if (!Number.isFinite(left) || left < 250) return 0
  const cap = Number.isFinite(opts.capMs) ? Math.max(0, Math.floor(opts.capMs)) : 0
  return Math.min(cap, Math.floor(left))
}

function geminiSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let settled = false
  const fromParent = () => controller.abort()
  const done = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    parent?.removeEventListener('abort', fromParent)
  }
  controller.signal.addEventListener('abort', done, { once: true })
  if (parent) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', fromParent, { once: true })
  }
  return { signal: controller.signal, done }
}

/**
 * Floor on questions per chunk, and the most chunks in one report.
 * chunkSize = max(6, ceil(n / 2)). Twelve questions is 2 calls of 6.
 * Eighty questions is 2 calls of 40. One to six questions stay one call.
 */
export const GEMINI_CHUNK_FLOOR = 6

/** Questions per Gemini call for a report of this length. */
export function geminiChunkSize(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  if (count === 0) return GEMINI_CHUNK_FLOOR
  return Math.max(GEMINI_CHUNK_FLOOR, Math.ceil(count / 2))
}

/**
 * Per-chunk output budget. 200 covers a 2 to 4 sentence answer (~110 tokens)
 * with room to spare. 64 covers the JSON wrapper. Thinking is off, so this
 * is answer text only. Every chunk in the report uses the planned chunk size,
 * including a short tail.
 */
export const GEMINI_CHUNK_TOKENS_PER_QUESTION = 200
export const GEMINI_CHUNK_TOKEN_BASE = 64

export function geminiChunkMaxOutputTokens(chunkSize: number): number {
  const count = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 0
  return count * GEMINI_CHUNK_TOKENS_PER_QUESTION + GEMINI_CHUNK_TOKEN_BASE
}

/** Contiguous slices. At most two of them. Order is the report order. */
export function geminiQuestionChunks<T>(questions: readonly T[]): T[][] {
  if (questions.length === 0) return []
  const size = geminiChunkSize(questions.length)
  const chunks: T[][] = []
  for (let index = 0; index < questions.length; index += size) {
    chunks.push(questions.slice(index, index + size))
  }
  return chunks
}

/**
 * Set when a gemini-3 `thinkingLevel` request comes back HTTP 400.
 * Later calls in this isolate, and any chunk in this request that has not
 * been sent yet, omit thinkingConfig. A 2.5 Flash `thinkingBudget` is unrelated.
 */
let geminiThinkingLevelRejected = false

export function resetGeminiThinkingMemo(): void {
  geminiThinkingLevelRejected = false
}

/**
 * 2.5 Flash thinks unless thinkingBudget is 0, and those tokens count against maxOutputTokens.
 * gemini-3 thinks unless thinkingLevel is minimal, and those tokens count the same way.
 * Older flash ids do not get thinkingConfig: a 2.0 model can reject the field.
 * After a gemini-3 400, thinkingLevel is left off for the rest of this isolate.
 */
export function geminiGenerationConfig(
  model: string,
  questionCount: number,
  opts?: { maxOutputTokens?: number },
): {
  temperature: number
  maxOutputTokens: number
  responseMimeType: 'application/json'
  thinkingConfig?: { thinkingBudget: 0 } | { thinkingLevel: 'minimal' }
} {
  const base = {
    temperature: 0.2,
    maxOutputTokens: opts?.maxOutputTokens ?? geminiMaxOutputTokens(questionCount),
    responseMimeType: 'application/json' as const,
  }
  const id = model.toLowerCase()
  if (id.startsWith('gemini-2.5-flash')) {
    return { ...base, thinkingConfig: { thinkingBudget: 0 } }
  }
  if (id.startsWith('gemini-3') && !geminiThinkingLevelRejected) {
    return { ...base, thinkingConfig: { thinkingLevel: 'minimal' } }
  }
  return base
}

function answersArrayPresent(raw: string): boolean {
  let text = raw.trim()
  if (!text) return false
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return false
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as unknown
    return !!data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { answers?: unknown }).answers)
  } catch {
    return false
  }
}

/**
 * Blank replies from one payload.
 * MAX_TOKENS, or text that is not a complete answers array, is bad_json (truncation).
 * No text, or a complete answers array of blanks, is empty.
 * Any non-blank reply means the call is not a miss.
 */
export function geminiTextMiss(
  raw: string,
  count: number,
  finishReason?: string,
): { replies: string[]; miss?: GeminiMiss } {
  if (count <= 0) return { replies: [] }
  const replies = parseGeminiAnswers(raw, count)
  if (replies.some((item) => item !== '')) return { replies }
  if (finishReason === 'MAX_TOKENS' || (raw.trim() !== '' && !answersArrayPresent(raw))) {
    return { replies, miss: { class: 'bad_json' } }
  }
  return { replies, miss: { class: 'empty' } }
}

function geminiFinishReason(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const candidates = (payload as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== 'object') return ''
  const reason = (candidates[0] as { finishReason?: unknown }).finishReason
  return typeof reason === 'string' ? reason : ''
}

function noteGeminiMiss(
  replies: string[],
  miss: GeminiMiss,
  reason?: 'max_tokens' | 'parse',
): GeminiReplySet {
  const safe = geminiMissForResponse(miss)
  console.info(geminiMissLogLine(safe, reason))
  return { replies, miss: safe }
}

/**
 * One class for the blank rows. A chunk that returned answers does not
 * contribute. http_reject wins, then timeout, then bad_json, then empty.
 */
export function geminiMissFromChunks(misses: readonly (GeminiMiss | undefined)[]): GeminiMiss | undefined {
  const present = misses.filter((miss): miss is GeminiMiss => !!miss)
  if (present.length === 0) return undefined
  const rank = ['http_reject', 'timeout', 'bad_json', 'empty', 'missing_key'] as const
  for (const kind of rank) {
    const hit = present.find((miss) => miss.class === kind)
    if (hit) return geminiMissForResponse(hit)
  }
  return geminiMissForResponse(present[0])
}

function dropGeminiBody(res: Response) {
  try {
    void res.body?.cancel()?.catch(() => {})
  } catch {
    // Status only. Never read the body.
  }
}

function geminiPostBody(model: string, prompt: string, questionCount: number, maxOutputTokens: number) {
  return {
    contents: [{ role: 'user' as const, parts: [{ text: prompt }] }],
    generationConfig: geminiGenerationConfig(model, questionCount, { maxOutputTokens }),
  }
}

async function postGemini(
  apiKey: string,
  model: string,
  prompt: string,
  questionCount: number,
  maxOutputTokens: number,
  signal: AbortSignal,
): Promise<{ res: Response; sentThinkingLevel: boolean }> {
  const requestBody = geminiPostBody(model, prompt, questionCount, maxOutputTokens)
  const thinking = requestBody.generationConfig.thinkingConfig
  const sentThinkingLevel = !!thinking && 'thinkingLevel' in thinking
  const res = await fetch(geminiGenerateUrl(model), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal,
    body: JSON.stringify(requestBody),
  })
  return { res, sentThinkingLevel }
}

/**
 * One slice. A gemini-3 thinkingLevel HTTP 400 retries once without thinkingConfig
 * and is remembered so the next slice skips that field. Any other non-OK status
 * is http_reject and is not retried. On a chunk, MAX_TOKENS is bad_json before
 * the answer text is parsed. A later parse failure is also bad_json.
 */
async function geminiSlice(opts: {
  apiKey: string
  model: string
  questions: string[]
  scrub: string[]
  signal: AbortSignal
  maxOutputTokens: number
  shape: 'single' | 'chunk'
}): Promise<GeminiReplySet> {
  const blank = () => opts.questions.map(() => '')
  const prompt = geminiAnswerPrompt(opts.questions.map((question) => scrubKeys(question, opts.scrub)))
  let res: Response
  let sentThinkingLevel = false
  try {
    const sent = await postGemini(
      opts.apiKey,
      opts.model,
      prompt,
      opts.questions.length,
      opts.maxOutputTokens,
      opts.signal,
    )
    res = sent.res
    sentThinkingLevel = sent.sentThinkingLevel
  } catch {
    return noteGeminiMiss(blank(), { class: 'timeout' })
  }
  if (!res.ok && res.status === 400 && sentThinkingLevel) {
    geminiThinkingLevelRejected = true
    dropGeminiBody(res)
    try {
      const retried = await postGemini(
        opts.apiKey,
        opts.model,
        prompt,
        opts.questions.length,
        opts.maxOutputTokens,
        opts.signal,
      )
      res = retried.res
    } catch {
      return noteGeminiMiss(blank(), { class: 'timeout' })
    }
  }
  if (!res.ok) {
    const status = res.status
    dropGeminiBody(res)
    return noteGeminiMiss(blank(), { class: 'http_reject', status })
  }
  try {
    const payload = (await res.json()) as unknown
    return repliesFromGeminiPayload(payload, opts.questions.length, opts.scrub, opts.shape)
  } catch {
    return noteGeminiMiss(blank(), { class: 'bad_json' }, 'parse')
  }
}

function repliesFromGeminiPayload(
  payload: unknown,
  count: number,
  scrub: string[],
  shape: 'single' | 'chunk',
): GeminiReplySet {
  const finish = geminiFinishReason(payload)
  // A chunk that hit the cap is bad_json before any answer parse. Do not keep a partial list.
  if (shape === 'chunk' && finish === 'MAX_TOKENS') {
    return noteGeminiMiss(
      Array.from({ length: count }, () => ''),
      { class: 'bad_json' },
      'max_tokens',
    )
  }
  const text = scrubKeys(geminiPayloadText(payload), scrub)
  const outcome = geminiTextMiss(text, count, shape === 'chunk' ? undefined : finish)
  const replies = outcome.replies.map((answer) => scrubKeys(answer, scrub))
  if (!outcome.miss) return { replies }
  if (outcome.miss.class === 'bad_json') {
    return noteGeminiMiss(replies, { class: 'bad_json' }, finish === 'MAX_TOKENS' ? 'max_tokens' : 'parse')
  }
  return noteGeminiMiss(replies, outcome.miss)
}

/**
 * Same unbranded questions, Gemini text only.
 * Guest visibility and Run test stay one call. A full report (`report`) runs
 * in at most two parallel chunks and is zipped back by position. A miss on
 * one chunk blanks only that slice.
 * Missing key, an HTTP error, a timeout, bad JSON, and an empty payload stay empty strings.
 */
export async function geminiReplies(opts: {
  apiKey: string
  model: string
  questions: string[]
  scrub: string[]
  /** Clamped to GEMINI_TIMEOUT_CAP_MS. Zero skips the call and reports timeout. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Signed-in full report and Run again. Omitted for the guest check and Run test. */
  report?: boolean
}): Promise<GeminiReplySet> {
  const blank = () => opts.questions.map(() => '')
  if (opts.questions.length === 0) return { replies: [] }
  if (!opts.apiKey.trim()) return noteGeminiMiss(blank(), { class: 'missing_key' })
  const rawTimeout = opts.timeoutMs
  const requested =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? Math.floor(rawTimeout) : GEMINI_TIMEOUT_CAP_MS
  const timeoutMs = Math.min(GEMINI_TIMEOUT_CAP_MS, Math.max(0, requested))
  if (timeoutMs === 0 || opts.signal?.aborted) return noteGeminiMiss(blank(), { class: 'timeout' })
  const timed = geminiSignal(timeoutMs, opts.signal)
  try {
    if (!opts.report) {
      return await geminiSlice({
        apiKey: opts.apiKey,
        model: opts.model,
        questions: opts.questions,
        scrub: opts.scrub,
        signal: timed.signal,
        maxOutputTokens: geminiMaxOutputTokens(opts.questions.length),
        shape: 'single',
      })
    }
    const planned = geminiChunkSize(opts.questions.length)
    const maxOutputTokens = geminiChunkMaxOutputTokens(planned)
    const chunks = geminiQuestionChunks(opts.questions)
    const parts = await Promise.all(
      chunks.map((questions) =>
        geminiSlice({
          apiKey: opts.apiKey,
          model: opts.model,
          questions,
          scrub: opts.scrub,
          signal: timed.signal,
          maxOutputTokens,
          shape: 'chunk',
        }),
      ),
    )
    const replies = parts.flatMap((part) => part.replies)
    const miss = geminiMissFromChunks(parts.map((part) => part.miss))
    return miss ? { replies, miss } : { replies }
  } finally {
    timed.done()
  }
}

function ownedVisibilityPrompt(
  domain: string,
  mode: VisibilityMode,
  questions: string[],
  excerpt: string | null,
): string {
  const lines = [
    `Mode: ${mode}`,
    `Brand domain: ${domain}`,
    'Answer these questions exactly. Do not add, drop, or rewrite them. Return the same question strings in the same order.',
  ]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  questions.forEach((question, index) => lines.push(`${index + 1}. ${question}`))
  if (mode === 'branded') {
    lines.push('Return answers aligned 1:1 with these questions. Do not return whoInstead.')
  } else {
    lines.push('Return whoInstead and mentions aligned to these questions. Do not invent a new question list.')
  }
  return lines.join('\n')
}

async function completeVisibility(
  apiKey: string,
  domain: string,
  excerpt: string | null,
  mode: VisibilityMode,
  owned: string[] | null = null,
  gemini: { apiKey: string; model: string } = { apiKey: '', model: GEMINI_MODEL_DEFAULT },
): Promise<Response> {
  const lines = [`Mode: ${mode}`, `Brand domain: ${domain}`]
  if (excerpt) lines.push(`Homepage excerpt (may be incomplete):\n${excerpt}`)
  const user = owned && owned.length > 0 ? ownedVisibilityPrompt(domain, mode, owned, excerpt) : lines.join('\n')

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
        max_tokens: owned && owned.length > 0 ? Math.min(2200, 400 + owned.length * 180) : mode === 'branded' ? 1400 : 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPromptFor(mode) },
          { role: 'user', content: user },
        ],
      }),
    })
  } catch (err) {
    return json(502, { error: `ChatGPT request failed: ${failureDetail(err)}` })
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
    return json(502, { error: `ChatGPT request failed: ${safe || 'HTTP ' + res.status}` })
  }

  let content = ''
  try {
    const payload = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[]
    }
    const raw = payload.choices?.[0]?.message?.content
    content = typeof raw === 'string' ? raw : ''
  } catch {
    return json(502, { error: 'ChatGPT request failed: unreadable response' })
  }

  const parsed = parseVisibilityContent(scrubSecret(content, apiKey), domain, owned && owned.length > 0 ? 1 : 3)
  if (!parsed) {
    return json(502, { error: 'ChatGPT request failed: model output was not usable JSON' })
  }

  const useOwned = Boolean(owned && owned.length > 0)
  const aligned = useOwned && owned ? alignOwned(owned, parsed) : null
  const questions = useOwned && owned ? owned : parsed.questions
  const answers = aligned ? aligned.answers : parsed.answers
  const mentions = aligned ? aligned.mentions : parsed.mentions
  const facts = factsFromVisibility({
    domain,
    mode,
    questions,
    answers,
    answered: parsed.answered,
    whoInstead: parsed.whoInstead,
    mentions,
  }).map((fact) => ({
    ...fact,
    question: scrubSecret(fact.question, apiKey),
    whoInstead: fact.whoInstead.map((name) => scrubSecret(name, apiKey)),
  }))
  const body: Record<string, unknown> = {
    ok: true,
    domain,
    model: MODEL,
    mode,
    questions,
    answered: parsed.answered,
    why: parsed.why,
    facts,
  }
  // Who-instead stays on the unbranded beat. OpenAI prose stays on the branded beat.
  if (mode === 'unbranded') body.whoInstead = parsed.whoInstead
  if (mode === 'branded') body.answers = answers
  // Gemini text is a sibling of the OpenAI result. A miss is empty strings, not a failed check.
  if (mode === 'unbranded') {
    const geminiResult = await geminiReplies({
      apiKey: gemini.apiKey,
      model: gemini.model,
      questions,
      scrub: [apiKey, gemini.apiKey],
    })
    body.gemini = geminiResult.replies
  }
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

  const { domain, mode, questions, questionsOverflow } = await fieldsFromRequest(request)
  if (!domain) return json(400, { error: 'domain must be a simple public hostname' })
  if (mode === 'invalid') return json(400, { error: 'mode must be unbranded or branded' })
  if (questionsOverflow) return json(400, { error: 'This check can hold 8 questions.' })
  if (questions && questions.length === 0) return json(400, { error: 'Keep at least one question.' })

  const secret = context.env?.OPENAI_API_KEY
  const apiKey = typeof secret === 'string' ? secret.trim() : ''
  if (!apiKey) return json(503, { error: 'OPENAI_API_KEY not configured' })
  const geminiKey = geminiApiKeyFromEnv(context.env)

  const gate = await gateModelCall({
    request,
    env: context.env,
    config: productConfigFromEnv(context.env),
  })
  if (!gate.ok) return gate.response

  const excerpt = await homepageExcerpt(domain)
  const safeExcerpt = excerpt ? scrubSecret(excerpt, apiKey) : null
  const result = await completeVisibility(apiKey, domain, safeExcerpt, mode, questions, {
    apiKey: geminiKey,
    model: geminiModelFromEnv(context.env),
  })
  if (result.status !== 200) {
    try {
      await gate.release()
    } catch {
      // Keep the model error. A failed release may count a check that did not finish.
    }
  }
  return result
}

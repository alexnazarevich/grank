/**
 * Signed-in Claude replies for unbranded full-report questions.
 * One question is one call (Run test). A longer list is at most four parallel
 * chunks, merged by position. One chunk's miss blanks only that slice.
 * A 404 on claude-haiku-5-5 is remembered for this isolate, so later calls
 * go straight to claude-haiku-4-5.
 * Guest /api/visibility does not import this module.
 * ANTHROPIC_API_KEY stays on the server. Never a VITE_ name.
 */

import {
  GEMINI_TIMEOUT_CAP_MS,
  geminiAnswerPrompt,
  geminiMissForResponse,
  geminiTextMiss,
  scrubSecret,
  type GeminiMiss,
  type GeminiMissClass,
} from './visibility.ts'

export const CLAUDE_MODEL_DEFAULT = 'claude-haiku-5-5'
export const CLAUDE_MODEL_FALLBACK = 'claude-haiku-4-5'
export const CLAUDE_TIMEOUT_CAP_MS = GEMINI_TIMEOUT_CAP_MS
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export const CLAUDE_MISS_CLASSES = ['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'] as const

export type ClaudeMiss = GeminiMiss
export type ClaudeMissClass = GeminiMissClass

export type ClaudeReplySet = {
  replies: string[]
  miss?: ClaudeMiss
}

type ClaudeEnv = { ANTHROPIC_API_KEY?: string; CLAUDE_MODEL?: string; VITE_ANTHROPIC_API_KEY?: string; VITE_CLAUDE_MODEL?: string }

/** Pages binding `ANTHROPIC_API_KEY` only. A client-prefixed name is not read. */
export function claudeApiKeyFromEnv(env: ClaudeEnv | undefined): string {
  const raw = env?.ANTHROPIC_API_KEY
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Model id only. A URL, a blank, or a client-prefixed name stays on the default. */
export function claudeModelFromEnv(env: ClaudeEnv | undefined): string {
  const raw = typeof env?.CLAUDE_MODEL === 'string' ? env.CLAUDE_MODEL.trim() : ''
  if (/^claude-[a-z0-9][a-z0-9.-]{0,80}$/i.test(raw)) return raw
  return CLAUDE_MODEL_DEFAULT
}

/**
 * Haiku 5.5 accepts effort. Haiku 4.5 does not — sending it returns 400.
 * Only the 5.x Haiku id gets `output_config.effort`.
 */
export function claudeSendsEffort(model: string): boolean {
  return /^claude-haiku-5(?:-|$)/i.test(model)
}

/**
 * Run test budget. One question, adaptive thinking at low effort.
 * Same ceiling Gemini uses. A full-report batch does not use this.
 */
export function claudeMaxOutputTokens(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  return Math.min(1_200, 400 + count * 160)
}

/**
 * Floor on questions per chunk, and the most chunks in one report.
 * chunkSize = max(4, ceil(n / 4)). Sixteen or fewer questions stay at 4 per
 * call. Eighty questions is 4 calls of 20. Every in-flight chunk can still
 * retry a 404 once, which is 8 calls, and only before this isolate remembers.
 */
export const CLAUDE_CHUNK_SIZE = 4

/** Questions per Claude call for a report of this length. */
export function claudeChunkSize(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  if (count === 0) return CLAUDE_CHUNK_SIZE
  return Math.max(CLAUDE_CHUNK_SIZE, Math.ceil(count / CLAUDE_CHUNK_SIZE))
}

/**
 * Per-answer allowance after the Haiku 5.5 tokenizer (~30% more tokens for
 * the same text than the 160-token figure). 48 covers the JSON wrapper.
 * A full chunk is 48 + 4 * 210 = 888 tokens. Thinking is off, so this is
 * answer text only.
 */
export const CLAUDE_CHUNK_TOKEN_BASE = 48
export const CLAUDE_CHUNK_TOKENS_PER_QUESTION = 210

export function claudeChunkMaxOutputTokens(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  return CLAUDE_CHUNK_TOKEN_BASE + count * CLAUDE_CHUNK_TOKENS_PER_QUESTION
}

/** Contiguous slices. At most CLAUDE_CHUNK_SIZE of them. Order is the report order. */
export function claudeQuestionChunks<T>(questions: readonly T[]): T[][] {
  if (questions.length === 0) return []
  const size = claudeChunkSize(questions.length)
  const chunks: T[][] = []
  for (let index = 0; index < questions.length; index += size) {
    chunks.push(questions.slice(index, index + size))
  }
  return chunks
}

/**
 * Set when claude-haiku-5-5 (or whatever primary id 404'd) is missing.
 * Later calls in this isolate, and any chunk in this request that has not
 * been sent yet, use the fallback without a retry.
 */
let claudeMissingModel: string | null = null

export function resetClaudeModelMemo(): void {
  claudeMissingModel = null
}

function claudeModelToSend(requested: string): string {
  if (claudeMissingModel && requested === claudeMissingModel) return CLAUDE_MODEL_FALLBACK
  return requested
}

function rememberClaudeFallback(model: string): void {
  if (model !== CLAUDE_MODEL_FALLBACK) claudeMissingModel = model
}

/**
 * Messages API body. No temperature, top_p, or top_k — Haiku 5.5 returns 400
 * for a non-default sampling value.
 * `single` is Run test: adaptive thinking, effort low, the 560-token one-question cap.
 * `chunk` is a full-report slice: thinking disabled (Haiku 5.5 allows that at
 * effort low) so max_tokens is spent on the answers. The fallback model omits
 * effort and thinking on both shapes.
 */
export function claudeMessageBody(
  model: string,
  prompt: string,
  questionCount: number,
  shape: 'single' | 'chunk' = 'single',
): {
  model: string
  max_tokens: number
  messages: [{ role: 'user'; content: string }]
  thinking?: { type: 'adaptive' } | { type: 'disabled' }
  output_config?: { effort: 'low' }
} {
  const body: {
    model: string
    max_tokens: number
    messages: [{ role: 'user'; content: string }]
    thinking?: { type: 'adaptive' } | { type: 'disabled' }
    output_config?: { effort: 'low' }
  } = {
    model,
    max_tokens: shape === 'chunk' ? claudeChunkMaxOutputTokens(questionCount) : claudeMaxOutputTokens(questionCount),
    messages: [{ role: 'user', content: prompt }],
  }
  if (claudeSendsEffort(model)) {
    body.thinking = shape === 'chunk' ? { type: 'disabled' } : { type: 'adaptive' }
    body.output_config = { effort: 'low' }
  }
  return body
}

/**
 * One class for the blank rows. A chunk that returned answers does not
 * contribute. http_reject wins, then timeout, then bad_json, then empty.
 */
export function claudeMissFromChunks(misses: readonly (ClaudeMiss | undefined)[]): ClaudeMiss | undefined {
  const present = misses.filter((miss): miss is ClaudeMiss => !!miss)
  if (present.length === 0) return undefined
  const rank = ['http_reject', 'timeout', 'bad_json', 'empty', 'missing_key'] as const
  for (const kind of rank) {
    const hit = present.find((miss) => miss.class === kind)
    if (hit) return claudeMissForResponse(hit)
  }
  return claudeMissForResponse(present[0])
}

export function claudeMissForResponse(miss: ClaudeMiss): { class: ClaudeMissClass; status?: number } {
  return geminiMissForResponse(miss)
}

export function claudeMissLogLine(miss: ClaudeMiss): string {
  const safe = claudeMissForResponse(miss)
  if (safe.class === 'http_reject' && typeof safe.status === 'number') return `claude miss http_reject ${safe.status}`
  return `claude miss ${safe.class}`
}

function scrubKeys(value: string, keys: string[]): string {
  return keys.reduce((out, key) => scrubSecret(out, key), value)
}

function noteClaudeMiss(replies: string[], miss: ClaudeMiss): ClaudeReplySet {
  const safe = claudeMissForResponse(miss)
  console.info(claudeMissLogLine(safe))
  return { replies, miss: safe }
}

function claudeSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
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

function claudePayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const content = (payload as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const rec = block as { type?: unknown; text?: unknown }
      if (rec.type !== 'text' || typeof rec.text !== 'string') return ''
      return rec.text
    })
    .join('')
}

function claudeStoppedEarly(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  return (payload as { stop_reason?: unknown }).stop_reason === 'max_tokens' ? 'MAX_TOKENS' : ''
}

/**
 * 404, or Anthropic's not_found_error, means the model id is missing.
 * HTTP 400 is a bad request (sampling, effort) and is not a retry.
 */
export async function claudeModelNotFound(res: Response): Promise<boolean> {
  if (res.status === 400) return false
  if (res.status === 404) return true
  try {
    const data = (await res.clone().json()) as { error?: { type?: unknown } }
    return data?.error?.type === 'not_found_error'
  } catch {
    return false
  }
}

async function postClaude(
  apiKey: string,
  model: string,
  prompt: string,
  questionCount: number,
  signal: AbortSignal,
  shape: 'single' | 'chunk',
): Promise<Response> {
  return fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    signal,
    body: JSON.stringify(claudeMessageBody(model, prompt, questionCount, shape)),
  })
}

function dropBody(res: Response) {
  try {
    void res.body?.cancel()?.catch(() => {})
  } catch {
    // Status only. Never read the body into a response or a log.
  }
}

/**
 * One slice. A 404 or not_found retries once on the fallback, without effort,
 * and is remembered so the next slice skips the missing id. HTTP 400 is
 * http_reject and is not retried. stop_reason max_tokens is bad_json.
 * Run test uses this same path, so it shares the memo.
 */
async function claudeSlice(opts: {
  apiKey: string
  model: string
  questions: string[]
  scrub: string[]
  signal: AbortSignal
  shape: 'single' | 'chunk'
}): Promise<ClaudeReplySet> {
  const blank = () => opts.questions.map(() => '')
  const prompt = geminiAnswerPrompt(opts.questions.map((question) => scrubKeys(question, opts.scrub)))
  const requested = opts.model
  let model = claudeModelToSend(requested)
  let res: Response
  try {
    res = await postClaude(opts.apiKey, model, prompt, opts.questions.length, opts.signal, opts.shape)
  } catch {
    return noteClaudeMiss(blank(), { class: 'timeout' })
  }
  if (!res.ok && model !== CLAUDE_MODEL_FALLBACK && (await claudeModelNotFound(res))) {
    rememberClaudeFallback(model)
    dropBody(res)
    model = CLAUDE_MODEL_FALLBACK
    try {
      res = await postClaude(opts.apiKey, model, prompt, opts.questions.length, opts.signal, opts.shape)
    } catch {
      return noteClaudeMiss(blank(), { class: 'timeout' })
    }
  }
  if (!res.ok) {
    const status = res.status
    dropBody(res)
    return noteClaudeMiss(blank(), { class: 'http_reject', status })
  }
  try {
    const payload = await res.json()
    const text = claudePayloadText(payload)
    const outcome = geminiTextMiss(scrubKeys(text, opts.scrub), opts.questions.length, claudeStoppedEarly(payload))
    const replies = outcome.replies.map((answer) => scrubKeys(answer, opts.scrub))
    if (!outcome.miss) return { replies }
    return noteClaudeMiss(replies, outcome.miss)
  } catch {
    return noteClaudeMiss(blank(), { class: 'bad_json' })
  }
}

/**
 * Same unbranded questions, Claude text only.
 * One question stays one call. A longer list runs in parallel chunks and is
 * zipped back by position. A miss on one chunk blanks only that slice.
 * The whole set shares one 8s abort. A chunk that 404s retries once.
 */
export async function claudeReplies(opts: {
  apiKey: string
  model: string
  questions: string[]
  scrub: string[]
  /** Clamped to CLAUDE_TIMEOUT_CAP_MS. Zero skips the call and reports timeout. */
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ClaudeReplySet> {
  const blank = () => opts.questions.map(() => '')
  if (opts.questions.length === 0) return { replies: [] }
  if (!opts.apiKey.trim()) return noteClaudeMiss(blank(), { class: 'missing_key' })
  const rawTimeout = opts.timeoutMs
  const requested =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? Math.floor(rawTimeout) : CLAUDE_TIMEOUT_CAP_MS
  const timeoutMs = Math.min(CLAUDE_TIMEOUT_CAP_MS, Math.max(0, requested))
  if (timeoutMs === 0 || opts.signal?.aborted) return noteClaudeMiss(blank(), { class: 'timeout' })
  const timed = claudeSignal(timeoutMs, opts.signal)
  try {
    if (opts.questions.length === 1) {
      return await claudeSlice({ ...opts, signal: timed.signal, shape: 'single' })
    }
    const chunks = claudeQuestionChunks(opts.questions)
    const parts = await Promise.all(
      chunks.map((questions) =>
        claudeSlice({
          apiKey: opts.apiKey,
          model: opts.model,
          questions,
          scrub: opts.scrub,
          signal: timed.signal,
          shape: 'chunk',
        }),
      ),
    )
    const replies = parts.flatMap((part) => part.replies)
    const miss = claudeMissFromChunks(parts.map((part) => part.miss))
    return miss ? { replies, miss } : { replies }
  } finally {
    timed.done()
  }
}

/**
 * Signed-in Claude replies for unbranded full-report questions.
 * One Messages API call. A miss is empty strings plus one class.
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
 * Answer tokens only, same ceiling Gemini uses so the call can finish inside 8s.
 * Thinking tokens on Haiku 5.5 count against this cap. Effort stays low so the
 * model can skip thinking instead of burning the budget.
 */
export function claudeMaxOutputTokens(questionCount: number): number {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 0
  return Math.min(1_200, 400 + count * 160)
}

/**
 * Messages API body. No temperature, top_p, or top_k — Haiku 5.5 returns 400
 * for a non-default sampling value. Effort is `low` via output_config.
 * The fallback model omits effort and adaptive thinking.
 */
export function claudeMessageBody(
  model: string,
  prompt: string,
  questionCount: number,
): {
  model: string
  max_tokens: number
  messages: [{ role: 'user'; content: string }]
  thinking?: { type: 'adaptive' }
  output_config?: { effort: 'low' }
} {
  const body: {
    model: string
    max_tokens: number
    messages: [{ role: 'user'; content: string }]
    thinking?: { type: 'adaptive' }
    output_config?: { effort: 'low' }
  } = {
    model,
    max_tokens: claudeMaxOutputTokens(questionCount),
    messages: [{ role: 'user', content: prompt }],
  }
  if (claudeSendsEffort(model)) {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort: 'low' }
  }
  return body
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
): Promise<Response> {
  return fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    signal,
    body: JSON.stringify(claudeMessageBody(model, prompt, questionCount)),
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
 * Same unbranded questions, Claude text only.
 * One call. If the chosen model 404s or is not_found, retry once on the fallback
 * without the effort param. Any other HTTP status, including 400, is http_reject.
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
  const prompt = geminiAnswerPrompt(opts.questions.map((question) => scrubKeys(question, opts.scrub)))
  const timed = claudeSignal(timeoutMs, opts.signal)
  try {
    let model = opts.model
    let res: Response
    try {
      res = await postClaude(opts.apiKey, model, prompt, opts.questions.length, timed.signal)
    } catch {
      return noteClaudeMiss(blank(), { class: 'timeout' })
    }
    if (!res.ok && model !== CLAUDE_MODEL_FALLBACK && (await claudeModelNotFound(res))) {
      dropBody(res)
      model = CLAUDE_MODEL_FALLBACK
      try {
        res = await postClaude(opts.apiKey, model, prompt, opts.questions.length, timed.signal)
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
  } finally {
    timed.done()
  }
}

/**
 * Searched answers for the Citations tab. Reused by the temporary timing probe.
 * One call per question. Neither path changes the plain ChatGPT, Gemini, or Claude blocks.
 *
 * ChatGPT uses the Responses API `web_search` tool (not the retired
 * `gpt-4o-mini-search-preview` Chat Completions model, which shut down on
 * 2026-07-23). `gpt-4o-mini` is the cheap model already used for plain answers
 * and is the default here. Override with `CHATGPT_SEARCH_MODEL` if that id
 * rejects the tool. `tool_choice` is `required` so a capped question searches.
 * Citations are `url_citation` annotations only. The sources list is never read.
 *
 * Gemini is one `generateContent` with `google_search`. The model default and
 * the gemini-3 `thinkingLevel: minimal` rule match `visibility.ts`. Plain text,
 * no JSON mode. A thinkingLevel HTTP 400 retries once without that field and is
 * remembered for later grounded calls in this isolate. It does not flip the
 * plain-Gemini memo in `visibility.ts`.
 *
 * Both waits are capped at 8s, the same ceiling as the existing engine calls.
 * `t_created` is when this call is constructed. `t_start` is the moment `fetch`
 * is invoked. Workers queue past 6 outbound connections inside `fetch`, so
 * `t_headers` is when response headers arrive and `t_end` is when the call is done.
 * Stamps are milliseconds since `originMs` (the probe request start).
 */

import { scrubSecret } from './http.ts'
import {
  GEMINI_MODEL_DEFAULT,
  GEMINI_TIMEOUT_CAP_MS,
  geminiGenerateUrl,
  geminiGenerationConfig,
  geminiMaxOutputTokens,
} from './visibility.ts'

export const CHATGPT_SEARCH_MODEL_DEFAULT = 'gpt-4o-mini'
export const SEARCH_TIMEOUT_MS = GEMINI_TIMEOUT_CAP_MS
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const CHATGPT_SEARCH_MAX_OUTPUT_TOKENS = 500
const MODEL_RE = /^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const GEMINI_MODEL_RE = /^gemini-[A-Za-z0-9][A-Za-z0-9.-]{0,80}$/

export const SEARCH_MISS_CLASSES = ['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'] as const

export type SearchMissClass = (typeof SEARCH_MISS_CLASSES)[number]

export type SearchMiss = {
  class: SearchMissClass
  status?: number
}

export type SearchUsage = {
  inputTokens: number
  outputTokens: number
}

/** Milliseconds since the request origin. `t_headers` is null when headers never arrived. */
export type SearchClock = {
  t_created: number
  t_start: number
  t_headers: number | null
  t_end: number
}

export type UrlCitation = { url: string; title: string }

export type GroundingChunk = { uri: string; title: string }

export type ChatGptWebSearchResult = {
  text: string
  citations: UrlCitation[]
  usage: SearchUsage
  searchCount: number
  /** Always 1. ChatGPT search does not retry. */
  attempts: number
  clock: SearchClock
  miss?: SearchMiss
}

export type GeminiGroundedResult = {
  text: string
  chunks: GroundingChunk[]
  searchCount: number
  hasSearchEntryPoint: boolean
  usage: SearchUsage
  /** 2 when a gemini-3 thinkingLevel HTTP 400 was retried once without that field. */
  attempts: number
  clock: SearchClock
  miss?: SearchMiss
}

type SearchEnv = { CHATGPT_SEARCH_MODEL?: string }

/**
 * Pages binding `CHATGPT_SEARCH_MODEL` only. A blank, a URL, or a client-prefixed
 * name stays on gpt-4o-mini. Not a `VITE_` variable.
 */
export function chatgptSearchModelFromEnv(env: SearchEnv | undefined): string {
  const raw = typeof env?.CHATGPT_SEARCH_MODEL === 'string' ? env.CHATGPT_SEARCH_MODEL.trim() : ''
  if (MODEL_RE.test(raw)) return raw
  return CHATGPT_SEARCH_MODEL_DEFAULT
}

/** A lower timeout is honored. Anything above the 8s cap is ignored. Zero skips the network. */
export function searchTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SEARCH_TIMEOUT_MS
  return Math.min(SEARCH_TIMEOUT_MS, Math.max(0, Math.floor(raw)))
}

export function elapsedSince(originMs: number): number {
  return Math.max(0, Date.now() - originMs)
}

export function clockTotalMs(clock: SearchClock): number {
  return Math.max(0, clock.t_end - clock.t_created)
}

/**
 * Time from `fetch()` invoke until response headers.
 * That span includes the Workers queue past 6 simultaneous outbound connections.
 * When headers never arrive, it is invoke until the call ends.
 */
export function clockWaitingMs(clock: SearchClock): number {
  const end = clock.t_headers === null ? clock.t_end : clock.t_headers
  return Math.max(0, end - clock.t_start)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function tokenCount(record: Record<string, unknown> | null, keys: readonly string[]): number {
  if (!record) return 0
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  }
  return 0
}

function scrubKeys(value: string, keys: readonly string[]): string {
  return keys.reduce((out, key) => (key ? scrubSecret(out, key) : out), value)
}

function secretList(apiKey: string, extra: readonly string[] | undefined): string[] {
  const keys = [apiKey.trim(), ...(extra ?? [])]
  return keys.filter((key) => key !== '')
}

function emptyUsage(): SearchUsage {
  return { inputTokens: 0, outputTokens: 0 }
}

export function engineAbort(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
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

export async function timedFetch(opts: {
  originMs: number
  tCreated: number
  url: string
  method: string
  headers: HeadersInit
  body?: string
  signal: AbortSignal
}): Promise<{ response: Response | null; clock: SearchClock; miss?: SearchMiss }> {
  const t_start = elapsedSince(opts.originMs)
  try {
    const response = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    })
    const t_headers = elapsedSince(opts.originMs)
    return {
      response,
      clock: { t_created: opts.tCreated, t_start, t_headers, t_end: t_headers },
    }
  } catch {
    const t_end = elapsedSince(opts.originMs)
    return {
      response: null,
      clock: { t_created: opts.tCreated, t_start, t_headers: null, t_end },
      miss: { class: 'timeout' },
    }
  }
}

async function dropBody(res: Response) {
  try {
    await res.body?.cancel()
  } catch {
    // Status only. Never read an error body into a response or a log.
  }
}

async function readJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function finishClock(clock: SearchClock, originMs: number): SearchClock {
  return { ...clock, t_end: elapsedSince(originMs) }
}

/**
 * Answer text and url_citation annotations from a Responses payload.
 * `web_search_call` items increment searchCount. Their `sources` arrays are ignored,
 * including when a source object carries a url. Annotations that are not
 * `url_citation` are ignored. Returns null when `output` is not an array.
 */
export function citationsFromWebSearchPayload(payload: unknown): {
  text: string
  citations: UrlCitation[]
  searchCount: number
  usage: SearchUsage
} | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null
  let searchCount = 0
  const texts: string[] = []
  const citations: UrlCitation[] = []
  for (const item of payload.output) {
    if (!isRecord(item)) continue
    if (item.type === 'web_search_call') searchCount += 1
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isRecord(part)) continue
      if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
      if (!Array.isArray(part.annotations)) continue
      for (const note of part.annotations) {
        if (!isRecord(note) || note.type !== 'url_citation') continue
        if (typeof note.url !== 'string') continue
        const url = note.url.trim()
        if (!url) continue
        const title = typeof note.title === 'string' ? note.title.trim() : ''
        citations.push({ url, title })
      }
    }
  }
  const usage = isRecord(payload.usage) ? payload.usage : null
  return {
    text: texts.join(' ').replace(/\s+/g, ' ').trim(),
    citations,
    searchCount,
    usage: {
      inputTokens: tokenCount(usage, ['input_tokens', 'prompt_tokens']),
      outputTokens: tokenCount(usage, ['output_tokens', 'completion_tokens']),
    },
  }
}

/**
 * Grounding metadata from one generateContent payload.
 * Chunks are `groundingChunks[].web` `{uri, title}` only.
 * searchCount is the number of `webSearchQueries` strings.
 * hasSearchEntryPoint is true when `searchEntryPoint.renderedContent` is non-blank.
 * Thought parts are not part of the answer text. Returns null when `candidates` is missing.
 */
export function groundingFromGeminiPayload(payload: unknown): {
  text: string
  chunks: GroundingChunk[]
  searchCount: number
  hasSearchEntryPoint: boolean
  usage: SearchUsage
} | null {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return null
  const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : null
  const tokens: SearchUsage = {
    inputTokens: tokenCount(usage, ['promptTokenCount', 'prompt_token_count']),
    outputTokens: tokenCount(usage, ['candidatesTokenCount', 'candidates_token_count']),
  }
  const first = payload.candidates[0]
  if (!isRecord(first)) {
    return { text: '', chunks: [], searchCount: 0, hasSearchEntryPoint: false, usage: tokens }
  }
  const texts: string[] = []
  const content = isRecord(first.content) ? first.content : null
  const parts = content && Array.isArray(content.parts) ? content.parts : []
  for (const part of parts) {
    if (!isRecord(part) || part.thought === true) continue
    if (typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
  }
  const meta = isRecord(first.groundingMetadata) ? first.groundingMetadata : {}
  const queries = Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : []
  const searchCount = queries.filter((query) => typeof query === 'string' && query.trim() !== '').length
  const chunks: GroundingChunk[] = []
  const rawChunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : []
  for (const chunk of rawChunks) {
    if (!isRecord(chunk) || !isRecord(chunk.web)) continue
    if (typeof chunk.web.uri !== 'string') continue
    const uri = chunk.web.uri.trim()
    if (!uri) continue
    const title = typeof chunk.web.title === 'string' ? chunk.web.title.trim() : ''
    chunks.push({ uri, title })
  }
  const entry = isRecord(meta.searchEntryPoint) ? meta.searchEntryPoint.renderedContent : undefined
  return {
    text: texts.join(' ').replace(/\s+/g, ' ').trim(),
    chunks,
    searchCount,
    hasSearchEntryPoint: typeof entry === 'string' && entry.trim() !== '',
    usage: tokens,
  }
}

function resolveSearchModel(model: string): string {
  const raw = model.trim()
  return MODEL_RE.test(raw) ? raw : CHATGPT_SEARCH_MODEL_DEFAULT
}

function resolveGeminiModel(model: string): string {
  const raw = model.trim()
  return GEMINI_MODEL_RE.test(raw) ? raw : GEMINI_MODEL_DEFAULT
}

/**
 * Open web search. `domain`, when present, is context for the buyer question.
 * It is not an `allowed_domains` filter: limiting sources to the brand site
 * would make the citation list meaningless.
 */
export function chatgptWebSearchBody(model: string, question: string, domain?: string): {
  model: string
  tools: [{ type: 'web_search' }]
  tool_choice: 'required'
  max_output_tokens: number
  input: string
} {
  const lines = [
    'Answer in two or three sentences for a software buyer. Use web search and cite the pages you used.',
    question,
  ]
  const host = typeof domain === 'string' ? domain.trim() : ''
  if (host) lines.push(`The buyer is looking at ${host}. Do not limit sources to that site.`)
  return {
    model,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    max_output_tokens: CHATGPT_SEARCH_MAX_OUTPUT_TOKENS,
    input: lines.join('\n'),
  }
}

let groundedThinkingRejected = false

export function resetGroundedThinkingMemo(): void {
  groundedThinkingRejected = false
}

function groundedGenerationConfig(model: string, allowThinkingLevel: boolean): {
  temperature: number
  maxOutputTokens: number
  thinkingConfig?: { thinkingBudget: 0 } | { thinkingLevel: 'minimal' }
} {
  const full = geminiGenerationConfig(model, 1, { maxOutputTokens: geminiMaxOutputTokens(1) })
  const generationConfig: {
    temperature: number
    maxOutputTokens: number
    thinkingConfig?: { thinkingBudget: 0 } | { thinkingLevel: 'minimal' }
  } = {
    temperature: full.temperature,
    maxOutputTokens: full.maxOutputTokens,
  }
  if (!full.thinkingConfig) return generationConfig
  if (!allowThinkingLevel && 'thinkingLevel' in full.thinkingConfig) return generationConfig
  generationConfig.thinkingConfig = full.thinkingConfig
  return generationConfig
}

export function geminiGroundedBody(model: string, question: string, allowThinkingLevel = true): {
  contents: [{ role: 'user'; parts: [{ text: string }] }]
  tools: [{ google_search: Record<string, never> }]
  generationConfig: ReturnType<typeof groundedGenerationConfig>
} {
  return {
    contents: [{ role: 'user', parts: [{ text: `Answer in two or three sentences for a software buyer.\n${question}` }] }],
    tools: [{ google_search: {} }],
    generationConfig: groundedGenerationConfig(model, allowThinkingLevel),
  }
}

function scrubCitation(citation: UrlCitation, secrets: readonly string[]): UrlCitation {
  return { url: scrubKeys(citation.url, secrets), title: scrubKeys(citation.title, secrets) }
}

function scrubChunk(chunk: GroundingChunk, secrets: readonly string[]): GroundingChunk {
  return { uri: scrubKeys(chunk.uri, secrets), title: scrubKeys(chunk.title, secrets) }
}

export async function chatgptWebSearch(opts: {
  apiKey: string
  model: string
  question: string
  domain?: string
  timeoutMs?: number
  originMs?: number
  signal?: AbortSignal
  scrub?: string[]
}): Promise<ChatGptWebSearchResult> {
  const originMs = typeof opts.originMs === 'number' ? opts.originMs : Date.now()
  const tCreated = elapsedSince(originMs)
  const secrets = secretList(opts.apiKey, opts.scrub)
  const idle = (): SearchClock => ({ t_created: tCreated, t_start: tCreated, t_headers: tCreated, t_end: tCreated })
  const blank = (): ChatGptWebSearchResult => ({
    text: '',
    citations: [],
    usage: emptyUsage(),
    searchCount: 0,
    attempts: 0,
    clock: idle(),
  })
  if (!opts.apiKey.trim()) return { ...blank(), miss: { class: 'missing_key' } }
  const timeoutMs = searchTimeoutMs(opts.timeoutMs)
  if (timeoutMs === 0 || opts.signal?.aborted) {
    return {
      ...blank(),
      attempts: 1,
      clock: { t_created: tCreated, t_start: tCreated, t_headers: null, t_end: elapsedSince(originMs) },
      miss: { class: 'timeout' },
    }
  }
  const model = resolveSearchModel(opts.model)
  const question = scrubKeys(opts.question, secrets)
  const domain = opts.domain ? scrubKeys(opts.domain, secrets) : undefined
  const timed = engineAbort(timeoutMs, opts.signal)
  try {
    const sent = await timedFetch({
      originMs,
      tCreated,
      url: OPENAI_RESPONSES_URL,
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(chatgptWebSearchBody(model, question, domain)),
      signal: timed.signal,
    })
    if (sent.miss || !sent.response) {
      return { ...blank(), attempts: 1, clock: sent.clock, miss: sent.miss ?? { class: 'timeout' } }
    }
    if (!sent.response.ok) {
      const status = sent.response.status
      await dropBody(sent.response)
      return {
        ...blank(),
        attempts: 1,
        clock: finishClock(sent.clock, originMs),
        miss: { class: 'http_reject', status },
      }
    }
    const payload = await readJson(sent.response)
    const clock = finishClock(sent.clock, originMs)
    const parsed = payload === null ? null : citationsFromWebSearchPayload(payload)
    if (!parsed) return { ...blank(), attempts: 1, clock, miss: { class: 'bad_json' } }
    const text = scrubKeys(parsed.text, secrets)
    const citations = parsed.citations.map((citation) => scrubCitation(citation, secrets))
    if (!text) {
      return { ...blank(), attempts: 1, clock, citations, usage: parsed.usage, searchCount: parsed.searchCount, miss: { class: 'empty' } }
    }
    return {
      text,
      citations,
      usage: parsed.usage,
      searchCount: parsed.searchCount,
      attempts: 1,
      clock,
    }
  } finally {
    timed.done()
  }
}

export async function geminiGrounded(opts: {
  apiKey: string
  model: string
  question: string
  timeoutMs?: number
  originMs?: number
  signal?: AbortSignal
  scrub?: string[]
}): Promise<GeminiGroundedResult> {
  const originMs = typeof opts.originMs === 'number' ? opts.originMs : Date.now()
  const tCreated = elapsedSince(originMs)
  const secrets = secretList(opts.apiKey, opts.scrub)
  const idle = (): SearchClock => ({ t_created: tCreated, t_start: tCreated, t_headers: tCreated, t_end: tCreated })
  const blank = (): GeminiGroundedResult => ({
    text: '',
    chunks: [],
    searchCount: 0,
    hasSearchEntryPoint: false,
    usage: emptyUsage(),
    attempts: 0,
    clock: idle(),
  })
  if (!opts.apiKey.trim()) return { ...blank(), miss: { class: 'missing_key' } }
  const timeoutMs = searchTimeoutMs(opts.timeoutMs)
  if (timeoutMs === 0 || opts.signal?.aborted) {
    return {
      ...blank(),
      attempts: 1,
      clock: { t_created: tCreated, t_start: tCreated, t_headers: null, t_end: elapsedSince(originMs) },
      miss: { class: 'timeout' },
    }
  }
  const model = resolveGeminiModel(opts.model)
  const question = scrubKeys(opts.question, secrets)
  const timed = engineAbort(timeoutMs, opts.signal)
  try {
    const allowThinking = !groundedThinkingRejected
    const firstBody = geminiGroundedBody(model, question, allowThinking)
    const thinking = firstBody.generationConfig.thinkingConfig
    const sentThinkingLevel = !!thinking && 'thinkingLevel' in thinking
    const post = (body: ReturnType<typeof geminiGroundedBody>) =>
      timedFetch({
        originMs,
        tCreated,
        url: geminiGenerateUrl(model),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': opts.apiKey.trim(),
        },
        body: JSON.stringify(body),
        signal: timed.signal,
      })
    let attempts = 1
    let sent = await post(firstBody)
    if (sent.response && !sent.response.ok && sent.response.status === 400 && sentThinkingLevel) {
      groundedThinkingRejected = true
      await dropBody(sent.response)
      const firstClock = sent.clock
      const next = await post(geminiGroundedBody(model, question, false))
      attempts = 2
      sent = {
        ...next,
        clock: { ...next.clock, t_created: firstClock.t_created, t_start: firstClock.t_start },
      }
    }
    if (sent.miss || !sent.response) {
      return { ...blank(), attempts, clock: sent.clock, miss: sent.miss ?? { class: 'timeout' } }
    }
    if (!sent.response.ok) {
      const status = sent.response.status
      await dropBody(sent.response)
      return {
        ...blank(),
        attempts,
        clock: finishClock(sent.clock, originMs),
        miss: { class: 'http_reject', status },
      }
    }
    const payload = await readJson(sent.response)
    const clock = finishClock(sent.clock, originMs)
    const parsed = payload === null ? null : groundingFromGeminiPayload(payload)
    if (!parsed) return { ...blank(), attempts, clock, miss: { class: 'bad_json' } }
    const text = scrubKeys(parsed.text, secrets)
    const chunks = parsed.chunks.map((chunk) => scrubChunk(chunk, secrets))
    if (!text) {
      return {
        ...blank(),
        attempts,
        clock,
        chunks,
        usage: parsed.usage,
        searchCount: parsed.searchCount,
        hasSearchEntryPoint: parsed.hasSearchEntryPoint,
        miss: { class: 'empty' },
      }
    }
    return {
      text,
      chunks,
      searchCount: parsed.searchCount,
      hasSearchEntryPoint: parsed.hasSearchEntryPoint,
      usage: parsed.usage,
      attempts,
      clock,
    }
  } finally {
    timed.done()
  }
}

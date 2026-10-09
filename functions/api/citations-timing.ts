/**
 * TEMPORARY preview probe. DELETE before launch. Not part of the product UI.
 *
 * GET /api/citations-timing?cap=0..6&domain=...&n=12&order=last|first
 * Header: `x-probe-token: <PROBE_TOKEN>`
 *
 * 404 when `CF_PAGES_BRANCH` is `main` or unset, when `PROBE_TOKEN` is unset
 * or blank, or when the header does not match. The token is never echoed.
 * There is no `CITATIONS_TIMING_PROBE` flag.
 *
 * Measures a signed-in Run again plus searched answers under Cloudflare Pages'
 * 6 simultaneous outbound connections. Gemini grounding is always on here
 * (the worst case). This route does not read `CITATIONS_GEMINI` and does not
 * change mention %, the plain engine blocks, or any production route.
 *
 * Start order matches full-report Run again for the existing engines: Gemini
 * chunks (at most two), then Claude chunks (at most four), then the plain
 * ChatGPT batch. Those three overlap. Run again also awaits a homepage excerpt
 * before ChatGPT; this probe skips that fetch. ChatGPT keeps its 22s timeout.
 * Gemini, Claude, both searched calls, and the Supabase select keep the 8s cap.
 * `cap=0` runs no searched calls: a baseline of today's Run again.
 *
 * Every outbound fetch goes through one 6-slot limiter (`functions/lib/slots.ts`).
 * `t_queued` is when the call asked for a slot. `t_slot` is when it got one.
 * That call's AbortController starts at `t_slot`, not while it is waiting.
 * `queue_ms` is `t_slot - t_queued`. `run_ms` is `t_end - t_slot`.
 * `late_start` is `queue_ms > 2000`. The slot is released in a `finally` block
 * after the body is read or `body.cancel()` runs.
 *
 * `order=last` (default) asks for slots for the existing engines first, so the
 * plain blocks are ahead of the searched calls. `order=first` asks for the
 * searched calls first. A Supabase `checks` select asks only after the model
 * calls, and only when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both set.
 *
 * Stamps are milliseconds since this request started. `t_start` is when `fetch`
 * is invoked. `t_headers` is when response headers arrive.
 * `totals.maxRunMs` is the longest engine `run_ms`. `totals.over8sFromSlot`
 * counts engine rows with `run_ms > 8000`. `totals.plainLateStarts` counts plain
 * rows with `late_start`. `totals.plainTimeouts` counts plain rows whose miss
 * is `timeout`. `totals.wallMs` is the model-call wall. Totals omit the select.
 */

import { FULL_REPORT_SYSTEM_PROMPT } from '../../src/fullReport.ts'
import { ownedAnswerPrompt } from '../../src/ownedQuestions.ts'
import {
  CLAUDE_MODEL_FALLBACK,
  CLAUDE_TIMEOUT_CAP_MS,
  claudeApiKeyFromEnv,
  claudeMessageBody,
  claudeModelFromEnv,
  claudeModelNotFound,
  claudeQuestionChunks,
} from './claude.ts'
import { canonicalHostname } from './homepage.ts'
import { json, scrubSecret } from './http.ts'
import { OUTBOUND_SLOT_LIMIT, cancelResponseBody, createOutboundSlots, type HeldSlot } from '../lib/slots.ts'
import {
  SEARCH_TIMEOUT_MS,
  clockTotalMs,
  clockWaitingMs,
  elapsedSince,
  geminiGrounded,
  chatgptSearchModelFromEnv,
  chatgptWebSearch,
  timedFetch,
  type SearchClock,
  type SearchMiss,
} from './searched.ts'
import { sbConfig, serviceHeaders } from './supabaseAuth.ts'
import {
  GEMINI_TIMEOUT_CAP_MS,
  geminiAnswerPrompt,
  geminiApiKeyFromEnv,
  geminiChunkMaxOutputTokens,
  geminiChunkSize,
  geminiGenerateUrl,
  geminiGenerationConfig,
  geminiModelFromEnv,
  geminiQuestionChunks,
} from './visibility.ts'

const CHATGPT_BATCH_TIMEOUT_MS = 22_000
const CHATGPT_BATCH_MODEL = 'gpt-4o-mini'
const CHATGPT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const TEXT_PREVIEW = 80

const QUESTION_BANK = [
  'What software should a B2B team use to track work across the week?',
  'Which platforms help a small company manage inbound customer requests?',
  'What do teams use to keep product issues and feedback in one place?',
  'Which tools help a revenue team see pipeline without a spreadsheet?',
  'What should a company use to onboard new employees without a shared inbox?',
  'Which products help a support team answer the same questions once?',
  'What do operations teams use to hand work between departments?',
  'Which systems help a finance team collect approvals before a purchase?',
  'What should a growing team use to document how work gets done?',
  'Which tools help a success team notice when a customer goes quiet?',
  'What do companies use to schedule meetings without a long email thread?',
  'Which platforms help a marketing team see which campaigns get replies?',
] as const

export const PROBE_QUESTION_BANK = QUESTION_BANK

type ProbeEnv = {
  CF_PAGES_BRANCH?: string
  PROBE_TOKEN?: string
  OPENAI_API_KEY?: string
  GEMINI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  CHATGPT_SEARCH_MODEL?: string
  GEMINI_MODEL?: string
  CLAUDE_MODEL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export type ProbeRow = {
  engine: string
  kind: string
  index: number
  t_created: number
  t_queued: number
  t_slot: number
  t_start: number
  t_headers: number | null
  t_end: number
  ms_total: number
  ms_waiting_estimate: number
  /** `t_slot - t_queued`. Time waiting for a limiter slot, before fetch. */
  queue_ms: number
  /** `t_end - t_slot`. Includes the fetch and the body read or cancel. */
  run_ms: number
  /** `queue_ms > 2000`. Wait inside fetch is not included. */
  late_start: boolean
  status: number | null
  miss: string | null
  tokensIn: number
  tokensOut: number
  searchCount: number
  citationCount: number
  attempts: number
  text?: string
  hasSearchEntryPoint?: boolean
}

/** Open only on a named preview branch. Production (`main`) and an unset branch stay closed. */
export function citationsProbeBranchOpen(env: { CF_PAGES_BRANCH?: string } | undefined): boolean {
  const branch = typeof env?.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH.trim() : ''
  return branch !== '' && branch !== 'main'
}

export function probeTokenFromEnv(env: { PROBE_TOKEN?: string } | undefined): string {
  const raw = env?.PROBE_TOKEN
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Constant-time compare. A length mismatch still walks every byte of the
 * longer input and does not throw. The token is not included in the result.
 */
export function probeTokensEqual(expected: string, provided: string): boolean {
  const enc = new TextEncoder()
  const a = enc.encode(expected)
  const bounded = provided.length > 4096 ? provided.slice(0, 4096) : provided
  const b = enc.encode(bounded)
  let mismatch = a.length === b.length ? 0 : 1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return mismatch === 0
}

/** Generic B2B SaaS buyer questions. Unbranded: the domain string is not inserted. */
export function probeQuestions(count: number): string[] {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const base = QUESTION_BANK[i % QUESTION_BANK.length] ?? QUESTION_BANK[0]
    const cycle = Math.floor(i / QUESTION_BANK.length)
    out.push(cycle === 0 ? base : `${base} Follow-up ${cycle + 1}.`)
  }
  return out
}

export function probeLogLine(row: ProbeRow): string {
  const status = row.miss === 'http_reject' && row.status !== null ? `http_reject ${row.status}` : row.miss ?? String(row.status ?? '-')
  return `citations-timing ${row.engine} ${row.kind} ${row.index} ${status} ${row.ms_total}ms wait=${row.ms_waiting_estimate} in=${row.tokensIn} out=${row.tokensOut} searches=${row.searchCount} citations=${row.citationCount}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function scrubKeys(value: string, keys: readonly string[]): string {
  return keys.reduce((out, key) => (key ? scrubSecret(out, key) : out), value)
}

function previewText(value: string, secrets: readonly string[]): string {
  return scrubKeys(value, secrets).replace(/\s+/g, ' ').trim().slice(0, TEXT_PREVIEW)
}

function tokenCount(record: Record<string, unknown> | null, keys: readonly string[]): number {
  if (!record) return 0
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  }
  return 0
}

function withEnd(clock: SearchClock, originMs: number): SearchClock {
  return { ...clock, t_end: elapsedSince(originMs) }
}

async function discard(res: Response) {
  await cancelResponseBody(res)
}

function notFound(): Response {
  return json(404, { error: 'Not found' })
}

/** Searched-question cap. `0` skips searched calls. Otherwise 1 through 6. */
export function parseProbeCap(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 6) return null
  return n
}

function parseCount(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return 12
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 40) return null
  return n
}

function parseOrder(raw: string | null): 'first' | 'last' | null {
  if (raw === null || raw.trim() === '') return 'last'
  const value = raw.trim().toLowerCase()
  if (value === 'first' || value === 'last') return value
  return null
}

function statusOf(miss: SearchMiss | undefined): number | null {
  if (!miss) return 200
  if (miss.class === 'http_reject') return typeof miss.status === 'number' ? miss.status : null
  if (miss.class === 'missing_key' || miss.class === 'timeout') return null
  return 200
}

/** True when the call waited more than 2s for a slot. `t_slot - t_queued`. */
export function rowLateStart(tQueued: number, tSlot: number): boolean {
  return tSlot - tQueued > 2000
}

export function queueMs(tQueued: number, tSlot: number): number {
  return Math.max(0, tSlot - tQueued)
}

export function runMs(tSlot: number, tEnd: number): number {
  return Math.max(0, tEnd - tSlot)
}

function clockFields(
  clock: SearchClock,
  tQueued: number,
  tSlot: number,
): Pick<
  ProbeRow,
  | 't_created'
  | 't_queued'
  | 't_slot'
  | 't_start'
  | 't_headers'
  | 't_end'
  | 'ms_total'
  | 'ms_waiting_estimate'
  | 'queue_ms'
  | 'run_ms'
  | 'late_start'
> {
  return {
    t_created: clock.t_created,
    t_queued: tQueued,
    t_slot: tSlot,
    t_start: clock.t_start,
    t_headers: clock.t_headers,
    t_end: clock.t_end,
    ms_total: clockTotalMs(clock),
    ms_waiting_estimate: clockWaitingMs(clock),
    queue_ms: queueMs(tQueued, tSlot),
    run_ms: runMs(tSlot, clock.t_end),
    late_start: rowLateStart(tQueued, tSlot),
  }
}

function idleClock(originMs: number): SearchClock {
  const t = elapsedSince(originMs)
  return { t_created: t, t_start: t, t_headers: t, t_end: t }
}

function missedRow(engine: string, kind: string, index: number, originMs: number, miss: string): ProbeRow {
  const clock = idleClock(originMs)
  return {
    engine,
    kind,
    index,
    ...clockFields(clock, clock.t_created, clock.t_created),
    status: null,
    miss,
    tokensIn: 0,
    tokensOut: 0,
    searchCount: 0,
    citationCount: 0,
    attempts: 0,
  }
}

function textField(text: string, secrets: readonly string[]): { text?: string } {
  const preview = previewText(text, secrets)
  return preview ? { text: preview } : {}
}

type Picked = { text: string; tokensIn: number; tokensOut: number }

async function readOutcome(
  sent: { response: Response | null; clock: SearchClock; miss?: SearchMiss },
  originMs: number,
  secrets: readonly string[],
  pick: (payload: unknown) => Picked | null,
): Promise<{ status: number | null; miss: string | null; clock: SearchClock; text: string; tokensIn: number; tokensOut: number }> {
  if (sent.miss || !sent.response) {
    return { status: null, miss: 'timeout', clock: sent.clock, text: '', tokensIn: 0, tokensOut: 0 }
  }
  const response = sent.response
  let payload: unknown
  let unreadable = false
  try {
    if (response.ok) payload = await response.json()
  } catch {
    unreadable = true
  } finally {
    await discard(response)
  }
  const clock = withEnd(sent.clock, originMs)
  if (!response.ok) {
    return { status: response.status, miss: 'http_reject', clock, text: '', tokensIn: 0, tokensOut: 0 }
  }
  if (unreadable) {
    return { status: response.status, miss: 'bad_json', clock, text: '', tokensIn: 0, tokensOut: 0 }
  }
  const picked = pick(payload)
  if (!picked) return { status: response.status, miss: 'bad_json', clock, text: '', tokensIn: 0, tokensOut: 0 }
  const text = scrubKeys(picked.text, secrets)
  if (!text.trim()) {
    return { status: response.status, miss: 'empty', clock, text: '', tokensIn: picked.tokensIn, tokensOut: picked.tokensOut }
  }
  return { status: response.status, miss: null, clock, text, tokensIn: picked.tokensIn, tokensOut: picked.tokensOut }
}

function pickGemini(payload: unknown): Picked | null {
  if (!isRecord(payload)) return null
  const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : null
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  const first = isRecord(candidates[0]) ? candidates[0] : null
  const content = first && isRecord(first.content) ? first.content : null
  const parts = content && Array.isArray(content.parts) ? content.parts : []
  const text = parts
    .map((part) => {
      if (!isRecord(part) || part.thought === true) return ''
      return typeof part.text === 'string' ? part.text : ''
    })
    .join(' ')
  return {
    text,
    tokensIn: tokenCount(usage, ['promptTokenCount']),
    tokensOut: tokenCount(usage, ['candidatesTokenCount']),
  }
}

function pickClaude(payload: unknown): Picked | null {
  if (!isRecord(payload)) return null
  const usage = isRecord(payload.usage) ? payload.usage : null
  const content = Array.isArray(payload.content) ? payload.content : []
  const text = content
    .map((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return ''
      return block.text
    })
    .join(' ')
  return {
    text,
    tokensIn: tokenCount(usage, ['input_tokens']),
    tokensOut: tokenCount(usage, ['output_tokens']),
  }
}

function pickChat(payload: unknown): Picked | null {
  if (!isRecord(payload)) return null
  const usage = isRecord(payload.usage) ? payload.usage : null
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = isRecord(choices[0]) ? choices[0] : null
  const message = first && isRecord(first.message) ? first.message : null
  const text = message && typeof message.content === 'string' ? message.content : ''
  return {
    text,
    tokensIn: tokenCount(usage, ['prompt_tokens', 'input_tokens']),
    tokensOut: tokenCount(usage, ['completion_tokens', 'output_tokens']),
  }
}

function plainGeminiBody(model: string, prompt: string, questionCount: number, maxOutputTokens: number, allowThinkingLevel: boolean) {
  const generationConfig = geminiGenerationConfig(model, questionCount, { maxOutputTokens })
  const thinking = generationConfig.thinkingConfig
  const sentThinkingLevel = !!thinking && 'thinkingLevel' in thinking
  if (!allowThinkingLevel && sentThinkingLevel) {
    const rest = { ...generationConfig }
    delete rest.thinkingConfig
    return {
      sentThinkingLevel: false,
      body: { contents: [{ role: 'user' as const, parts: [{ text: prompt }] }], generationConfig: rest },
    }
  }
  return {
    sentThinkingLevel,
    body: { contents: [{ role: 'user' as const, parts: [{ text: prompt }] }], generationConfig },
  }
}

function chatgptBatches(questions: readonly string[]): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < questions.length; i += 20) batches.push(questions.slice(i, i + 20))
  return batches
}

export async function onRequest(context: { request: Request; env?: ProbeEnv }): Promise<Response> {
  const { request } = context
  const env = context.env
  const token = probeTokenFromEnv(env)
  if (!citationsProbeBranchOpen(env) || !token || !probeTokensEqual(token, request.headers.get('x-probe-token') ?? '')) {
    return notFound()
  }
  if (request.method !== 'GET') return json(405, { error: 'Use GET' })

  const url = new URL(request.url)
  const domain = canonicalHostname(url.searchParams.get('domain'))
  if (!domain) return json(400, { error: 'domain must be a simple public hostname' })
  const cap = parseProbeCap(url.searchParams.get('cap'))
  if (cap === null) return json(400, { error: 'cap must be an integer from 0 to 6' })
  const n = parseCount(url.searchParams.get('n'))
  if (!n) return json(400, { error: 'n must be an integer from 1 to 40' })
  const order = parseOrder(url.searchParams.get('order'))
  if (!order) return json(400, { error: 'order must be first or last' })

  const originMs = Date.now()
  const questions = probeQuestions(n)
  const searched = Math.min(cap, questions.length)
  const openaiKey = typeof env?.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : ''
  const geminiKey = geminiApiKeyFromEnv(env)
  const claudeKey = claudeApiKeyFromEnv(env)
  const searchModel = chatgptSearchModelFromEnv(env)
  const geminiModel = geminiModelFromEnv(env)
  const claudeModel = claudeModelFromEnv(env)
  const sb = sbConfig(env)
  const secrets = [token, openaiKey, geminiKey, claudeKey, sb?.serviceRole ?? ''].filter((secret) => secret !== '')
  const scrub = (value: string) => scrubKeys(value, secrets)

  let plainThinkingRejected = false
  let claudeUsesFallback = false
  const slots = createOutboundSlots(OUTBOUND_SLOT_LIMIT)
  const now = () => elapsedSince(originMs)
  const tasks: Promise<ProbeRow>[] = []
  const held = (clock: SearchClock, slot: HeldSlot) => clockFields(clock, slot.t_queued, slot.t_slot)

  const track = (work: Promise<ProbeRow>) => {
    tasks.push(
      work.then((row) => {
        console.info(probeLogLine(row))
        return row
      }),
    )
  }

  const timeGemini = (index: number, chunk: string[], maxOutputTokens: number) => {
    const tCreated = elapsedSince(originMs)
    if (!geminiKey) return Promise.resolve(missedRow('gemini', 'plain', index, originMs, 'missing_key'))
    const prompt = geminiAnswerPrompt(chunk.map(scrub))
    return slots.use({ timeoutMs: GEMINI_TIMEOUT_CAP_MS, now }, async (slot) => {
      const allow = !plainThinkingRejected
      const built = plainGeminiBody(geminiModel, prompt, chunk.length, maxOutputTokens, allow)
      const post = (body: unknown) =>
        timedFetch({
          originMs,
          tCreated,
          url: geminiGenerateUrl(geminiModel),
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify(body),
          signal: slot.signal,
        })
      let attempts = 1
      let sent = await post(built.body)
      if (sent.response && !sent.response.ok && sent.response.status === 400 && built.sentThinkingLevel) {
        plainThinkingRejected = true
        await discard(sent.response)
        const first = sent.clock
        const nextBody = plainGeminiBody(geminiModel, prompt, chunk.length, maxOutputTokens, false)
        const next = await post(nextBody.body)
        attempts = 2
        sent = { ...next, clock: { ...next.clock, t_created: first.t_created, t_start: first.t_start } }
      }
      const outcome = await readOutcome(sent, originMs, secrets, pickGemini)
      return {
        engine: 'gemini',
        kind: 'plain',
        index,
        ...held(outcome.clock, slot),
        status: outcome.status,
        miss: outcome.miss,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        searchCount: 0,
        citationCount: 0,
        attempts,
        ...textField(outcome.text, secrets),
      }
    })
  }

  const timeClaude = (index: number, chunk: string[], shape: 'single' | 'chunk') => {
    const tCreated = elapsedSince(originMs)
    if (!claudeKey) return Promise.resolve(missedRow('claude', 'plain', index, originMs, 'missing_key'))
    const prompt = geminiAnswerPrompt(chunk.map(scrub))
    return slots.use({ timeoutMs: CLAUDE_TIMEOUT_CAP_MS, now }, async (slot) => {
      const post = (model: string) =>
        timedFetch({
          originMs,
          tCreated,
          url: CLAUDE_URL,
          method: 'POST',
          headers: {
            'x-api-key': claudeKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(claudeMessageBody(model, prompt, chunk.length, shape)),
          signal: slot.signal,
        })
      let model = claudeUsesFallback && claudeModel !== CLAUDE_MODEL_FALLBACK ? CLAUDE_MODEL_FALLBACK : claudeModel
      let attempts = 1
      let sent = await post(model)
      if (
        sent.response &&
        !sent.response.ok &&
        model !== CLAUDE_MODEL_FALLBACK &&
        (await claudeModelNotFound(sent.response))
      ) {
        claudeUsesFallback = true
        await discard(sent.response)
        const first = sent.clock
        model = CLAUDE_MODEL_FALLBACK
        const next = await post(model)
        attempts = 2
        sent = { ...next, clock: { ...next.clock, t_created: first.t_created, t_start: first.t_start } }
      }
      const outcome = await readOutcome(sent, originMs, secrets, pickClaude)
      return {
        engine: 'claude',
        kind: 'plain',
        index,
        ...held(outcome.clock, slot),
        status: outcome.status,
        miss: outcome.miss,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        searchCount: 0,
        citationCount: 0,
        attempts,
        ...textField(outcome.text, secrets),
      }
    })
  }

  const timeChatBatch = (index: number, batch: string[]) => {
    const tCreated = elapsedSince(originMs)
    if (!openaiKey) return Promise.resolve(missedRow('chatgpt', 'plain', index, originMs, 'missing_key'))
    const prompt = ownedAnswerPrompt(
      domain,
      [{ id: 'problems', title: 'Problems you solve', questions: batch.map(scrub) }],
      null,
    )
    return slots.use({ timeoutMs: CHATGPT_BATCH_TIMEOUT_MS, now }, async (slot) => {
      const sent = await timedFetch({
        originMs,
        tCreated,
        url: CHATGPT_COMPLETIONS_URL,
        method: 'POST',
        headers: {
          authorization: `Bearer ${openaiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: CHATGPT_BATCH_MODEL,
          temperature: 0.3,
          max_tokens: Math.min(4500, 350 + batch.length * 130),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: FULL_REPORT_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
        signal: slot.signal,
      })
      const outcome = await readOutcome(sent, originMs, secrets, pickChat)
      return {
        engine: 'chatgpt',
        kind: 'plain',
        index,
        ...held(outcome.clock, slot),
        status: outcome.status,
        miss: outcome.miss,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        searchCount: 0,
        citationCount: 0,
        attempts: 1,
        ...textField(outcome.text, secrets),
      }
    })
  }

  const timeSearch = (index: number, question: string) => {
    const tCreated = elapsedSince(originMs)
    if (!openaiKey) return Promise.resolve(missedRow('chatgpt', 'search', index, originMs, 'missing_key'))
    return slots.use({ timeoutMs: SEARCH_TIMEOUT_MS, now }, async (slot) => {
      const result = await chatgptWebSearch({
        apiKey: openaiKey,
        model: searchModel,
        question,
        domain,
        originMs,
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: slot.signal,
        scrub: secrets,
      })
      return {
        engine: 'chatgpt',
        kind: 'search',
        index,
        ...held({ ...result.clock, t_created: tCreated }, slot),
        status: statusOf(result.miss),
        miss: result.miss?.class ?? null,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        searchCount: result.searchCount,
        citationCount: result.citations.length,
        attempts: result.attempts,
        ...textField(result.text, secrets),
      }
    })
  }

  const timeGrounded = (index: number, question: string) => {
    const tCreated = elapsedSince(originMs)
    if (!geminiKey) return Promise.resolve(missedRow('gemini', 'grounded', index, originMs, 'missing_key'))
    return slots.use({ timeoutMs: SEARCH_TIMEOUT_MS, now }, async (slot) => {
      const result = await geminiGrounded({
        apiKey: geminiKey,
        model: geminiModel,
        question,
        originMs,
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: slot.signal,
        scrub: secrets,
      })
      return {
        engine: 'gemini',
        kind: 'grounded',
        index,
        ...held({ ...result.clock, t_created: tCreated }, slot),
        status: statusOf(result.miss),
        miss: result.miss?.class ?? null,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        searchCount: result.searchCount,
        citationCount: result.chunks.length,
        attempts: result.attempts,
        hasSearchEntryPoint: result.hasSearchEntryPoint,
        ...textField(result.text, secrets),
      }
    })
  }

  const startSearched = () => {
    for (let index = 0; index < searched; index++) track(timeSearch(index, questions[index] ?? ''))
    for (let index = 0; index < searched; index++) track(timeGrounded(index, questions[index] ?? ''))
  }

  const startExisting = () => {
    const maxOutputTokens = geminiChunkMaxOutputTokens(geminiChunkSize(questions.length))
    geminiQuestionChunks(questions).forEach((chunk, index) => {
      track(timeGemini(index, chunk, maxOutputTokens))
    })
    if (questions.length === 1) {
      track(timeClaude(0, questions, 'single'))
    } else {
      claudeQuestionChunks(questions).forEach((chunk, index) => {
        track(timeClaude(index, chunk, 'chunk'))
      })
    }
    chatgptBatches(questions).forEach((batch, index) => {
      track(timeChatBatch(index, batch))
    })
  }

  try {
    if (order === 'first') startSearched()
    startExisting()
    if (order === 'last') startSearched()
    const calls = await Promise.all(tasks)
    const wallMs = elapsedSince(originMs)

    let supabaseMs: number | undefined
    if (sb) {
      const tCreated = elapsedSince(originMs)
      const row = await slots.use({ timeoutMs: GEMINI_TIMEOUT_CAP_MS, now }, async (slot) => {
        const sent = await timedFetch({
          originMs,
          tCreated,
          url: `${sb.url}/rest/v1/checks?select=id&limit=1`,
          method: 'GET',
          headers: serviceHeaders(sb.serviceRole),
          signal: slot.signal,
        })
        const outcome = await readOutcome(sent, originMs, secrets, (payload) => (Array.isArray(payload) || isRecord(payload) ? { text: '', tokensIn: 0, tokensOut: 0 } : null))
        const built: ProbeRow = {
          engine: 'supabase',
          kind: 'select',
          index: 0,
          ...held(outcome.clock, slot),
          status: outcome.status,
          miss: outcome.miss === 'empty' ? null : outcome.miss,
          tokensIn: 0,
          tokensOut: 0,
          searchCount: 0,
          citationCount: 0,
          attempts: 1,
        }
        return built
      })
      console.info(probeLogLine(row))
      calls.push(row)
      supabaseMs = row.ms_total
    }

    const engineCalls = calls.filter((row) => row.engine !== 'supabase')
    const misses = { missing_key: 0, http_reject: 0, timeout: 0, bad_json: 0, empty: 0 }
    const missingKeys: string[] = []
    let maxRunMs = 0
    let over8sFromSlot = 0
    let totalSearches = 0
    let plainLateStarts = 0
    let plainTimeouts = 0
    for (const row of engineCalls) {
      totalSearches += row.searchCount
      if (row.run_ms > maxRunMs) maxRunMs = row.run_ms
      if (row.run_ms > GEMINI_TIMEOUT_CAP_MS) over8sFromSlot += 1
      if (row.kind === 'plain' && row.late_start) plainLateStarts += 1
      if (row.kind === 'plain' && row.miss === 'timeout') plainTimeouts += 1
      if (row.miss && row.miss in misses) misses[row.miss as keyof typeof misses] += 1
      if (row.miss !== 'missing_key') continue
      const name =
        row.engine === 'chatgpt' ? 'OPENAI_API_KEY' : row.engine === 'gemini' ? 'GEMINI_API_KEY' : row.engine === 'claude' ? 'ANTHROPIC_API_KEY' : ''
      if (name && !missingKeys.includes(name)) missingKeys.push(name)
    }

    const note =
      order === 'last'
        ? 'A 6-slot limiter wraps every outbound fetch, and the timeout starts when a slot is granted. Existing engines ask first: Gemini chunks, then Claude chunks, then the ChatGPT batch. Searched calls ask after those. Cap 0 skips searched calls. The homepage excerpt is not fetched. A Supabase select, when the service role is set, asks after the model calls. totals omit that select.'
        : 'A 6-slot limiter wraps every outbound fetch, and the timeout starts when a slot is granted. Searched calls ask first, then Gemini chunks, Claude chunks, and the ChatGPT batch. Cap 0 skips searched calls. The homepage excerpt is not fetched. A Supabase select, when the service role is set, asks after the model calls. totals omit that select.'

    const body: Record<string, unknown> = {
      ok: true,
      cap,
      n: questions.length,
      searched,
      domain,
      order,
      branch: typeof env?.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH.trim() : '',
      note,
      models: {
        chatgpt: CHATGPT_BATCH_MODEL,
        chatgptSearch: searchModel,
        gemini: geminiModel,
        claude: claudeModel,
      },
      timeouts: { chatgptMs: CHATGPT_BATCH_TIMEOUT_MS, engineMs: GEMINI_TIMEOUT_CAP_MS },
      calls,
      totals: { wallMs, maxRunMs, over8sFromSlot, misses, totalSearches, plainLateStarts, plainTimeouts },
      ...(supabaseMs !== undefined ? { supabaseMs } : {}),
      ...(missingKeys.length > 0 ? { missing_keys: missingKeys } : {}),
    }
    const encoded = JSON.stringify(body)
    if (secrets.some((secret) => secret.length >= 8 && encoded.includes(secret))) {
      return json(500, { error: 'Could not build the timing probe.' })
    }
    return new Response(encoded, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch {
    return json(500, { error: 'Could not build the timing probe.' })
  }
}

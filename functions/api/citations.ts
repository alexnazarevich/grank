/**
 * Citations for a signed-in full report and Run test.
 * ChatGPT web search always runs for the capped unbranded questions.
 * Gemini grounding runs only when CITATIONS_GEMINI is exactly `on`.
 * Each source is {engine, url, domain, title} on the question inside the saved check.
 */

import {
  CITATIONS_CAP,
  citationMetaFor,
  citationsGeminiEnabled,
  sourceFromUrl,
  stripGeminiFromStored,
} from '../../src/citations.ts'
import {
  unbrandedQuestionTexts,
  type FullReportTheme,
  type QuestionSearch,
} from '../../src/fullReport.ts'
import { createOutboundSlots, type OutboundSlots } from '../lib/slots.ts'
import { chatgptSearchModelFromEnv, chatgptWebSearch, geminiGrounded, type SearchMiss } from './searched.ts'
import { geminiApiKeyFromEnv, geminiModelFromEnv } from './visibility.ts'
import { serviceHeaders } from './supabaseAuth.ts'

const SEARCH_TIMEOUT_MS = 8_000

export { CITATIONS_CAP, citationMetaFor, citationsGeminiEnabled, createOutboundSlots }
export type { OutboundSlots }

type CitationEnv = {
  CITATIONS_GEMINI?: string
  OPENAI_API_KEY?: string
  GEMINI_API_KEY?: string
  CHATGPT_SEARCH_MODEL?: string
  GEMINI_MODEL?: string
}

function missOf(miss: SearchMiss | undefined): QuestionSearch['miss'] {
  if (!miss) return undefined
  return miss.status === undefined ? { class: miss.class } : { class: miss.class, status: miss.status }
}

function sourcesFromChatGpt(citations: { url: string; title: string }[]): QuestionSearch['sources'] {
  const sources: QuestionSearch['sources'] = []
  for (const citation of citations) {
    const source = sourceFromUrl(citation.url, citation.title, 'chatgpt')
    if (source) sources.push(source)
  }
  return sources
}

function sourcesFromGrounding(chunks: { uri: string; title: string }[]): QuestionSearch['sources'] {
  const sources: QuestionSearch['sources'] = []
  for (const chunk of chunks) {
    const source = sourceFromUrl(chunk.uri, chunk.title, 'gemini')
    if (source) sources.push(source)
  }
  return sources
}

export async function searchOneQuestion(opts: {
  question: string
  domain: string
  env: CitationEnv | undefined
  slots: OutboundSlots
  scrub: string[]
  gemini: boolean
  apiKey: string
}): Promise<QuestionSearch[]> {
  const geminiKey = opts.gemini ? geminiApiKeyFromEnv(opts.env) : ''
  const chatgpt = opts.slots.use({ timeoutMs: SEARCH_TIMEOUT_MS, now: () => Date.now() }, (slot) =>
    chatgptWebSearch({
      apiKey: opts.apiKey,
      model: chatgptSearchModelFromEnv(opts.env),
      question: opts.question,
      domain: opts.domain,
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: slot.signal,
      scrub: opts.scrub,
    }),
  )
  const grounded = opts.gemini
    ? opts.slots.use({ timeoutMs: SEARCH_TIMEOUT_MS, now: () => Date.now() }, (slot) =>
        geminiGrounded({
          apiKey: geminiKey,
          model: geminiModelFromEnv(opts.env),
          question: opts.question,
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal: slot.signal,
          scrub: opts.scrub,
        }),
      )
    : null
  const [chat, gem] = await Promise.all([chatgpt, grounded])
  const searches: QuestionSearch[] = [
    {
      engine: 'chatgpt',
      text: chat.miss ? '' : chat.text,
      sources: sourcesFromChatGpt(chat.citations),
      ...(missOf(chat.miss) ? { miss: missOf(chat.miss) } : {}),
    },
  ]
  if (gem) {
    const renderedContent = gem.suggestionsHtml.trim() ? gem.suggestionsHtml : undefined
    searches.push({
      engine: 'gemini',
      text: gem.miss ? '' : gem.text,
      sources: sourcesFromGrounding(gem.chunks),
      ...(missOf(gem.miss) ? { miss: missOf(gem.miss) } : {}),
      ...(renderedContent ? { renderedContent } : {}),
    })
  }
  return searches
}

export function cappedQuestions(themes: readonly FullReportTheme[]): string[] {
  return unbrandedQuestionTexts(themes).slice(0, CITATIONS_CAP)
}

export async function searchQuestionList(opts: {
  questions: readonly string[]
  domain: string
  env: CitationEnv | undefined
  slots: OutboundSlots
  scrub: string[]
  apiKey: string
}): Promise<Map<string, QuestionSearch[]>> {
  const gemini = citationsGeminiEnabled(opts.env)
  const pairs = await Promise.all(
    opts.questions.map(async (question) => {
      const searches = await searchOneQuestion({ ...opts, question, gemini })
      return [question.toLowerCase(), searches] as const
    }),
  )
  return new Map(pairs)
}

export function attachSearches(themes: FullReportTheme[], found: Map<string, QuestionSearch[]>): FullReportTheme[] {
  return themes.map((theme) => ({
    ...theme,
    questions: theme.questions.map((item) => {
      if (item.framing !== 'unbranded') return item
      const searches = found.get(item.question.toLowerCase())
      if (!searches) return item
      return { ...item, searches }
    }),
  }))
}

export type PurgeResult = { rows: number; sources: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Gemini citation sources stored on a check. `present` is a Gemini search, source, or searched count. */
export function geminiCitationBurden(result: unknown): { sources: number; present: boolean } {
  let sources = 0
  let present = false
  if (!isRecord(result) || !isRecord(result.fullReport)) return { sources, present }
  const full = result.fullReport
  const themes = Array.isArray(full.themes) ? full.themes : []
  for (const theme of themes) {
    if (!isRecord(theme) || !Array.isArray(theme.questions)) continue
    for (const item of theme.questions) {
      if (!isRecord(item)) continue
      if (typeof item.renderedContent === 'string' && item.renderedContent.trim()) present = true
      if (!Array.isArray(item.searches)) continue
      for (const search of item.searches) {
        if (!isRecord(search)) continue
        if (search.engine === 'gemini') present = true
        const html = search.renderedContent ?? search.suggestionsHtml
        if (search.engine === 'gemini' && typeof html === 'string' && html.trim()) present = true
        const list = Array.isArray(search.sources) ? search.sources : []
        for (const source of list) {
          if (!isRecord(source)) continue
          const engine = source.engine === 'chatgpt' || source.engine === 'gemini' ? source.engine : search.engine
          if (engine === 'gemini') {
            present = true
            sources += 1
          }
        }
      }
    }
  }
  if (isRecord(full.citations) && isRecord(full.citations.searched) && 'gemini' in full.citations.searched) present = true
  return { sources, present }
}

/**
 * Remove Gemini sources and Search Suggestions from saved checks.
 * Pages through checks and PATCH only rows that still contain them.
 * A second call changes nothing.
 */
export async function purgeGeminiCitations(env: {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}): Promise<PurgeResult> {
  const url = env.SUPABASE_URL?.trim().replace(/\/$/, '') || ''
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ''
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  let rows = 0
  let sources = 0
  let offset = 0
  const page = 200
  for (;;) {
    const res = await fetch(
      `${url}/rest/v1/checks?select=id,result&order=created_at.asc&limit=${page}&offset=${offset}`,
      { headers: serviceHeaders(key) },
    )
    if (!res.ok) throw new Error(`checks read failed: HTTP ${res.status}`)
    const list = (await res.json().catch(() => [])) as { id?: string; result?: unknown }[]
    if (!Array.isArray(list) || list.length === 0) break
    for (const row of list) {
      if (!row || typeof row.id !== 'string' || !row.result || !geminiCitationBurden(row.result).present) continue
      const removed = geminiCitationBurden(row.result).sources
      const next = stripGeminiFromStored(row.result)
      if (JSON.stringify(next) === JSON.stringify(row.result)) continue
      const patched = await fetch(`${url}/rest/v1/checks?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: serviceHeaders(key, 'return=minimal'),
        body: JSON.stringify({ result: next }),
      })
      if (!patched.ok) throw new Error(`checks update failed: HTTP ${patched.status}`)
      rows += 1
      sources += removed
    }
    if (list.length < page) break
    offset += list.length
  }
  return { rows, sources }
}

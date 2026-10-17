/**
 * Citations for a signed-in full report and Run test.
 * ChatGPT web search always runs for the capped unbranded questions.
 * Gemini grounding runs only when CITATIONS_GEMINI is exactly `on`.
 * Sources use one shape: engine, url, domain, title, question, run id.
 */

import {
  CITATIONS_CAP,
  citationDomain,
  citationsGeminiEnabled,
  sourceFromUrl,
  stripGeminiFromStored,
} from '../../src/citations.ts'
import {
  unbrandedQuestionTexts,
  type CitationEngine,
  type FullReportTheme,
  type QuestionSearch,
} from '../../src/fullReport.ts'
import { createOutboundSlots, type OutboundSlots } from '../lib/slots.ts'
import { chatgptSearchModelFromEnv, chatgptWebSearch, geminiGrounded, type SearchMiss } from './searched.ts'
import { geminiApiKeyFromEnv, geminiModelFromEnv } from './visibility.ts'
import { sbFetch, serviceHeaders, type ServiceDb } from './supabaseAuth.ts'

const SEARCH_TIMEOUT_MS = 8_000

export { CITATIONS_CAP, citationsGeminiEnabled, createOutboundSlots }
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
    const source = sourceFromUrl(citation.url, citation.title)
    if (source) sources.push(source)
  }
  return sources
}

function sourcesFromGrounding(chunks: { uri: string; title: string }[]): QuestionSearch['sources'] {
  const sources: QuestionSearch['sources'] = []
  for (const chunk of chunks) {
    const source = sourceFromUrl(chunk.uri, chunk.title)
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
    const suggestions = gem.suggestionsHtml.trim() ? gem.suggestionsHtml : undefined
    searches.push({
      engine: 'gemini',
      text: gem.miss ? '' : gem.text,
      sources: sourcesFromGrounding(gem.chunks),
      ...(missOf(gem.miss) ? { miss: missOf(gem.miss) } : {}),
      ...(suggestions ? { suggestionsHtml: suggestions } : {}),
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

type SourceRow = {
  user_id: string
  run_id: string
  question: string
  engine: CitationEngine
  url: string
  domain: string
  title: string
}

type SuggestionRow = {
  user_id: string
  run_id: string
  question: string
  engine: CitationEngine
  rendered_content: string
}

function rowsFromThemes(userId: string, runId: string, themes: readonly FullReportTheme[]): {
  sources: SourceRow[]
  suggestions: SuggestionRow[]
} {
  const sources: SourceRow[] = []
  const suggestions: SuggestionRow[] = []
  for (const theme of themes) {
    for (const item of theme.questions) {
      for (const search of item.searches ?? []) {
        for (const source of search.sources) {
          if (!source.url || !citationDomain(source.url)) continue
          sources.push({
            user_id: userId,
            run_id: runId,
            question: item.question,
            engine: search.engine,
            url: source.url,
            domain: source.domain,
            title: source.title,
          })
        }
        if (search.suggestionsHtml && search.suggestionsHtml.trim()) {
          suggestions.push({
            user_id: userId,
            run_id: runId,
            question: item.question,
            engine: search.engine,
            rendered_content: search.suggestionsHtml,
          })
        }
      }
    }
  }
  return { sources, suggestions }
}

async function sbSlot(slots: OutboundSlots, sb: ServiceDb, path: string, init: RequestInit): Promise<Response | null> {
  try {
    return await sbFetch(sb, path, init, slots)
  } catch {
    return null
  }
}

/** Replace this run's source rows. A failed write does not fail the report. */
export async function saveCitationRows(
  sb: ServiceDb,
  slots: OutboundSlots,
  userId: string,
  runId: string,
  themes: readonly FullReportTheme[],
): Promise<void> {
  const { sources, suggestions } = rowsFromThemes(userId, runId, themes)
  await sbSlot(slots, sb, `/rest/v1/citation_sources?run_id=eq.${runId}`, {
    method: 'DELETE',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
  })
  await sbSlot(slots, sb, `/rest/v1/citation_suggestions?run_id=eq.${runId}`, {
    method: 'DELETE',
    headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
  })
  if (sources.length > 0) {
    await sbSlot(slots, sb, '/rest/v1/citation_sources', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      body: JSON.stringify(sources),
    })
  }
  if (suggestions.length > 0) {
    await sbSlot(slots, sb, '/rest/v1/citation_suggestions', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      body: JSON.stringify(suggestions),
    })
  }
}

export type PurgeResult = { sources: number; suggestions: number }

function rowCount(payload: unknown): number {
  return Array.isArray(payload) ? payload.length : 0
}

/**
 * Delete every Gemini source and stored Search Suggestions.
 * A second call deletes nothing. Also strips Gemini searches from saved checks
 * so a later read cannot show them.
 */
export async function purgeGeminiCitations(env: {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}): Promise<PurgeResult> {
  const url = env.SUPABASE_URL?.trim().replace(/\/$/, '') || ''
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ''
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  const headers = serviceHeaders(key, 'return=representation')
  const sourcesRes = await fetch(`${url}/rest/v1/citation_sources?engine=eq.gemini`, { method: 'DELETE', headers })
  if (!sourcesRes.ok) throw new Error(`citation_sources delete failed: HTTP ${sourcesRes.status}`)
  const sources = rowCount(await sourcesRes.json().catch(() => []))
  const suggestionsRes = await fetch(`${url}/rest/v1/citation_suggestions?engine=eq.gemini`, {
    method: 'DELETE',
    headers,
  })
  if (!suggestionsRes.ok) throw new Error(`citation_suggestions delete failed: HTTP ${suggestionsRes.status}`)
  const suggestions = rowCount(await suggestionsRes.json().catch(() => []))
  await stripStoredGemini(url, key)
  return { sources, suggestions }
}

async function stripStoredGemini(url: string, key: string): Promise<void> {
  const headers = serviceHeaders(key)
  let offset = 0
  for (;;) {
    const res = await fetch(
      `${url}/rest/v1/checks?select=id,result&order=created_at.asc&limit=200&offset=${offset}`,
      { headers },
    )
    if (!res.ok) return
    const rows = (await res.json().catch(() => [])) as { id?: string; result?: unknown }[]
    if (!Array.isArray(rows) || rows.length === 0) return
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.result) continue
      const next = stripGeminiFromStored(row.result)
      if (JSON.stringify(next) === JSON.stringify(row.result)) continue
      await fetch(`${url}/rest/v1/checks?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: serviceHeaders(key, 'return=minimal'),
        body: JSON.stringify({ result: next }),
      })
    }
    if (rows.length < 200) return
    offset += rows.length
  }
}

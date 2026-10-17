/**
 * Citations tab model. One source shape for every engine.
 * ChatGPT is always a citing engine. Gemini is on only when the read says so.
 * Mention %, who-instead, and the plain engine blocks are not computed here.
 */

import {
  unbrandedQuestionTexts,
  type CitationEngine,
  type CitationSource,
  type FullReport,
  type FullReportQuestion,
  type QuestionSearch,
} from './fullReport.ts'

/** Locked. First this many unbranded questions are searched on a full run. */
export const CITATIONS_CAP = 3

export const CITATION_COPY = {
  tab: 'Citations',
  enginesBoth: 'Sources from ChatGPT with web search and Gemini with Google Search',
  enginesChatGpt: 'Sources from ChatGPT with web search',
  helper:
    'Sites each engine cited when it searched the web to answer your unbranded questions this run. Counted per engine, not a ranking.',
  sitesTitle: 'Sites cited',
  yourSite: 'Your site',
  showQuestions: 'Show questions',
  hideQuestions: 'Hide questions',
  sources: 'Sources',
  noSources: 'No sources cited.',
  notSearched: 'Not searched on this run.',
  chatgptBlock: 'Generated · ChatGPT with web search',
  chatgptMiss: "ChatGPT web search didn't answer.",
  geminiBlock: 'Generated · Gemini with Google Search',
  geminiMiss: "Gemini with Google Search didn't answer.",
  suggestions: 'Google searches behind this answer',
  before: 'This report was saved before Citations. Run again to add sources.',
  unbrandedOnly: 'Citations cover unbranded questions only.',
} as const

const MISS_PLAIN = new Set(['missing_key', 'timeout', 'bad_json', 'empty'])

export function citationsGeminiEnabled(env: { CITATIONS_GEMINI?: string } | undefined): boolean {
  const raw = typeof env?.CITATIONS_GEMINI === 'string' ? env.CITATIONS_GEMINI.trim().toLowerCase() : ''
  return raw === 'on'
}

export function hostKey(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '')
}

/** Hostname of an http(s) URL, without a leading www. Empty when the URL is not usable. */
export function citationDomain(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return hostKey(parsed.hostname)
  } catch {
    return ''
  }
}

export function sourceFromUrl(url: string, title: string): CitationSource | null {
  const domain = citationDomain(url)
  if (!domain) return null
  return { url: url.trim(), domain, title: title.replace(/\s+/g, ' ').trim() }
}

export function questionCountPhrase(n: number): string {
  return n === 1 ? '1 question' : `${n} questions`
}

export function summaryLine(engine: CitationEngine, n: number, cited: number | 'miss'): string {
  const name = engine === 'chatgpt' ? 'ChatGPT' : 'Gemini'
  if (cited === 'miss') return `${name} didn't return sources on this run.`
  const tail = cited === 0 ? "Your site wasn't cited on any." : `Your site was cited on ${cited}.`
  return `${name} searched the web on ${questionCountPhrase(n)}. ${tail}`
}

export function engineSiteCount(engine: CitationEngine, k: number): string {
  const name = engine === 'chatgpt' ? 'ChatGPT' : 'Gemini'
  return `${name} · ${questionCountPhrase(k)}`
}

export function engineNotCited(engine: CitationEngine): string {
  return `${engine === 'chatgpt' ? 'ChatGPT' : 'Gemini'} · not cited`
}

export function capFootnote(gemini: boolean, cap: number): string {
  if (gemini) {
    return `ChatGPT and Gemini search the web on the first ${cap} unbranded questions. Run test question to search another.`
  }
  return `ChatGPT searches the web on the first ${cap} unbranded questions. Run test question to search another.`
}

export function neitherCitedLine(domain: string): string {
  return `${domain} wasn't cited this run.`
}

export function chipAriaLabel(domain: string): string {
  return `Open ${domain} in a new tab`
}

export function searchMissSentence(engine: CitationEngine, miss: { class?: string; status?: number } | undefined): string {
  const base = engine === 'chatgpt' ? CITATION_COPY.chatgptMiss : CITATION_COPY.geminiMiss
  if (!miss || typeof miss.class !== 'string') return base
  if (miss.class === 'http_reject') {
    const status = typeof miss.status === 'number' && Number.isInteger(miss.status) ? miss.status : null
    return status === null ? `${base} (http_reject)` : `${base} (http_reject ${status})`
  }
  if (MISS_PLAIN.has(miss.class)) return `${base} (${miss.class})`
  return base
}

export function enginesLabel(gemini: boolean): string {
  return gemini ? CITATION_COPY.enginesBoth : CITATION_COPY.enginesChatGpt
}

type QuestionHit = { question: string; search: QuestionSearch }

function questionKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function searchesFor(report: FullReport, engine: CitationEngine): QuestionHit[] {
  const hits: QuestionHit[] = []
  for (const theme of report.themes) {
    for (const item of theme.questions) {
      if (item.framing !== 'unbranded') continue
      const search = item.searches?.find((entry) => entry.engine === engine)
      if (search) hits.push({ question: item.question, search })
    }
  }
  return hits
}

/**
 * Questions this engine searched on this run.
 * ChatGPT counts the first `cap` unbranded questions, plus any later question
 * that has a ChatGPT search record (a Run test past the cap). A Run test on a
 * question already inside the cap does not add another.
 * Gemini counts only questions that have a Gemini search record.
 */
export function searchedQuestions(report: FullReport, engine: CitationEngine): string[] {
  if (!report.citations) return []
  if (engine === 'gemini' && !report.citations.gemini) return []
  const unbranded = unbrandedQuestionTexts(report.themes)
  const cap = report.citations.cap
  const out: string[] = []
  const seen = new Set<string>()
  unbranded.forEach((question, index) => {
    const key = questionKey(question)
    if (seen.has(key)) return
    const inCap = index < cap
    const has = searchesFor(report, engine).some((item) => questionKey(item.question) === key)
    if (engine === 'chatgpt') {
      if (inCap || has) {
        seen.add(key)
        out.push(question)
      }
      return
    }
    if (has) {
      seen.add(key)
      out.push(question)
    }
  })
  return out
}

function ownCited(search: QuestionSearch, domain: string): boolean {
  const own = hostKey(domain)
  return search.sources.some((source) => hostKey(source.domain) === own)
}

export type CitationSummary = {
  engine: CitationEngine
  text: string
}

export function engineSummaries(report: FullReport): CitationSummary[] {
  if (!report.citations) return []
  const engines: CitationEngine[] = report.citations.gemini ? ['chatgpt', 'gemini'] : ['chatgpt']
  return engines.map((engine) => {
    const questions = searchedQuestions(report, engine)
    const hits = searchesFor(report, engine)
    const byKey = new Map(hits.map((hit) => [questionKey(hit.question), hit.search]))
    const allMiss =
      questions.length > 0 && questions.every((question) => byKey.get(questionKey(question))?.miss)
    if (allMiss) return { engine, text: summaryLine(engine, questions.length, 'miss') }
    const cited = questions.filter((question) => {
      const search = byKey.get(questionKey(question))
      return !!search && !search.miss && ownCited(search, report.domain)
    }).length
    return { engine, text: summaryLine(engine, questions.length, cited) }
  })
}

export type SiteQuestion = {
  question: string
  sources: { engine: CitationEngine; source: CitationSource }[]
}

export type CitedSite = {
  domain: string
  own: boolean
  counts: { engine: CitationEngine; text: string }[]
  questions: SiteQuestion[]
}

function citingEngines(report: FullReport): CitationEngine[] {
  return report.citations?.gemini ? ['chatgpt', 'gemini'] : ['chatgpt']
}

export function citedSites(report: FullReport): { sites: CitedSite[]; neither: string | null } {
  const engines = citingEngines(report)
  const own = hostKey(report.domain)
  const byDomain = new Map<string, Map<CitationEngine, Map<string, CitationSource[]>>>()
  for (const engine of engines) {
    for (const hit of searchesFor(report, engine)) {
      if (hit.search.miss) continue
      for (const source of hit.search.sources) {
        const domain = hostKey(source.domain)
        if (!domain) continue
        const engineMap = byDomain.get(domain) ?? new Map<CitationEngine, Map<string, CitationSource[]>>()
        const questions = engineMap.get(engine) ?? new Map<string, CitationSource[]>()
        const list = questions.get(hit.question) ?? []
        if (!list.some((item) => item.url === source.url)) list.push(source)
        questions.set(hit.question, list)
        engineMap.set(engine, questions)
        byDomain.set(domain, engineMap)
      }
    }
  }
  const sites: CitedSite[] = []
  for (const [domain, engineMap] of byDomain) {
    const counts: CitedSite['counts'] = []
    const questionMap = new Map<string, SiteQuestion>()
    for (const engine of engines) {
      const questions = engineMap.get(engine)
      const k = questions ? questions.size : 0
      if (k > 0) counts.push({ engine, text: engineSiteCount(engine, k) })
      else if (domain === own) counts.push({ engine, text: engineNotCited(engine) })
      if (!questions) continue
      for (const [question, sources] of questions) {
        const row = questionMap.get(question) ?? { question, sources: [] }
        for (const source of sources) row.sources.push({ engine, source })
        questionMap.set(question, row)
      }
    }
    sites.push({
      domain,
      own: domain === own,
      counts,
      questions: [...questionMap.values()],
    })
  }
  sites.sort((a, b) => {
    const rank = (site: CitedSite) =>
      Math.max(
        0,
        ...site.counts.map((count) => {
          const match = /(\d+) question/.exec(count.text)
          return match ? Number(match[1]) : 0
        }),
      )
    const delta = rank(b) - rank(a)
    if (delta !== 0) return delta
    return a.domain.localeCompare(b.domain)
  })
  const ownCitedByAny = sites.some((site) => site.own && site.counts.some((count) => !count.text.endsWith('not cited')))
  return { sites, neither: ownCitedByAny ? null : neitherCitedLine(report.domain) }
}

export type CitationTab =
  | { kind: 'before' }
  | { kind: 'unbranded' }
  | {
      kind: 'ready'
      gemini: boolean
      engines: string
      helper: string
      summaries: CitationSummary[]
      sites: CitedSite[]
      neither: string | null
      footnote: string
    }

export function citationTab(report: FullReport): CitationTab {
  if (!report.citations) return { kind: 'before' }
  if (unbrandedQuestionTexts(report.themes).length === 0) return { kind: 'unbranded' }
  const listed = citedSites(report)
  return {
    kind: 'ready',
    gemini: report.citations.gemini,
    engines: enginesLabel(report.citations.gemini),
    helper: CITATION_COPY.helper,
    summaries: engineSummaries(report),
    sites: listed.sites,
    neither: listed.neither,
    footnote: capFootnote(report.citations.gemini, report.citations.cap),
  }
}

export type QuestionCitationView = {
  engine: CitationEngine
  block: string
  state: 'not-searched' | 'miss' | 'answer'
  text: string
  sources: CitationSource[]
  suggestionsHtml?: string
}

/** Blocks under an opened question. Hidden engines are omitted. */
export function questionCitationViews(report: FullReport, item: FullReportQuestion): QuestionCitationView[] {
  if (!report.citations || item.framing !== 'unbranded') return []
  const unbranded = unbrandedQuestionTexts(report.themes)
  const index = unbranded.findIndex((question) => questionKey(question) === questionKey(item.question))
  const inCap = index >= 0 && index < report.citations.cap
  const engines: CitationEngine[] = report.citations.gemini ? ['chatgpt', 'gemini'] : ['chatgpt']
  const views: QuestionCitationView[] = []
  for (const engine of engines) {
    const search = item.searches?.find((entry) => entry.engine === engine)
    const block = engine === 'chatgpt' ? CITATION_COPY.chatgptBlock : CITATION_COPY.geminiBlock
    if (!search && !inCap) {
      views.push({ engine, block, state: 'not-searched', text: CITATION_COPY.notSearched, sources: [] })
      continue
    }
    if (!search) {
      views.push({ engine, block, state: 'not-searched', text: CITATION_COPY.notSearched, sources: [] })
      continue
    }
    if (search.miss || !search.text.trim()) {
      views.push({
        engine,
        block,
        state: 'miss',
        text: searchMissSentence(engine, search.miss),
        sources: search.sources,
        ...(engine === 'gemini' && search.suggestionsHtml ? { suggestionsHtml: search.suggestionsHtml } : {}),
      })
      continue
    }
    views.push({
      engine,
      block,
      state: 'answer',
      text: search.text,
      sources: search.sources,
      ...(engine === 'gemini' && search.suggestionsHtml ? { suggestionsHtml: search.suggestionsHtml } : {}),
    })
  }
  return views
}

/** Drop Gemini searches and mark the read as Gemini-off. ChatGPT stays. */
export function hideGeminiCitations(report: FullReport): FullReport {
  if (!report.citations?.gemini && !report.themes.some((theme) => theme.questions.some((item) => item.searches?.some((search) => search.engine === 'gemini')))) {
    return report
  }
  return {
    ...report,
    citations: report.citations ? { ...report.citations, gemini: false } : report.citations,
    themes: report.themes.map((theme) => ({
      ...theme,
      questions: theme.questions.map((item) => {
        if (!item.searches) return item
        const searches = item.searches.filter((search) => search.engine !== 'gemini')
        return { ...item, searches }
      }),
    })),
  }
}

/** Strip Gemini citation fields from a stored check result. Other fields stay. */
export function stripGeminiFromStored(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  const full = record.fullReport
  if (!full || typeof full !== 'object' || Array.isArray(full)) return result
  const blob = full as Record<string, unknown>
  const themes = Array.isArray(blob.themes)
    ? blob.themes.map((theme) => {
        if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return theme
        const themeRecord = theme as Record<string, unknown>
        if (!Array.isArray(themeRecord.questions)) return theme
        return {
          ...themeRecord,
          questions: themeRecord.questions.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item
            const question = item as Record<string, unknown>
            if (!Array.isArray(question.searches)) return item
            return {
              ...question,
              searches: question.searches.filter((search) => {
                if (!search || typeof search !== 'object' || Array.isArray(search)) return false
                return (search as { engine?: unknown }).engine !== 'gemini'
              }),
            }
          }),
        }
      })
    : blob.themes
  const citations =
    blob.citations && typeof blob.citations === 'object' && !Array.isArray(blob.citations)
      ? { ...(blob.citations as Record<string, unknown>), gemini: false }
      : blob.citations
  return { ...record, fullReport: { ...blob, themes, citations } }
}

export function patchQuestionSearches(report: FullReport, question: string, searches: QuestionSearch[], gemini: boolean): FullReport {
  const key = questionKey(question)
  const themes = report.themes.map((theme) => ({
    ...theme,
    questions: theme.questions.map((item) => {
      if (questionKey(item.question) !== key || item.framing !== 'unbranded') return item
      const kept = (item.searches ?? []).filter((search) => !searches.some((next) => next.engine === search.engine))
      return { ...item, searches: [...kept, ...searches] }
    }),
  }))
  const next: FullReport = {
    ...report,
    themes,
    citations: { cap: report.citations?.cap ?? CITATIONS_CAP, gemini },
  }
  return gemini ? next : hideGeminiCitations(next)
}

/** Every fixed Citations string, plus the sentences the tab builds for n=1 and n=2. */
export function citationCopyCorpus(): string[] {
  return [
    CITATION_COPY.tab,
    CITATION_COPY.enginesBoth,
    CITATION_COPY.enginesChatGpt,
    CITATION_COPY.helper,
    CITATION_COPY.sitesTitle,
    CITATION_COPY.yourSite,
    CITATION_COPY.showQuestions,
    CITATION_COPY.hideQuestions,
    CITATION_COPY.sources,
    CITATION_COPY.noSources,
    CITATION_COPY.notSearched,
    CITATION_COPY.chatgptBlock,
    CITATION_COPY.chatgptMiss,
    CITATION_COPY.geminiBlock,
    CITATION_COPY.geminiMiss,
    CITATION_COPY.suggestions,
    CITATION_COPY.before,
    CITATION_COPY.unbrandedOnly,
    summaryLine('chatgpt', 1, 0),
    summaryLine('chatgpt', 2, 1),
    summaryLine('gemini', 1, 'miss'),
    summaryLine('gemini', 3, 2),
    engineSiteCount('chatgpt', 1),
    engineSiteCount('gemini', 4),
    engineNotCited('chatgpt'),
    engineNotCited('gemini'),
    capFootnote(true, CITATIONS_CAP),
    capFootnote(false, CITATIONS_CAP),
    neitherCitedLine('linear.app'),
    chipAriaLabel('linear.app'),
    'ChatGPT',
    'Gemini',
  ]
}

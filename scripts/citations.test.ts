/**
 * Citations tab. url_citation only, required web search, Gemini switch,
 * purge, cap 3, Run test past the cap, and the shared slot limiter.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { purgeGeminiCitations, searchOneQuestion } from '../functions/api/citations.ts'
import { citationsFromWebSearchPayload, chatgptWebSearchBody, groundingFromGeminiPayload } from '../functions/api/searched.ts'
import { createOutboundSlots } from '../functions/lib/slots.ts'
import { onRequest as onVisibility } from '../functions/api/visibility.ts'
import {
  CITATIONS_CAP,
  CITATION_COPY,
  citationCopyCorpus,
  citationMetaFor,
  citationsGeminiEnabled,
  hideGeminiCitations,
  searchedQuestions,
  stripGeminiFromStored,
  citationTab,
} from '../src/citations.ts'
import { patchQuestionSearches } from '../src/citations.ts'
import type { FullReport, QuestionSearch } from '../src/fullReport.ts'

function report(searches: QuestionSearch[][], gemini = true): FullReport {
  const questions = [
    'What should a team use to track issues?',
    'Who else shows up for issue tracking?',
    'How do teams plan a week of work?',
    'What do support teams use for tickets?',
    'Which tools help a finance team collect approvals?',
  ]
  return {
    domain: 'linear.app',
    model: 'gpt-4o-mini',
    includesBranded: true,
    citations: { cap: CITATIONS_CAP, gemini },
    themes: [
      {
        id: 'problems',
        title: 'Problems you solve',
        framing: 'unbranded',
        questions: questions.map((question, index) => ({
          question,
          answer: 'A plain answer.',
          framing: 'unbranded' as const,
          whoInstead: [],
          ...(searches[index] ? { searches: searches[index] } : {}),
        })),
      },
    ],
  }
}

function chat(domain = 'jira.com'): QuestionSearch {
  return {
    engine: 'chatgpt',
    text: 'Teams often start with a tracker.',
    sources: [{ url: `https://${domain}/a`, domain, title: 'Jira' }],
  }
}

describe('citations', () => {
  it('counts url_citation annotations and ignores every sources list', () => {
    const parsed = citationsFromWebSearchPayload({
      output: [
        {
          type: 'web_search_call',
          action: { type: 'search', sources: [{ type: 'url', url: 'https://sources.example/ignored' }] },
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'A searched answer.',
              sources: [{ url: 'https://sources.example/in-the-message' }],
              annotations: [
                { type: 'url_citation', url: 'https://cited.example/a', title: 'Cited A' },
                { type: 'file_citation', url: 'https://files.example/nope', title: 'Not a url citation' },
              ],
            },
          ],
        },
      ],
    })
    assert.ok(parsed)
    assert.equal(parsed.searchCount, 1)
    assert.deepEqual(parsed.citations, [{ url: 'https://cited.example/a', title: 'Cited A' }])
    assert.equal(JSON.stringify(parsed.citations).includes('sources.example'), false)
  })

  it('requires web_search on the ChatGPT request', () => {
    const body = chatgptWebSearchBody('gpt-4o-mini', 'What should a team use to track issues?', 'linear.app')
    assert.equal(body.tool_choice, 'required')
    assert.deepEqual(body.tools, [{ type: 'web_search' }])
    assert.equal(body.model, 'gpt-4o-mini')
  })

  it('keeps Google suggestions HTML unmodified', () => {
    const html = '<div>search suggestions</div>'
    const parsed = groundingFromGeminiPayload({
      candidates: [
        {
          content: { parts: [{ text: 'A grounded answer.' }] },
          groundingMetadata: {
            webSearchQueries: ['tracker'],
            groundingChunks: [{ web: { uri: 'https://ground.example/a', title: 'Ground A' } }],
            searchEntryPoint: { renderedContent: html },
          },
        },
      ],
    })
    assert.equal(parsed?.suggestionsHtml, html)
    assert.equal(parsed?.hasSearchEntryPoint, true)
  })

  it('treats unset, off, and any other value as Gemini citations off', () => {
    assert.equal(citationsGeminiEnabled(undefined), false)
    assert.equal(citationsGeminiEnabled({}), false)
    assert.equal(citationsGeminiEnabled({ CITATIONS_GEMINI: '' }), false)
    assert.equal(citationsGeminiEnabled({ CITATIONS_GEMINI: 'off' }), false)
    assert.equal(citationsGeminiEnabled({ CITATIONS_GEMINI: 'yes' }), false)
    assert.equal(citationsGeminiEnabled({ CITATIONS_GEMINI: ' on ' }), true)
  })

  it('hides Gemini from the tab and a saved report when the switch is off', () => {
    const gemini: QuestionSearch = {
      engine: 'gemini',
      text: 'A grounded answer.',
      sources: [{ engine: 'gemini', url: 'https://ground.example/a', domain: 'ground.example', title: 'Ground' }],
      renderedContent: '<div>widget</div>',
    }
    const stored = report([[chat(), gemini]], true)
    const hidden = hideGeminiCitations(stored)
    assert.equal(hidden.citations?.gemini, false)
    assert.equal(hidden.themes[0]?.questions[0]?.searches?.some((search) => search.engine === 'gemini'), false)
    assert.equal(hidden.themes[0]?.questions[0]?.searches?.some((search) => search.engine === 'chatgpt'), true)
    const tab = citationTab(hidden)
    assert.equal(tab.kind, 'ready')
    if (tab.kind !== 'ready') return
    assert.equal(tab.engines, CITATION_COPY.enginesChatGpt)
    assert.equal(tab.summaries.some((line) => line.engine === 'gemini'), false)
    assert.equal(JSON.stringify(tab).includes('Gemini'), false)
    const stripped = stripGeminiFromStored({
      report: 'full',
      fullReport: stored,
    }) as { fullReport: FullReport }
    assert.equal(
      stripped.fullReport.themes[0]?.questions[0]?.searches?.some((search) => search.engine === 'gemini'),
      false,
    )
    assert.equal(stripped.fullReport.citations?.gemini, false)
  })

  it('locks the search cap at 3 and adds 1 only for a Run test past the cap', () => {
    assert.equal(CITATIONS_CAP, 3)
    const base = report([
      [chat()],
      [chat('asana.com')],
      [chat('monday.com')],
    ])
    assert.equal(searchedQuestions(base, 'chatgpt').length, CITATIONS_CAP)
    const within = patchQuestionSearches(base, base.themes[0]!.questions[0]!.question, [chat('notion.com')], true)
    assert.equal(searchedQuestions(within, 'chatgpt').length, CITATIONS_CAP)
    const past = patchQuestionSearches(
      base,
      base.themes[0]!.questions[CITATIONS_CAP]!.question,
      [chat('height.app')],
      true,
    )
    assert.equal(searchedQuestions(past, 'chatgpt').length, CITATIONS_CAP + 1)
    assert.equal(searchedQuestions(past, 'gemini').length, 0)
    assert.equal(past.citations?.searched?.chatgpt, CITATIONS_CAP + 1)
    assert.equal(past.citations?.searched?.gemini, 0)
  })

  it('shows a searching line under signed-in Run again and not for guests', () => {
    assert.equal(CITATION_COPY.searching, 'Searching the web for sources…')
    assert.equal(/ChatGPT|Gemini|Claude|\d|question/i.test(CITATION_COPY.searching), false)
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const guestHome = app.slice(app.indexOf("phase !== 'result'"), app.indexOf('!screen && reportPhase'))
    assert.equal(guestHome.includes('citationSearchBusy'), false)
    assert.equal(guestHome.includes('CITATION_COPY.searching'), false)
    assert.equal(guestHome.includes('Searching the web for sources'), false)
    const reportAgain = app.slice(app.indexOf('screen && fullReport && reportOnly'), app.indexOf(') : screen ?'))
    assert.equal(reportAgain.includes('citationSearchBusy'), true)
    assert.equal(reportAgain.includes('CITATION_COPY.searching'), true)
    const landAgain = app.slice(app.indexOf(') : screen ?'), app.indexOf('full-report-door'))
    assert.equal(landAgain.includes('CITATION_COPY.searching'), false)
    const visibility = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.equal(visibility.includes('Searching the web for sources'), false)
    assert.equal(visibility.includes('CITATION_COPY'), false)
  })

  it('does not call Gemini grounding when the switch is off', async () => {
    const slots = createOutboundSlots()
    const calls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      if (url.includes('/v1/responses')) {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'A searched answer.',
                    annotations: [{ type: 'url_citation', url: 'https://cited.example/a', title: 'Cited A' }],
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error('unexpected ' + url)
    }) as typeof fetch
    try {
      const searches = await searchOneQuestion({
        question: 'What should a team use to track issues?',
        domain: 'linear.app',
        env: { CITATIONS_GEMINI: 'off', OPENAI_API_KEY: 'sk-test' },
        slots,
        scrub: [],
        gemini: false,
        apiKey: 'sk-test',
      })
      assert.equal(calls.some((url) => url.includes('generativelanguage.googleapis.com')), false)
      assert.equal(calls.some((url) => url.includes('/v1/responses')), true)
      assert.deepEqual(
        searches.map((search) => search.engine),
        ['chatgpt'],
      )
      assert.equal(searches[0]?.sources[0]?.engine, 'chatgpt')
      assert.equal(searches.some((search) => search.engine === 'gemini'), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('sends tool_choice required and holds at most 6 slots', async () => {
    const slots = createOutboundSlots()
    let active = 0
    let max = 0
    const bodies: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      active += 1
      max = Math.max(max, active)
      if (typeof init?.body === 'string') bodies.push(init.body)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          searchOneQuestion({
            question: `Question ${index}`,
            domain: 'linear.app',
            env: { OPENAI_API_KEY: 'sk-test' },
            slots,
            scrub: [],
            gemini: false,
            apiKey: 'sk-test',
          }),
        ),
      )
      assert.equal(max, 6)
      assert.equal(bodies.every((body) => body.includes('"tool_choice":"required"')), true)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('purges Gemini citations from saved checks and is idempotent', async () => {
    const checks = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        result: {
          report: 'full',
          fullReport: {
            citations: { cap: 3, gemini: true, searched: { chatgpt: 1, gemini: 1 } },
            themes: [
              {
                questions: [
                  {
                    searches: [
                      {
                        engine: 'chatgpt',
                        text: 'A plain searched answer.',
                        sources: [{ engine: 'chatgpt', url: 'https://jira.com/a', domain: 'jira.com', title: 'Jira' }],
                      },
                      {
                        engine: 'gemini',
                        text: 'A grounded answer.',
                        sources: [
                          { engine: 'gemini', url: 'https://asana.com/a', domain: 'asana.com', title: 'Asana' },
                          { engine: 'gemini', url: 'https://monday.com/a', domain: 'monday.com', title: 'Monday' },
                        ],
                        renderedContent: '<div>widget</div>',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        result: {
          report: 'full',
          fullReport: {
            themes: [{ questions: [{ searches: [{ engine: 'chatgpt', text: 'Only ChatGPT.', sources: [] }] }] }],
          },
        },
      },
    ]
    const calls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      calls.push(`${method} ${url}`)
      if (url.includes('citation_sources') || url.includes('citation_suggestions')) {
        throw new Error('citation tables are not in the schema')
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify(checks), { status: 200 })
      }
      if (method === 'PATCH' && url.includes('/rest/v1/checks')) {
        const id = /id=eq\.([^&]+)/.exec(url)?.[1] || ''
        const body = JSON.parse(String(init?.body || '{}')) as { result?: unknown }
        const row = checks.find((item) => item.id === id)
        if (row && body.result) row.result = body.result as (typeof checks)[number]['result']
        return new Response(null, { status: 204 })
      }
      return new Response('[]', { status: 200 })
    }) as typeof fetch
    try {
      const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service' }
      const first = await purgeGeminiCitations(env)
      assert.equal(first.rows, 1)
      assert.equal(first.sources, 2)
      const kept = checks[0]?.result.fullReport.themes[0]?.questions[0]?.searches
      assert.deepEqual(
        kept?.map((search) => search.engine),
        ['chatgpt'],
      )
      assert.equal(JSON.stringify(checks[0]).includes('renderedContent'), false)
      assert.equal(JSON.stringify(checks[0]).includes('asana.com'), false)
      assert.equal(JSON.stringify(checks[0]).includes('jira.com'), true)
      assert.equal(checks[0]?.result.fullReport.citations.searched.gemini, undefined)
      assert.equal(checks[0]?.result.fullReport.citations.gemini, false)
      const second = await purgeGeminiCitations(env)
      assert.equal(second.rows, 0)
      assert.equal(second.sources, 0)
      assert.equal(calls.filter((call) => call.startsWith('PATCH')).length, 1)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('stores citations in the check JSON and adds no table', () => {
    const migrations = readdirSync(new URL('../supabase/migrations/', import.meta.url))
    assert.equal(migrations.some((name) => name.includes('citation')), false)
    const schema = readFileSync(new URL('../supabase/migrations/20260925120000_save_and_rerun.sql', import.meta.url), 'utf8')
    assert.match(schema, /create table public\.checks \([\s\S]*result jsonb/)
    assert.equal(schema.includes('citation_sources'), false)
    const later = readFileSync(new URL('../supabase/migrations/20260926203000_full_report.sql', import.meta.url), 'utf8')
    assert.equal(later.includes('alter table public.checks'), false)
    const saver = readFileSync(new URL('../functions/api/full-report.ts', import.meta.url), 'utf8')
    assert.equal(saver.includes('citation_sources'), false)
    assert.equal(saver.includes('citation_suggestions'), false)
    assert.match(saver, /user_id: userId,\s*domain,\s*mode: 'unbranded',\s*result,/)
    const api = readFileSync(new URL('../functions/api/citations.ts', import.meta.url), 'utf8')
    assert.equal(api.includes('citation_sources'), false)
    assert.equal(api.includes('citation_suggestions'), false)
    const meta = citationMetaFor(
      report([
        [chat()],
        [chat('asana.com')],
        [chat('monday.com')],
      ]).themes,
      false,
    )
    assert.equal(meta.cap, CITATIONS_CAP)
    assert.equal(meta.gemini, false)
    assert.deepEqual(meta.searched, { chatgpt: CITATIONS_CAP })
  })

  it('keeps the guest visibility path free of citation calls', async () => {
    const source = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.equal(source.includes('CITATIONS_GEMINI'), false)
    assert.equal(source.includes('chatgptWebSearch'), false)
    assert.equal(source.includes('web_search'), false)
    const prev = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      if (url.startsWith('https://linear.app')) return new Response('<html><title>Linear</title><p>Issue tracking for software teams planning work together every week.</p></html>', { status: 200 })
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    questions: [
                      'What is Linear?',
                      'Linear vs Jira for a small team?',
                      'Is Linear worth it for engineering orgs?',
                    ],
                    answered: 'partial',
                    why: 'Linear is widely known, but comparison answers often cite larger incumbents too.',
                    whoInstead: ['Jira', 'Asana'],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ answers: ['A Gemini answer.'] }) }] } }],
          }),
          { status: 200 },
        )
      }
      return new Response('no', { status: 404 })
    }) as typeof fetch
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=unbranded'),
        env: { OPENAI_API_KEY: 'sk-guest', GEMINI_API_KEY: 'gemini-guest', CITATIONS_GEMINI: 'on' },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(urls.some((url) => url.includes('/v1/responses')), false)
      assert.equal(text.includes('searches'), false)
      assert.equal(text.includes('url_citation'), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('has no citation rank, share, or percent wording', () => {
    const corpus = citationCopyCorpus().join('\n').replace(/ranking/g, '')
    for (const phrase of ['% cited', 'rank', 'share of', 'Top cited', 'total sources']) {
      assert.equal(corpus.toLowerCase().includes(phrase.toLowerCase()), false, phrase)
    }
  })
})

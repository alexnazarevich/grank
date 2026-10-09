/**
 * Citations timing probe. Parsing, miss classes, and the preview guard.
 * The probe is not a production route: main and an unset branch are 404,
 * and a request without the preview token is 404.
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { resetClaudeModelMemo } from '../functions/api/claude.ts'
import { onRequest as probe } from '../functions/api/citations-timing.ts'
import {
  citationsProbeBranchOpen,
  probeLogLine,
  probeQuestions,
  probeTokenFromEnv,
  probeTokensEqual,
  PROBE_QUESTION_BANK,
  type ProbeRow,
} from '../functions/api/citations-timing.ts'
import {
  CHATGPT_SEARCH_MODEL_DEFAULT,
  SEARCH_MISS_CLASSES,
  SEARCH_TIMEOUT_MS,
  chatgptSearchModelFromEnv,
  chatgptWebSearch,
  citationsFromWebSearchPayload,
  geminiGrounded,
  groundingFromGeminiPayload,
  resetGroundedThinkingMemo,
} from '../functions/api/searched.ts'
import { GEMINI_MODEL_DEFAULT, geminiGenerationConfig, geminiMaxOutputTokens, resetGeminiThinkingMemo } from '../functions/api/visibility.ts'

const OPENAI = 'sk-openai-timing-probe-secret'
const GEMINI = 'gemini-timing-probe-secret'
const ANTHROPIC = 'sk-ant-timing-probe-secret'
const TOKEN = 'probe-token-should-not-leak-xyz'
const SERVICE = 'service-role-timing-probe-secret'
const BRANCH = 'cursor/citations-timing-probe'

type Call = { url: string; method: string; body: string; headers: Record<string, string> }

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function headerMap(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers)
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: urlOf(input),
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers: headerMap(init),
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = prev
    },
  }
}

function searchPayload(text = 'Teams often start with a shared tracker.') {
  return {
    output: [
      {
        type: 'web_search_call',
        id: 'ws_1',
        action: {
          type: 'search',
          query: 'b2b tracker',
          sources: [{ type: 'url', url: 'https://sources.example/ignored', title: 'Ignored source' }],
        },
      },
      {
        type: 'web_search_call',
        action: { type: 'open_page', sources: [{ url: 'https://sources.example/also-ignored' }] },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text,
            sources: [{ url: 'https://sources.example/in-the-message', title: 'Still ignored' }],
            annotations: [
              { type: 'url_citation', url: 'https://cited.example/a', title: 'Cited A' },
              { type: 'file_citation', url: 'https://files.example/nope', title: 'Not a url citation' },
              { type: 'url_citation', url: 'https://cited.example/b', title: 'Cited B' },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 22 },
  }
}

function groundingPayload(text = 'A grounded answer for a software buyer.') {
  return {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: 'hidden chain' },
            { text },
          ],
        },
        groundingMetadata: {
          webSearchQueries: ['b2b tracker', ' ', 'shared inbox'],
          groundingChunks: [
            { web: { uri: 'https://ground.example/a', title: 'Ground A' } },
            { retrievedContext: { uri: 'https://retrieved.example/skip', title: 'Skip' } },
            { web: { uri: '  ', title: 'Blank' } },
            { web: { uri: 'https://ground.example/b', title: 'Ground B' } },
          ],
          searchEntryPoint: { renderedContent: '<div>search suggestions</div>' },
        },
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 },
  }
}

function env(extra: Record<string, string | undefined> = {}) {
  return {
    CF_PAGES_BRANCH: BRANCH,
    PROBE_TOKEN: TOKEN,
    OPENAI_API_KEY: OPENAI,
    GEMINI_API_KEY: GEMINI,
    ANTHROPIC_API_KEY: ANTHROPIC,
    ...extra,
  }
}

function ask(query: string, token: string | null = TOKEN, extra?: Record<string, string | undefined>) {
  const headers = new Headers()
  if (token !== null) headers.set('x-probe-token', token)
  return probe({
    request: new Request(`https://grank.pages.dev/api/citations-timing?${query}`, { headers }),
    env: env(extra),
  })
}

describe('citations timing', { concurrency: false }, () => {
describe('citation parsers', () => {
  it('counts url_citation annotations and ignores every sources list', () => {
    const parsed = citationsFromWebSearchPayload(searchPayload())
    assert.ok(parsed)
    assert.equal(parsed.searchCount, 2)
    assert.deepEqual(parsed.citations, [
      { url: 'https://cited.example/a', title: 'Cited A' },
      { url: 'https://cited.example/b', title: 'Cited B' },
    ])
    assert.equal(parsed.text, 'Teams often start with a shared tracker.')
    assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 22 })
    assert.equal(JSON.stringify(parsed.citations).includes('sources.example'), false)
    assert.equal(JSON.stringify(parsed.citations).includes('files.example'), false)
    assert.equal(citationsFromWebSearchPayload({ sources: [{ url: 'https://sources.example/only' }] }), null)
  })

  it('reads grounding chunks, query count, and search entry point presence', () => {
    const parsed = groundingFromGeminiPayload(groundingPayload())
    assert.ok(parsed)
    assert.equal(parsed.text, 'A grounded answer for a software buyer.')
    assert.equal(parsed.text.includes('hidden chain'), false)
    assert.equal(parsed.searchCount, 2)
    assert.deepEqual(parsed.chunks, [
      { uri: 'https://ground.example/a', title: 'Ground A' },
      { uri: 'https://ground.example/b', title: 'Ground B' },
    ])
    assert.equal(parsed.hasSearchEntryPoint, true)
    assert.deepEqual(parsed.usage, { inputTokens: 5, outputTokens: 9 })
    const blank = groundingFromGeminiPayload({
      candidates: [{ content: { parts: [{ text: 'Answer' }] }, groundingMetadata: { searchEntryPoint: { renderedContent: '   ' } } }],
    })
    assert.equal(blank?.hasSearchEntryPoint, false)
    assert.equal(blank?.searchCount, 0)
    assert.equal(groundingFromGeminiPayload({ usageMetadata: {} }), null)
  })
})

describe('searched calls', { concurrency: false }, () => {
  beforeEach(() => {
    resetGeminiThinkingMemo()
    resetGroundedThinkingMemo()
    resetClaudeModelMemo()
  })

  it('uses gpt-4o-mini, required web_search, and only url_citation rows', async () => {
    assert.equal(CHATGPT_SEARCH_MODEL_DEFAULT, 'gpt-4o-mini')
    assert.equal(SEARCH_TIMEOUT_MS, 8_000)
    assert.deepEqual(SEARCH_MISS_CLASSES, ['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'])
    assert.equal(chatgptSearchModelFromEnv(undefined), 'gpt-4o-mini')
    assert.equal(chatgptSearchModelFromEnv({ CHATGPT_SEARCH_MODEL: '  gpt-4.1-mini  ' }), 'gpt-4.1-mini')
    assert.equal(chatgptSearchModelFromEnv({ CHATGPT_SEARCH_MODEL: 'https://api.openai.com' }), 'gpt-4o-mini')
    assert.equal(chatgptSearchModelFromEnv({ VITE_CHATGPT_SEARCH_MODEL: 'gpt-4.1-mini' } as never), 'gpt-4o-mini')

    const mock = install(() => new Response(JSON.stringify(searchPayload(`Noted ${OPENAI}.`)), { status: 200 }))
    try {
      const hit = await chatgptWebSearch({
        apiKey: OPENAI,
        model: 'gpt-4o-mini',
        question: 'What should a team use to track work?',
        domain: 'linear.app',
        timeoutMs: 8_000,
      })
      const sent = JSON.parse(mock.calls[0]?.body || '{}') as {
        model?: string
        tool_choice?: string
        tools?: { type?: string; filters?: unknown }[]
        include?: unknown
        input?: string
      }
      assert.equal(mock.calls.length, 1)
      assert.match(mock.calls[0]?.url || '', /\/v1\/responses$/)
      assert.equal(sent.model, 'gpt-4o-mini')
      assert.equal(sent.tool_choice, 'required')
      assert.deepEqual(sent.tools, [{ type: 'web_search' }])
      assert.equal(sent.include, undefined)
      assert.equal(JSON.stringify(sent).includes('allowed_domains'), false)
      assert.match(sent.input || '', /linear\.app/)
      assert.equal(hit.miss, undefined)
      assert.equal(hit.searchCount, 2)
      assert.equal(hit.citations.length, 2)
      assert.equal(hit.citations.some((row) => row.url.includes('sources.example')), false)
      assert.match(hit.text, /\[redacted\]/)
      assert.equal(hit.text.includes(OPENAI), false)
      assert.equal(hit.usage.inputTokens, 11)
      assert.equal(hit.usage.outputTokens, 22)
      assert.equal(hit.attempts, 1)
      assert.ok(hit.clock.t_start >= hit.clock.t_created)
      assert.equal(typeof hit.clock.t_headers, 'number')
    } finally {
      mock.restore()
    }
  })

  it('maps the five miss classes and does not return the error body', async () => {
    let fetches = 0
    const missing = install(() => {
      fetches += 1
      return new Response('nope', { status: 500 })
    })
    try {
      const hit = await chatgptWebSearch({ apiKey: '   ', model: 'gpt-4o-mini', question: 'What should a team use?' })
      assert.equal(hit.miss?.class, 'missing_key')
      assert.equal(fetches, 0)
    } finally {
      missing.restore()
    }

    const rejected = install(
      () => new Response(JSON.stringify({ error: { message: `key ${OPENAI}` } }), { status: 429 }),
    )
    try {
      const hit = await chatgptWebSearch({ apiKey: OPENAI, model: 'gpt-4o-mini', question: 'What should a team use?' })
      assert.deepEqual(hit.miss, { class: 'http_reject', status: 429 })
      assert.equal(JSON.stringify(hit).includes(OPENAI), false)
      assert.equal(hit.text, '')
    } finally {
      rejected.restore()
    }

    const broken = install(() => new Response('not-json', { status: 200 }))
    try {
      const hit = await chatgptWebSearch({ apiKey: OPENAI, model: 'gpt-4o-mini', question: 'What should a team use?' })
      assert.equal(hit.miss?.class, 'bad_json')
    } finally {
      broken.restore()
    }

    const empty = install(() =>
      new Response(
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '  ' }] }], usage: { input_tokens: 3, output_tokens: 1 } }),
        { status: 200 },
      ),
    )
    try {
      const hit = await chatgptWebSearch({ apiKey: OPENAI, model: 'gpt-4o-mini', question: 'What should a team use?' })
      assert.equal(hit.miss?.class, 'empty')
      assert.equal(hit.usage.inputTokens, 3)
    } finally {
      empty.restore()
    }

    const slow = install((_call) => {
      return new Promise((_resolve, reject) => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        setTimeout(() => reject(err), 15)
      })
    })
    try {
      const hit = await chatgptWebSearch({
        apiKey: OPENAI,
        model: 'gpt-4o-mini',
        question: 'What should a team use?',
        timeoutMs: 20,
      })
      assert.equal(hit.miss?.class, 'timeout')
      assert.equal(hit.clock.t_headers, null)
      assert.ok(hit.clock.t_end >= hit.clock.t_start)
    } finally {
      slow.restore()
    }
  })

  it('sends google_search, keeps thinkingLevel minimal, and retries a thinking 400 once', async () => {
    assert.equal(GEMINI_MODEL_DEFAULT, 'gemini-3.5-flash-lite')
    const bodies: { tools?: unknown; generationConfig?: { responseMimeType?: string; thinkingConfig?: unknown } }[] = []
    let status = 400
    const mock = install((call) => {
      bodies.push(JSON.parse(call.body) as (typeof bodies)[number])
      if (status === 400) {
        status = 200
        return new Response(JSON.stringify({ error: { message: GEMINI } }), { status: 400 })
      }
      return new Response(JSON.stringify(groundingPayload(`Grounded ${GEMINI}.`)), { status: 200 })
    })
    try {
      const hit = await geminiGrounded({
        apiKey: GEMINI,
        model: GEMINI_MODEL_DEFAULT,
        question: 'What should a team use to track work?',
        timeoutMs: 8_000,
      })
      assert.equal(bodies.length, 2)
      assert.deepEqual(bodies[0]?.tools, [{ google_search: {} }])
      assert.equal(bodies[0]?.generationConfig?.responseMimeType, undefined)
      assert.deepEqual(bodies[0]?.generationConfig?.thinkingConfig, { thinkingLevel: 'minimal' })
      assert.equal(bodies[0]?.generationConfig?.maxOutputTokens, geminiMaxOutputTokens(1))
      assert.equal(bodies[1]?.generationConfig?.thinkingConfig, undefined)
      assert.equal(hit.miss, undefined)
      assert.equal(hit.attempts, 2)
      assert.equal(hit.searchCount, 2)
      assert.equal(hit.chunks.length, 2)
      assert.equal(hit.hasSearchEntryPoint, true)
      assert.equal(hit.chunks.some((chunk) => chunk.uri.includes('retrieved.example')), false)
      assert.match(hit.text, /\[redacted\]/)
      assert.equal(hit.text.includes(GEMINI), false)
      assert.equal(JSON.stringify(hit).includes('search suggestions'), false)
      assert.deepEqual(geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 1).thinkingConfig, { thinkingLevel: 'minimal' })
    } finally {
      mock.restore()
    }
  })
})

describe('probe guard', { concurrency: false }, () => {
  beforeEach(() => {
    resetGeminiThinkingMemo()
    resetGroundedThinkingMemo()
    resetClaudeModelMemo()
  })

  it('compares the preview token without echoing it', () => {
    assert.equal(probeTokensEqual(TOKEN, TOKEN), true)
    assert.equal(probeTokensEqual(TOKEN, 'nope'), false)
    assert.equal(probeTokensEqual(TOKEN, ''), false)
    assert.equal(probeTokensEqual(TOKEN, TOKEN + 'x'), false)
    assert.equal(probeTokenFromEnv(undefined), '')
    assert.equal(probeTokenFromEnv({ PROBE_TOKEN: '   ' }), '')
    assert.equal(probeTokenFromEnv({ PROBE_TOKEN: `  ${TOKEN}  ` }), TOKEN)
    assert.equal(citationsProbeBranchOpen(undefined), false)
    assert.equal(citationsProbeBranchOpen({}), false)
    assert.equal(citationsProbeBranchOpen({ CF_PAGES_BRANCH: '   ' }), false)
    assert.equal(citationsProbeBranchOpen({ CF_PAGES_BRANCH: 'main' }), false)
    assert.equal(citationsProbeBranchOpen({ CF_PAGES_BRANCH: ' main ' }), false)
    assert.equal(citationsProbeBranchOpen({ CF_PAGES_BRANCH: BRANCH }), true)
  })

  it('returns 404 when the token env is missing', async () => {
    const mock = install(() => {
      throw new Error('fetch leaked')
    })
    try {
      const res = await ask('cap=6&domain=linear.app', TOKEN, { PROBE_TOKEN: undefined })
      assert.equal(res.status, 404)
      const body = (await res.json()) as { error?: string }
      assert.equal(body.error, 'Not found')
      assert.equal(JSON.stringify(body).includes(TOKEN), false)
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })

  it('returns 404 when the header is wrong or missing', async () => {
    const mock = install(() => {
      throw new Error('fetch leaked')
    })
    try {
      const wrong = await ask('cap=6&domain=linear.app', 'wrong-token-value')
      assert.equal(wrong.status, 404)
      assert.equal(JSON.stringify(await wrong.json()).includes(TOKEN), false)
      const missing = await ask('cap=6&domain=linear.app', null)
      assert.equal(missing.status, 404)
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })

  it('returns 404 on main even with the correct token', async () => {
    const mock = install(() => {
      throw new Error('fetch leaked')
    })
    try {
      const res = await ask('cap=6&domain=linear.app', TOKEN, { CF_PAGES_BRANCH: 'main' })
      assert.equal(res.status, 404)
      const unset = await ask('cap=6&domain=linear.app', TOKEN, { CF_PAGES_BRANCH: undefined })
      assert.equal(unset.status, 404)
      const padded = await ask('cap=6&domain=linear.app', TOKEN, { CF_PAGES_BRANCH: ' main ' })
      assert.equal(padded.status, 404)
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })

  it('runs on a non-main branch when the token matches', async () => {
    const mock = install((call) => {
      if (call.url.includes('/v1/responses')) {
        return new Response(JSON.stringify(searchPayload(`Search answer ${OPENAI} ${TOKEN}`)), { status: 200 })
      }
      if (call.url.includes('generativelanguage.googleapis.com') && call.body.includes('google_search')) {
        return new Response(JSON.stringify(groundingPayload(`Grounded answer ${GEMINI}`)), { status: 200 })
      }
      if (call.url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"answers":["A plain Gemini answer about tracking work."]}' }] } }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
          }),
          { status: 200 },
        )
      }
      if (call.url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"answers":["A plain Claude answer about tracking work."]}' }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
          { status: 200 },
        )
      }
      if (call.url.includes('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: `ChatGPT plain ${'x'.repeat(120)}` } }],
            usage: { prompt_tokens: 8, completion_tokens: 9 },
          }),
          { status: 200 },
        )
      }
      if (call.url.includes('/rest/v1/checks')) return new Response('[]', { status: 200 })
      throw new Error(`unexpected ${call.url}`)
    })
    const logs: string[] = []
    const prev = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '))
    }
    try {
      const res = await ask('cap=4&domain=linear.app&n=12&order=last', TOKEN, {
        CITATIONS_TIMING_PROBE: 'off',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: SERVICE,
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        ok?: boolean
        cap?: number
        n?: number
        searched?: number
        order?: string
        domain?: string
        calls?: ProbeRow[]
        totals?: { wallMs: number; over8s: number; totalSearches: number; misses: Record<string, number> }
        supabaseMs?: number
        missing_keys?: string[]
        text?: string
      }
      assert.equal(body.ok, true)
      assert.equal(body.cap, 4)
      assert.equal(body.n, 12)
      assert.equal(body.searched, 4)
      assert.equal(body.order, 'last')
      assert.equal(body.domain, 'linear.app')
      assert.equal(body.missing_keys, undefined)
      assert.equal(typeof body.supabaseMs, 'number')
      assert.ok(body.totals)
      assert.equal(body.totals.over8s, 0)
      assert.equal(body.totals.totalSearches, 4 * 2 + 4 * 2)
      assert.equal(body.totals.misses.missing_key, 0)
      const calls = body.calls ?? []
      assert.equal(calls.filter((row) => row.engine === 'gemini' && row.kind === 'plain').length, 2)
      assert.equal(calls.filter((row) => row.engine === 'claude' && row.kind === 'plain').length, 3)
      assert.equal(calls.filter((row) => row.engine === 'chatgpt' && row.kind === 'plain').length, 1)
      assert.equal(calls.filter((row) => row.engine === 'chatgpt' && row.kind === 'search').length, 4)
      assert.equal(calls.filter((row) => row.engine === 'gemini' && row.kind === 'grounded').length, 4)
      assert.equal(calls.at(-1)?.engine, 'supabase')
      const chat = calls.find((row) => row.engine === 'chatgpt' && row.kind === 'plain')
      assert.ok(chat?.text && chat.text.length <= 80)
      assert.equal(chat.text.includes('x'.repeat(81)), false)
      const search = calls.find((row) => row.kind === 'search')
      assert.match(search?.text || '', /\[redacted\]/)
      const grounded = calls.find((row) => row.kind === 'grounded')
      assert.equal(grounded?.hasSearchEntryPoint, true)
      assert.equal(grounded?.citationCount, 2)
      assert.equal(search?.citationCount, 2)
      const encoded = JSON.stringify(body)
      assert.equal(encoded.includes(TOKEN), false)
      assert.equal(encoded.includes(OPENAI), false)
      assert.equal(encoded.includes(GEMINI), false)
      assert.equal(encoded.includes(ANTHROPIC), false)
      assert.equal(encoded.includes(SERVICE), false)
      assert.equal(encoded.includes('search suggestions'), false)
      assert.equal(encoded.includes(PROBE_QUESTION_BANK[0]), false)
      assert.equal(logs.length, calls.length)
      assert.equal(logs.some((line) => line.includes(TOKEN) || line.includes(OPENAI) || line.includes(SERVICE)), false)
      assert.match(logs[0] || '', /^citations-timing /)

      const kinds = mock.calls.map((call) => {
        if (call.url.includes('/v1/responses')) return 'search'
        if (call.url.includes('generativelanguage') && call.body.includes('google_search')) return 'grounded'
        if (call.url.includes('generativelanguage')) return 'gemini'
        if (call.url.includes('anthropic')) return 'claude'
        if (call.url.includes('/v1/chat/completions')) return 'chatgpt'
        if (call.url.includes('/rest/v1/checks')) return 'supabase'
        return call.url
      })
      assert.deepEqual(kinds, [
        'gemini',
        'gemini',
        'claude',
        'claude',
        'claude',
        'chatgpt',
        'search',
        'search',
        'search',
        'search',
        'grounded',
        'grounded',
        'grounded',
        'grounded',
        'supabase',
      ])
      const responses = mock.calls.find((call) => call.url.includes('/v1/responses'))
      const sentSearch = JSON.parse(responses?.body || '{}') as { tool_choice?: string; tools?: { type?: string }[] }
      assert.equal(sentSearch.tool_choice, 'required')
      assert.deepEqual(sentSearch.tools, [{ type: 'web_search' }])
      assert.equal(responses?.headers.authorization?.includes(OPENAI), true)
      const plainGemini = mock.calls.find((call) => call.url.includes('generativelanguage') && !call.body.includes('google_search'))
      const sentGemini = JSON.parse(plainGemini?.body || '{}') as {
        generationConfig?: { responseMimeType?: string; thinkingConfig?: unknown; maxOutputTokens?: number }
      }
      assert.equal(sentGemini.generationConfig?.responseMimeType, 'application/json')
      assert.deepEqual(sentGemini.generationConfig?.thinkingConfig, { thinkingLevel: 'minimal' })
      const completions = mock.calls.find((call) => call.url.includes('/v1/chat/completions'))
      const sentChat = JSON.parse(completions?.body || '{}') as { model?: string; max_tokens?: number }
      assert.equal(sentChat.model, 'gpt-4o-mini')
      assert.equal(sentChat.max_tokens, 350 + 12 * 130)
    } finally {
      console.info = prev
      mock.restore()
    }
  })

  it('starts searched calls first when order=first and reports missing keys', async () => {
    const mock = install((call) => {
      if (call.url.includes('api.openai.com')) throw new Error('openai leaked')
      if (call.url.includes('generativelanguage') && call.body.includes('google_search')) {
        return new Response(JSON.stringify(groundingPayload()), { status: 200 })
      }
      if (call.url.includes('generativelanguage')) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini plain.' }] } }] }), { status: 200 })
      }
      if (call.url.includes('anthropic')) {
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Claude plain.' }] }), { status: 200 })
      }
      throw new Error(`unexpected ${call.url}`)
    })
    try {
      const res = await ask('cap=6&domain=linear.app&n=12&order=first', TOKEN, { OPENAI_API_KEY: '  ' })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { missing_keys?: string[]; calls?: ProbeRow[]; order?: string; searched?: number }
      assert.equal(body.order, 'first')
      assert.equal(body.searched, 6)
      assert.deepEqual(body.missing_keys, ['OPENAI_API_KEY'])
      const search = body.calls?.find((row) => row.kind === 'search')
      assert.equal(search?.miss, 'missing_key')
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(mock.calls[0]?.body.includes('google_search'), true)
      const firstPlain = mock.calls.findIndex((call) => call.url.includes('generativelanguage') && !call.body.includes('google_search'))
      assert.ok(firstPlain > 0)
    } finally {
      mock.restore()
    }
  })
})

describe('probe question list', () => {
  it('stays unbranded and does not call a model', () => {
    assert.equal(PROBE_QUESTION_BANK.length, 12)
    const questions = probeQuestions(14)
    assert.equal(questions.length, 14)
    assert.equal(questions.some((question) => /linear|chatgpt|gemini/i.test(question)), false)
    assert.match(questions[12] || '', /Follow-up 2/)
    const line = probeLogLine({
      engine: 'gemini',
      kind: 'grounded',
      index: 0,
      t_created: 1,
      t_start: 2,
      t_headers: 3,
      t_end: 4,
      ms_total: 3,
      ms_waiting_estimate: 1,
      status: 429,
      miss: 'http_reject',
      tokensIn: 1,
      tokensOut: 2,
      searchCount: 1,
      citationCount: 0,
      attempts: 1,
    })
    assert.equal(line, 'citations-timing gemini grounded 0 http_reject 429 3ms wait=1 in=1 out=2 searches=1 citations=0')
    assert.equal(line.includes(TOKEN), false)
  })
})
})

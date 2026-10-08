/**
 * Claude is a labeled full-report engine. A miss stays soft.
 * Guest /api/visibility does not call Anthropic.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  CLAUDE_MODEL_DEFAULT,
  CLAUDE_MODEL_FALLBACK,
  CLAUDE_TIMEOUT_CAP_MS,
  claudeApiKeyFromEnv,
  claudeMaxOutputTokens,
  claudeMessageBody,
  claudeMissLogLine,
  claudeModelFromEnv,
  claudeReplies,
  claudeSendsEffort,
} from '../functions/api/claude.ts'
import { onRequest as fullReport } from '../functions/api/full-report.ts'
import { onRequest as testQuestion } from '../functions/api/test-question.ts'
import { onRequest as visibility } from '../functions/api/visibility.ts'

const KEY = 'sk-openai-claude-suite-secret'
const ANTHROPIC = 'sk-ant-claude-suite-secret'
const SB = 'https://example.supabase.co'
const SERVICE = 'service-role-claude-suite'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type Call = { url: string; method: string; body: string }

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: urlOf(input),
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
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

function claudeText(text: string, stop: string = 'end_turn') {
  return new Response(
    JSON.stringify({
      stop_reason: stop,
      content: [
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
        { type: 'text', text },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('Claude request shape', () => {
  it('defaults to Haiku 5.5, ignores client env names, and omits sampling params', () => {
    assert.equal(CLAUDE_MODEL_DEFAULT, 'claude-haiku-5-5')
    assert.equal(CLAUDE_MODEL_FALLBACK, 'claude-haiku-4-5')
    assert.equal(CLAUDE_TIMEOUT_CAP_MS, 8_000)
    assert.equal(claudeModelFromEnv(undefined), CLAUDE_MODEL_DEFAULT)
    assert.equal(claudeModelFromEnv({ CLAUDE_MODEL: '  claude-haiku-4-5  ' }), 'claude-haiku-4-5')
    assert.equal(claudeModelFromEnv({ CLAUDE_MODEL: 'https://api.anthropic.com/v1/messages' }), CLAUDE_MODEL_DEFAULT)
    assert.equal(claudeModelFromEnv({ VITE_CLAUDE_MODEL: 'claude-haiku-4-5' } as never), CLAUDE_MODEL_DEFAULT)
    assert.equal(claudeApiKeyFromEnv(undefined), '')
    assert.equal(claudeApiKeyFromEnv({ ANTHROPIC_API_KEY: '  sk-ant-key  ' }), 'sk-ant-key')
    assert.equal(claudeApiKeyFromEnv({ VITE_ANTHROPIC_API_KEY: ANTHROPIC } as never), '')
    assert.equal(claudeSendsEffort(CLAUDE_MODEL_DEFAULT), true)
    assert.equal(claudeSendsEffort(CLAUDE_MODEL_FALLBACK), false)
    const primary = claudeMessageBody(CLAUDE_MODEL_DEFAULT, 'Answer.', 2)
    assert.equal(primary.max_tokens, claudeMaxOutputTokens(2))
    assert.deepEqual(primary.output_config, { effort: 'low' })
    assert.deepEqual(primary.thinking, { type: 'adaptive' })
    assert.equal('temperature' in primary, false)
    assert.equal('top_p' in primary, false)
    assert.equal('top_k' in primary, false)
    const fallback = claudeMessageBody(CLAUDE_MODEL_FALLBACK, 'Answer.', 1)
    assert.equal(fallback.output_config, undefined)
    assert.equal(fallback.thinking, undefined)
    assert.equal(JSON.stringify(fallback).includes('temperature'), false)
    assert.equal(claudeMaxOutputTokens(100), 1_200)
  })

  it('retries a 404 once on Haiku 4.5 without effort, and maps 400 to http_reject', async () => {
    const calls: { model?: string; effort?: unknown; temperature?: unknown }[] = []
    const mock = install(async (call) => {
      const body = JSON.parse(call.body) as {
        model?: string
        output_config?: { effort?: string }
        temperature?: number
      }
      calls.push({ model: body.model, effort: body.output_config?.effort, temperature: body.temperature })
      if (calls.length === 1) return new Response(JSON.stringify({ error: { type: 'not_found_error' } }), { status: 404 })
      return claudeText(JSON.stringify({ answers: ['Monday is a common pick.'] }))
    })
    try {
      const hit = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['What should a team use for issue tracking?'],
        scrub: [ANTHROPIC],
        timeoutMs: 8_000,
      })
      assert.deepEqual(hit.replies, ['Monday is a common pick.'])
      assert.equal(hit.miss, undefined)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]?.model, CLAUDE_MODEL_DEFAULT)
      assert.equal(calls[0]?.effort, 'low')
      assert.equal(calls[0]?.temperature, undefined)
      assert.equal(calls[1]?.model, CLAUDE_MODEL_FALLBACK)
      assert.equal(calls[1]?.effort, undefined)
      assert.equal(JSON.stringify(hit).includes(ANTHROPIC), false)
    } finally {
      mock.restore()
    }

    let posts = 0
    const rejected = install(async () => {
      posts += 1
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'temperature' } }), {
        status: 400,
      })
    })
    try {
      const miss = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['What should a team use?'],
        scrub: [ANTHROPIC],
      })
      assert.deepEqual(miss.replies, [''])
      assert.deepEqual(miss.miss, { class: 'http_reject', status: 400 })
      assert.equal(posts, 1)
      assert.equal(claudeMissLogLine({ class: 'http_reject', status: 400 }), 'claude miss http_reject 400')
      assert.equal(JSON.stringify(miss).includes('temperature'), false)
      assert.equal(JSON.stringify(miss).includes(ANTHROPIC), false)
    } finally {
      rejected.restore()
    }
  })

  it('keeps the five miss classes and never calls when the key or the budget is gone', async () => {
    const quiet = install(() => {
      throw new Error('missing key must not fetch')
    })
    try {
      const missing = await claudeReplies({
        apiKey: '  ',
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['One?'],
        scrub: [],
      })
      assert.deepEqual(missing, { replies: [''], miss: { class: 'missing_key' } })
      const skipped = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['One?'],
        scrub: [],
        timeoutMs: 0,
      })
      assert.deepEqual(skipped.miss, { class: 'timeout' })
    } finally {
      quiet.restore()
    }

    const thrown = install(() => {
      throw new Error(`network ${ANTHROPIC}`)
    })
    try {
      const timed = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['One?'],
        scrub: [ANTHROPIC],
      })
      assert.deepEqual(timed.miss, { class: 'timeout' })
      assert.equal(JSON.stringify(timed).includes(ANTHROPIC), false)
    } finally {
      thrown.restore()
    }

    const bad = install(() => claudeText('not json'))
    try {
      const parsed = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['One?'],
        scrub: [],
      })
      assert.deepEqual(parsed.miss, { class: 'bad_json' })
    } finally {
      bad.restore()
    }

    const blank = install(() => claudeText(JSON.stringify({ answers: [''] })))
    try {
      const empty = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['One?'],
        scrub: [],
      })
      assert.deepEqual(empty.miss, { class: 'empty' })
    } finally {
      blank.restore()
    }
  })
})

describe('guest visibility stays off Claude', () => {
  it('does not call Anthropic and does not return a claude field', async () => {
    const source = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.equal(source.includes('api.anthropic.com'), false)
    assert.equal(source.includes('claudeReplies'), false)
    assert.equal(source.includes('ANTHROPIC_API_KEY'), false)
    const urls: string[] = []
    const mock = install(async (call) => {
      urls.push(call.url)
      if (!call.url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  questions: [
                    'What should a team use for issue tracking?',
                    'Who else should a team use for issue tracking?',
                    'What do support teams use for tickets?',
                  ],
                  answered: 'partial',
                  why: 'Incumbents show up more often than the brand.',
                  whoInstead: ['Jira', 'Asana'],
                  mentions: ['not_mentioned', 'not_mentioned', 'not_mentioned'],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    try {
      const res = await visibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=unbranded'),
        env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: ANTHROPIC, FULL_REPORT_OPENAI: 'off' },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { claude?: unknown; questions?: string[] }
      assert.equal('claude' in body, false)
      assert.equal(body.questions?.length, 3)
      assert.equal(urls.some((url) => url.includes('api.anthropic.com')), false)
      assert.equal(urls.some((url) => url.includes('api.openai.com')), true)
    } finally {
      mock.restore()
    }
  })
})

describe('Claude miss cannot fail a signed-in report or a test question', () => {
  it('returns 200 with the ChatGPT answer when Claude rejects', async () => {
    const kept = 'What should a team use for issue tracking?'
    const mock = install(async (call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    themes: [
                      {
                        id: 'problems',
                        questions: [
                          {
                            question: kept,
                            answer: 'Jira shows up for that job.',
                            mention: 'not_mentioned',
                            whoInstead: ['Jira'],
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (call.url.includes('api.anthropic.com')) {
        assert.equal(call.body.includes('temperature'), false)
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-27T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-27T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.url, { status: 500 })
    })
    try {
      const res = await fullReport({
        request: new Request('https://grank.pages.dev/api/full-report', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'linear.app', owned: [{ question: kept, themeId: 'problems' }] }),
        }),
        env: {
          OPENAI_API_KEY: KEY,
          ANTHROPIC_API_KEY: ANTHROPIC,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
          FULL_REPORT_QUESTION_TARGET: '6',
          FULL_REPORT_THEME_MIN: '1',
          FULL_REPORT_THEME_MAX: '3',
          FREE_FULL_REPORTS: '1',
        },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(ANTHROPIC), false)
      assert.equal(text.includes(KEY), false)
      const body = JSON.parse(text) as {
        claudeMiss?: { class: string; status?: number }
        themes: { questions: { answer: string; claude?: string; framing?: string }[] }[]
      }
      assert.equal(body.themes[0]?.questions[0]?.answer, 'Jira shows up for that job.')
      assert.equal(body.themes[0]?.questions[0]?.claude, '')
      assert.deepEqual(body.claudeMiss, { class: 'http_reject', status: 400 })
      const saved = mock.calls.find((call) => call.method === 'POST' && call.url.includes('/rest/v1/checks'))
      assert.equal(saved?.body.includes('claudeMiss'), false)
      assert.equal(saved?.body.includes(ANTHROPIC), false)
    } finally {
      mock.restore()
    }
  })

  it('returns a Claude miss for one test question and does not write usage', async () => {
    const mock = install(async (call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('api.anthropic.com')) {
        return new Response('no', { status: 404 })
      }
      return new Response('unexpected ' + call.url, { status: 500 })
    })
    try {
      const res = await testQuestion({
        request: new Request('https://grank.test/api/test-question', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            domain: 'linear.app',
            question: 'What should a team use for issue tracking?',
            engine: 'claude',
          }),
        }),
        env: {
          OPENAI_API_KEY: KEY,
          ANTHROPIC_API_KEY: ANTHROPIC,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
          CLAUDE_MODEL: 'claude-haiku-4-5',
        },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const body = JSON.parse(text) as { engine?: string; claude?: string; claudeMiss?: { class: string; status?: number } }
      assert.equal(body.engine, 'claude')
      assert.equal(body.claude, '')
      assert.deepEqual(body.claudeMiss, { class: 'http_reject', status: 404 })
      assert.equal(text.includes(ANTHROPIC), false)
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(mock.calls.some((call) => call.url.includes('usage_events')), false)
      assert.equal(mock.calls.filter((call) => call.url.includes('api.anthropic.com')).length, 1)
    } finally {
      mock.restore()
    }
  })
})

/**
 * Claude is a labeled full-report engine. A miss stays soft.
 * Guest /api/visibility does not call Anthropic.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, it } from 'node:test'
import {
  CLAUDE_CHUNK_SIZE,
  CLAUDE_CHUNK_TOKEN_BASE,
  CLAUDE_CHUNK_TOKENS_PER_QUESTION,
  CLAUDE_MODEL_DEFAULT,
  CLAUDE_MODEL_FALLBACK,
  CLAUDE_TIMEOUT_CAP_MS,
  claudeApiKeyFromEnv,
  claudeChunkMaxOutputTokens,
  claudeMaxOutputTokens,
  claudeMessageBody,
  claudeMissFromChunks,
  claudeMissLogLine,
  claudeModelFromEnv,
  claudeChunkSize,
  claudeQuestionChunks,
  claudeReplies,
  claudeSendsEffort,
  resetClaudeModelMemo,
} from '../functions/api/claude.ts'
import { OWNED_QUESTION_MAX } from '../src/ownedQuestions.ts'
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

describe('Claude request shape', { concurrency: false }, () => {
  beforeEach(() => {
    resetClaudeModelMemo()
  })
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

    resetClaudeModelMemo()
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

describe('Claude full-report chunks', { concurrency: false }, () => {
  beforeEach(() => {
    resetClaudeModelMemo()
  })

  it('keeps at most four chunks and budgets 210 tokens per question in the chunk', () => {
    assert.equal(CLAUDE_CHUNK_SIZE, 4)
    assert.equal(CLAUDE_CHUNK_TOKENS_PER_QUESTION, 210)
    assert.equal(CLAUDE_CHUNK_TOKEN_BASE, 48)
    assert.equal(claudeChunkMaxOutputTokens(4), 888)
    assert.equal(claudeChunkMaxOutputTokens(2), 468)
    assert.equal(claudeMaxOutputTokens(1), 560)
    const expected: Record<number, number[]> = {
      4: [4],
      10: [4, 4, 2],
      16: [4, 4, 4, 4],
      17: [5, 5, 5, 2],
      40: [10, 10, 10, 10],
      80: [20, 20, 20, 20],
    }
    for (const [raw, sizes] of Object.entries(expected)) {
      const count = Number(raw)
      assert.equal(claudeChunkSize(count), sizes[0])
      const questions = Array.from({ length: count }, (_, index) => `q${index}`)
      const slices = claudeQuestionChunks(questions)
      assert.ok(slices.length <= 4)
      assert.deepEqual(
        slices.map((slice) => slice.length),
        sizes,
      )
      assert.deepEqual(slices.flat(), questions)
      for (const slice of slices) {
        const body = claudeMessageBody(CLAUDE_MODEL_DEFAULT, 'Answer.', slice.length, 'chunk')
        assert.equal(body.max_tokens, slice.length * CLAUDE_CHUNK_TOKENS_PER_QUESTION + CLAUDE_CHUNK_TOKEN_BASE)
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.deepEqual(body.output_config, { effort: 'low' })
        assert.equal('temperature' in body, false)
      }
    }
    const fallback = claudeMessageBody(CLAUDE_MODEL_FALLBACK, 'Answer.', 20, 'chunk')
    assert.equal(fallback.max_tokens, 4248)
    assert.equal(fallback.thinking, undefined)
    assert.equal(fallback.output_config, undefined)
    assert.equal(OWNED_QUESTION_MAX, 80)
    assert.deepEqual(claudeMissFromChunks([undefined, { class: 'bad_json' }, { class: 'http_reject', status: 400 }]), {
      class: 'http_reject',
      status: 400,
    })
  })

  it('merges a 10-question batch by position and blanks only the failed chunk', async () => {
    const questions = Array.from({ length: 10 }, (_, index) => `What should a team use for job ${index}?`)
    const bodies: { count: number; thinking?: string; effort?: string; max_tokens?: number; temperature?: unknown }[] = []
    const mock = install(async (call) => {
      const body = JSON.parse(call.body) as {
        max_tokens?: number
        temperature?: number
        thinking?: { type?: string }
        output_config?: { effort?: string }
        messages?: { content?: string }[]
      }
      const prompt = body.messages?.[0]?.content ?? ''
      const count = (prompt.match(/^\d+\. /gm) ?? []).length
      bodies.push({
        count,
        thinking: body.thinking?.type,
        effort: body.output_config?.effort,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
      })
      if (prompt.includes('job 4?')) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 })
      }
      const answers = questions.filter((question) => prompt.includes(question)).map((question) => `Claude ${question}`)
      return claudeText(JSON.stringify({ answers }))
    })
    try {
      const hit = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions,
        scrub: [ANTHROPIC],
        timeoutMs: 8_000,
      })
      assert.equal(bodies.length, 3)
      assert.deepEqual(bodies.map((item) => item.count), [4, 4, 2])
      assert.equal(bodies.every((item) => item.thinking === 'disabled' && item.effort === 'low'), true)
      assert.deepEqual(bodies.map((item) => item.max_tokens), [888, 888, 468])
      assert.equal(bodies.every((item) => item.temperature === undefined), true)
      assert.equal(hit.replies.length, 10)
      assert.equal(hit.replies[0], 'Claude What should a team use for job 0?')
      assert.equal(hit.replies[3], 'Claude What should a team use for job 3?')
      assert.deepEqual(hit.replies.slice(4, 8), ['', '', '', ''])
      assert.equal(hit.replies[8], 'Claude What should a team use for job 8?')
      assert.equal(hit.replies[9], 'Claude What should a team use for job 9?')
      assert.deepEqual(hit.miss, { class: 'http_reject', status: 400 })
      assert.equal(JSON.stringify(hit).includes(ANTHROPIC), false)
    } finally {
      mock.restore()
    }
  })

  it('classifies a truncated chunk as bad_json and keeps the other slices', async () => {
    const questions = Array.from({ length: 6 }, (_, index) => `How do teams handle task ${index}?`)
    const mock = install(async (call) => {
      const body = JSON.parse(call.body) as { messages?: { content?: string }[] }
      const prompt = body.messages?.[0]?.content ?? ''
      if (prompt.includes('task 4?')) {
        return claudeText('{"answers":["cut', 'max_tokens')
      }
      const answers = questions.filter((question) => prompt.includes(question)).map(() => 'Kept.')
      return claudeText(JSON.stringify({ answers }))
    })
    try {
      const hit = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions,
        scrub: [],
      })
      assert.deepEqual(hit.replies.slice(0, 4), ['Kept.', 'Kept.', 'Kept.', 'Kept.'])
      assert.deepEqual(hit.replies.slice(4), ['', ''])
      assert.deepEqual(hit.miss, { class: 'bad_json' })
    } finally {
      mock.restore()
    }
  })

  it('merges every chunk size by position', async () => {
    for (const count of [4, 10, 16, 17, 40, 80]) {
      const questions = Array.from({ length: count }, (_, index) => `Slot ${index} question?`)
      const seen: { max_tokens?: number; questions: string[] }[] = []
      const mock = install(async (call) => {
        const body = JSON.parse(call.body) as { max_tokens?: number; messages?: { content?: string }[] }
        const prompt = body.messages?.[0]?.content ?? ''
        const asked = questions.filter((question) => prompt.includes(question))
        seen.push({ max_tokens: body.max_tokens, questions: asked })
        return claudeText(JSON.stringify({ answers: asked.map((question) => `A ${question}`) }))
      })
      try {
        const hit = await claudeReplies({
          apiKey: ANTHROPIC,
          model: CLAUDE_MODEL_DEFAULT,
          questions,
          scrub: [],
        })
        assert.ok(seen.length <= 4, `n=${count} made ${seen.length} calls`)
        assert.deepEqual(
          seen.map((item) => item.questions.length),
          claudeQuestionChunks(questions).map((slice) => slice.length),
        )
        assert.equal(
          seen.every((item) => item.max_tokens === (item.questions.length * 210 + 48)),
          true,
        )
        assert.deepEqual(
          hit.replies,
          questions.map((question) => `A ${question}`),
        )
        assert.equal(hit.miss, undefined)
      } finally {
        mock.restore()
      }
    }
  })

  it('remembers a 404 and retries each chunk at most once', async () => {
    const questions = Array.from({ length: 80 }, (_, index) => `Category question ${index}?`)
    const seen: { model?: string; thinking?: string; max_tokens?: number }[] = []
    const mock = install(async (call) => {
      const body = JSON.parse(call.body) as {
        model?: string
        max_tokens?: number
        thinking?: { type?: string }
        messages?: { content?: string }[]
      }
      seen.push({ model: body.model, thinking: body.thinking?.type, max_tokens: body.max_tokens })
      const prompt = body.messages?.[0]?.content ?? ''
      if (body.model === CLAUDE_MODEL_DEFAULT) {
        return new Response(JSON.stringify({ error: { type: 'not_found_error' } }), { status: 404 })
      }
      const asked = [...questions, 'What should a team use for issue tracking?'].filter((question) =>
        prompt.includes(question),
      )
      return claudeText(JSON.stringify({ answers: asked.map(() => 'Yes.') }))
    })
    try {
      const first = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions,
        scrub: [],
      })
      const primary = seen.filter((item) => item.model === CLAUDE_MODEL_DEFAULT)
      const fallback = seen.filter((item) => item.model === CLAUDE_MODEL_FALLBACK)
      assert.equal(primary.length, 4)
      assert.equal(primary.every((item) => item.thinking === 'disabled' && item.max_tokens === 4248), true)
      assert.equal(fallback.length, 4)
      assert.equal(fallback.every((item) => item.thinking === undefined && item.max_tokens === 4248), true)
      assert.equal(seen.length, 8)
      assert.equal(first.replies.length, 80)
      assert.equal(first.replies.every((reply) => reply === 'Yes.'), true)
      assert.equal(first.miss, undefined)

      seen.length = 0
      const second = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions,
        scrub: [],
      })
      assert.equal(seen.length, 4)
      assert.equal(seen.every((item) => item.model === CLAUDE_MODEL_FALLBACK), true)
      assert.equal(seen.some((item) => item.model === CLAUDE_MODEL_DEFAULT), false)
      assert.equal(second.replies.every((reply) => reply === 'Yes.'), true)

      seen.length = 0
      const tested = await claudeReplies({
        apiKey: ANTHROPIC,
        model: CLAUDE_MODEL_DEFAULT,
        questions: ['What should a team use for issue tracking?'],
        scrub: [],
      })
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.model, CLAUDE_MODEL_FALLBACK)
      assert.equal(seen[0]?.thinking, undefined)
      assert.equal(tested.replies[0], 'Yes.')
    } finally {
      mock.restore()
    }
  })

  it('returns 200 on Run again when one Claude chunk rejects', async () => {
    const questions = Array.from({ length: 10 }, (_, index) => `What should a team use for job ${index}?`)
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
                        questions: questions.map((question) => ({
                          question,
                          answer: `ChatGPT ${question}`,
                          mention: 'not_mentioned',
                          whoInstead: ['Jira'],
                        })),
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
        const body = JSON.parse(call.body) as { messages?: { content?: string }[]; thinking?: { type?: string } }
        assert.equal(body.thinking?.type, 'disabled')
        assert.equal(call.body.includes('temperature'), false)
        const prompt = body.messages?.[0]?.content ?? ''
        if (prompt.includes('job 4?')) {
          return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 })
        }
        const answers = questions.filter((question) => prompt.includes(question)).map((question) => `Claude ${question}`)
        return claudeText(JSON.stringify({ answers }))
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
          body: JSON.stringify({
            domain: 'linear.app',
            owned: questions.map((question) => ({ question, themeId: 'problems' })),
          }),
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
      const body = JSON.parse(text) as {
        claudeMiss?: { class: string; status?: number }
        themes: { questions: { question: string; answer: string; claude?: string }[] }[]
      }
      const rows = body.themes[0]?.questions ?? []
      assert.equal(rows.length, 10)
      assert.equal(rows[0]?.answer, 'ChatGPT What should a team use for job 0?')
      assert.equal(rows[0]?.claude, 'Claude What should a team use for job 0?')
      assert.equal(rows[4]?.claude, '')
      assert.equal(rows[7]?.claude, '')
      assert.equal(rows[9]?.claude, 'Claude What should a team use for job 9?')
      assert.deepEqual(body.claudeMiss, { class: 'http_reject', status: 400 })
      assert.equal(mock.calls.filter((call) => call.url.includes('api.anthropic.com')).length, 3)
      assert.equal(text.includes(ANTHROPIC), false)
    } finally {
      mock.restore()
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

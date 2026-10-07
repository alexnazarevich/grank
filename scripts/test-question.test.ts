/**
 * One signed-in question, one engine.
 * The route must not meter a full report or rewrite mention, history, or the other engine.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { describe, it } from 'node:test'
import { TEST_QUESTION_SIGN_IN, onRequest } from '../functions/api/test-question.ts'
import { PRODUCT_DEFAULTS } from '../src/config/productConfig.ts'
import type { FullReport } from '../src/fullReport.ts'
import { STORY } from '../src/story.ts'
import { interpretTestQuestionResponse, patchTestAnswer } from '../src/testQuestionClient.ts'

const KEY = 'sk-openai-test-question-secret'
const GEMINI = 'gemini-test-question-secret'
const SB = 'https://example.supabase.co'
const SERVICE = 'service-role-test-secret'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUESTION = 'What should a team use to track issues?'
const OTHER = 'How do teams plan a week?'

type Call = { url: string; method: string; body: string; headers: Headers }

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
      headers: new Headers(init?.headers),
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

function env(extra: Record<string, string> = {}) {
  return {
    OPENAI_API_KEY: KEY,
    GEMINI_API_KEY: GEMINI,
    SUPABASE_URL: SB,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    ...extra,
  }
}

function post(body: unknown, token = 'user-access-token') {
  return new Request('https://grank.test/api/test-question', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function authOk() {
  return new Response(JSON.stringify({ id: USER, email: 'a@example.com' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function openaiOk(question: string, answer: string) {
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
                      question,
                      answer,
                      framing: 'unbranded',
                      mention: 'mentioned',
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
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function geminiOk(text: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify({ answers: [text] }) }] },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function wroteUsage(calls: Call[]): boolean {
  return calls.some(
    (call) =>
      call.url.includes('usage_events') ||
      call.url.includes('/rest/v1/checks') ||
      call.url.includes('/rest/v1/profiles'),
  )
}

const sample = (): FullReport => ({
  domain: 'linear.app',
  model: 'gpt-4o-mini',
  includesBranded: true,
  themes: [
    {
      id: 'problems',
      title: 'Problems you solve',
      framing: 'unbranded',
      questions: [
        {
          question: QUESTION,
          answer: 'Stored OpenAI must stay.',
          framing: 'unbranded',
          mention: 'not_mentioned',
          whoInstead: ['Jira'],
          gemini: 'Stored Gemini until the test.',
        },
        {
          question: OTHER,
          answer: 'Second OpenAI must stay.',
          framing: 'unbranded',
          mention: 'mentioned',
          whoInstead: [],
          gemini: 'Second Gemini must stay.',
        },
      ],
    },
    {
      id: 'described',
      title: 'How you’re described',
      framing: 'branded',
      questions: [
        {
          question: 'What do teams say about Linear?',
          answer: 'Branded OpenAI stays.',
          framing: 'branded',
          whoInstead: [],
        },
      ],
    },
  ],
})

describe('test question route', () => {
  it('rejects guests and does not call a model', async () => {
    const mock = install(() => {
      throw new Error('guest test must not fetch')
    })
    try {
      const res = await onRequest({ request: post({ domain: 'linear.app', question: QUESTION, engine: 'gemini' }, ''), env: env() })
      assert.equal(res.status, 401)
      const body = (await res.json()) as { error?: string }
      assert.equal(body.error, TEST_QUESTION_SIGN_IN)
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })

  it('runs Gemini for one question and skips usage, checks, and OpenAI', async () => {
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      if (call.url.includes('generativelanguage.googleapis.com')) return geminiOk('Only this Gemini block changed.')
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({
          domain: 'linear.app',
          question: QUESTION,
          engine: 'gemini',
          themeId: 'problems',
          questions: [QUESTION, OTHER],
        }),
        env: env(),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { ok?: boolean; engine?: string; gemini?: string }
      assert.deepEqual(Object.keys(body).sort(), ['engine', 'gemini', 'ok'])
      assert.equal(body.ok, true)
      assert.equal(body.engine, 'gemini')
      assert.equal(body.gemini, 'Only this Gemini block changed.')
      const geminiCall = mock.calls.find((call) => call.url.includes('generativelanguage.googleapis.com'))
      assert.ok(geminiCall)
      assert.match(geminiCall.url, /models\/gemini-3\.5-flash-lite:generateContent/)
      assert.match(geminiCall.body, /What should a team use to track issues\?/)
      assert.equal(geminiCall.body.includes(OTHER), false)
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(wroteUsage(mock.calls), false)
      assert.equal(mock.calls.some((call) => call.url.includes('/api/full-report')), false)
    } finally {
      mock.restore()
    }
  })

  it('returns only the OpenAI answer and drops mention and who-instead', async () => {
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      if (call.url.includes('api.openai.com')) return openaiOk(QUESTION, 'OpenAI only this question.')
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({ domain: 'linear.app', question: QUESTION, engine: 'openai', themeId: 'problems' }),
        env: env(),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), ['answer', 'engine', 'ok'])
      assert.equal(body.answer, 'OpenAI only this question.')
      assert.equal(JSON.stringify(body).includes('Jira'), false)
      assert.equal(JSON.stringify(body).includes('mentioned'), false)
      assert.equal(JSON.stringify(body).includes('whoInstead'), false)
      const openai = mock.calls.find((call) => call.url.includes('api.openai.com'))
      assert.ok(openai)
      assert.match(openai.body, /What should a team use to track issues\?/)
      assert.equal(openai.body.includes(OTHER), false)
      assert.equal(mock.calls.some((call) => call.url.includes('generativelanguage.googleapis.com')), false)
      assert.equal(wroteUsage(mock.calls), false)
    } finally {
      mock.restore()
    }
  })

  it('pauses an OpenAI test when FULL_REPORT_OPENAI is off and still allows Gemini', async () => {
    const paused = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({ domain: 'linear.app', question: QUESTION, engine: 'openai' }),
        env: env({ FULL_REPORT_OPENAI: ' off ' }),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { ok?: boolean; engine?: string; openaiPaused?: boolean; answer?: string }
      assert.equal(body.ok, true)
      assert.equal(body.engine, 'openai')
      assert.equal(body.openaiPaused, true)
      assert.equal('answer' in body, false)
      assert.equal(paused.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(paused.calls.some((call) => call.url.includes('generativelanguage.googleapis.com')), false)
      assert.equal(wroteUsage(paused.calls), false)
      const read = interpretTestQuestionResponse(200, body, false)
      assert.deepEqual(read, { ok: true, engine: 'openai', openaiPaused: true })
    } finally {
      paused.restore()
    }

    const gemini = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      if (call.url.includes('generativelanguage.googleapis.com')) return geminiOk('Gemini while OpenAI is paused.')
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({ domain: 'linear.app', question: QUESTION, engine: 'Gemini' }),
        env: env({ FULL_REPORT_OPENAI: 'OFF' }),
      })
      const body = (await res.json()) as { gemini?: string }
      assert.equal(body.gemini, 'Gemini while OpenAI is paused.')
      assert.equal(gemini.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(wroteUsage(gemini.calls), false)
    } finally {
      gemini.restore()
    }
  })

  it('rejects a third engine and a missing OpenAI key without writing usage', async () => {
    const claude = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({ domain: 'linear.app', question: QUESTION, engine: 'claude' }),
        env: env(),
      })
      assert.equal(res.status, 400)
      assert.equal(claude.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(wroteUsage(claude.calls), false)
    } finally {
      claude.restore()
    }

    const missing = install((call) => {
      if (call.url.includes('/auth/v1/user')) return authOk()
      return new Response(`unexpected ${call.url}`, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: post({ domain: 'linear.app', question: QUESTION, engine: 'openai' }),
        env: { ...env(), OPENAI_API_KEY: '  ' },
      })
      assert.equal(res.status, 503)
      const body = (await res.json()) as { error?: string; code?: string; upgrade?: boolean }
      assert.equal(body.error, 'OPENAI_API_KEY not configured')
      assert.equal(body.code, undefined)
      assert.equal(body.upgrade, undefined)
      assert.equal(missing.calls.some((call) => call.url.includes('api.openai.com')), false)
    } finally {
      missing.restore()
    }
  })

  it('does not count as a full report, and cron stays off', () => {
    const limit = interpretTestQuestionResponse(
      402,
      { ok: false, error: 'Check limit reached.', code: 'quota_exceeded', upgrade: true },
      false,
    )
    assert.equal(limit.ok, false)
    assert.equal('code' in limit, false)
    assert.equal('upgrade' in limit, false)
    assert.equal(PRODUCT_DEFAULTS.trackingCronEnabled, false)
    const route = readFileSync(new URL('../functions/api/test-question.ts', import.meta.url), 'utf8')
    const scheduled = readFileSync(new URL('../functions/scheduled.ts', import.meta.url), 'utf8')
    const client = readFileSync(new URL('../src/testQuestionClient.ts', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    assert.equal(route.includes('usage_events'), false)
    assert.equal(route.includes('admitUsage'), false)
    assert.equal(route.includes('appendRunHistory'), false)
    assert.equal(route.includes('/api/full-report'), false)
    assert.equal(route.includes('reserveReport'), false)
    assert.equal(scheduled.includes('test-question'), false)
    assert.equal(scheduled.includes('export async function onRequest'), false)
    assert.equal(scheduled.includes('export function onRequest'), false)
    assert.equal(client.includes('quota'), false)
    assert.equal(client.includes('/api/full-report'), false)
    const handler = app.slice(app.indexOf('async function onRunTestQuestion'), app.indexOf('async function runOwnedReport'))
    assert.equal(handler.includes('async function onRunTestQuestion'), true)
    assert.equal(handler.includes('setQuotaWall'), false)
    assert.equal(handler.includes('setRuns'), false)
    assert.equal(handler.includes('fetchFullReport'), false)
    assert.equal(handler.includes('fetchOwnedReport'), false)
    assert.equal(handler.includes('/api/full-report'), false)
    assert.equal(STORY.runTestQuestion, 'Run test question')
    assert.equal(STORY.engineOpenAI, 'OpenAI')
    assert.equal(STORY.engineGemini, 'Gemini')
    assert.equal(STORY.runTestHelper, 'Only this question, one engine. Not a full report.')
    assert.equal(STORY.runTestBusy, 'Running…')
    assert.equal(STORY.engineFilterHelper, 'Which engines show under each question.')
    assert.equal(STORY.geminiMiss, "Gemini didn't answer.")
  })
})

describe('test question patch', () => {
  it('updates one Gemini block and leaves mention, the other engine, and other questions', () => {
    const report = sample()
    const next = patchTestAnswer(report, QUESTION, { engine: 'gemini', gemini: 'Only this Gemini block changed.' })
    const first = next.themes[0].questions[0]
    const second = next.themes[0].questions[1]
    assert.equal(first.gemini, 'Only this Gemini block changed.')
    assert.equal(first.answer, 'Stored OpenAI must stay.')
    assert.equal(first.mention, 'not_mentioned')
    assert.deepEqual(first.whoInstead, ['Jira'])
    assert.equal(second, report.themes[0].questions[1])
    assert.equal(next.themes[1], report.themes[1])
    const branded = patchTestAnswer(report, 'What do teams say about Linear?', {
      engine: 'gemini',
      gemini: 'Should not attach.',
    })
    assert.equal(branded, report)
  })

  it('updates one OpenAI answer and leaves Gemini, mention, and who-instead', () => {
    const report = sample()
    const next = patchTestAnswer(report, QUESTION, { engine: 'openai', answer: 'Fresh OpenAI answer.' })
    const first = next.themes[0].questions[0]
    assert.equal(first.answer, 'Fresh OpenAI answer.')
    assert.equal(first.gemini, 'Stored Gemini until the test.')
    assert.equal(first.mention, 'not_mentioned')
    assert.deepEqual(first.whoInstead, ['Jira'])
    assert.equal(next.themes[0].questions[1], report.themes[0].questions[1])
  })
})

describe('test question control', () => {
  it('shows the story strings on an open signed-in question and nowhere else', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule(
        '/src/FullReportSection.tsx',
      )) as typeof import('../src/FullReportSection.tsx')
      const report = sample()
      const runs = [
        {
          at: '2026-09-27T12:00:00.000Z',
          mode: 'full' as const,
          mentions: [
            { question: QUESTION, mention: 'not_mentioned' as const, whoInstead: ['Jira'] },
            { question: OTHER, mention: 'mentioned' as const, whoInstead: [] },
          ],
        },
      ]
      const run = () => Promise.resolve({ ok: true as const })
      const closed = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          onRunTestQuestion: run,
        }),
      )
      assert.equal(closed.includes(STORY.runTestQuestion), false)
      assert.match(closed, /Which engines show under each question\./)
      assert.match(closed, /<td>50%<\/td>/)

      const opened = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          topicsOpen: true,
          onRunTestQuestion: run,
        }),
      )
      assert.match(opened, /What should a team use to track issues\?/)
      assert.equal(opened.includes(STORY.runTestQuestion), false)
      assert.equal(opened.includes('Stored OpenAI must stay.'), false)

      const answered = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          answersOpen: true,
          onRunTestQuestion: run,
        }),
      )
      assert.match(answered, /Run test question/)
      assert.match(answered, /Only this question, one engine\. Not a full report\./)
      assert.match(answered, /data-engine="openai"/)
      assert.match(answered, /data-engine="gemini"/)
      assert.match(answered, /Generated · OpenAI/)
      assert.match(answered, /Generated · Gemini/)
      assert.match(answered, /Which engines show under each question\./)
      assert.match(answered, /<td>50%<\/td>/)
      assert.equal(answered.includes('ChatGPT'), false)
      assert.equal(answered.includes('Claude'), false)
      const unsigned = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          answersOpen: true,
        }),
      )
      assert.equal(unsigned.includes(STORY.runTestQuestion), false)

      const branded = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report: {
            ...report,
            themes: report.themes.filter((theme) => theme.framing === 'branded'),
          },
          runs: [],
          answersOpen: true,
          onRunTestQuestion: run,
        }),
      )
      assert.match(branded, /data-engine="openai"/)
      assert.equal(branded.includes('data-engine="gemini"'), false)
      assert.match(branded, /Only this question, one engine\. Not a full report\./)
    } finally {
      await server.close()
    }
  })
})

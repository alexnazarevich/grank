import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { onRequest } from '../functions/api/full-report.ts'
import { PRODUCT_DEFAULTS } from '../src/config/productConfig.ts'
import {
  mentionsBrand,
  selectThemePlan,
  shapeFullReport,
  type PlannedTheme,
} from '../src/fullReport.ts'
import { interpretFullReportResponse } from '../src/fullReportClient.ts'
import { STORY } from '../src/story.ts'

const KEY = 'sk-openai-full-report-secret'
const SB = 'https://example.supabase.co'
const SERVICE = 'service-role-test-secret'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OLDER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CHECK_USAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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

function completionFor(body: string): string {
  const sent = JSON.parse(body) as { messages?: { content?: string }[] }
  const user = sent.messages?.[1]?.content || ''
  const themes: { id: string; questions: { question: string; answer: string; framing: string }[] }[] = []
  const re = /Theme id "([a-z]+)" \([^)]+\): write (\d+) questions ([^\n]+)/g
  let match: RegExpExecArray | null
  let n = 0
  while ((match = re.exec(user))) {
    const id = match[1]
    const count = Number(match[2])
    const instruction = match[3]
    const questions = []
    for (let i = 0; i < count; i++) {
      n += 1
      const branded = instruction.includes('that name') || (instruction.includes('About half') && i % 2 === 0)
      questions.push({
        question: branded ? `What do teams say about Linear number ${n}?` : `What should a team use for job ${n}?`,
        answer: `Generated answer ${n}.`,
        framing: branded ? 'branded' : 'unbranded',
      })
    }
    themes.push({ id, questions })
  }
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ themes }) } }],
  })
}

function env(extra: Record<string, string> = {}) {
  return {
    OPENAI_API_KEY: KEY,
    SUPABASE_URL: SB,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    FULL_REPORT_QUESTION_TARGET: '6',
    FULL_REPORT_THEME_MIN: '3',
    FULL_REPORT_THEME_MAX: '3',
    FREE_FULL_REPORTS: '1',
    ...extra,
  }
}

function authedRequest() {
  return new Request('https://grank.pages.dev/api/full-report', {
    method: 'POST',
    headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'linear.app' }),
  })
}

describe('theme plan', () => {
  it('uses five locked themes and keeps alternatives unbranded', () => {
    const plan = selectThemePlan({
      questionTarget: 55,
      themeMin: 3,
      themeMax: 6,
      includesBranded: true,
    })
    assert.deepEqual(
      plan.map((theme) => theme.title),
      ['Problems you solve', 'How you’re described', 'Trust & proof', 'Alternatives & who else', 'Buying & next step'],
    )
    assert.equal(plan.some((theme) => theme.id === 'edge'), false)
    assert.equal(plan.find((theme) => theme.id === 'alternatives')?.ask, 'unbranded')
    assert.equal(plan.find((theme) => theme.id === 'described')?.ask, 'branded')
    assert.equal(
      plan.reduce((sum, theme) => sum + theme.count, 0),
      55,
    )
    const withEdge = selectThemePlan({
      questionTarget: 12,
      themeMin: 6,
      themeMax: 6,
      includesBranded: false,
    })
    assert.equal(withEdge.at(-1)?.id, 'edge')
    assert.equal(withEdge.every((theme) => theme.ask === 'unbranded'), true)
  })

  it('moves branded dig questions out of alternatives and drops engine themes', () => {
    const plan = selectThemePlan({
      questionTarget: 8,
      themeMin: 3,
      themeMax: 4,
      includesBranded: true,
    })
    const themes = shapeFullReport(
      {
        themes: [
          {
            id: 'problems',
            questions: [
              { question: 'What do teams use to track issues?', answer: 'Trackers and spreadsheets.' },
              { question: 'How does Linear compare on planning?', answer: 'It is often named.' },
            ],
          },
          {
            id: 'described',
            questions: [{ question: 'How do people describe Linear?', answer: 'As a fast tracker.' }],
          },
          {
            id: 'trust',
            questions: [{ question: 'Is Linear trustworthy for a team?', answer: 'Public teams cite it.' }],
          },
          {
            id: 'alternatives',
            questions: [
              { question: 'Who else shows up for issue tracking?', answer: 'Jira and Asana.' },
              { question: 'How does Linear compare to Jira?', answer: 'Both get named.' },
            ],
          },
          {
            id: 'Google results',
            title: 'Perplexity audit',
            questions: [{ question: 'What does Google rank first?', answer: 'A page.' }],
          },
        ],
      },
      { domain: 'linear.app', plan, includesBranded: true, themeMin: 3, questionTarget: 8 },
    )
    assert.ok(themes)
    if (!themes) return
    const alternatives = themes.find((theme) => theme.id === 'alternatives')
    assert.ok(alternatives)
    assert.equal(alternatives.questions.some((item) => mentionsBrand(item.question, 'linear.app')), false)
    assert.equal(alternatives.questions.some((item) => item.framing === 'branded'), false)
    const described = themes.find((theme) => theme.id === 'described')
    assert.equal(described?.questions.some((item) => item.question.includes('compare to Jira')), true)
    assert.equal(themes.some((theme) => /google|perplexity|serp/i.test(theme.title)), false)
    assert.equal(JSON.stringify(themes).includes('%'), false)
    const problems = themes.find((theme) => theme.id === 'problems')
    assert.equal(problems?.questions.some((item) => mentionsBrand(item.question, 'linear.app')), false)
  })

  it('omits an empty theme and drops branded questions when the knob is off', () => {
    const plan: PlannedTheme[] = selectThemePlan({
      questionTarget: 6,
      themeMin: 3,
      themeMax: 3,
      includesBranded: false,
    })
    const themes = shapeFullReport(
      {
        themes: [
          {
            id: 'problems',
            questions: [
              { question: 'What do teams use to track issues?', answer: 'A tracker.' },
              { question: 'How do product teams plan a week?', answer: 'A board.' },
            ],
          },
          {
            id: 'described',
            questions: [
              { question: 'How is a fast tracker usually described?', answer: 'Opinionated and quick.' },
              { question: 'What is Linear known for?', answer: 'Should be dropped.' },
            ],
          },
          {
            id: 'trust',
            questions: [{ question: 'What proof do buyers look for in this category?', answer: 'Customers and reviews.' }],
          },
        ],
      },
      { domain: 'linear.app', plan, includesBranded: false, themeMin: 3, questionTarget: 6 },
    )
    assert.ok(themes)
    if (!themes) return
    assert.equal(themes.some((theme) => theme.id === 'edge'), false)
    const described = themes.find((theme) => theme.id === 'described')
    assert.equal(described?.questions.some((item) => item.question.includes('Linear')), false)
    assert.equal(JSON.stringify(themes).includes('Linear'), false)
  })
})

describe('POST /api/full-report', () => {
  it('refuses a signed-out call before OpenAI or Supabase', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('guest must not generate')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/full-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'linear.app' }),
        }),
        env: env(),
      })
      assert.equal(res.status, 401)
      const body = (await res.json()) as { error?: string }
      assert.match(body.error || '', /Sign in/)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('builds a themed report, saves it, and does not leak secrets', async () => {
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([]), { status: 201 })
      }
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        assert.equal(call.body.includes(KEY), false)
        assert.match(call.body, /gpt-4o-mini/)
        assert.match(call.body, /not a multi-engine scrape/)
        assert.match(call.body, /visibility percentage/)
        assert.match(call.body, /alternatives/)
        return new Response(completionFor(call.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.body, /"kind":"full_report"/)
        assert.equal(call.body.includes('"kind":"check"'), false)
        assert.equal(call.body.includes(SERVICE), false)
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, /kind=eq\.full_report/)
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        assert.match(call.body, /"mode":"unbranded"/)
        assert.match(call.body, /"report":"full"/)
        assert.match(call.body, /Generated · OpenAI/)
        assert.equal(call.body.includes('%'), false)
        assert.equal(call.body.includes(SERVICE), false)
        assert.equal(call.body.includes(KEY), false)
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({ request: authedRequest(), env: env() })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(KEY), false)
      assert.equal(text.includes(SERVICE), false)
      const body = JSON.parse(text) as {
        ok?: boolean
        report?: string
        model?: string
        themes?: { id: string; title: string; questions: { question: string; framing: string; answer: string }[] }[]
        includesBranded?: boolean
        check?: { id?: string }
      }
      assert.equal(body.ok, true)
      assert.equal(body.report, 'full')
      assert.equal(body.model, 'gpt-4o-mini')
      assert.equal(body.check?.id, CHECK)
      assert.equal(body.themes?.length, 3)
      const count = body.themes?.reduce((sum, theme) => sum + theme.questions.length, 0) ?? 0
      assert.equal(count, 6)
      assert.deepEqual(
        body.themes?.map((theme) => theme.title),
        ['Problems you solve', 'How you’re described', 'Trust & proof'],
      )
      const described = body.themes?.find((theme) => theme.id === 'described')
      assert.equal(described?.questions.every((item) => item.framing === 'branded'), true)
      const problems = body.themes?.find((theme) => theme.id === 'problems')
      assert.equal(problems?.questions.every((item) => item.framing === 'unbranded'), true)
      assert.equal(JSON.stringify(body).includes('percent'), false)
      assert.equal(mock.calls.some((call) => call.body.includes('"kind":"check"')), false)
    } finally {
      mock.restore()
    }
  })

  it('keeps alternatives unbranded in the generated set', async () => {
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        assert.match(call.body, /Never put a branded question in alternatives/)
        return new Response(completionFor(call.body), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest(),
        env: env({
          FULL_REPORT_QUESTION_TARGET: '8',
          FULL_REPORT_THEME_MIN: '4',
          FULL_REPORT_THEME_MAX: '4',
        }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const body = JSON.parse(text) as {
        themes: { id: string; title: string; questions: { question: string; framing: string }[] }[]
      }
      const alternatives = body.themes.find((theme) => theme.id === 'alternatives')
      assert.equal(alternatives?.title, 'Alternatives & who else')
      assert.ok(alternatives && alternatives.questions.length > 0)
      assert.equal(
        alternatives.questions.every((item) => item.framing === 'unbranded' && !/linear/i.test(item.question)),
        true,
      )
    } finally {
      mock.restore()
    }
  })

  it('blocks the second free report without calling the model when the paywall is off', async () => {
    const mock = install((call) => {
      if (call.url.includes('api.openai.com') || call.url.startsWith('https://linear.app')) {
        throw new Error('model call leaked past the free report')
      }
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('[]', { status: 201 })
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, new RegExp(USAGE))
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({ request: authedRequest(), env: env({ PAYWALL_ENABLED: 'false' }) })
      const text = await res.text()
      assert.equal(res.status, 403, text)
      assert.equal(text.includes(KEY), false)
      const body = JSON.parse(text) as { code?: string; error?: string }
      assert.equal(body.code, 'full_report_limit')
      assert.equal(body.error, PRODUCT_DEFAULTS.copy.fullReportLimitHit)
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), false)
    } finally {
      mock.restore()
    }
  })

  it('counts a further report as a check when the paywall is on, and stops at the check quota', async () => {
    const blocked = install((call) => {
      if (call.url.includes('api.openai.com') || call.url.startsWith('https://linear.app')) {
        throw new Error('model call leaked past the check quota')
      }
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.method === 'GET' && call.url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        const kind = call.body.includes('full_report') ? USAGE : CHECK_USAGE
        return new Response(JSON.stringify([{ id: kind }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.check')) {
        return new Response(JSON.stringify([{ id: OLDER }, { id: CHECK_USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest(),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '1' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      const body = JSON.parse(text) as { code?: string }
      assert.equal(body.code, 'quota_exceeded')
      assert.equal(blocked.calls.some((call) => call.body.includes('"kind":"check"')), true)
      assert.equal(blocked.calls.some((call) => call.url.includes('api.openai.com')), false)
    } finally {
      blocked.restore()
    }

    const allowed = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        return new Response(completionFor(call.body), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.method === 'GET' && call.url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ plan: 'paid' }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        const kind = call.body.includes('full_report') ? USAGE : CHECK_USAGE
        return new Response(JSON.stringify([{ id: kind }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.check')) {
        return new Response(JSON.stringify([{ id: CHECK_USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(null, { status: 204 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest(),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '3', PAID_QUOTA_AMOUNT: '10' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(allowed.calls.some((call) => call.body.includes('"kind":"check"')), true)
      assert.equal(allowed.calls.filter((call) => call.body.includes('"kind":"full_report"')).length, 1)
    } finally {
      allowed.restore()
    }
  })

  it('releases the free slot when the model output is unusable', async () => {
    let deleted = false
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"themes":[]}' } }] }), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        deleted = true
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({ request: authedRequest(), env: env() })
      assert.equal(res.status, 502)
      assert.equal(deleted, true)
      assert.equal(mock.calls.some((call) => call.url.includes('/rest/v1/checks')), false)
    } finally {
      mock.restore()
    }
  })
})

describe('full report client', () => {
  it('reads a limit and a quota wall without treating them as a report', () => {
    const limit = interpretFullReportResponse(403, { ok: false, code: 'full_report_limit', error: 'You’ve used your free full report.' }, false)
    assert.equal(limit.ok, false)
    if (limit.ok) return
    assert.equal(limit.code, 'full_report_limit')
    const quota = interpretFullReportResponse(402, { code: 'quota_exceeded', error: 'Check limit reached.', plan: 'free' }, false)
    assert.equal(quota.ok, false)
    if (quota.ok) return
    assert.equal(quota.code, 'quota_exceeded')
    assert.equal(quota.plan, 'free')
    const leaked = interpretFullReportResponse(502, { error: `failed ${KEY}` }, false)
    assert.equal(leaked.ok, false)
    if (leaked.ok) return
    assert.equal(leaked.error.includes(KEY), false)
    const down = interpretFullReportResponse(404, null, true)
    assert.equal(down.ok, false)
    if (down.ok) return
    assert.match(down.error, /\/api\/full-report/)
  })
})

describe('guest aha copy stays put', () => {
  it('keeps Check visibility on the homepage and wires the full-report CTA from config', () => {
    assert.equal(STORY.cta, 'Check visibility')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const section = readFileSync(new URL('../src/FullReportSection.tsx', import.meta.url), 'utf8')
    const ui = `${app}\n${section}`
    assert.match(app, /STORY\.cta/)
    assert.match(ui, /showFullReportCta/)
    assert.match(ui, /fullReportMagicLinkHint/)
    assert.match(ui, /fullReportTitle/)
    assert.match(ui, /fullReportSub/)
    assert.match(ui, /fullReportLoading/)
    assert.match(ui, /fullReportEmptyThemes/)
    assert.match(ui, /fullReportLimitHit/)
    assert.match(ui, /themeSectionEyebrow/)
    assert.equal(app.includes('report SKU'), false)
  })
})

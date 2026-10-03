import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { onRequest } from '../functions/api/full-report.ts'
import { BRANDED_SYSTEM_PROMPT, UNBRANDED_SYSTEM_PROMPT } from '../functions/api/visibility.ts'
import { PRODUCT_DEFAULTS } from '../src/config/productConfig.ts'
import {
  FULL_REPORT_SYSTEM_PROMPT,
  applyRunPins,
  fullReportFromStored,
  fullReportPrompt,
  mentionsBrand,
  selectThemePlan,
  shapeFullReport,
  type PlannedTheme,
} from '../src/fullReport.ts'
import { MENTION_FACT_RULES, SHARPER_Q_RULES, mentionFromAnswer } from '../src/mentionFacts.ts'
import { fullReportOpensPayGate, interpretFullReportResponse } from '../src/fullReportClient.ts'
import { mentionStatusLabel, whoInsteadByTopic, whoInsteadCountLabel, whoInsteadNames } from '../src/mentionLabel.ts'
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

function authedRequest(extra: Record<string, unknown> = {}) {
  return new Request('https://grank.pages.dev/api/full-report', {
    method: 'POST',
    headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'linear.app', ...extra }),
  })
}

describe('sharper questions and mention facts', () => {
  it('appends sharper rules and mention fields to the full-report system prompt', () => {
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes(SHARPER_Q_RULES), true)
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes(MENTION_FACT_RULES), true)
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes('not a multi-engine scrape'), true)
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes('What is {brand}?'), true)
  })

  it('asks recommendation-shaped unbranded problems questions and stays honest', () => {
    const plan = selectThemePlan({
      questionTarget: 8,
      themeMin: 4,
      themeMax: 4,
      includesBranded: true,
    })
    const prompt = fullReportPrompt('linear.app', plan, 'Issue tracking for software teams.')
    const problems = prompt.split('\n').filter((line) => line.includes('"problems"') || line.startsWith('On problems answers'))
    assert.match(problems.join('\n'), /recommendation-shaped questions only/)
    assert.match(problems.join('\n'), /what tools, platforms, or software for the job/)
    assert.match(problems.join('\n'), /what teams use for the job/)
    assert.match(problems.join('\n'), /Take the job from the homepage excerpt/)
    assert.match(problems.join('\n'), /Do not name Linear, the product, or linear\.app/)
    assert.match(problems.join('\n'), /Do not ask abstract how-do-I-solve questions/)
    assert.match(
      problems.join('\n'),
      /you may name real products you already know; if unsure, say so plainly and leave whoInstead empty — never invent names, and do not force a company roster/,
    )
    assert.equal(prompt.includes('always return companies'), false)
    assert.equal(prompt.includes('category or job-to-be-done'), false)
    assert.match(prompt, /For "alternatives", ask who else shows up in the category\. Do not mention Linear\./)
    assert.match(FULL_REPORT_SYSTEM_PROMPT, /recommendation-shaped questions that do not name the brand, product, or domain/)
    assert.match(FULL_REPORT_SYSTEM_PROMPT, /what tools, platforms, or software for the job, or what teams use for the job/)
    assert.match(FULL_REPORT_SYSTEM_PROMPT, /using the homepage excerpt for the job/)
    assert.match(
      FULL_REPORT_SYSTEM_PROMPT,
      /On problems answers, you may name real products you already know; if unsure, say so plainly and leave whoInstead empty — never invent names, and do not force a company roster\./,
    )
    assert.match(FULL_REPORT_SYSTEM_PROMPT, /The theme id "alternatives" is unbranded only: who else shows up in the category/)
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes('always return companies'), false)
    assert.equal(FULL_REPORT_SYSTEM_PROMPT.includes('category or job-to-be-done'), false)
    assert.match(UNBRANDED_SYSTEM_PROMPT, /category or job-to-be-done/)
    assert.equal(UNBRANDED_SYSTEM_PROMPT.includes('recommendation-shaped'), false)
    assert.match(BRANDED_SYSTEM_PROMPT, /every question must include the brand name/)
    assert.equal(BRANDED_SYSTEM_PROMPT.includes('recommendation-shaped'), false)
    assert.equal(SHARPER_Q_RULES.includes('recommendation-shaped'), false)
    assert.equal(STORY.landTitle, 'Do you show up for what you solve?')
  })

  it('stores mention and whoInstead, and drops both on a failed answer', () => {
    const plan = selectThemePlan({
      questionTarget: 6,
      themeMin: 3,
      themeMax: 3,
      includesBranded: true,
    })
    const themes = shapeFullReport(
      {
        themes: [
          {
            id: 'problems',
            questions: [
              {
                question: 'What should a team use to track issues?',
                answer: 'Jira and Asana show up for that job.',
                whoInstead: ['Linear', 'Jira', 'Asana', 'Height', 'Nope'],
                mention: 'mentioned',
              },
              {
                question: 'How do teams plan a week?',
                answer: '',
                whoInstead: ['Jira'],
                mention: 'not_mentioned',
              },
            ],
          },
          {
            id: 'described',
            questions: [
              {
                question: 'How do people describe Linear?',
                answer: 'Linear is a fast issue tracker.',
                whoInstead: ['Jira'],
                mention: 'not_mentioned',
              },
            ],
          },
          {
            id: 'trust',
            questions: [
              {
                question: 'Is Linear trustworthy for a team?',
                answer: 'It might be trusted, but that is unclear.',
                mention: 'mentioned',
              },
            ],
          },
        ],
      },
      { domain: 'linear.app', plan, includesBranded: true, themeMin: 3, questionTarget: 6 },
    )
    assert.ok(themes)
    if (!themes) return
    const problems = themes.find((theme) => theme.id === 'problems')
    const cited = problems?.questions.find((item) => item.question.includes('track issues'))
    const failed = problems?.questions.find((item) => item.question.includes('plan a week'))
    assert.equal(cited?.mention, 'unclear')
    assert.deepEqual(cited?.whoInstead, ['Jira', 'Asana', 'Height'])
    assert.equal(cited?.framing, 'unbranded')
    assert.equal(failed?.mention, undefined)
    assert.deepEqual(failed?.whoInstead, [])
    const described = themes.find((theme) => theme.id === 'described')
    assert.equal(described?.questions[0]?.mention, 'mentioned')
    assert.deepEqual(described?.questions[0]?.whoInstead, [])
    const trust = themes.find((theme) => theme.id === 'trust')
    assert.equal(trust?.questions[0]?.mention, 'unclear')
    assert.equal(mentionFromAnswer('', 'linear.app', 'mentioned'), undefined)
    assert.equal(JSON.stringify(themes).includes('%'), false)
  })

  it('places this-run pins without putting a branded question in alternatives', () => {
    const plan = selectThemePlan({
      questionTarget: 4,
      themeMin: 3,
      themeMax: 3,
      includesBranded: true,
    })
    const themes = shapeFullReport(
      {
        themes: [
          { id: 'problems', questions: [{ question: 'What should a team use to track issues?', answer: 'A tracker.' }] },
          { id: 'described', questions: [{ question: 'How do people describe Linear?', answer: 'Linear is fast.' }] },
          { id: 'trust', questions: [{ question: 'Is Linear trustworthy for a team?', answer: 'Public teams cite Linear.' }] },
        ],
      },
      { domain: 'linear.app', plan, includesBranded: true, themeMin: 3, questionTarget: 4 },
    )
    assert.ok(themes)
    if (!themes) return
    const pinned = applyRunPins(
      themes,
      [
        { question: 'Who else should a team use to track issues?', framing: 'unbranded' },
        { question: 'How do buyers describe Linear on speed?', framing: 'unbranded' },
      ],
      { domain: 'linear.app', includesBranded: true },
    )
    const alternatives = pinned.find((theme) => theme.id === 'alternatives')
    const described = pinned.find((theme) => theme.id === 'described')
    assert.equal(alternatives?.questions.some((item) => item.question.includes('Who else')), true)
    assert.equal(alternatives?.questions.every((item) => item.framing === 'unbranded'), true)
    assert.equal(described?.questions.some((item) => item.question.includes('buyers describe Linear')), true)
    const injected = described?.questions.find((item) => item.question.includes('buyers describe Linear'))
    assert.equal(injected?.answer, '')
    assert.equal(injected?.mention, undefined)
    assert.deepEqual(injected?.whoInstead, [])
  })
})

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

  it('keeps buying as two homogeneous themes and does not mix framings', () => {
    const plan = selectThemePlan({
      questionTarget: 10,
      themeMin: 3,
      themeMax: 5,
      includesBranded: true,
    })
    assert.equal(plan.find((theme) => theme.id === 'buying')?.ask, 'split')
    assert.equal(plan.find((theme) => theme.id === 'problems')?.ask, 'unbranded')
    assert.equal(plan.find((theme) => theme.id === 'trust')?.ask, 'branded')
    const prompt = fullReportPrompt('linear.app', plan, null)
    assert.equal(prompt.includes('About half'), false)
    assert.match(prompt, /Never mix both framings in one theme/)
    assert.match(prompt, /Theme id "buying" \(Buying & next step\): write \d+ questions that do not name Linear/)
    assert.match(prompt, /Theme id "buying" \(Buying & next step\): write \d+ questions that name Linear/)
    const themes = shapeFullReport(
      {
        themes: [
          {
            id: 'problems',
            questions: [
              { question: 'What should a team use to track issues?', answer: 'A tracker.' },
              { question: 'How does Linear compare on planning?', answer: 'Linear is often named.' },
            ],
          },
          {
            id: 'described',
            questions: [
              { question: 'How do people describe Linear?', answer: 'Linear is fast.' },
              { question: 'What should a team use to plan a week?', answer: 'A board.' },
            ],
          },
          { id: 'trust', questions: [{ question: 'Is Linear trustworthy for a team?', answer: 'Teams cite Linear.' }] },
          {
            id: 'buying',
            questions: [
              { question: 'What should a team buy for issue tracking?', answer: 'A tracker.' },
              { question: 'Should a team buy Linear next?', answer: 'Linear is one option.' },
            ],
          },
        ],
      },
      { domain: 'linear.app', plan, includesBranded: true, themeMin: 3, questionTarget: 8 },
    )
    assert.ok(themes)
    if (!themes) return
    assert.equal(
      themes.every((theme) => theme.questions.every((item) => item.framing === theme.framing)),
      true,
    )
    const buying = themes.filter((theme) => theme.id === 'buying')
    assert.deepEqual(
      buying.map((theme) => theme.framing),
      ['unbranded', 'branded'],
    )
    assert.equal(buying[0]?.questions.every((item) => !/linear/i.test(item.question)), true)
    assert.equal(buying[1]?.questions.every((item) => /linear/i.test(item.question)), true)
    const problems = themes.find((theme) => theme.id === 'problems')
    assert.equal(problems?.framing, 'unbranded')
    assert.equal(problems?.questions.some((item) => item.question.includes('plan a week')), true)
    assert.equal(problems?.questions.some((item) => /linear/i.test(item.question)), false)
    const described = themes.filter((theme) => theme.id === 'described')
    assert.equal(described.length, 1)
    assert.equal(described[0]?.framing, 'branded')
    const stored = fullReportFromStored({
      report: 'full',
      fullReport: {
        domain: 'linear.app',
        model: 'gpt-4o-mini',
        includesBranded: true,
        themes: [
          {
            id: 'buying',
            questions: [
              { question: 'What should a team buy for issue tracking?', answer: 'A tracker.', mention: 'not_mentioned' },
              { question: 'Should a team buy Linear next?', answer: 'Linear is one option.', mention: 'mentioned' },
            ],
          },
        ],
      },
    })
    assert.deepEqual(
      stored?.themes.map((theme) => [theme.id, theme.framing]),
      [
        ['buying', 'unbranded'],
        ['buying', 'branded'],
      ],
    )
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
        assert.match(call.body, /recommendation-shaped questions only/)
        assert.match(call.body, /do not force a company roster/)
        assert.match(call.body, /unbranded only: who else shows up in the category/)
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
      const res = await onRequest({
        request: authedRequest(),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '3' }),
      })
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
      const withFacts = body.themes as {
        id: string
        questions: { mention?: string; whoInstead?: string[]; framing: string; question: string }[]
      }[]
      assert.equal(
        withFacts.every((theme) =>
          theme.questions.every(
            (item) =>
              item.mention === 'not_mentioned' &&
              Array.isArray(item.whoInstead) &&
              (item.framing === 'branded' ? item.whoInstead.length === 0 : true),
          ),
        ),
        true,
      )
      const openai = mock.calls.find((call) => call.url.includes('api.openai.com'))
      assert.equal(openai?.body.includes(SHARPER_Q_RULES.split('\n')[0]), true)
      assert.equal(openai?.body.includes('not_mentioned'), true)
      assert.equal(openai?.body.includes('whoInstead'), true)
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

  it('keeps a pinned question in this run and in the saved result', async () => {
    const pin = 'Who else should a product team use for issue tracking?'
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        assert.match(call.body, /Pinned unbranded question: Who else should a product team/)
        assert.equal(call.body.includes('saved prompt library'), true)
        return new Response(completionFor(call.body), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        assert.match(call.body, /Who else should a product team/)
        assert.match(call.body, /"id":"alternatives"/)
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest({ pins: [{ question: pin, framing: 'unbranded' }, { question: pin, framing: 'branded' }] }),
        env: env(),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const body = JSON.parse(text) as {
        themes: { id: string; questions: { question: string; framing: string; mention?: string; whoInstead: string[] }[] }[]
      }
      const alternatives = body.themes.find((theme) => theme.id === 'alternatives')
      const pinned = alternatives?.questions.find((item) => item.question === pin)
      assert.ok(pinned)
      assert.equal(pinned?.framing, 'unbranded')
      assert.equal(pinned?.mention, undefined)
      assert.deepEqual(pinned?.whoInstead, [])
      assert.equal(body.themes.some((theme) => theme.id === 'alternatives' && theme.questions.some((item) => /linear/i.test(item.question))), false)
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), true)
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

  it('opens the pay gate on a second full report and does not spend free check quota', async () => {
    const blocked = install((call) => {
      if (call.url.includes('api.openai.com') || call.url.startsWith('https://linear.app')) {
        throw new Error('model call leaked past the free full report')
      }
      if (call.body.includes('"kind":"check"')) {
        throw new Error('free check quota must not buy another full report')
      }
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.method === 'GET' && call.url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.body, /"kind":"full_report"/)
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest(),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '3' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      const body = JSON.parse(text) as { code?: string; upgrade?: boolean; plan?: string; error?: string }
      assert.equal(body.code, 'full_report_limit')
      assert.equal(body.upgrade, true)
      assert.equal(body.plan, 'free')
      assert.equal(body.error, PRODUCT_DEFAULTS.copy.fullReportLimitHit)
      assert.equal(blocked.calls.some((call) => call.body.includes('"kind":"check"')), false)
      assert.equal(blocked.calls.some((call) => call.url.includes('api.openai.com')), false)
      assert.equal(blocked.calls.some((call) => call.url.includes('/rest/v1/checks')), false)
    } finally {
      blocked.restore()
    }
  })

  it('lets a paid plan spend check quota on a further full report', async () => {
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
    assert.equal(limit.upgrade, false)
    assert.equal(fullReportOpensPayGate(limit), false)
    const wall = interpretFullReportResponse(
      402,
      { ok: false, code: 'full_report_limit', error: 'You’ve used your free full report.', upgrade: true, plan: 'free' },
      false,
    )
    assert.equal(wall.ok, false)
    if (wall.ok) return
    assert.equal(wall.code, 'full_report_limit')
    assert.equal(wall.upgrade, true)
    assert.equal(wall.plan, 'free')
    assert.equal(fullReportOpensPayGate(wall), true)
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
  it('does not route the short land through the full-report allotment', () => {
    const visibility = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.equal(visibility.includes('freeFullReports'), false)
    assert.equal(visibility.includes('full_report_limit'), false)
    assert.equal(visibility.includes('FULL_REPORT'), false)
  })

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
    assert.match(app, /fullReportOpensPayGate/)
    assert.match(app, /<h2>\{config\.copy\.upgradeHeadline\}<\/h2>/)
    assert.match(app, /<p>\{config\.copy\.upgradeBody\}<\/p>/)
    assert.equal(app.includes('Need more checks?'), false)
    assert.equal(PRODUCT_DEFAULTS.copy.upgradeHeadline, 'Free limit reached')
    assert.match(PRODUCT_DEFAULTS.copy.upgradeBody, /more full reports, saved checks, and ongoing land and dig/)
    assert.match(section, /STORY\.landEyebrow/)
    assert.match(section, /STORY\.digEyebrow/)
    assert.equal(section.includes('themeSectionEyebrow'), false)
    assert.equal(section.includes('q-badge'), false)
    assert.equal(app.includes('report SKU'), false)
    assert.equal(app.includes('showFullAnswer'), false)
    assert.equal(app.includes('hideAnswer'), false)
    assert.equal(app.includes('answer-expand'), false)
    assert.equal(app.includes('report-q-toggle'), false)
    assert.equal(app.includes('aria-expanded'), false)
    assert.match(app, /<p className="answer-body">\{answer \|\| STORY\.answerMiss\}<\/p>/)
    assert.equal(section.includes('showFullAnswer'), false)
    assert.equal(section.includes('hideAnswer'), false)
    assert.equal(section.includes('Show full answer'), false)
    assert.equal(section.includes('Hide answer'), false)
    assert.equal(section.includes('answer-expand'), false)
    assert.equal(section.includes('splitAnswerSkim'), false)
    assert.equal(section.includes('answerSkim'), false)
    assert.equal(/fetch\s*\(/.test(section), false)
    assert.equal(section.includes('openai.com'), false)
    assert.equal(section.includes('useEffect'), false)
  })
})

describe('full-report question accordion', () => {
  it('uses the same mention labels as the land skim', () => {
    const copy = PRODUCT_DEFAULTS.copy
    assert.equal(mentionStatusLabel('mentioned', copy), 'Mentioned')
    assert.equal(mentionStatusLabel('not_mentioned', copy), 'Not mentioned')
    assert.equal(mentionStatusLabel('unclear', copy), 'Unclear')
    assert.deepEqual(whoInsteadNames([' Jira ', 'Asana', 'Height', 'Extra'], 'unbranded'), [' Jira ', 'Asana', 'Height'])
    assert.deepEqual(whoInsteadNames(['Jira', 'Asana'], 'unbranded'), ['Jira', 'Asana'])
    assert.deepEqual(whoInsteadNames(['Jira'], 'branded'), [])
    assert.equal(STORY.whoInsteadBoardTitle, 'Who showed up instead')
    assert.equal(
      STORY.whoInsteadBoardHelper,
      'By topic, on unbranded questions this run — not market share.',
    )
    assert.equal(STORY.whoInsteadBoardEmpty, 'No one else showed up yet.')
    assert.equal(STORY.whoInsteadBoardCount, 'Appeared on {n} questions')
    assert.equal(whoInsteadCountLabel(STORY.whoInsteadBoardCount, 2), 'Appeared on 2 questions')
    assert.equal(whoInsteadCountLabel(STORY.whoInsteadBoardCount, 1), 'Appeared on 1 questions')
    const topics = whoInsteadByTopic([
      {
        id: 'problems',
        title: 'Problems you solve',
        framing: 'unbranded',
        questions: [
          { question: 'Track issues?', framing: 'unbranded', mention: 'not_mentioned', whoInstead: ['Jira', 'Asana', 'jira'] },
          { question: 'Plan a week?', framing: 'unbranded', mention: 'unclear', whoInstead: [' Height ', 'Jira'] },
          { question: 'You showed up', framing: 'unbranded', mention: 'mentioned', whoInstead: ['Notion'] },
          { question: 'No fact', framing: 'unbranded', whoInstead: ['Coda'] },
        ],
      },
      {
        id: 'described',
        title: 'How you’re described',
        framing: 'branded',
        questions: [
          { question: 'Describe you?', framing: 'branded', mention: 'not_mentioned', whoInstead: ['Slack', 'Jira'] },
        ],
      },
      {
        id: 'alternatives',
        title: 'Alternatives & who else',
        framing: 'unbranded',
        questions: [
          {
            question: 'Who else tracks issues?',
            framing: 'unbranded',
            mention: 'not_mentioned',
            whoInstead: ['Linear', 'Jira', 'Height', 'Extra'],
          },
        ],
      },
      {
        id: 'buying',
        title: 'Buying & next step',
        framing: 'unbranded',
        questions: [
          { question: 'What should I buy?', framing: 'unbranded', mention: 'mentioned', whoInstead: ['Notion'] },
        ],
      },
    ])
    assert.deepEqual(
      topics.map((topic) => topic.title),
      ['Problems you solve', 'Alternatives & who else'],
    )
    assert.deepEqual(topics[0]?.names, [
      { name: 'Jira', questions: 2 },
      { name: 'Asana', questions: 1 },
      { name: 'Height', questions: 1 },
    ])
    assert.deepEqual(topics[0]?.questions, [
      { question: 'Track issues?', names: ['Jira', 'Asana'] },
      { question: 'Plan a week?', names: ['Height', 'Jira'] },
    ])
    assert.deepEqual(topics[1]?.names, [
      { name: 'Height', questions: 1 },
      { name: 'Jira', questions: 1 },
      { name: 'Linear', questions: 1 },
    ])
    assert.deepEqual(topics[1]?.questions, [
      { question: 'Who else tracks issues?', names: ['Linear', 'Jira', 'Height'] },
    ])
    assert.equal(topics.some((topic) => topic.id === 'described' || topic.id === 'buying'), false)
    assert.equal(JSON.stringify(topics).includes('Slack'), false)
    assert.equal(JSON.stringify(topics).includes('Notion'), false)
    assert.equal(JSON.stringify(topics).includes('Coda'), false)
    assert.equal(JSON.stringify(topics).includes('Extra'), false)
    assert.deepEqual(
      whoInsteadByTopic([{ id: 'problems', title: 'Problems you solve', framing: 'unbranded', questions: [] }]),
      [],
    )
    assert.deepEqual(
      whoInsteadByTopic([
        {
          id: 'trust',
          title: 'Trust & proof',
          framing: 'branded',
          questions: [{ question: 'Proof?', framing: 'branded', mention: 'not_mentioned', whoInstead: ['Slack'] }],
        },
      ]),
      [],
    )
    assert.equal(/SOV|market share %|% mentioned|Competitors/.test(whoInsteadCountLabel(STORY.whoInsteadBoardCount, 4)), false)
    assert.equal(/SOV|Competitors|competitive share/.test(STORY.whoInsteadBoardHelper), false)
  })

  it('opens the answer from the question and keeps the chip trailing', () => {
    const section = readFileSync(new URL('../src/FullReportSection.tsx', import.meta.url), 'utf8')
    const mark = readFileSync(new URL('../src/MentionMark.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
    assert.match(section, /aria-expanded=\{open\}/)
    assert.match(section, /className="report-q-toggle"/)
    assert.match(section, /aria-label=\{item\.question\}/)
    assert.match(section, /mentionStatusLabel\(item\.mention, copy\)/)
    assert.match(section, /whoInsteadNames\(item\.whoInstead, item\.framing\)/)
    const render = section.slice(section.indexOf('export function FullReportSection'))
    const boardAt = render.indexOf('<WhoInsteadBoard')
    const themeBlockAt = render.indexOf('theme-block')
    assert.equal(boardAt > 0 && themeBlockAt > boardAt, true)
    assert.match(section, /whoInsteadByTopic\(report\.themes\)/)
    assert.equal(section.includes('whoInsteadBoard('), false)
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    assert.equal(app.includes('WhoInsteadBoard'), false)
    assert.equal(app.includes('who-instead-land'), false)
    assert.match(
      section,
      /className=\{`tag plain mention report-mention\$\{item\.mention === 'mentioned' \? ' mentioned' : ''\}`\}/,
    )
    assert.match(section, /item\.answer/)
    assert.match(section, /STORY\.answerMiss/)
    const openAt = section.indexOf('{open ?')
    assert.equal(openAt > 0, true)
    const openBranch = section.slice(openAt)
    assert.match(openBranch, /mention-names/)
    assert.match(openBranch, /answer-body/)
    assert.equal(section.slice(0, openAt).includes('mention-names'), false)
    assert.equal(section.slice(0, openAt).includes('answer-body'), false)
    assert.match(mark, /mentionStatusLabel\(mention, copy\)/)
    assert.match(mark, /whoInsteadNames\(whoInstead, framing\)/)
    assert.match(mark, /mention-names/)
    assert.equal(mark.includes('answer-expand'), false)
    assert.equal(mark.includes('showFullAnswer'), false)
    assert.match(css, /\.report-q-head\s*\{[^}]*flex-wrap:\s*wrap/)
    assert.match(css, /\.report-q-head\s*\{[^}]*align-items:\s*flex-start/)
    assert.match(css, /\.report-q-toggle\s*\{[^}]*flex:\s*1\s+1\s+auto/)
    assert.match(css, /\.report-q-toggle\s*\{[^}]*min-width:\s*0/)
    assert.match(css, /\.report-mention\s*\{[^}]*flex:\s*none/)
    assert.equal(/\.report-mention\s*\{[^}]*flex:\s*0\s+0/.test(css), false)
    assert.equal(/\.report-mention\s*\{[^}]*flex-basis:\s*\d/.test(css), false)
    assert.match(css, /\.report-mention\.mentioned\s*\{[^}]*background:\s*#064e3b/)
    assert.match(css, /\.report-mention\.mentioned\s*\{[^}]*color:\s*var\(--yes\)/)
    assert.match(css, /\.report-mention\.mentioned\s*\{[^}]*border-color:\s*#065f46/)
    assert.equal(mark.includes('report-mention'), false)
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.report-q-toggle\s*\{[^}]*flex:\s*none/)
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.report-q-toggle\s*\{[^}]*width:\s*100%/)
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.report-mention\s*\{[^}]*flex:\s*none/)
  })

  it('answers an owned question set instead of writing a new roster', async () => {
    const kept = 'What should a team use for issue tracking?'
    const added = 'How do teams describe Linear?'
    const mock = install((call) => {
      if (call.url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('{}', { status: 201 })
      if (call.url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (call.url.includes('api.openai.com')) {
        assert.match(call.body, /Do not add questions/)
        assert.match(call.body, /Do not rewrite question text/)
        assert.equal(/write \d+ questions/.test(call.body), false)
        assert.match(call.body, new RegExp(kept.replace(/[?]/g, '\\?')))
        assert.match(call.body, /How do teams describe Linear/)
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
                            question: 'What tool should I buy instead?',
                            answer: 'Jira shows up for that job.',
                            mention: 'mentioned',
                            whoInstead: ['Jira', 'Asana'],
                          },
                        ],
                      },
                      {
                        id: 'described',
                        questions: [
                          {
                            question: added,
                            answer: 'Linear is a fast issue tracker for software teams.',
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
          { status: 200 },
        )
      }
      if (call.url.includes('/rest/v1/usage_events')) {
        throw new Error('owned re-run must not spend a full-report allotment')
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/checks')) {
        assert.match(call.body, /questionSetOwned/)
        assert.match(call.body, /What should a team use for issue tracking/)
        assert.match(call.body, /How do teams describe Linear/)
        assert.equal(call.body.includes('What tool should I buy'), false)
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-27T00:00:00.000Z' }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: CHECK, created_at: '2026-09-27T00:00:00.000Z' }]), { status: 200 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onRequest({
        request: authedRequest({
          owned: [
            { question: kept, themeId: 'problems' },
            { question: added, themeId: 'described' },
          ],
        }),
        env: env(),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(KEY), false)
      const body = JSON.parse(text) as {
        themes: { id: string; questions: { question: string; mention?: string; answer: string; whoInstead: string[] }[] }[]
      }
      const problems = body.themes.find((theme) => theme.id === 'problems')?.questions[0]
      const described = body.themes.find((theme) => theme.id === 'described')?.questions[0]
      assert.equal(problems?.question, kept)
      assert.equal(problems?.mention, 'unclear')
      assert.deepEqual(problems?.whoInstead, ['Jira', 'Asana'])
      assert.equal(described?.question, added)
      assert.equal(described?.mention, 'mentioned')
      assert.deepEqual(described?.whoInstead, [])
      assert.equal(body.themes.some((theme) => theme.questions.some((item) => item.question === 'What tool should I buy instead?')), false)
      assert.equal(mock.calls.some((call) => call.url.includes('kind=eq.full_report')), false)
    } finally {
      mock.restore()
    }
  })
})

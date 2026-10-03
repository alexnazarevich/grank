import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { saveCheck } from '../src/checksClient.ts'
import { PRODUCT_DEFAULTS, productConfigFromEnv } from '../src/config/productConfig.ts'
import { LABEL_GENERATED, LABEL_SAMPLE, LABEL_UNBRANDED, screenFromSaved, viewFromAha, viewFromSaved } from '../src/savedResult.ts'
import { idsBeyondCap, retentionCutoffIso, shapeStoredCheck } from '../functions/api/shapeCheck.ts'
import { onRequest, SAVE_REQUIRES_PLAN, SERVER_AUTH_NOT_CONFIGURED } from '../functions/api/checks.ts'

const SECRET = 'service-role-test-secret'
const URL = 'https://example.supabase.co'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NEW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OLD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const DRAFT = {
  domain: 'linear.app',
  mode: 'unbranded',
  questions: ['What is Linear?', 'Linear vs Jira?', 'Is Linear worth it?'],
  questionsGenerated: true,
  answered: 'partial',
  answeredWhy: 'Linear is known, but comparison answers often cite other tools.',
  answeredLive: true,
  model: 'gpt-4o-mini',
  whoInstead: ['Linear', 'Jira', 'Asana'],
  whoInsteadLive: true,
  homepageSupport: 'Supporting homepage fetch: Partial. Page content only — not the model read.',
  homepageSnippet: 'secret homepage body with emails@example.com',
}

function env(extra: Record<string, string> = {}) {
  return { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SECRET, ...extra }
}

describe('shapeStoredCheck', () => {
  it('keeps questions, answers, and who-instead, and drops the homepage snippet by default', () => {
    const shaped = shapeStoredCheck(DRAFT, PRODUCT_DEFAULTS, SECRET)
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal(shaped.domain, 'linear.app')
    assert.equal(shaped.mode, 'unbranded')
    assert.deepEqual(shaped.result.questions, DRAFT.questions)
    assert.equal(shaped.result.answers?.answered, 'partial')
    assert.deepEqual(shaped.result.whoInstead, ['Jira', 'Asana'])
    assert.equal(shaped.result.homepageSupport, DRAFT.homepageSupport)
    assert.equal('homepageSnippet' in shaped.result, false)
    assert.equal(shaped.result.labels.questions, LABEL_GENERATED)
    assert.equal(shaped.result.labels.whoInstead, LABEL_GENERATED)
    assert.equal(shaped.result.labels.mode, LABEL_UNBRANDED)
    assert.equal(shaped.result.model, 'gpt-4o-mini')
  })

  it('omits fields when store flags are off and still keeps labels', () => {
    const config = productConfigFromEnv({
      STORE_QUESTIONS: 'false',
      STORE_ANSWERS: 'false',
      STORE_WHO_INSTEAD: 'false',
      STORE_HOMEPAGE_SNIPPET: 'false',
    })
    const shaped = shapeStoredCheck(DRAFT, config, SECRET)
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal('questions' in shaped.result, false)
    assert.equal('answers' in shaped.result, false)
    assert.equal('whoInstead' in shaped.result, false)
    assert.equal('homepageSnippet' in shaped.result, false)
    assert.equal('homepageSupport' in shaped.result, false)
    assert.equal(shaped.result.labels.questions, LABEL_GENERATED)
    assert.equal(shaped.result.labels.mode, LABEL_UNBRANDED)
  })

  it('stores the homepage snippet only when the knob is on, and scrubs the service key', () => {
    const config = productConfigFromEnv({ STORE_HOMEPAGE_SNIPPET: 'true' })
    const shaped = shapeStoredCheck(
      { ...DRAFT, answeredWhy: `leak ${SECRET} in the why`, homepageSnippet: `body ${SECRET}` },
      config,
      SECRET,
    )
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.match(shaped.result.homepageSnippet || '', /body \[redacted\]/)
    assert.match(shaped.result.answers?.why || '', /\[redacted\]/)
    assert.equal(JSON.stringify(shaped.result).includes(SECRET), false)
  })

  it('labels sample questions when generation failed', () => {
    const shaped = shapeStoredCheck({ ...DRAFT, questionsGenerated: false, answeredLive: false, answered: null }, PRODUCT_DEFAULTS)
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal(shaped.result.labels.questions, LABEL_SAMPLE)
    assert.equal(shaped.result.questionsGenerated, false)
    assert.equal(shaped.result.answers?.live, false)
  })

  it('rejects a non-hostname', () => {
    const shaped = shapeStoredCheck({ ...DRAFT, domain: 'http://linear.app/path' }, PRODUCT_DEFAULTS)
    assert.equal(shaped.ok, false)
  })

  it('keeps branded replies on the dig and who-instead on the unbranded beat', () => {
    const shaped = shapeStoredCheck(
      {
        ...DRAFT,
        mode: 'branded',
        replies: ['Linear is an issue tracker.', ''],
        whoInstead: ['Jira'],
        unbranded: {
          questions: DRAFT.questions,
          questionsGenerated: true,
          answered: 'partial',
          answeredWhy: DRAFT.answeredWhy,
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Jira', 'Asana'],
          whoInsteadLive: true,
        },
        branded: {
          questions: ['What is Linear known for?'],
          questionsGenerated: true,
          replies: ['Teams cite Linear for issue tracking.'],
          answered: 'yes',
          answeredWhy: 'The brand is named in branded questions.',
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Should not stick'],
        },
      },
      PRODUCT_DEFAULTS,
      SECRET,
    )
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal(shaped.mode, 'branded')
    assert.equal('whoInstead' in shaped.result, false)
    assert.deepEqual(shaped.result.answers?.replies, ['Linear is an issue tracker.', ''])
    assert.deepEqual(shaped.result.unbranded?.whoInstead, ['Jira', 'Asana'])
    assert.deepEqual(shaped.result.branded?.replies, ['Teams cite Linear for issue tracking.'])
    assert.equal('whoInstead' in (shaped.result.branded || {}), false)
    assert.equal(shaped.result.labels.mode, 'Branded')
  })

  it('stores Gemini text beside the OpenAI answer, and a miss does not clear it', () => {
    const withText = shapeStoredCheck(
      {
        ...DRAFT,
        gemini: ['Monday is a common pick for this job.', '', ''],
        unbranded: {
          questions: DRAFT.questions,
          questionsGenerated: true,
          answered: 'partial',
          answeredWhy: DRAFT.answeredWhy,
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Jira', 'Asana'],
          whoInsteadLive: true,
          gemini: ['Monday is a common pick for this job.', '', ''],
          facts: [
            {
              question: DRAFT.questions[0],
              framing: 'unbranded',
              id: 'problems',
              mention: 'not_mentioned',
              whoInstead: ['Jira', 'Asana'],
            },
          ],
        },
      },
      PRODUCT_DEFAULTS,
    )
    assert.equal(withText.ok, true)
    if (!withText.ok) return
    assert.equal(withText.result.answers?.answered, 'partial')
    assert.equal(withText.result.answers?.why, DRAFT.answeredWhy)
    assert.deepEqual(withText.result.whoInstead, ['Jira', 'Asana'])
    assert.deepEqual(withText.result.gemini, ['Monday is a common pick for this job.', '', ''])
    assert.deepEqual(withText.result.unbranded?.gemini, ['Monday is a common pick for this job.', '', ''])
    assert.deepEqual(withText.result.unbranded?.whoInstead, ['Jira', 'Asana'])
    assert.equal(withText.result.facts?.[0]?.mention, 'not_mentioned')
    assert.deepEqual(withText.result.facts?.[0]?.whoInstead, ['Jira', 'Asana'])
    assert.equal(JSON.stringify(withText.result.facts).includes('Monday'), false)
    assert.equal(JSON.stringify(withText.result.whoInstead).includes('Monday'), false)

    const missed = shapeStoredCheck(
      {
        ...DRAFT,
        gemini: ['', '', ''],
        unbranded: {
          questions: DRAFT.questions,
          questionsGenerated: true,
          answered: 'partial',
          answeredWhy: DRAFT.answeredWhy,
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Jira', 'Asana'],
          whoInsteadLive: true,
          gemini: ['', '', ''],
        },
      },
      PRODUCT_DEFAULTS,
    )
    assert.equal(missed.ok, true)
    if (!missed.ok) return
    assert.equal(missed.result.answers?.answered, 'partial')
    assert.equal(missed.result.answers?.live, true)
    assert.deepEqual(missed.result.whoInstead, ['Jira', 'Asana'])
    assert.deepEqual(missed.result.gemini, ['', '', ''])
    assert.deepEqual(missed.result.unbranded?.gemini, ['', '', ''])
    const reopened = screenFromSaved({
      id: 'check',
      domain: 'linear.app',
      mode: 'unbranded',
      createdAt: '2026-10-03T00:00:00.000Z',
      result: missed.result,
    })
    assert.equal(reopened.unbranded.answered, 'partial')
    assert.deepEqual(reopened.unbranded.whoInstead, ['Jira', 'Asana'])
    assert.deepEqual(reopened.unbranded.gemini, ['', '', ''])

    const hidden = shapeStoredCheck(
      { ...DRAFT, gemini: ['Monday is a common pick.'] },
      productConfigFromEnv({ STORE_ANSWERS: 'false' }),
    )
    assert.equal(hidden.ok, true)
    if (!hidden.ok) return
    assert.equal('answers' in hidden.result, false)
    assert.equal('gemini' in hidden.result, false)
  })

  it('does not store Gemini on the branded beat', () => {
    const shaped = shapeStoredCheck(
      {
        ...DRAFT,
        mode: 'branded',
        replies: ['Linear is an issue tracker.'],
        gemini: ['Should not land on the branded result.'],
        branded: {
          questions: ['What is Linear known for?'],
          questionsGenerated: true,
          replies: ['Teams cite Linear for issue tracking.'],
          answered: 'yes',
          answeredWhy: 'The brand is named in branded questions.',
          answeredLive: true,
          model: 'gpt-4o-mini',
          gemini: ['Should not land on branded.'],
        },
        unbranded: {
          questions: DRAFT.questions,
          questionsGenerated: true,
          answered: 'partial',
          answeredWhy: DRAFT.answeredWhy,
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Jira'],
          whoInsteadLive: true,
          gemini: ['A category reply that stays on unbranded.'],
        },
      },
      PRODUCT_DEFAULTS,
    )
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal('gemini' in shaped.result, false)
    assert.deepEqual(shaped.result.answers?.replies, ['Linear is an issue tracker.'])
    assert.equal('gemini' in (shaped.result.branded || {}), false)
    assert.deepEqual(shaped.result.unbranded?.gemini, ['A category reply that stays on unbranded.'])
    assert.deepEqual(shaped.result.unbranded?.whoInstead, ['Jira'])
  })

  it('persists per-question mention facts with stable theme ids', () => {
    const shaped = shapeStoredCheck(
      {
        ...DRAFT,
        unbranded: {
          questions: DRAFT.questions,
          questionsGenerated: true,
          answered: 'no',
          answeredWhy: DRAFT.answeredWhy,
          answeredLive: true,
          model: 'gpt-4o-mini',
          whoInstead: ['Jira', 'Asana'],
          whoInsteadLive: true,
          facts: [
            {
              question: 'What should a team use to track issues?',
              framing: 'unbranded',
              id: 'problems',
              mention: 'not_mentioned',
              whoInstead: ['Linear', 'Jira', 'Asana', 'Height'],
            },
            {
              question: 'Who else shows up for issue tracking?',
              framing: 'unbranded',
              id: 'alternatives',
              mention: 'not_mentioned',
              whoInstead: ['Jira'],
            },
          ],
        },
      },
      PRODUCT_DEFAULTS,
      SECRET,
    )
    assert.equal(shaped.ok, true)
    if (!shaped.ok) return
    assert.equal(shaped.result.facts?.length, 2)
    assert.equal(shaped.result.facts?.[0]?.id, 'problems')
    assert.equal(shaped.result.facts?.[0]?.mention, 'not_mentioned')
    assert.equal(shaped.result.facts?.[0]?.framing, 'unbranded')
    assert.deepEqual(shaped.result.facts?.[0]?.whoInstead, ['Jira', 'Asana', 'Height'])
    assert.equal(shaped.result.facts?.[1]?.id, 'alternatives')
    assert.deepEqual(shaped.result.unbranded?.facts, shaped.result.facts)
    assert.equal(JSON.stringify(shaped.result).includes('%'), false)
  })
})

describe('history trim', () => {
  it('drops the oldest ids past the cap and keeps everything when retention is 0', () => {
    const drop = idsBeyondCap(
      [
        { id: NEW_ID, created_at: '2026-09-25T00:00:00.000Z' },
        { id: OLD_ID, created_at: '2026-09-01T00:00:00.000Z' },
      ],
      1,
    )
    assert.deepEqual(drop, [OLD_ID])
    assert.equal(retentionCutoffIso(0), null)
    const cutoff = retentionCutoffIso(2, Date.parse('2026-09-25T00:00:00.000Z'))
    assert.equal(cutoff, '2026-09-23T00:00:00.000Z')
  })
})

describe('view models', () => {
  it('keeps Generated · OpenAI and Unbranded on a live result', () => {
    const aha = {
      domain: 'linear.app',
      questions: ['What is Linear?', 'Linear vs Jira?', 'Is Linear worth it?'],
      questionsGenerated: true,
      answered: 'partial',
      answeredWhy: 'Known, with caveats.',
      answeredLive: true,
      model: 'gpt-4o-mini',
      whoInstead: ['Jira'],
      whoInsteadLive: true,
      homepageSupport: null,
    }
    const view = viewFromAha(aha)
    assert.equal(view.questionsLabel, 'Generated · OpenAI')
    assert.equal(view.whoInsteadLabel, 'Generated · OpenAI')
    assert.equal(view.modeLabel, 'Unbranded')
    assert.equal(view.model, 'gpt-4o-mini')
  })

  it('says what was not saved instead of inventing alternatives', () => {
    const view = viewFromSaved({
      id: NEW_ID,
      domain: 'linear.app',
      mode: 'unbranded',
      createdAt: '2026-09-25T00:00:00.000Z',
      result: {
        labels: {
          questions: LABEL_GENERATED,
          answered: 'Live model',
          whoInstead: LABEL_GENERATED,
          mode: LABEL_UNBRANDED,
        },
        model: 'gpt-4o-mini',
      },
    })
    assert.match(view.questionsNote || '', /not saved/)
    assert.match(view.whoInsteadEmpty, /not saved/)
    assert.equal(view.modeLabel, 'Unbranded')
  })
})

describe('onRequest /api/checks', () => {
  it('returns 503 when Supabase is not configured and does not call fetch', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('should not fetch')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', { method: 'POST', body: '{}' }),
        env: {},
      })
      assert.equal(res.status, 503)
      const body = (await res.json()) as { error?: string }
      assert.equal(body.error, SERVER_AUTH_NOT_CONFIGURED)
      assert.match(body.error || '', /Auth not configured/)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('returns 401 without a session and does not call fetch', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('should not fetch')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks'),
        env: env(),
      })
      assert.equal(res.status, 401)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('inserts a new check, trims to the cap, and never returns the service role', async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      assert.equal(body.includes('VITE_'), false)
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles')) {
        return new Response('', { status: 201 })
      }
      if (method === 'POST' && url.endsWith('/rest/v1/checks')) {
        const sent = JSON.parse(body) as { result?: { homepageSnippet?: string }; user_id?: string }
        assert.equal(sent.user_id, USER)
        assert.equal(sent.result?.homepageSnippet, undefined)
        return new Response(
          JSON.stringify([{ id: NEW_ID, created_at: '2026-09-25T12:00:00.000Z' }]),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'GET' && url.includes('select=id,created_at')) {
        return new Response(
          JSON.stringify([
            { id: NEW_ID, created_at: '2026-09-25T12:00:00.000Z' },
            { id: OLD_ID, created_at: '2026-09-01T00:00:00.000Z' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'DELETE' && url.includes('/rest/v1/checks')) {
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/rest/v1/usage_events')) {
        const sent = JSON.parse(body) as { kind?: string; user_id?: string }
        assert.equal(sent.kind, 'save')
        assert.equal(sent.user_id, USER)
        return new Response('', { status: 201 })
      }
      return new Response('unexpected ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: `Bearer user-access-token`, 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({ MAX_SAVED_CHECKS_PER_USER: '1' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(SECRET), false)
      const body = JSON.parse(text) as { ok?: boolean; check?: { id?: string; result?: { whoInstead?: string[] } } }
      assert.equal(body.ok, true)
      assert.equal(body.check?.id, NEW_ID)
      assert.deepEqual(body.check?.result?.whoInstead, ['Jira', 'Asana'])
      const deleted = calls.find((call) => call.method === 'DELETE')
      assert.ok(deleted)
      assert.match(deleted.url, new RegExp(OLD_ID))
      assert.equal(deleted.url.includes(NEW_ID), false)
      assert.equal(calls.some((call) => call.url.includes('select=plan')), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('lists only the signed-in user and applies retention', async () => {
    const calls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(`${init?.method || 'GET'} ${url}`)
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if ((init?.method || 'GET') === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('select=id,domain,mode,result,created_at')) {
        assert.match(url, new RegExp(`user_id=eq.${USER}`))
        return new Response(
          JSON.stringify([
            {
              id: NEW_ID,
              domain: 'linear.app',
              mode: 'unbranded',
              created_at: '2026-09-25T12:00:00.000Z',
              result: { labels: { mode: 'Unbranded', questions: 'Generated · OpenAI', answered: 'Live model', whoInstead: 'Generated · OpenAI' }, model: 'gpt-4o-mini', questions: ['What is Linear?'] },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          headers: { authorization: 'Bearer user-access-token' },
        }),
        env: env({ CHECK_RETENTION_DAYS: '14' }),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { checks?: { domain?: string; createdAt?: string }[] }
      assert.equal(body.checks?.[0]?.domain, 'linear.app')
      assert.equal(body.checks?.[0]?.createdAt, '2026-09-25T12:00:00.000Z')
      assert.ok(calls.some((call) => call.startsWith('DELETE') && call.includes('created_at=lt.')))
    } finally {
      globalThis.fetch = prev
    }
  })

  it('does not wall a free save before the complimentary full report is used', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles') && method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (method === 'GET' && url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: NEW_ID, created_at: '2026-09-26T01:00:00.000Z' }]), { status: 201 })
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: NEW_ID, created_at: '2026-09-26T01:00:00.000Z' }]), { status: 200 })
      }
      if (method === 'POST' && url.includes('/rest/v1/usage_events')) {
        assert.match(body, /"kind":"save"/)
        return new Response('', { status: 201 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_UNIT: 'checks' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('saves the complimentary full report for a free account', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles') && method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (method === 'GET' && url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      if (method === 'GET' && url.includes('kind=eq.save')) {
        assert.match(url, /created_at=gte\./)
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: NEW_ID, created_at: '2026-09-26T01:00:00.000Z' }]), { status: 201 })
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: NEW_ID, created_at: '2026-09-26T01:00:00.000Z' }]), { status: 200 })
      }
      if (method === 'POST' && url.includes('/rest/v1/usage_events')) {
        assert.match(body, /"kind":"save"/)
        return new Response('', { status: 201 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '0', FREE_QUOTA_UNIT: 'checks' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const body = JSON.parse(text) as { ok?: boolean; check?: { id?: string } }
      assert.equal(body.ok, true)
      assert.equal(body.check?.id, NEW_ID)
      assert.equal(calls.some((call) => call.body.includes('"kind":"check"')), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('walls a further free save after the complimentary full report is saved', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles') && method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (method === 'GET' && url.includes('kind=eq.full_report')) {
        return new Response(JSON.stringify([{ created_at: '2026-09-26T00:00:00.000Z' }]), { status: 200 })
      }
      if (method === 'GET' && url.includes('kind=eq.save')) {
        return new Response(JSON.stringify([{ created_at: '2026-09-26T01:00:00.000Z' }]), { status: 200 })
      }
      if (url.includes('/rest/v1/checks') || (method === 'POST' && url.includes('/rest/v1/usage_events'))) {
        return new Response('further free save must not be recorded', { status: 500 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_AMOUNT: '3', FREE_QUOTA_UNIT: 'checks' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      assert.equal(text.includes(SECRET), false)
      const body = JSON.parse(text) as { code?: string; plan?: string; error?: string }
      assert.equal(body.code, 'quota_exceeded')
      assert.equal(body.plan, 'free')
      assert.equal(body.error, SAVE_REQUIRES_PLAN)
      assert.equal(calls.some((call) => call.url.includes('/rest/v1/checks')), false)
      assert.equal(calls.some((call) => call.method === 'POST' && call.url.includes('/rest/v1/usage_events')), false)
      assert.equal(calls.some((call) => call.body.includes('"kind":"check"')), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('saves a paid check under the paid history cap', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles') && method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'paid' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (method === 'POST' && url.endsWith('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ id: NEW_ID, created_at: '2026-09-25T12:00:00.000Z' }]), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && url.includes('select=id,created_at')) {
        return new Response(
          JSON.stringify([
            { id: NEW_ID, created_at: '2026-09-25T12:00:00.000Z' },
            { id: OLD_ID, created_at: '2026-09-01T00:00:00.000Z' },
          ]),
          { status: 200 },
        )
      }
      if (method === 'DELETE' && url.includes('/rest/v1/checks')) return new Response(null, { status: 204 })
      if (method === 'POST' && url.includes('/rest/v1/usage_events')) {
        const sent = JSON.parse(body) as { kind?: string }
        assert.equal(sent.kind, 'save')
        return new Response('', { status: 201 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({
          PAYWALL_ENABLED: 'true',
          FREE_QUOTA_UNIT: 'checks',
          FREE_QUOTA_AMOUNT: '3',
          PAID_MAX_SAVED_CHECKS: '1',
          MAX_SAVED_CHECKS_PER_USER: '20',
        }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const deleted = calls.find((call) => call.method === 'DELETE' && call.url.includes('/rest/v1/checks'))
      assert.ok(deleted)
      assert.match(deleted.url, new RegExp(OLD_ID))
      assert.equal(calls.some((call) => call.method === 'POST' && call.url.endsWith('/rest/v1/checks')), true)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('blocks a paid save at the saves quota and does not insert the check', async () => {
    const usageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const olderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const calls: { url: string; method: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      calls.push({ url, method })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles') && method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'paid' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (method === 'POST' && url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: usageId }]), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: olderId }, { id: usageId }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'DELETE' && url.includes('/rest/v1/usage_events')) return new Response(null, { status: 204 })
      if (url.includes('/rest/v1/checks')) return new Response('should not insert', { status: 500 })
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify(DRAFT),
        }),
        env: env({ PAYWALL_ENABLED: 'true', FREE_QUOTA_UNIT: 'saves', PAID_QUOTA_AMOUNT: '1' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      assert.equal(text.includes(SECRET), false)
      const body = JSON.parse(text) as { code?: string; plan?: string }
      assert.equal(body.code, 'quota_exceeded')
      assert.equal(body.plan, 'paid')
      assert.equal(calls.some((call) => call.url.includes('/rest/v1/checks')), false)
      assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.includes(usageId)))
    } finally {
      globalThis.fetch = prev
    }
  })

  it('patches the question list on a saved full report and keeps mention on the remaining question', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(
          JSON.stringify([
            {
              id: NEW_ID,
              domain: 'linear.app',
              mode: 'unbranded',
              created_at: '2026-09-25T12:00:00.000Z',
              result: {
                report: 'full',
                labels: {
                  questions: 'Generated · OpenAI',
                  answered: 'Generated · OpenAI',
                  whoInstead: 'Generated · OpenAI',
                  mode: 'Full report',
                },
                model: 'gpt-4o-mini',
                questionsGenerated: true,
                fullReport: {
                  domain: 'linear.app',
                  model: 'gpt-4o-mini',
                  includesBranded: true,
                  themes: [
                    {
                      id: 'problems',
                      title: 'Problems you solve',
                      questions: [
                        {
                          question: 'What should a team use for issue tracking?',
                          answer: 'Jira shows up for that job.',
                          framing: 'unbranded',
                          mention: 'not_mentioned',
                          whoInstead: ['Jira'],
                        },
                        {
                          question: 'What do product teams use to plan work?',
                          answer: 'Several tools get named.',
                          framing: 'unbranded',
                          mention: 'not_mentioned',
                          whoInstead: [],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'PATCH' && url.includes('/rest/v1/checks')) {
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'PATCH',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            id: NEW_ID,
            questions: [
              { question: 'What should a team use for issue tracking?', themeId: 'problems' },
              { question: 'What tools do support teams use for tickets?', themeId: 'problems' },
            ],
          }),
        }),
        env: env(),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(SECRET), false)
      const body = JSON.parse(text) as {
        check?: {
          result?: {
            questionSetOwned?: boolean
            fullReport?: { themes?: { id?: string; questions?: { question?: string; mention?: string; answer?: string }[] }[] }
          }
        }
      }
      const questions = body.check?.result?.fullReport?.themes?.[0]?.questions
      assert.equal(body.check?.result?.questionSetOwned, true)
      assert.deepEqual(
        questions?.map((item) => item.question),
        ['What should a team use for issue tracking?', 'What tools do support teams use for tickets?'],
      )
      assert.equal(questions?.[0]?.mention, 'not_mentioned')
      assert.equal(questions?.[1]?.answer, '')
      assert.equal(questions?.[1]?.mention, undefined)
      assert.equal(body.check?.result?.fullReport?.themes?.[0]?.id, 'problems')
      const patched = calls.find((call) => call.method === 'PATCH')
      assert.ok(patched)
      assert.match(patched.body, /What tools do support teams use for tickets/)
      assert.equal(patched.body.includes('What do product teams use to plan work?'), false)
      assert.equal(calls.some((call) => call.method === 'POST' && call.url.includes('/rest/v1/checks')), false)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('saveCheck quota signal', () => {
  it('keeps quota_exceeded on the client result', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, code: 'quota_exceeded', error: 'Check limit reached.', plan: 'paid' }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    try {
      const result = await saveCheck('token', DRAFT as never)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.code, 'quota_exceeded')
        assert.equal(result.plan, 'paid')
        assert.equal(result.error, 'Check limit reached.')
      }
    } finally {
      globalThis.fetch = prev
    }
  })
})

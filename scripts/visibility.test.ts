import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { onRequest, parseVisibilityContent, scrubSecret } from '../functions/api/visibility.ts'
import { interpretVisibilityResponse } from '../src/visibilityClient.ts'

const KEY = 'sk-test-visibility-secret'

function modelPayload(content: unknown) {
  return JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  })
}

const GOOD = {
  questions: [
    'What is Linear?',
    'Linear vs Jira for a small team?',
    'Is Linear worth it for engineering orgs?',
  ],
  answered: 'partial',
  why: 'Linear is widely known, but comparison answers often cite larger incumbents too.',
  whoInstead: ['Jira', 'Asana'],
}

describe('parseVisibilityContent', () => {
  it('reads a JSON object and drops whoInstead', () => {
    const parsed = parseVisibilityContent(JSON.stringify(GOOD))
    assert.equal(parsed?.answered, 'partial')
    assert.equal(parsed?.questions.length, 3)
    assert.equal('whoInstead' in (parsed || {}), false)
  })

  it('accepts fenced JSON and caps questions at 5', () => {
    const raw = '```json\n' + JSON.stringify({
      ...GOOD,
      questions: ['a', 'b', 'c', 'd', 'e', 'f'],
    }) + '\n```'
    const parsed = parseVisibilityContent(raw)
    assert.equal(parsed?.questions.length, 5)
    assert.equal(parsed?.questions[4], 'e')
  })

  it('rejects fewer than 3 questions, a bad label, or an empty why', () => {
    assert.equal(parseVisibilityContent(JSON.stringify({ ...GOOD, questions: ['only', 'two'] })), null)
    assert.equal(parseVisibilityContent(JSON.stringify({ ...GOOD, answered: 'maybe' })), null)
    assert.equal(parseVisibilityContent(JSON.stringify({ ...GOOD, why: '   ' })), null)
  })
})

describe('scrubSecret', () => {
  it('removes the live key and sk- tokens', () => {
    const out = scrubSecret(`bad key ${KEY} and sk-abcdefghijklmnop`, KEY)
    assert.equal(out.includes(KEY), false)
    assert.equal(out.includes('sk-abc'), false)
  })
})

describe('onRequest /api/visibility', () => {
  it('returns 400 for an unsafe domain and does not call fetch', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('should not fetch')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=127.0.0.1'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 400)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('returns 503 when OPENAI_API_KEY is missing and does not call fetch', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('should not fetch')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app'),
        env: {},
      })
      assert.equal(res.status, 503)
      const body = (await res.json()) as { error?: string }
      assert.equal(body.error, 'OPENAI_API_KEY not configured')
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('returns model questions and answered-by-you without the key or whoInstead', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://linear.app')) {
        return new Response('<title>Linear</title><p>Linear is an issue tracker for software teams.</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      assert.equal(url, 'https://api.openai.com/v1/chat/completions')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), `Bearer ${KEY}`)
      const sent = String(init?.body || '')
      assert.equal(sent.includes(KEY), false)
      assert.match(sent, /gpt-4o-mini/)
      assert.match(sent, /issue tracker/)
      return new Response(modelPayload(GOOD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.equal(text.includes(KEY), false)
      assert.equal(text.includes('whoInstead'), false)
      const body = JSON.parse(text) as { ok?: boolean; answered?: string; model?: string; questions?: string[] }
      assert.equal(body.ok, true)
      assert.equal(body.answered, 'partial')
      assert.equal(body.model, 'gpt-4o-mini')
      assert.equal(body.questions?.length, 3)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('accepts POST JSON and scrubs the key out of an OpenAI error', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('nope', { status: 500 })
      }
      return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'notion.so' }),
        }),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 502)
      const text = await res.text()
      assert.equal(text.includes(KEY), false)
      assert.match(text, /OpenAI request failed/)
      assert.match(text, /\[redacted\]/)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('interpretVisibilityResponse', () => {
  it('accepts a live payload and refuses a Yes buried in an error', () => {
    const ok = interpretVisibilityResponse(200, {
      ok: true,
      model: 'gpt-4o-mini',
      questions: GOOD.questions,
      answered: 'partial',
      why: GOOD.why,
    }, false)
    assert.equal(ok.ok, true)

    const failed = interpretVisibilityResponse(502, {
      ok: false,
      error: 'OpenAI request failed: timed out',
      answered: 'yes',
    }, false)
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.match(failed.error, /timed out/)
  })

  it('surfaces the missing-key error verbatim', () => {
    const missing = interpretVisibilityResponse(503, { error: 'OPENAI_API_KEY not configured' }, false)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error, 'OPENAI_API_KEY not configured')
  })
})

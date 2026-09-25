import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { onRequest, parseVisibilityContent, parseVisibilityMode, parseWhoInstead, scrubSecret } from '../functions/api/visibility.ts'
import { stubQuestionsFor } from '../src/demoData.ts'
import { STORY } from '../src/story.ts'
import { fetchVisibility, interpretVisibilityResponse, parseClientWhoInstead } from '../src/visibilityClient.ts'

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

describe('parseWhoInstead', () => {
  it('trims names and caps at 3', () => {
    const names = parseWhoInstead(['  Jira ', 'Asana', '  Height  ', 'Shortcut', '   ', 12, 'Notion'])
    assert.deepEqual(names, ['Jira', 'Asana', 'Height'])
  })

  it('returns an empty list when missing, blank, or not a list', () => {
    assert.deepEqual(parseWhoInstead(undefined), [])
    assert.deepEqual(parseWhoInstead(null), [])
    assert.deepEqual(parseWhoInstead('Jira'), [])
    assert.deepEqual(parseWhoInstead(['   ', '']), [])
  })

  it('skips this brand and still fills up to 3 other names', () => {
    const names = parseWhoInstead(
      ['Linear', 'linear.app', ' Jira ', 'Jira', 'Asana', 'Height'],
      'linear.app',
    )
    assert.deepEqual(names, ['Jira', 'Asana', 'Height'])
  })

  it('drops names that are too long to be a brand', () => {
    const names = parseWhoInstead(['Jira', 'x'.repeat(81), 'Asana'])
    assert.deepEqual(names, ['Jira', 'Asana'])
  })
})

describe('parseVisibilityContent', () => {
  it('reads questions, the verdict, and whoInstead', () => {
    const parsed = parseVisibilityContent(JSON.stringify(GOOD))
    assert.equal(parsed?.answered, 'partial')
    assert.equal(parsed?.questions.length, 3)
    assert.deepEqual(parsed?.whoInstead, ['Jira', 'Asana'])
  })

  it('keeps a usable verdict when whoInstead is missing', () => {
    const { whoInstead: _drop, ...rest } = GOOD
    const parsed = parseVisibilityContent(JSON.stringify(rest))
    assert.equal(parsed?.answered, 'partial')
    assert.deepEqual(parsed?.whoInstead, [])
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

  it('returns model questions, answered-by-you, and whoInstead without the key', async () => {
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
      assert.match(sent, /Mode: unbranded/)
      assert.match(sent, /whoInstead/)
      assert.match(sent, /Do not put the brand name/)
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
      const body = JSON.parse(text) as {
        ok?: boolean
        answered?: string
        model?: string
        mode?: string
        questions?: string[]
        whoInstead?: string[]
      }
      assert.equal(body.ok, true)
      assert.equal(body.mode, 'unbranded')
      assert.equal(body.answered, 'partial')
      assert.equal(body.model, 'gpt-4o-mini')
      assert.equal(body.questions?.length, 3)
      assert.deepEqual(body.whoInstead, ['Jira', 'Asana'])
    } finally {
      globalThis.fetch = prev
    }
  })

  it('asks each domain for its own who-instead set', async () => {
    const prompts: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('<title>Brand</title><p>Enough homepage copy to excerpt this brand for the model.</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      prompts.push(String(init?.body || ''))
      const sent = JSON.parse(String(init?.body || '')) as { messages?: { content?: string }[] }
      const user = sent.messages?.map((m) => m.content || '').find((content) => content.includes('Brand domain:')) || ''
      const domain = /Brand domain: (\S+)/.exec(user)?.[1] || 'unknown'
      const alts = domain.startsWith('linear') ? ['Jira', 'Height'] : ['Coda', 'Slite']
      return new Response(
        modelPayload({ ...GOOD, whoInstead: alts }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const linear = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app'),
        env: { OPENAI_API_KEY: KEY },
      })
      const notion = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=notion.so'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(prompts.length, 2)
      assert.notEqual(prompts[0], prompts[1])
      assert.match(prompts[0], /linear\.app/)
      assert.match(prompts[1], /notion\.so/)
      assert.match(prompts[0], /whoInstead/)
      const linearBody = (await linear.json()) as { whoInstead?: string[] }
      const notionBody = (await notion.json()) as { whoInstead?: string[] }
      assert.deepEqual(linearBody.whoInstead, ['Jira', 'Height'])
      assert.deepEqual(notionBody.whoInstead, ['Coda', 'Slite'])
    } finally {
      globalThis.fetch = prev
    }
  })

  it('returns an empty whoInstead list instead of inventing names', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('nope', { status: 404 })
      }
      const { whoInstead: _drop, ...rest } = GOOD
      return new Response(modelPayload(rest), {
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
      const body = (await res.json()) as { ok?: boolean; whoInstead?: string[] }
      assert.equal(body.ok, true)
      assert.deepEqual(body.whoInstead, [])
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
      whoInstead: ['  Jira ', 'Asana', 'Height', 'Shortcut'],
    }, false, 'linear.app')
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.mode, 'unbranded')
      assert.deepEqual(ok.whoInstead, ['Jira', 'Asana', 'Height'])
    }

    const failed = interpretVisibilityResponse(502, {
      ok: false,
      error: 'OpenAI request failed: timed out',
      answered: 'yes',
      whoInstead: ['Jira', 'Asana'],
    }, false)
    assert.equal(failed.ok, false)
    if (!failed.ok) {
      assert.match(failed.error, /timed out/)
      assert.equal('whoInstead' in failed, false)
    }
  })

  it('keeps a live result when whoInstead is missing', () => {
    const ok = interpretVisibilityResponse(200, {
      ok: true,
      model: 'gpt-4o-mini',
      questions: GOOD.questions,
      answered: 'yes',
      why: GOOD.why,
    }, false)
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.whoInstead, [])
    assert.deepEqual(parseClientWhoInstead([' Linear ', 'Coda'], 'linear.app'), ['Coda'])
  })

  it('surfaces the missing-key error verbatim', () => {
    const missing = interpretVisibilityResponse(503, { error: 'OPENAI_API_KEY not configured' }, false)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error, 'OPENAI_API_KEY not configured')
  })

  it('drops whoInstead on a branded payload', () => {
    const ok = interpretVisibilityResponse(200, {
      ok: true,
      mode: 'branded',
      model: 'gpt-4o-mini',
      questions: ['What is Linear?', 'How do people describe Linear?', 'What does Linear claim?'],
      answered: 'yes',
      why: 'Named questions usually get a description.',
      whoInstead: ['Jira', 'Asana'],
    }, false, 'linear.app', 'branded')
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.mode, 'branded')
      assert.deepEqual(ok.whoInstead, [])
    }
  })

  it('rejects a mode that does not match the request', () => {
    const failed = interpretVisibilityResponse(200, {
      ok: true,
      mode: 'unbranded',
      model: 'gpt-4o-mini',
      questions: GOOD.questions,
      answered: 'partial',
      why: GOOD.why,
      whoInstead: ['Jira'],
    }, false, 'linear.app', 'branded')
    assert.equal(failed.ok, false)
  })
})

describe('parseVisibilityMode', () => {
  it('treats blank as absent and accepts either mode', () => {
    assert.equal(parseVisibilityMode(undefined), 'absent')
    assert.equal(parseVisibilityMode(null), 'absent')
    assert.equal(parseVisibilityMode(''), 'absent')
    assert.equal(parseVisibilityMode('  '), 'absent')
    assert.equal(parseVisibilityMode('Unbranded'), 'unbranded')
    assert.equal(parseVisibilityMode('BRANDED'), 'branded')
  })

  it('rejects an unknown mode', () => {
    assert.equal(parseVisibilityMode('both'), 'invalid')
    assert.equal(parseVisibilityMode(1), 'invalid')
  })
})

describe('onRequest mode', () => {
  it('rejects an unknown mode and does not call fetch', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('should not fetch')
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=both'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error?: string }
      assert.equal(body.error, 'mode must be unbranded or branded')
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('branded mode asks for named questions and omits whoInstead', async () => {
    let sent = ''
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('<title>Linear</title><p>Linear is an issue tracker for software teams.</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      sent = String(init?.body || '')
      return new Response(modelPayload({
        ...GOOD,
        questions: [
          'What is Linear?',
          'How do people describe Linear?',
          'What does Linear claim about speed?',
        ],
        whoInstead: ['Jira', 'Asana'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=branded'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 200)
      assert.match(sent, /Mode: branded/)
      assert.match(sent, /every question must include the brand name/)
      assert.equal(sent.includes('whoInstead'), false)
      const body = (await res.json()) as { mode?: string; questions?: string[] }
      assert.equal(body.mode, 'branded')
      assert.equal('whoInstead' in body, false)
      assert.equal(body.questions?.length, 3)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('accepts branded mode from POST JSON', async () => {
    let sent = ''
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('nope', { status: 404 })
      }
      sent = String(init?.body || '')
      return new Response(modelPayload({
        questions: ['What is Notion?', 'How is Notion described?', 'What does Notion claim?'],
        answered: 'partial',
        why: 'Named questions get a partial description.',
        whoInstead: ['Coda'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'notion.so', mode: 'branded' }),
        }),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 200)
      assert.match(sent, /Mode: branded/)
      assert.match(sent, /notion\.so/)
      assert.equal(sent.includes('whoInstead'), false)
      const body = (await res.json()) as { mode?: string }
      assert.equal(body.mode, 'branded')
      assert.equal('whoInstead' in body, false)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('fetchVisibility', () => {
  it('requests the branded mode and keeps whoInstead empty', async () => {
    const prev = globalThis.fetch
    let called = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      called = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return new Response(JSON.stringify({
        ok: true,
        mode: 'branded',
        model: 'gpt-4o-mini',
        questions: ['What is Linear?', 'How is Linear described?', 'What does Linear claim?'],
        answered: 'partial',
        why: 'Named questions get a partial description.',
        whoInstead: ['Jira'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fetchVisibility('linear.app', 'branded')
      assert.match(called, /mode=branded/)
      assert.match(called, /domain=linear\.app/)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.mode, 'branded')
        assert.deepEqual(result.whoInstead, [])
      }
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('unbranded samples and story copy', () => {
  it('does not put the brand name in sample questions', () => {
    const { questions } = stubQuestionsFor('linear.app')
    assert.equal(questions.length >= 3, true)
    assert.equal(questions.some((q) => /linear/i.test(q)), false)
  })

  it('keeps the land and dig lines', () => {
    assert.equal(STORY.landEyebrow, 'Unbranded')
    assert.equal(STORY.landTitle, 'Do you show up for what you solve?')
    assert.equal(
      STORY.landHelper,
      'Category questions — no brand name required. This is the usual first ask.',
    )
    assert.equal(STORY.landBadge, 'Unbranded')
    assert.equal(STORY.ask, 'Ask about your brand')
    assert.equal(STORY.digLoading, 'Checking what they say when people name you…')
    assert.equal(STORY.digEyebrow, 'Branded')
    assert.equal(STORY.digTitle, 'What do they say about you?')
    assert.equal(
      STORY.digHelper,
      'Questions that name your brand — tone, claims, how you’re described.',
    )
    assert.equal(STORY.digBadge, 'Branded')
    assert.equal(STORY.digFail, 'Couldn’t generate branded questions — try again.')
    assert.equal(
      STORY.homeSub,
      'Paste a URL. First we check whether you show up for the problems you solve — then you can ask what they say about your brand.',
    )
    assert.equal(
      STORY.proof,
      'Every question is labeled Unbranded or Branded. We don’t mix them into one score.',
    )
  })
})

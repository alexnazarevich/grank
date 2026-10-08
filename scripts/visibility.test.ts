import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, it } from 'node:test'
import { BRANDED_SYSTEM_PROMPT, GEMINI_CHUNK_TOKEN_BASE, GEMINI_CHUNK_TOKENS_PER_QUESTION, GEMINI_MISS_CLASSES, GEMINI_MODEL_DEFAULT, GEMINI_REPORT_BUDGET_MS, GEMINI_TIMEOUT_CAP_MS, UNBRANDED_SYSTEM_PROMPT, geminiAnswerPrompt, geminiApiKeyFromEnv, geminiChunkMaxOutputTokens, geminiChunkSize, geminiGenerateBody, geminiGenerateUrl, geminiGenerationConfig, geminiMaxOutputTokens, geminiMissForResponse, geminiMissFromChunks, geminiMissLogLine, geminiModelFromEnv, geminiQuestionChunks, geminiReplies, geminiTextMiss, geminiTimeoutFromEnv, geminiWaitMs, onRequest, parseGeminiAnswers, parseVisibilityContent, parseVisibilityMode, parseWhoInstead, readQuestionAnswers, resetGeminiThinkingMemo, scrubSecret } from '../functions/api/visibility.ts'
import { geminiRow } from '../src/engineBlock.ts'
import { whoInsteadByTopic } from '../src/mentionLabel.ts'
import { SHARPER_Q_RULES, factsFromVisibility, mentionFromAnswer } from '../src/mentionFacts.ts'
import { PRODUCT_DEFAULTS } from '../src/config/productConfig.ts'
import { stubQuestionsFor } from '../src/demoData.ts'
import { STORY } from '../src/story.ts'
import { fetchVisibility, interpretVisibilityResponse, parseClientAnswers, parseClientWhoInstead } from '../src/visibilityClient.ts'

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

describe('sharper questions and mention facts', () => {
  it('appends the same sharper rules to both land prompts', () => {
    assert.equal(UNBRANDED_SYSTEM_PROMPT.includes(SHARPER_Q_RULES), true)
    assert.equal(BRANDED_SYSTEM_PROMPT.includes(SHARPER_Q_RULES), true)
    assert.equal(BRANDED_SYSTEM_PROMPT.includes('whoInstead'), false)
    assert.equal(UNBRANDED_SYSTEM_PROMPT.includes('What is {brand}?'), true)
    assert.equal(BRANDED_SYSTEM_PROMPT.includes('who else for this job?'), true)
  })

  it('derives branded mention from the answer and leaves whoInstead empty', () => {
    const facts = factsFromVisibility({
      domain: 'linear.app',
      mode: 'branded',
      questions: ['How do people describe Linear?', 'What does Linear claim?', 'Does Linear fit a small team?'],
      answers: ['Linear is an issue tracker for software teams.', '', 'Linear might fit a small team, but that is unclear.'],
      answered: 'partial',
      whoInstead: ['Jira', 'Asana'],
      mentions: ['mentioned', 'mentioned', 'not_mentioned'],
    })
    assert.equal(facts[0]?.mention, 'mentioned')
    assert.equal(facts[0]?.id, 'described')
    assert.deepEqual(facts[0]?.whoInstead, [])
    assert.equal(facts[1]?.mention, undefined)
    assert.equal(facts[2]?.mention, 'unclear')
    assert.equal(mentionFromAnswer('', 'linear.app', 'mentioned'), undefined)
  })

  it('maps unbranded mentions and keeps a shared whoInstead list', () => {
    const facts = factsFromVisibility({
      domain: 'linear.app',
      mode: 'unbranded',
      questions: [
        'What should a team use to track issues?',
        'Who else shows up for issue tracking?',
        'How do teams plan a week of work?',
      ],
      answers: [],
      answered: 'no',
      whoInstead: ['Linear', 'Jira', 'Asana', 'Height'],
      mentions: ['mentioned', '', 'not_mentioned'],
    })
    assert.equal(facts[0]?.mention, 'mentioned')
    assert.equal(facts[0]?.id, 'problems')
    assert.deepEqual(facts[0]?.whoInstead, ['Jira', 'Asana', 'Height'])
    assert.equal(facts[1]?.id, 'alternatives')
    assert.equal(facts[1]?.mention, 'not_mentioned')
    assert.equal(facts[2]?.mention, 'not_mentioned')
  })
})

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

  it('aligns parallel answers and leaves blanks empty', () => {
    const parsed = parseVisibilityContent(JSON.stringify({
      ...GOOD,
      answers: [
        '  Linear is a project tool for software teams. Public descriptions stay general. ',
        '',
        '   ',
      ],
    }))
    assert.equal(parsed?.questions.length, 3)
    assert.equal(parsed?.answers[0]?.startsWith('Linear is a project tool'), true)
    assert.equal(parsed?.answers[1], '')
    assert.equal(parsed?.answers[2], '')
  })

  it('reads { question, answer } objects and drops a bad question without shifting', () => {
    const parsed = parseVisibilityContent(JSON.stringify({
      ...GOOD,
      questions: [
        { question: 'What is Linear?', answer: 'Linear is an issue tracker. Teams use it for software work. The summary stays cautious.' },
        { question: '   ', answer: 'This must not become an answer for the next question.' },
        { question: 'How do people describe Linear?', answer: '' },
        { question: 'What does Linear claim?', answer: 12 },
      ],
      answers: ['parallel-0', 'parallel-1', 'People describe Linear in general terms. It is known for a fast workflow. That is not a live quote.', ''],
    }))
    assert.deepEqual(parsed?.questions, [
      'What is Linear?',
      'How do people describe Linear?',
      'What does Linear claim?',
    ])
    assert.equal(parsed?.answers[0]?.includes('issue tracker'), true)
    assert.equal(parsed?.answers[1]?.startsWith('People describe Linear'), true)
    assert.equal(parsed?.answers[2], '')
    assert.equal(parsed?.answers.some((a) => a.includes('must not become')), false)
  })

  it('keeps answer index when a string question is dropped', () => {
    const { questions, answers } = readQuestionAnswers(
      ['What is Linear?', '', 'How is Linear described?', 'x'.repeat(241), 'What does Linear claim?'],
      ['First reply about Linear. It is a product tool. Details stay public.', 'dropped', 'Second reply about Linear. Tone is the point. No citation.', 'also dropped', ''],
    )
    assert.deepEqual(questions, ['What is Linear?', 'How is Linear described?', 'What does Linear claim?'])
    assert.equal(answers[0]?.startsWith('First reply'), true)
    assert.equal(answers[1]?.startsWith('Second reply'), true)
    assert.equal(answers[2], '')
    assert.equal(answers.some((a) => a.includes('dropped')), false)
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
      assert.match(sent, /"max_tokens":600/)
      assert.equal(sent.includes('"answers"'), false)
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
      assert.equal('answers' in body, false)
      const facts = (JSON.parse(text) as { facts?: { id?: string; mention?: string; whoInstead?: string[]; framing?: string }[] }).facts
      assert.equal(facts?.length, 3)
      assert.equal(facts?.[0]?.framing, 'unbranded')
      assert.equal(facts?.[0]?.mention, 'unclear')
      assert.equal(facts?.[1]?.id, 'problems')
      assert.deepEqual(facts?.[0]?.whoInstead, ['Jira', 'Asana'])
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
      assert.match(text, /ChatGPT request failed/)
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
      error: 'ChatGPT request failed: timed out',
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

  it('marks a quota response so the page can show the upgrade wall', () => {
    const blocked = interpretVisibilityResponse(
      402,
      {
        ok: false,
        code: 'quota_exceeded',
        error: 'Check limit reached.',
        plan: 'free',
        quota: { amount: 3 },
      },
      false,
    )
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.code, 'quota_exceeded')
      assert.equal(blocked.plan, 'free')
      assert.equal(blocked.error, 'Check limit reached.')
      assert.equal(JSON.stringify(blocked).includes('3'), false)
    }
  })

  it('surfaces the missing-key error verbatim', () => {
    const missing = interpretVisibilityResponse(503, { error: 'OPENAI_API_KEY not configured' }, false)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error, 'OPENAI_API_KEY not configured')
  })

  it('drops whoInstead on a branded payload and keeps aligned answers', () => {
    const ok = interpretVisibilityResponse(200, {
      ok: true,
      mode: 'branded',
      model: 'gpt-4o-mini',
      questions: ['What is Linear?', 'How do people describe Linear?', 'What does Linear claim?'],
      answers: ['  A short Linear reply. It stays general. No live quote. ', ''],
      answered: 'yes',
      why: 'Named questions usually get a description.',
      whoInstead: ['Jira', 'Asana'],
    }, false, 'linear.app', 'branded')
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.mode, 'branded')
      assert.deepEqual(ok.whoInstead, [])
      assert.equal(ok.answers[0]?.startsWith('A short Linear reply'), true)
      assert.equal(ok.answers[1], '')
      assert.equal(ok.answers[2], '')
      assert.equal(ok.answers.length, 3)
    }
  })

  it('reads branded question objects and drops answers on unbranded', () => {
    const branded = interpretVisibilityResponse(200, {
      ok: true,
      mode: 'branded',
      model: 'gpt-4o-mini',
      questions: [
        { question: 'What is Linear?', answer: 'Linear is a software project tool. The reply is a sample. It is not a scrape.' },
        { question: 'How is Linear described?', answer: '   ' },
        { question: 'What does Linear claim?', answer: 'Linear talks about a fast workflow. That claim stays high level. No URL.' },
      ],
      answered: 'partial',
      why: 'Named questions get a partial description.',
    }, false, 'linear.app', 'branded')
    assert.equal(branded.ok, true)
    if (branded.ok) {
      assert.equal(branded.answers.length, 3)
      assert.match(branded.answers[0], /software project tool/)
      assert.equal(branded.answers[1], '')
      assert.match(branded.answers[2], /fast workflow/)
    }

    const unbranded = interpretVisibilityResponse(200, {
      ok: true,
      mode: 'unbranded',
      model: 'gpt-4o-mini',
      questions: GOOD.questions,
      answers: ['This reply must not land on the unbranded beat.'],
      answered: 'partial',
      why: GOOD.why,
      whoInstead: ['Jira'],
    }, false, 'linear.app', 'unbranded')
    assert.equal(unbranded.ok, true)
    if (unbranded.ok) {
      assert.deepEqual(unbranded.answers, [])
      assert.deepEqual(unbranded.whoInstead, ['Jira'])
    }
    assert.equal(parseClientAnswers(
      [{ question: 'What is Notion?', answer: '' }],
      ['Notion is a workspace. People use it for notes and docs. The note stays general.'],
    ).answers[0]?.startsWith('Notion is a workspace'), true)
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
      assert.match(sent, /\\"answers\\"/)
      assert.match(sent, /2 to 4 sentences/)
      assert.match(sent, /ChatGPT said/)
      assert.match(sent, /"max_tokens":1400/)
      assert.match(sent, /gpt-4o-mini/)
      assert.equal(sent.includes('whoInstead'), false)
      assert.match(sent, /ban generic/)
      assert.match(sent, /one intent/)
      const body = (await res.json()) as {
        mode?: string
        questions?: string[]
        answers?: string[]
        facts?: { whoInstead?: string[]; mention?: string; id?: string }[]
      }
      assert.equal(body.mode, 'branded')
      assert.equal('whoInstead' in body, false)
      assert.equal(body.facts?.every((fact) => fact.whoInstead?.length === 0), true)
      assert.equal(body.facts?.every((fact) => fact.mention === undefined), true)
      assert.equal(body.facts?.[0]?.id, 'described')
      assert.equal(body.questions?.length, 3)
      assert.deepEqual(body.answers, ['', '', ''])
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

  it('returns branded answers aligned to questions and does not invent a missing one', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('nope', { status: 404 })
      }
      return new Response(modelPayload({
        questions: [
          'What is Linear?',
          'How do people describe Linear?',
          'What does Linear claim?',
        ],
        answers: [
          `Linear is a project tool for software teams. Public blurbs stay general. key ${KEY} must not leak.`,
          '',
        ],
        answered: 'partial',
        why: 'Named questions get a partial description.',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=branded'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.equal(text.includes(KEY), false)
      const body = JSON.parse(text) as { answers?: string[]; questions?: string[]; whoInstead?: unknown }
      assert.equal(body.questions?.length, 3)
      assert.equal(body.answers?.length, 3)
      assert.match(body.answers?.[0] || '', /project tool/)
      assert.match(body.answers?.[0] || '', /\[redacted\]/)
      assert.equal(body.answers?.[1], '')
      assert.equal(body.answers?.[2], '')
      assert.equal('whoInstead' in body, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('omits answers on unbranded even when the model sends them', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) {
        return new Response('nope', { status: 404 })
      }
      return new Response(modelPayload({
        ...GOOD,
        answers: ['A reply that must not show on the unbranded land beat. It is extra. Ignore it.'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=unbranded'),
        env: { OPENAI_API_KEY: KEY },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { whoInstead?: string[]; answers?: string[] }
      assert.deepEqual(body.whoInstead, ['Jira', 'Asana'])
      assert.equal('answers' in body, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('still calls OpenAI for a guest check when full-report OpenAI is off', async () => {
    let openai = false
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.openai.com')) {
        openai = true
        return new Response(modelPayload(GOOD), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=unbranded'),
        env: { OPENAI_API_KEY: KEY, FULL_REPORT_OPENAI: 'off' },
      })
      assert.equal(res.status, 200)
      assert.equal(openai, true)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('answers owned questions instead of returning a generated roster', async () => {
    const owned = [
      'What should a team use for issue tracking?',
      'Who else should a team use for issue tracking?',
      'What do support teams use for tickets?',
    ]
    let sent = ''
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      sent = String(init?.body || '')
      return new Response(modelPayload({
        ...GOOD,
        questions: ['Generated one?', 'Generated two?', 'Generated three?'],
        mentions: ['not_mentioned', 'not_mentioned', 'not_mentioned'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'linear.app', mode: 'unbranded', questions: owned }),
        }),
        env: { OPENAI_API_KEY: KEY },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.match(sent, /Do not add, drop, or rewrite/)
      assert.match(sent, /What should a team use for issue tracking\?/)
      const body = JSON.parse(text) as { questions?: string[]; facts?: { question?: string; mention?: string; id?: string }[] }
      assert.deepEqual(body.questions, owned)
      assert.equal(body.questions?.includes('Generated one?'), false)
      assert.equal(body.facts?.length, owned.length)
      assert.equal(body.facts?.[0]?.question, owned[0])
      assert.equal(body.facts?.[0]?.mention, 'not_mentioned')
      assert.equal(body.facts?.[0]?.id, 'problems')
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
        answers: ['Linear gets a short description. It is a sample reply. Not a live engine line.', ''],
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
        assert.equal(result.answers.length, 3)
        assert.match(result.answers[0], /short description/)
        assert.equal(result.answers[1], '')
        assert.equal(result.answers[2], '')
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
      "Questions are generated based on your brand's website",
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
    assert.equal(STORY.answerLabel, 'Generated · ChatGPT')
    assert.equal(
      STORY.answerHelper,
      "Each answer is labeled with the engine that gave it. Branded answers are ChatGPT only. We don't blend them into one score.",
    )
    assert.equal(STORY.answerMiss, 'Couldn’t get an answer.')
    assert.equal('showFullAnswer' in STORY, false)
    assert.equal('hideAnswer' in STORY, false)
    assert.equal(JSON.stringify(STORY).includes('Show full answer'), false)
    assert.equal(JSON.stringify(STORY).includes('Hide answer'), false)
    assert.equal(JSON.stringify(STORY).includes('what ChatGPT said'), false)
    assert.equal(
      STORY.homeSub,
      'See what LLMs say when your audience asks about the problems you solve.',
    )
    const removed =
      'Every question is labeled Unbranded or Branded. We don’t mix them into one score.'
    assert.equal('proof' in STORY, false)
    assert.equal(JSON.stringify(STORY).includes(removed), false)
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    assert.equal(app.includes('STORY.proof'), false)
    assert.equal(app.includes(removed), false)
    assert.match(app, /land \? STORY\.landHelper : STORY\.digHelper/)
  })

  it('locks the homepage story lines', () => {
    assert.equal(STORY.documentTitle, 'Grank — See if you show up in AI answers')
    assert.equal(STORY.headerBadge, 'SIMPLE AEO · LABELED MODEL CHECKS')
    assert.equal(STORY.homeH1, 'What does AI say about your brand?')
    assert.equal(STORY.urlPlaceholder, 'https://yourbrand.com')
    assert.equal(STORY.cta, 'Check visibility')
    assert.equal(STORY.homeLoading, 'Checking how AI might talk about you…')
    assert.equal(STORY.exampleLead, 'Or try an example:')
    assert.equal(
      STORY.homeProof,
      "Your free check labels ChatGPT and Gemini answers. Full reports add Claude. Branded answers are ChatGPT only. We never blend them into one score.",
    )
    assert.equal(STORY.foilTitle, 'Built for thin teams')
    assert.equal(
      STORY.foilBody,
      '“Are we in AI answers?” shouldn’t need a $499 demo or a prompt lab. Suites sell ops. You need a glance: do you show up for what you solve — and who shows up instead.',
    )
    assert.equal(
      STORY.foilFoot,
      'Land on unbranded. Dig into branded when you’re ready. Free checks, then one simple upgrade if you need more — no credit packs.',
    )
    assert.equal(JSON.stringify(STORY).includes('11 models'), false)
    assert.equal(JSON.stringify(STORY).includes('blended visibility'), false)
  })
})

const GEMINI_KEY = 'gemini-test-key-should-not-leak'

function geminiPayload(answers: string[]) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] } }],
  })
}

describe('gemini on unbranded questions', { concurrency: false }, () => {
  beforeEach(() => {
    resetGeminiThinkingMemo()
  })

  it('labels OpenAI and Gemini apart, and a miss is not the OpenAI label', () => {
    assert.equal(STORY.answerLabel, 'Generated · ChatGPT')
    assert.equal(STORY.geminiLabel, 'Generated · Gemini')
    assert.equal(STORY.geminiMiss, "Gemini didn't answer.")
    assert.equal(/multi-engine|suite|blend|SOV|Perplexity|AI Overviews/i.test(`${STORY.geminiLabel} ${STORY.geminiMiss}`), false)
    const hit = geminiRow(['Teams use a tracker for this job.'], 0)
    assert.equal(hit?.label, 'Generated · Gemini')
    assert.equal(hit?.body, 'Teams use a tracker for this job.')
    assert.equal(hit?.miss, false)
    const miss = geminiRow([''], 0)
    assert.equal(miss?.label, 'Generated · Gemini')
    assert.equal(miss?.body, "Gemini didn't answer.")
    assert.equal(miss?.miss, true)
    assert.equal(miss?.body === STORY.answerLabel, false)
    assert.equal(geminiRow(undefined, 0), null)
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const answers = readFileSync(new URL('../src/UnbrandedAnswers.tsx', import.meta.url), 'utf8')
    assert.match(app, /land && beat\.questionsGenerated \?/)
    assert.match(app, /<UnbrandedAnswers/)
    assert.match(answers, /STORY\.answerLabel/)
    assert.match(answers, /row\.label/)
    assert.match(answers, /row\.body/)
    const geminiAt = answers.indexOf('{row ? (')
    assert.equal(geminiAt > 0, true)
    const geminiBlock = answers.slice(geminiAt)
    assert.equal(geminiBlock.includes('MentionMark'), false)
    assert.equal(geminiBlock.includes('whoInstead'), false)
    const report = readFileSync(new URL('../functions/api/full-report.ts', import.meta.url), 'utf8')
    const scheduled = readFileSync(new URL('../functions/scheduled.ts', import.meta.url), 'utf8')
    assert.match(report, /GEMINI_API_KEY/)
    assert.equal(report.includes('VITE_'), false)
    assert.equal(report.includes('aiplatform.googleapis.com'), false)
    assert.equal(scheduled.includes('GEMINI'), false)
    assert.equal(PRODUCT_DEFAULTS.trackingCronEnabled, false)
  })

  it('keeps the flash model as a knob and does not call Vertex', () => {
    assert.equal(GEMINI_MODEL_DEFAULT, 'gemini-3.5-flash-lite')
    assert.equal(geminiModelFromEnv(undefined), GEMINI_MODEL_DEFAULT)
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: 'gemini-2.0-flash' }), 'gemini-2.0-flash')
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: 'gemini-2.5-pro' }), GEMINI_MODEL_DEFAULT)
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: 'https://aiplatform.googleapis.com/gemini' }), GEMINI_MODEL_DEFAULT)
    const url = geminiGenerateUrl('gemini-2.0-flash')
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    assert.equal(url.includes('aiplatform.googleapis.com'), false)
    const prompt = geminiAnswerPrompt(['What should a team use for issue tracking?'])
    assert.equal(/whoInstead|mention|Perplexity|Vertex|multi-engine/i.test(prompt), false)
    assert.deepEqual(
      parseGeminiAnswers(JSON.stringify({ answers: ['A tracker helps.'], whoInstead: ['Monday'] }), 1),
      ['A tracker helps.'],
    )
  })

  it('returns Gemini text beside the OpenAI result and does not harvest Gemini names', async () => {
    const urls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      if (url.startsWith('https://linear.app')) {
        return new Response('<title>Linear</title><p>Linear is an issue tracker for software teams.</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.includes('api.openai.com')) {
        const sent = String(init?.body || '')
        assert.match(sent, /gpt-4o-mini/)
        assert.equal(sent.includes(GEMINI_KEY), false)
        assert.equal(sent.includes('"answers"'), false)
        return new Response(
          modelPayload({
            ...GOOD,
            mentions: ['not_mentioned', 'not_mentioned', 'not_mentioned'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/)
      assert.equal(url.includes(GEMINI_KEY), false)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-goog-api-key'), GEMINI_KEY)
      const sent = String(init?.body || '')
      assert.equal(sent.includes(GEMINI_KEY), false)
      assert.match(sent, /What is Linear\?/)
      const sentBody = JSON.parse(sent) as {
        generationConfig?: {
          thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string }
          maxOutputTokens?: number
          responseMimeType?: string
        }
      }
      assert.equal(sentBody.generationConfig?.responseMimeType, 'application/json')
      assert.deepEqual(sentBody.generationConfig?.thinkingConfig, { thinkingLevel: 'minimal' })
      assert.equal(sentBody.generationConfig?.maxOutputTokens, geminiMaxOutputTokens(3))
      assert.equal(
        urls.filter((item) => item.includes('generativelanguage.googleapis.com')).length,
        1,
      )
      return new Response(
        geminiPayload([
          `Monday and ClickUp are common picks. key ${GEMINI_KEY} must not leak.`,
          'Asana sometimes shows up in roundups.',
          '',
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app'),
        env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY },
      })
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.equal(text.includes(KEY), false)
      assert.equal(text.includes(GEMINI_KEY), false)
      const body = JSON.parse(text) as {
        answered?: string
        why?: string
        model?: string
        questions?: string[]
        whoInstead?: string[]
        answers?: string[]
        gemini?: string[]
        facts?: { mention?: string; whoInstead?: string[]; question?: string; framing?: string }[]
      }
      assert.equal(body.answered, 'partial')
      assert.equal(body.why, GOOD.why)
      assert.equal(body.model, 'gpt-4o-mini')
      assert.deepEqual(body.questions, GOOD.questions)
      assert.deepEqual(body.whoInstead, ['Jira', 'Asana'])
      assert.equal('answers' in body, false)
      assert.equal(body.gemini?.length, 3)
      assert.match(body.gemini?.[0] || '', /Monday and ClickUp/)
      assert.match(body.gemini?.[0] || '', /\[redacted\]/)
      assert.match(body.gemini?.[1] || '', /Asana/)
      assert.equal(body.gemini?.[2], '')
      assert.equal('geminiMiss' in body, false)
      assert.equal(body.facts?.every((fact) => fact.mention === 'not_mentioned'), true)
      assert.equal(body.facts?.every((fact) => fact.framing === 'unbranded'), true)
      assert.deepEqual(body.facts?.[0]?.whoInstead, ['Jira', 'Asana'])
      assert.equal(JSON.stringify(body.facts).includes('Monday'), false)
      assert.equal(JSON.stringify(body.facts).includes('ClickUp'), false)
      const topics = whoInsteadByTopic([
        {
          id: 'problems',
          title: 'Problems you solve',
          framing: 'unbranded',
          questions: (body.facts || []).map((fact) => ({
            question: fact.question || '',
            framing: 'unbranded' as const,
            mention: fact.mention as 'not_mentioned',
            whoInstead: fact.whoInstead || [],
          })),
        },
      ])
      const names = topics.flatMap((topic) => topic.names.map((row) => row.name))
      assert.deepEqual(names.sort(), ['Asana', 'Jira'])
      assert.equal(names.includes('Monday'), false)
      assert.equal(urls.some((url) => url.includes('generativelanguage.googleapis.com')), true)
      assert.equal(urls.some((url) => url.includes('aiplatform.googleapis.com')), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('keeps the OpenAI answer when Gemini fails or the key is missing', async () => {
    const cases: { env: Record<string, string>; geminiStatus: number | 'throw'; log: string }[] = [
      { env: { OPENAI_API_KEY: KEY }, geminiStatus: 500, log: 'gemini miss missing_key' },
      { env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY }, geminiStatus: 500, log: 'gemini miss http_reject 500' },
      { env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY }, geminiStatus: 'throw', log: 'gemini miss timeout' },
    ]
    for (const item of cases) {
      const urls: string[] = []
      const logs: string[] = []
      const prev = globalThis.fetch
      const prevInfo = console.info
      console.info = (...args: unknown[]) => {
        logs.push(args.map((part) => String(part)).join(' '))
      }
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        urls.push(url)
        if (!url.includes('api.openai.com') && !url.includes('generativelanguage.googleapis.com')) {
          return new Response('nope', { status: 404 })
        }
        if (url.includes('generativelanguage.googleapis.com')) {
          if (item.geminiStatus === 'throw') throw new Error(`network ${GEMINI_KEY}`)
          return new Response(JSON.stringify({ error: { message: `bad ${GEMINI_KEY}` } }), { status: item.geminiStatus })
        }
        return new Response(modelPayload(GOOD), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      try {
        const res = await onRequest({
          request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=unbranded'),
          env: item.env,
        })
        assert.equal(res.status, 200)
        const text = await res.text()
        assert.equal(text.includes(KEY), false)
        assert.equal(text.includes(GEMINI_KEY), false)
        assert.equal(text.includes('prompt should not leak') || text.includes('network'), false)
        const body = JSON.parse(text) as {
          answered?: string
          why?: string
          questions?: string[]
          whoInstead?: string[]
          gemini?: string[]
          geminiMiss?: { class?: string; status?: number; message?: string; body?: string }
        }
        assert.equal(body.answered, 'partial')
        assert.equal(body.why, GOOD.why)
        assert.deepEqual(body.questions, GOOD.questions)
        assert.deepEqual(body.whoInstead, ['Jira', 'Asana'])
        assert.deepEqual(body.gemini, ['', '', ''])
        const expectMiss =
          item.log === 'gemini miss missing_key'
            ? { class: 'missing_key' }
            : item.log === 'gemini miss http_reject 500'
              ? { class: 'http_reject', status: 500 }
              : { class: 'timeout' }
        assert.deepEqual(body.geminiMiss, expectMiss)
        assert.equal(body.geminiMiss?.message, undefined)
        assert.equal(body.geminiMiss?.body, undefined)
        assert.equal(JSON.stringify(body.geminiMiss).includes(GEMINI_KEY), false)
        assert.equal(JSON.stringify(body.geminiMiss).includes(KEY), false)
        const calledGemini = urls.some((url) => url.includes('generativelanguage.googleapis.com'))
        assert.equal(calledGemini, Boolean(item.env.GEMINI_API_KEY))
        assert.deepEqual(logs, [item.log])
        assert.equal(logs.some((line) => line.includes(GEMINI_KEY) || line.includes(KEY)), false)
      } finally {
        globalThis.fetch = prev
        console.info = prevInfo
      }
    }
  })

  it('does not call Gemini for branded dig', async () => {
    const urls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      if (!url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      return new Response(
        modelPayload({
          questions: ['What is Linear?', 'How do people describe Linear?', 'What does Linear claim?'],
          answers: ['Linear is a project tool. The note stays general. No quote.'],
          answered: 'partial',
          why: 'Named questions get a partial description.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app&mode=branded'),
        env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY, GEMINI_MODEL: 'gemini-2.0-flash' },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { mode?: string; answers?: string[]; gemini?: unknown }
      assert.equal(body.mode, 'branded')
      assert.equal(body.answers?.length, 3)
      assert.equal('gemini' in body, false)
      assert.equal(urls.some((url) => url.includes('generativelanguage.googleapis.com')), false)
      assert.equal('geminiMiss' in body, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('adds a temporary guest geminiMiss when every reply is blank and never the key', async () => {
    const src = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.match(src, /TEMP until bet \(15\) passes — remove/)
    const answers = readFileSync(new URL('../src/UnbrandedAnswers.tsx', import.meta.url), 'utf8')
    assert.equal(answers.includes('geminiMiss'), false)
    const leaked = `bad ${GEMINI_KEY} prompt should not leak`
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: leaked, body: leaked } }), { status: 400 })
      }
      if (url.includes('api.openai.com')) {
        return new Response(modelPayload(GOOD), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-grank-anon': 'anon-guest' },
          body: JSON.stringify({ domain: 'linear.app', mode: 'unbranded' }),
        }),
        env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY },
      })
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.equal(text.includes(GEMINI_KEY), false)
      assert.equal(text.includes(KEY), false)
      assert.equal(text.includes('prompt should not leak'), false)
      const body = JSON.parse(text) as {
        gemini?: string[]
        geminiMiss?: { class?: string; status?: number; message?: string; body?: string; key?: string }
      }
      assert.deepEqual(body.gemini, ['', '', ''])
      assert.deepEqual(body.geminiMiss, { class: 'http_reject', status: 400 })
      assert.equal(Object.keys(body.geminiMiss ?? {}).sort().join(','), 'class,status')
      const read = interpretVisibilityResponse(200, JSON.parse(text), false, 'linear.app', 'unbranded')
      assert.equal(read.ok, true)
      if (!read.ok) return
      assert.equal('geminiMiss' in read, false)
      assert.equal(JSON.stringify(read).includes('http_reject'), false)
      assert.equal(JSON.stringify(read).includes(GEMINI_KEY), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('reads Gemini text on the client without turning it into who-instead or mention', () => {
    const ok = interpretVisibilityResponse(
      200,
      {
        ok: true,
        mode: 'unbranded',
        model: 'gpt-4o-mini',
        questions: GOOD.questions,
        answered: 'partial',
        why: GOOD.why,
        whoInstead: ['Jira', 'Asana'],
        mentions: ['not_mentioned', 'not_mentioned', 'not_mentioned'],
        gemini: ['Monday and ClickUp show up for this job.', ''],
      },
      false,
      'linear.app',
      'unbranded',
    )
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    assert.deepEqual(ok.answers, [])
    assert.deepEqual(ok.whoInstead, ['Jira', 'Asana'])
    assert.equal(ok.gemini[0]?.includes('Monday'), true)
    assert.equal(ok.gemini[1], '')
    assert.equal(ok.gemini[2], '')
    assert.equal(ok.facts.every((fact) => fact.mention === 'not_mentioned'), true)
    assert.deepEqual(ok.facts[0]?.whoInstead, ['Jira', 'Asana'])
    assert.equal(JSON.stringify(ok.facts).includes('Monday'), false)
  })

  it('maps each Gemini miss to one class and does not leak the key, prompt, or body', async () => {
    assert.deepEqual([...GEMINI_MISS_CLASSES], ['missing_key', 'http_reject', 'timeout', 'bad_json', 'empty'])
    assert.equal(STORY.geminiMiss, "Gemini didn't answer.")
    const answers = readFileSync(new URL('../src/UnbrandedAnswers.tsx', import.meta.url), 'utf8')
    const section = readFileSync(new URL('../src/FullReportSection.tsx', import.meta.url), 'utf8')
    assert.equal(answers.includes('geminiMiss'), false)
    assert.equal(answers.includes('missing_key'), false)
    assert.equal(answers.includes('http_reject'), false)
    assert.equal(section.includes('missing_key'), false)
    assert.equal(section.includes('http_reject'), false)
    const flash = geminiGenerationConfig('gemini-2.5-flash', 3)
    assert.equal(flash.thinkingConfig?.thinkingBudget, 0)
    assert.equal('thinkingLevel' in (flash.thinkingConfig ?? {}), false)
    const lite = geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 3)
    assert.deepEqual(lite.thinkingConfig, { thinkingLevel: 'minimal' })
    assert.equal(lite.maxOutputTokens, 880)
    assert.equal(lite.responseMimeType, 'application/json')
    assert.equal(geminiMaxOutputTokens(100), 1_200)
    assert.equal(GEMINI_TIMEOUT_CAP_MS, 8_000)
    assert.equal(geminiTimeoutFromEnv(undefined), 8_000)
    assert.equal(geminiTimeoutFromEnv({ GEMINI_TIMEOUT_MS: '60000' }), 8_000)
    assert.equal(geminiTimeoutFromEnv({ GEMINI_TIMEOUT_MS: '250' }), 250)
    assert.equal(
      geminiWaitMs({ capMs: 8_000, budgetMs: GEMINI_REPORT_BUDGET_MS, startedAt: 0, now: 0 }),
      8_000,
    )
    assert.equal(
      geminiWaitMs({ capMs: 8_000, budgetMs: GEMINI_REPORT_BUDGET_MS, startedAt: 0, now: 24_000 }),
      0,
    )
    const older = geminiGenerationConfig('gemini-2.0-flash', 2)
    assert.equal('thinkingConfig' in older, false)
    assert.equal(geminiGenerateUrl(GEMINI_MODEL_DEFAULT).includes('generativelanguage.googleapis.com'), true)
    assert.deepEqual(geminiMissForResponse({ class: 'http_reject', status: 404 }), { class: 'http_reject', status: 404 })
    assert.deepEqual(geminiMissForResponse({ class: 'http_reject', status: 0 }), { class: 'http_reject' })
    assert.equal(geminiMissLogLine({ class: 'missing_key' }), 'gemini miss missing_key')
    assert.equal(geminiMissLogLine({ class: 'http_reject', status: 429 }), 'gemini miss http_reject 429')
    assert.equal(geminiMissLogLine({ class: 'timeout' }), 'gemini miss timeout')
    assert.equal(geminiMissLogLine({ class: 'bad_json' }), 'gemini miss bad_json')
    assert.equal(geminiMissLogLine({ class: 'empty' }), 'gemini miss empty')
    assert.equal(geminiMissLogLine({ class: 'missing_key', status: 500 }).includes('500'), false)

    const shapeQuestions = ['What should a team use for issue tracking?']
    const model = geminiModelFromEnv(undefined)
    const prompt = geminiAnswerPrompt(shapeQuestions)
    const documented = geminiGenerateBody(model, prompt, shapeQuestions.length)
    const documentedUrl = geminiGenerateUrl(model)
    assert.equal(model, 'gemini-3.5-flash-lite')
    assert.equal(
      documentedUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    )
    assert.equal(documentedUrl.includes('key='), false)
    assert.equal(documented.contents[0].role, 'user')
    assert.equal(documented.contents[0].parts.length, 1)
    assert.equal(documented.contents[0].parts[0].text, prompt)
    assert.deepEqual(documented.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' })
    const legacy = geminiGenerateBody('gemini-2.5-flash', prompt, 1)
    assert.deepEqual(legacy.generationConfig.thinkingConfig, { thinkingBudget: 0 })
    assert.equal(documented.generationConfig.responseMimeType, 'application/json')
    assert.equal(documented.generationConfig.temperature, 0.2)
    assert.equal(documented.generationConfig.maxOutputTokens, 560)
    assert.equal('responseSchema' in documented.generationConfig, false)
    assert.equal('thinkingConfig' in documented, false)
    assert.equal('responseSchema' in documented, false)
    assert.equal(JSON.stringify(documented).includes(GEMINI_KEY), false)

    assert.equal(geminiApiKeyFromEnv(undefined), '')
    assert.equal(geminiApiKeyFromEnv({ GEMINI_API_KEY: '  gemini-key  ' }), 'gemini-key')
    assert.equal(geminiApiKeyFromEnv({ GEMINI_API_KEY: '   ' }), '')
    assert.equal(geminiApiKeyFromEnv({ VITE_GEMINI_API_KEY: GEMINI_KEY }), '')
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: '  gemini-2.5-flash  ' }), 'gemini-2.5-flash')
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: 'models/gemini-2.5-flash' }), GEMINI_MODEL_DEFAULT)
    assert.equal(geminiModelFromEnv({ VITE_GEMINI_MODEL: 'gemini-2.0-flash' }), GEMINI_MODEL_DEFAULT)
    assert.equal(geminiModelFromEnv({ GEMINI_MODEL: 'gemini-2.5-pro' }), GEMINI_MODEL_DEFAULT)
    const proUrl = geminiGenerateUrl(geminiModelFromEnv({ GEMINI_MODEL: 'gemini-2.5-pro' }))
    assert.equal(proUrl, geminiGenerateUrl(GEMINI_MODEL_DEFAULT))
    const proBody = geminiGenerateBody(geminiModelFromEnv({ GEMINI_MODEL: 'gemini-2.5-pro' }), prompt, 1)
    assert.deepEqual(proBody.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' })

    const shapeCalls: { url: string; body: string; key: string | null }[] = []
    const prevFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      shapeCalls.push({ url, body: String(init?.body || ''), key: headers.get('x-goog-api-key') })
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answers":["A tracker."]}' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const sent = await geminiReplies({
        apiKey: GEMINI_KEY,
        model,
        questions: shapeQuestions,
        scrub: [],
        timeoutMs: 1_000,
      })
      assert.equal(sent.miss, undefined)
      assert.equal(shapeCalls.length, 1)
      assert.equal(shapeCalls[0]?.url, documentedUrl)
      assert.equal(shapeCalls[0]?.key, GEMINI_KEY)
      assert.equal(shapeCalls[0]?.url.includes(GEMINI_KEY), false)
      assert.equal(shapeCalls[0]?.body.includes(GEMINI_KEY), false)
      assert.deepEqual(JSON.parse(shapeCalls[0]?.body || '{}'), documented)
      const blankKey = await geminiReplies({
        apiKey: '   ',
        model,
        questions: shapeQuestions,
        scrub: [],
        timeoutMs: 1_000,
      })
      assert.deepEqual(blankKey, { replies: [''], miss: { class: 'missing_key' } })
      assert.equal(shapeCalls.length, 1)
      const viteOnly = await geminiReplies({
        apiKey: geminiApiKeyFromEnv({ VITE_GEMINI_API_KEY: GEMINI_KEY }),
        model: geminiModelFromEnv({ VITE_GEMINI_MODEL: 'gemini-2.0-flash', GEMINI_MODEL: 'gemini-2.5-pro' }),
        questions: shapeQuestions,
        scrub: [],
      })
      assert.deepEqual(viteOnly.miss, { class: 'missing_key' })
      assert.equal(shapeCalls.length, 1)
    } finally {
      globalThis.fetch = prevFetch
    }

    const filled = geminiTextMiss(JSON.stringify({ answers: ['Monday is a common pick.', ''] }), 2)
    assert.equal(filled.miss, undefined)
    assert.equal(filled.replies[0], 'Monday is a common pick.')
    assert.equal(filled.replies[1], '')
    assert.deepEqual(geminiTextMiss('', 2).miss, { class: 'empty' })
    assert.deepEqual(geminiTextMiss(JSON.stringify({ answers: ['', ''] }), 2).miss, { class: 'empty' })
    assert.deepEqual(geminiTextMiss('here is some prose', 2).miss, { class: 'bad_json' })
    assert.deepEqual(geminiTextMiss('{"answers":', 1).miss, { class: 'bad_json' })
    assert.deepEqual(geminiTextMiss('', 2, 'MAX_TOKENS').miss, { class: 'bad_json' })
    assert.deepEqual(
      geminiTextMiss(JSON.stringify({ answers: ['', ''] }), 2, 'MAX_TOKENS').miss,
      { class: 'bad_json' },
    )
    assert.deepEqual(geminiTextMiss('{"answers":["cut', 2, 'MAX_TOKENS').miss, { class: 'bad_json' })
    assert.equal(
      geminiTextMiss(JSON.stringify({ answers: ['Monday is a common pick.'] }), 1, 'MAX_TOKENS').miss,
      undefined,
    )
    assert.deepEqual(geminiTextMiss('', 2, 'STOP').miss, { class: 'empty' })

    const questions = ['What should a team use for issue tracking?']
    const leak = `bad ${GEMINI_KEY} prompt should not leak`
    const cases: { name: string; run: () => Promise<Response>; log: string; miss: { class: string; status?: number } }[] = [
      {
        name: 'missing_key',
        run: async () => {
          throw new Error('fetch should not run')
        },
        log: 'gemini miss missing_key',
        miss: { class: 'missing_key' },
      },
      {
        name: 'http_reject',
        run: async () => new Response(JSON.stringify({ error: { message: leak } }), { status: 404 }),
        log: 'gemini miss http_reject 404',
        miss: { class: 'http_reject', status: 404 },
      },
      {
        name: 'http_reject_5xx',
        run: async () => new Response(leak, { status: 503 }),
        log: 'gemini miss http_reject 503',
        miss: { class: 'http_reject', status: 503 },
      },
      {
        name: 'timeout',
        run: async () => {
          const err = new Error(`timed out ${GEMINI_KEY}`)
          err.name = 'TimeoutError'
          throw err
        },
        log: 'gemini miss timeout',
        miss: { class: 'timeout' },
      },
      {
        name: 'transport',
        run: async () => {
          throw new Error(`network ${GEMINI_KEY}`)
        },
        log: 'gemini miss timeout',
        miss: { class: 'timeout' },
      },
      {
        name: 'bad_json',
        run: async () => new Response(`not-json ${GEMINI_KEY}`, { status: 200 }),
        log: 'gemini miss bad_json parse',
        miss: { class: 'bad_json' },
      },
      {
        name: 'bad_shape',
        run: async () =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: `sure ${GEMINI_KEY}` }] } }] }),
            { status: 200 },
          ),
        log: 'gemini miss bad_json parse',
        miss: { class: 'bad_json' },
      },
      {
        name: 'empty',
        run: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
        log: 'gemini miss empty',
        miss: { class: 'empty' },
      },
      {
        name: 'empty_answers',
        run: async () =>
          new Response(
            JSON.stringify({
              candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ answers: [''] }) }] } }],
            }),
            { status: 200 },
          ),
        log: 'gemini miss empty',
        miss: { class: 'empty' },
      },
      {
        name: 'max_tokens',
        run: async () =>
          new Response(
            JSON.stringify({
              candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '' }] } }],
            }),
            { status: 200 },
          ),
        log: 'gemini miss bad_json max_tokens',
        miss: { class: 'bad_json' },
      },
      {
        name: 'truncated_json',
        run: async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: 'MAX_TOKENS',
                  content: { parts: [{ text: '{"answers":["cut' }] },
                },
              ],
            }),
            { status: 200 },
          ),
        log: 'gemini miss bad_json max_tokens',
        miss: { class: 'bad_json' },
      },
      {
        name: 'abort',
        run: async () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          throw err
        },
        log: 'gemini miss timeout',
        miss: { class: 'timeout' },
      },
    ]

    for (const item of cases) {
      const logs: string[] = []
      const prevInfo = console.info
      const prev = globalThis.fetch
      let called = false
      console.info = (...args: unknown[]) => {
        logs.push(args.map((part) => String(part)).join(' '))
      }
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        called = true
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('x-goog-api-key'), GEMINI_KEY)
        assert.equal(headers.has('authorization'), false)
        const sent = String(init?.body || '')
        assert.equal(sent.includes(GEMINI_KEY), false)
        return item.run()
      }) as typeof fetch
      try {
        const result = await geminiReplies({
          apiKey: item.name === 'missing_key' ? '' : GEMINI_KEY,
          model: GEMINI_MODEL_DEFAULT,
          questions,
          scrub: [GEMINI_KEY],
        })
        assert.deepEqual(result.replies, [''])
        assert.deepEqual(result.miss, item.miss)
        assert.deepEqual(logs, [item.log])
        const packed = JSON.stringify(result) + logs.join('\n')
        assert.equal(packed.includes(GEMINI_KEY), false)
        assert.equal(packed.includes('prompt should not leak'), false)
        assert.equal(packed.includes('not-json'), false)
        assert.equal(packed.includes('sure '), false)
        assert.equal(called, item.name !== 'missing_key')
      } finally {
        console.info = prevInfo
        globalThis.fetch = prev
      }
    }

    const logs: string[] = []
    const prevInfo = console.info
    const prev = globalThis.fetch
    console.info = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '))
    }
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: JSON.stringify({ answers: [`thought ${GEMINI_KEY}`] }) },
                  { text: JSON.stringify({ answers: [`Monday is a common pick. key ${GEMINI_KEY} stays out.`] }) },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch
    try {
      const hit = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: 'gemini-2.0-flash',
        questions,
        scrub: [GEMINI_KEY],
      })
      assert.equal(hit.miss, undefined)
      assert.match(hit.replies[0] || '', /Monday is a common pick/)
      assert.match(hit.replies[0] || '', /\[redacted\]/)
      assert.equal((hit.replies[0] || '').includes('thought'), false)
      assert.deepEqual(logs, [])
      assert.equal(JSON.stringify(hit).includes(GEMINI_KEY), false)
    } finally {
      console.info = prevInfo
      globalThis.fetch = prev
    }
  })

  it('chunks a full report into at most two calls and gives each one a 110-token answer budget', async () => {
    const answerTokens = 110
    const sizes: Record<number, number[]> = {
      1: [1],
      4: [4],
      6: [6],
      12: [6, 6],
      20: [10, 10],
      80: [40, 40],
    }
    for (const raw of Object.keys(sizes)) {
      const count = Number(raw)
      const questions = Array.from({ length: count }, (_, index) => `q${index}`)
      const slices = geminiQuestionChunks(questions)
      assert.ok(slices.length <= 2, `n=${count} made ${slices.length} chunks`)
      assert.deepEqual(
        slices.map((slice) => slice.length),
        sizes[count],
      )
      assert.deepEqual(slices.flat(), questions)
      const planned = geminiChunkSize(count)
      assert.equal(
        geminiChunkMaxOutputTokens(planned),
        planned * GEMINI_CHUNK_TOKENS_PER_QUESTION + GEMINI_CHUNK_TOKEN_BASE,
      )
      assert.ok(geminiChunkMaxOutputTokens(planned) >= slices[0].length * answerTokens)
    }
    assert.deepEqual(
      geminiMissFromChunks([undefined, { class: 'bad_json' }, { class: 'http_reject', status: 500 }]),
      { class: 'http_reject', status: 500 },
    )
    assert.deepEqual(geminiGenerationConfig('gemini-2.5-flash', 4).thinkingConfig, { thinkingBudget: 0 })
    assert.deepEqual(geminiGenerationConfig('gemini-2.5-flash-lite', 1).thinkingConfig, { thinkingBudget: 0 })
    assert.deepEqual(geminiGenerationConfig('gemini-3.5-flash-lite', 6).thinkingConfig, { thinkingLevel: 'minimal' })
    assert.deepEqual(geminiGenerationConfig('gemini-3-flash', 2).thinkingConfig, { thinkingLevel: 'minimal' })
    assert.equal('thinkingConfig' in geminiGenerationConfig('gemini-2.0-flash', 2), false)
    assert.equal(geminiGenerationConfig('gemini-2.5-flash', 6).responseMimeType, 'application/json')
    assert.equal(geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 12).responseMimeType, 'application/json')

    const questions = Array.from({ length: 12 }, (_, index) => `What should a team use for job ${index}?`)
    assert.equal(geminiMaxOutputTokens(12), 1_200)
    assert.equal(400 + 12 * 160, 2_320)
    assert.ok(12 * answerTokens > geminiMaxOutputTokens(12))
    const oldConfig = geminiGenerateBody(GEMINI_MODEL_DEFAULT, geminiAnswerPrompt(questions), questions.length)
    assert.equal(oldConfig.generationConfig.maxOutputTokens, 1_200)
    assert.equal(oldConfig.generationConfig.responseMimeType, 'application/json')
    const sentinel = 'TRUNCATED-BODY-MUST-NOT-LOG'
    const logs: string[] = []
    const prevInfo = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '))
    }
    const seen: { maxOutputTokens?: number; responseMimeType?: string; thinking?: unknown; count: number }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '')) as {
        generationConfig?: {
          maxOutputTokens?: number
          responseMimeType?: string
          thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number }
        }
        contents?: { parts?: { text?: string }[] }[]
      }
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? ''
      const count = (prompt.match(/^\d+\. /gm) ?? []).length
      seen.push({
        maxOutputTokens: body.generationConfig?.maxOutputTokens,
        responseMimeType: body.generationConfig?.responseMimeType,
        thinking: body.generationConfig?.thinkingConfig,
        count,
      })
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'MAX_TOKENS',
              content: { parts: [{ text: `{"answers":["${sentinel}` }] },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const old = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: false,
      })
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.count, 12)
      assert.equal(seen[0]?.maxOutputTokens, 1_200)
      assert.equal(seen[0]?.responseMimeType, 'application/json')
      assert.deepEqual(old.replies, questions.map(() => ''))
      assert.deepEqual(old.miss, { class: 'bad_json' })
      assert.equal('reason' in (old.miss ?? {}), false)
      assert.deepEqual(logs, ['gemini miss bad_json max_tokens'])
      assert.equal(logs.join('\n').includes(sentinel), false)
      assert.equal(JSON.stringify(old).includes(sentinel), false)
      assert.equal(JSON.stringify(old).includes(GEMINI_KEY), false)
    } finally {
      globalThis.fetch = prev
      console.info = prevInfo
    }

    const planned = geminiChunkSize(12)
    const budget = geminiChunkMaxOutputTokens(planned)
    assert.equal(planned, 6)
    assert.equal(budget, 6 * 200 + 64)
    assert.equal(budget, 1_264)
    assert.ok(budget >= 6 * answerTokens)
    assert.ok(budget >= 6 * answerTokens + GEMINI_CHUNK_TOKEN_BASE)

    const chunkLogs: string[] = []
    const chunkSeen: { maxOutputTokens?: number; responseMimeType?: string; thinking?: unknown; count: number }[] = []
    console.info = (...args: unknown[]) => {
      chunkLogs.push(args.map((part) => String(part)).join(' '))
    }
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '')) as {
        generationConfig?: {
          maxOutputTokens?: number
          responseMimeType?: string
          thinkingConfig?: { thinkingLevel?: string }
        }
        contents?: { parts?: { text?: string }[] }[]
      }
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? ''
      const asked = questions.filter((question) => prompt.includes(question))
      chunkSeen.push({
        maxOutputTokens: body.generationConfig?.maxOutputTokens,
        responseMimeType: body.generationConfig?.responseMimeType,
        thinking: body.generationConfig?.thinkingConfig,
        count: asked.length,
      })
      const answers = asked.map((question) => `Kept ${question}`)
      const fenced = '```json\n' + JSON.stringify({ answers }) + '\n```'
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { thought: true, text: JSON.stringify({ answers: [`thought ${GEMINI_KEY}`] }) },
                  { text: fenced },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const next = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(chunkSeen.length, 2)
      assert.deepEqual(
        chunkSeen.map((item) => item.count),
        [6, 6],
      )
      assert.equal(
        chunkSeen.every((item) => item.maxOutputTokens === budget && item.responseMimeType === 'application/json'),
        true,
      )
      assert.equal(
        chunkSeen.every((item) => JSON.stringify(item.thinking) === JSON.stringify({ thinkingLevel: 'minimal' })),
        true,
      )
      assert.deepEqual(
        next.replies,
        questions.map((question) => `Kept ${question}`),
      )
      assert.equal(next.miss, undefined)
      assert.equal(next.replies.some((reply) => reply.includes('thought')), false)
      assert.deepEqual(chunkLogs, [])
      assert.equal(JSON.stringify(next).includes(GEMINI_KEY), false)
    } finally {
      globalThis.fetch = prev
      console.info = prevInfo
    }
  })

  it('blanks only the chunk that missed and does not salvage a MAX_TOKENS parse', async () => {
    const questions = Array.from({ length: 12 }, (_, index) => `What should a team use for job ${index}?`)
    const salvage = `Salvage ${GEMINI_KEY} must not leak`
    const logs: string[] = []
    const prevInfo = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '))
    }
    const seen: { responseMimeType?: string; maxOutputTokens?: number }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '')) as {
        generationConfig?: { responseMimeType?: string; maxOutputTokens?: number }
        contents?: { parts?: { text?: string }[] }[]
      }
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? ''
      seen.push({
        responseMimeType: body.generationConfig?.responseMimeType,
        maxOutputTokens: body.generationConfig?.maxOutputTokens,
      })
      const asked = questions.filter((question) => prompt.includes(question))
      if (prompt.includes('job 0?')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'MAX_TOKENS',
                content: {
                  parts: [{ text: JSON.stringify({ answers: asked.map(() => salvage) }) }],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify({ answers: asked.map((question) => `Kept ${question}`) }) }] },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const hit = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(seen.length, 2)
      assert.equal(
        seen.every((item) => item.responseMimeType === 'application/json' && item.maxOutputTokens === 1_264),
        true,
      )
      assert.deepEqual(hit.replies.slice(0, 6), ['', '', '', '', '', ''])
      assert.deepEqual(
        hit.replies.slice(6),
        questions.slice(6).map((question) => `Kept ${question}`),
      )
      assert.deepEqual(hit.miss, { class: 'bad_json' })
      assert.equal(Object.keys(hit.miss ?? {}).join(','), 'class')
      assert.deepEqual(logs, ['gemini miss bad_json max_tokens'])
      const packed = JSON.stringify(hit) + logs.join('\n')
      assert.equal(packed.includes(salvage), false)
      assert.equal(packed.includes(GEMINI_KEY), false)
      assert.equal(packed.includes('MAX_TOKENS'), false)
    } finally {
      globalThis.fetch = prev
      console.info = prevInfo
    }

    const parseLogs: string[] = []
    console.info = (...args: unknown[]) => {
      parseLogs.push(args.map((part) => String(part)).join(' '))
    }
    const prose = `not-json ${GEMINI_KEY} prompt should not leak`
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '')) as { contents?: { parts?: { text?: string }[] }[] }
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? ''
      const asked = questions.filter((question) => prompt.includes(question))
      if (prompt.includes('job 6?')) {
        return new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: prose }] } }],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify({ answers: asked.map((question) => `Kept ${question}`) }) }] },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const hit = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.deepEqual(
        hit.replies.slice(0, 6),
        questions.slice(0, 6).map((question) => `Kept ${question}`),
      )
      assert.deepEqual(hit.replies.slice(6), ['', '', '', '', '', ''])
      assert.deepEqual(hit.miss, { class: 'bad_json' })
      assert.deepEqual(parseLogs, ['gemini miss bad_json parse'])
      const packed = JSON.stringify(hit) + parseLogs.join('\n')
      assert.equal(packed.includes(prose), false)
      assert.equal(packed.includes(GEMINI_KEY), false)
      assert.equal(packed.includes('prompt should not leak'), false)
    } finally {
      globalThis.fetch = prev
      console.info = prevInfo
    }
  })

  it('retries a gemini-3 thinkingLevel 400 once and remembers the plain request', async () => {
    const questions = Array.from({ length: 12 }, (_, index) => `What should a team use for job ${index}?`)
    const bodies: { thinking?: unknown; responseMimeType?: string; maxOutputTokens?: number }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '')) as {
        generationConfig?: {
          thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number }
          responseMimeType?: string
          maxOutputTokens?: number
        }
        contents?: { parts?: { text?: string }[] }[]
      }
      bodies.push({
        thinking: body.generationConfig?.thinkingConfig,
        responseMimeType: body.generationConfig?.responseMimeType,
        maxOutputTokens: body.generationConfig?.maxOutputTokens,
      })
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? ''
      const asked = questions.filter((question) => prompt.includes(question))
      if (body.generationConfig?.thinkingConfig && 'thinkingLevel' in body.generationConfig.thinkingConfig) {
        return new Response(JSON.stringify({ error: { message: `bad ${GEMINI_KEY}` } }), { status: 400 })
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify({ answers: asked.map((question) => `Kept ${question}`) }) }] },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const hit = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(bodies.length, 4)
      assert.deepEqual(
        bodies.slice(0, 2).map((item) => item.thinking),
        [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'minimal' }],
      )
      assert.equal(
        bodies.slice(2).every((item) => item.thinking === undefined),
        true,
      )
      assert.equal(
        bodies.every((item) => item.responseMimeType === 'application/json' && item.maxOutputTokens === 1_264),
        true,
      )
      assert.deepEqual(
        hit.replies,
        questions.map((question) => `Kept ${question}`),
      )
      assert.equal(hit.miss, undefined)
      assert.equal(JSON.stringify(hit).includes(GEMINI_KEY), false)
      assert.equal('thinkingConfig' in geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 6), false)
      assert.deepEqual(geminiGenerationConfig('gemini-2.5-flash', 6).thinkingConfig, { thinkingBudget: 0 })

      bodies.length = 0
      const again = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(bodies.length, 2)
      assert.equal(
        bodies.every((item) => item.thinking === undefined && item.responseMimeType === 'application/json'),
        true,
      )
      assert.equal(again.miss, undefined)
    } finally {
      globalThis.fetch = prev
      resetGeminiThinkingMemo()
    }

    let posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 })
    }) as typeof fetch
    try {
      const rejected = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: GEMINI_MODEL_DEFAULT,
        questions,
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(posts, 2)
      assert.deepEqual(rejected.replies, questions.map(() => ''))
      assert.deepEqual(rejected.miss, { class: 'http_reject', status: 500 })
      assert.deepEqual(geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 1).thinkingConfig, { thinkingLevel: 'minimal' })
    } finally {
      globalThis.fetch = prev
    }

    posts = 0
    globalThis.fetch = (async () => {
      posts += 1
      return new Response(JSON.stringify({ error: { message: `bad ${GEMINI_KEY}` } }), { status: 400 })
    }) as typeof fetch
    try {
      const flash = await geminiReplies({
        apiKey: GEMINI_KEY,
        model: 'gemini-2.5-flash',
        questions: questions.slice(0, 6),
        scrub: [GEMINI_KEY],
        report: true,
      })
      assert.equal(posts, 1)
      assert.deepEqual(flash.miss, { class: 'http_reject', status: 400 })
      assert.deepEqual(geminiGenerationConfig(GEMINI_MODEL_DEFAULT, 1).thinkingConfig, { thinkingLevel: 'minimal' })
    } finally {
      globalThis.fetch = prev
    }
  })
})

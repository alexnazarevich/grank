/**
 * Signed-in full report: expand one question, run Gemini, and leave the rest put.
 * A paused OpenAI test changes that OpenAI block only.
 */
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { createServer, type ViteDevServer } from 'vite'
import { describe, it } from 'node:test'

const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const Q1 = 'What should a team use?'
const Q2 = 'How do teams plan a week?'
const OPENAI_1 = 'Stored OpenAI must stay.'
const GEMINI_1 = 'Stored Gemini until the test.'
const OPENAI_2 = 'Second OpenAI must stay.'
const GEMINI_2 = 'Second Gemini must stay.'
const FRESH = 'Only this Gemini block changed.'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

function savedCheck() {
  return {
    id: CHECK,
    domain: 'linear.app',
    mode: 'full',
    createdAt: '2026-09-27T12:00:00.000Z',
    result: {
      report: 'full',
      questionSetOwned: true,
      model: 'gpt-4o-mini',
      runs: [
        {
          at: '2026-09-27T12:00:00.000Z',
          mode: 'full',
          mentions: [
            { question: Q1, mention: 'not_mentioned', whoInstead: ['Jira'] },
            { question: Q2, mention: 'mentioned', whoInstead: [] },
          ],
        },
      ],
      fullReport: {
        domain: 'linear.app',
        model: 'gpt-4o-mini',
        includesBranded: false,
        themes: [
          {
            id: 'problems',
            title: 'Problems you solve',
            framing: 'unbranded',
            questions: [
              {
                question: Q1,
                answer: OPENAI_1,
                framing: 'unbranded',
                mention: 'not_mentioned',
                whoInstead: ['Jira'],
                gemini: GEMINI_1,
              },
              {
                question: Q2,
                answer: OPENAI_2,
                framing: 'unbranded',
                mention: 'mentioned',
                whoInstead: [],
                gemini: GEMINI_2,
              },
            ],
          },
        ],
      },
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('run test question on the signed-in report', () => {
  it('refreshes one Gemini block and does not burn a full report', async () => {
    const dom = new Window({ url: 'https://grank.test/' })
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      localStorage: globalThis.localStorage,
      sessionStorage: globalThis.sessionStorage,
      HTMLElement: globalThis.HTMLElement,
      fetch: globalThis.fetch,
    }
    globalThis.window = dom as unknown as Window & typeof globalThis.window
    globalThis.document = dom.document as unknown as Document
    globalThis.localStorage = dom.localStorage
    globalThis.sessionStorage = dom.sessionStorage
    globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const access = jwt({ sub: 'user-1', email: 'alex@example.com', exp: 2_000_000_000 })
    dom.localStorage.setItem(
      'grank.auth.session',
      JSON.stringify({
        access_token: access,
        refresh_token: 'refresh-1',
        expires_at: 1_900_000_000,
        user: { id: 'user-1', email: 'alex@example.com' },
      }),
    )

    const testBodies: { question?: string; engine?: string; domain?: string }[] = []
    const methods: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      methods.push(`${method} ${url}`)
      if (url.includes('/api/product-config')) return new Response('no', { status: 404 })
      if (url.includes('/api/checks') && method === 'GET') return jsonResponse({ ok: true, checks: [savedCheck()] })
      if (url.includes('/api/test-question') && method === 'POST') {
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { question?: string; engine?: string }) : {}
        testBodies.push(body)
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('authorization'), `Bearer ${access}`)
        assert.equal(headers.get('x-grank-anon'), null)
        if (body.engine === 'gemini') return jsonResponse({ ok: true, engine: 'gemini', gemini: FRESH })
        if (body.engine === 'openai') return jsonResponse({ ok: true, engine: 'openai', openaiPaused: true })
        return jsonResponse({ error: 'unexpected engine' }, 400)
      }
      return jsonResponse({ error: `unexpected ${method} ${url}` }, 500)
    }) as typeof fetch

    process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key'
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    const react = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = react
    let root: { unmount: () => void } | null = null
    try {
      const { default: App } = (await server.ssrLoadModule('/src/App.tsx')) as typeof import('../src/App.tsx')
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root?.render(react.createElement(App))
      })

      const text = () => (document.body.textContent || '').replace(/\s+/g, ' ')
      async function settle() {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
        })
      }
      async function waitFor(label: string, predicate: () => boolean) {
        const start = Date.now()
        while (Date.now() - start < 4000) {
          if (predicate()) return
          await settle()
        }
        throw new Error(`${label}\n${text().slice(0, 1200)}`)
      }
      function buttonNamed(label: string): HTMLButtonElement {
        const found = [...document.querySelectorAll('button')].find((btn) => (btn.textContent || '').includes(label))
        if (!found) throw new Error(`missing button ${label}\n${text().slice(0, 1200)}`)
        return found as HTMLButtonElement
      }
      async function clickNamed(label: string) {
        const btn = buttonNamed(label)
        await act(async () => {
          btn.click()
        })
        await settle()
      }
      function testEngine(engine: string): HTMLButtonElement {
        const found = document.querySelector(`.test-question button[data-engine="${engine}"]`)
        if (!found) throw new Error(`missing test ${engine}\n${text().slice(0, 1200)}`)
        return found as HTMLButtonElement
      }

      await waitFor('signed in', () => text().includes('alex@example.com'))
      await clickNamed('Your checks')
      await waitFor('history', () => text().includes('linear.app'))
      await clickNamed('linear.app')
      await waitFor('saved report', () => text().includes('Problems you solve') && text().includes('Run again'))
      assert.equal(text().includes('Run test question'), false)
      if (!text().includes(Q1)) await clickNamed('Problems you solve')
      await clickNamed(Q1)
      await waitFor('test control', () => text().includes('Run test question') && text().includes(GEMINI_1))
      assert.equal(text().includes('Only this question, one engine. Not a full report.'), true)
      assert.equal(text().includes('Which engines show under each question.'), true)
      assert.equal(text().includes(OPENAI_1), true)
      assert.equal(text().includes('50%'), true)
      assert.equal(text().includes('Jira'), true)
      assert.equal(text().includes('Not mentioned'), true)
      assert.equal(text().includes(OPENAI_2), false)
      assert.equal(text().includes(GEMINI_2), false)

      await act(async () => {
        testEngine('gemini').click()
      })
      await waitFor('fresh gemini', () => text().includes(FRESH))
      assert.equal(text().includes(GEMINI_1), false)
      assert.equal(text().includes(OPENAI_1), true)
      assert.equal(text().includes('50%'), true)
      assert.equal(text().includes('Jira'), true)
      assert.equal(text().includes('Not mentioned'), true)
      assert.equal(text().includes('Free limit reached'), false)
      assert.equal(text().includes('You’ve used your free full report.'), false)
      assert.equal(text().includes("ChatGPT is paused, so this run isn't saved to Over time."), false)
      assert.equal(testBodies.length, 1)
      assert.equal(testBodies[0]?.engine, 'gemini')
      assert.equal(testBodies[0]?.question, Q1)
      assert.equal(testBodies[0]?.domain, 'linear.app')
      assert.equal(methods.some((line) => line.includes('/api/full-report')), false)
      assert.equal(methods.some((line) => line.includes('/api/checks') && line.startsWith('POST')), false)
      assert.equal(methods.some((line) => line.includes('/api/checks') && line.startsWith('PATCH')), false)

      await clickNamed(Q2)
      await waitFor('second question', () => text().includes(OPENAI_2) && text().includes(GEMINI_2))
      assert.equal(text().includes(FRESH), true)
      assert.equal(text().includes(OPENAI_1), true)

      await act(async () => {
        testEngine('openai').click()
      })
      await waitFor('paused openai block', () => text().includes('ChatGPT is paused for this run.'))
      assert.equal(text().split('ChatGPT is paused for this run.').length - 1, 1)
      assert.equal(text().includes('Paused while ChatGPT is off.'), false)
      assert.equal(text().includes("ChatGPT is paused, so this run isn't saved to Over time."), false)
      assert.equal(text().includes(FRESH), true)
      assert.equal(text().includes(OPENAI_2), true)
      assert.equal(text().includes(GEMINI_2), true)
      assert.equal(text().includes('Not mentioned'), true)
      assert.equal(text().includes('50%'), true)
      assert.equal(text().includes('Jira'), true)
      assert.equal(testBodies[1]?.engine, 'openai')
      assert.equal(testBodies[1]?.question, Q1)
      assert.equal(methods.some((line) => line.includes('/api/full-report')), false)

      await clickNamed('Competitors')
      await waitFor('competitors', () => text().includes('Not market share.'))
      assert.equal(text().includes('50%'), true)
      assert.equal(text().includes('Jira'), true)
      assert.equal(text().includes(FRESH), false)
      if (!text().includes(Q1)) await clickNamed('Problems you solve')
      await clickNamed(Q1)
      await waitFor('competitors answer', () => text().includes(FRESH))
      assert.equal(text().includes(OPENAI_1), false)
      assert.equal(text().includes('ChatGPT is paused for this run.'), true)
      assert.equal(text().includes('50%'), true)
      assert.equal(text().includes('Jira'), true)
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount()
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      globalThis.fetch = previous.fetch
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.localStorage = previous.localStorage
      globalThis.sessionStorage = previous.sessionStorage
      globalThis.HTMLElement = previous.HTMLElement
      await server.close()
      await dom.happyDOM.close()
    }
  })
})

/**
 * Owned Run again, the way the screen does it: open a saved full report, open the
 * unbranded question, then Run again. This is App state, not a detached render.
 * A stored check has no class. A failed Run again must not look like that.
 * A 200 with geminiMiss must still be on the opened row after the response,
 * including after the engine filter remounts the grid.
 */
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { createServer, type ViteDevServer } from 'vite'
import { describe, it } from 'node:test'

const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const QUESTION = 'What should a team use?'
const STORED_ANSWER = 'Stored OpenAI answer.'
const PATCH_ANSWER = 'STORED ONLY ANSWER.'
const FRESH_ANSWER = 'Fresh OpenAI answer.'
const LEAK = 'prompt-should-not-leak'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
}

function reportBlob(answer: string) {
  return {
    report: 'full' as const,
    questionSetOwned: true,
    model: 'gpt-4o-mini',
    runs: [
      {
        at: '2026-09-27T12:00:00.000Z',
        mode: 'full',
        mentions: [{ question: QUESTION, mention: 'not_mentioned', whoInstead: ['Jira'] }],
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
              question: QUESTION,
              answer,
              framing: 'unbranded',
              mention: 'not_mentioned',
              whoInstead: ['Jira'],
              gemini: '',
            },
          ],
        },
      ],
    },
  }
}

function savedCheck(answer: string) {
  return {
    id: CHECK,
    domain: 'linear.app',
    mode: 'full',
    createdAt: '2026-09-27T12:00:00.000Z',
    result: reportBlob(answer),
  }
}

function freshReport() {
  const stored = reportBlob(FRESH_ANSWER)
  return {
    ok: true,
    report: 'full',
    domain: 'linear.app',
    model: 'gpt-4o-mini',
    includesBranded: false,
    themes: stored.fullReport.themes,
    check: { id: CHECK, domain: 'linear.app', createdAt: '2026-10-06T12:00:00.000Z' },
    runs: [
      ...stored.runs,
      {
        at: '2026-10-06T12:00:00.000Z',
        mode: 'full',
        mentions: [{ question: QUESTION, mention: 'not_mentioned', whoInstead: ['Jira'] }],
      },
    ],
    geminiMiss: { class: 'missing_key', message: LEAK, key: 'gemini-secret-key' },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

describe('owned Run again client state', () => {
  it('keeps the miss class on the opened unbranded row after Run again', async () => {
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

    let reportPosts = 0
    let patchBody: unknown = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (url.includes('/api/product-config')) return new Response('no', { status: 404 })
      if (url.includes('/api/checks') && method === 'GET') return jsonResponse({ ok: true, checks: [savedCheck(STORED_ANSWER)] })
      if (url.includes('/api/checks') && method === 'PATCH') {
        patchBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        return jsonResponse({ ok: true, check: savedCheck(PATCH_ANSWER) })
      }
      if (url.includes('/api/full-report') && method === 'POST') {
        reportPosts += 1
        if (reportPosts === 1) return jsonResponse({ error: 'Could not save this full report.' }, 502)
        return jsonResponse(freshReport())
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
        throw new Error(`${label}\n${text().slice(0, 900)}`)
      }
      function buttonNamed(label: string): HTMLButtonElement {
        const found = [...document.querySelectorAll('button')].find((btn) => (btn.textContent || '').includes(label))
        if (!found) throw new Error(`missing button ${label}\n${text().slice(0, 900)}`)
        return found as HTMLButtonElement
      }
      async function clickNamed(label: string) {
        const btn = buttonNamed(label)
        await act(async () => {
          btn.click()
        })
        await settle()
      }
      async function openQuestion() {
        if (!text().includes(QUESTION)) await clickNamed('Problems you solve')
        if (!text().includes("Gemini didn't answer.")) await clickNamed(QUESTION)
      }

      await waitFor('signed in', () => text().includes('alex@example.com'))
      await clickNamed('Your checks')
      await waitFor('history', () => text().includes('linear.app'))
      await clickNamed('linear.app')
      await waitFor('saved report', () => text().includes('Problems you solve') && text().includes('Run again'))
      await openQuestion()
      await waitFor('stored miss line', () => text().includes(STORED_ANSWER) && text().includes("Gemini didn't answer."))
      assert.equal(text().includes('(missing_key)'), false)
      assert.equal(text().includes(FRESH_ANSWER), false)

      await clickNamed('Run again')
      await waitFor('failed run stays visible', () => text().includes('Could not save this full report.'))
      assert.equal(reportPosts, 1)
      assert.equal(text().includes(STORED_ANSWER), true)
      assert.equal(text().includes(PATCH_ANSWER), false)
      assert.equal(text().includes('(missing_key)'), false)
      assert.equal(text().includes("Gemini didn't answer."), true)
      const patched = patchBody as { questions?: { question?: string }[] } | null
      assert.equal(patched?.questions?.[0]?.question, QUESTION)
      assert.equal(JSON.stringify(patchBody).includes('geminiMiss'), false)

      await clickNamed('Run again')
      await waitFor('fresh answer', () => text().includes(FRESH_ANSWER))
      await openQuestion()
      await waitFor('miss class', () => text().includes("Gemini didn't answer. (missing_key)"))
      assert.equal(text().includes('Could not save this full report.'), false)
      assert.equal(text().includes(PATCH_ANSWER), false)
      assert.equal(text().includes(STORED_ANSWER), false)
      assert.equal(text().includes(LEAK), false)
      assert.equal(text().includes('gemini-secret-key'), false)
      assert.equal(reportPosts, 2)

      await clickNamed('Gemini')
      await waitFor('gemini filter', () => text().includes('No Gemini mentions on this check yet.'))
      assert.equal(text().includes("Gemini didn't answer. (missing_key)"), false)
      await clickNamed('OpenAI')
      await openQuestion()
      await waitFor('class after filter', () => text().includes("Gemini didn't answer. (missing_key)"))
      assert.equal(text().includes(FRESH_ANSWER), true)
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

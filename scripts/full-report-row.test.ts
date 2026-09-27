import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { describe, it } from 'node:test'

describe('full-report row markup', () => {
  it('skims question and mention chip, and leaves the answer off the closed row', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule('/src/FullReportSection.tsx')) as typeof import('../src/FullReportSection.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const answer = 'Jira and Asana show up for that job. This sentence must stay hidden until the question opens.'
      const branded = 'Linear is a fast issue tracker for software teams.'
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report: {
            domain: 'linear.app',
            model: 'gpt-4o-mini',
            includesBranded: true,
            themes: [
              {
                id: 'problems',
                title: 'Problems you solve',
                questions: [
                  {
                    question: 'What should a team use to track issues?',
                    answer,
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Jira', 'Asana'],
                  },
                  {
                    question: 'How do people describe Linear?',
                    answer: branded,
                    framing: 'branded',
                    mention: 'mentioned',
                    whoInstead: ['Jira'],
                  },
                  {
                    question: 'How do teams plan a week?',
                    answer: '',
                    framing: 'unbranded',
                    mention: undefined,
                    whoInstead: [],
                  },
                  {
                    question: 'Is the weekly plan obvious?',
                    answer: 'It might be Linear, but that is only implied.',
                    framing: 'unbranded',
                    mention: 'unclear',
                    whoInstead: ['Height'],
                  },
                  {
                    question: 'What is missing from this category?',
                    answer: 'The reply never names Linear.',
                    framing: 'branded',
                    mention: 'not_mentioned',
                    whoInstead: [],
                  },
                ],
              },
            ],
          },
        }),
      )
      assert.match(html, /What should a team use to track issues\?/)
      assert.equal(html.includes('Who instead'), false)
      assert.match(html, />Mentioned</)
      assert.match(html, />Unclear</)
      assert.match(html, />Not mentioned</)
      assert.match(html, /aria-expanded="false"/)
      assert.match(html, /report-q-toggle/)
      assert.match(html, /report-mention/)
      const chips = [...html.matchAll(/class="([^"]*report-mention[^"]*)">([^<]*)</g)]
      assert.deepEqual(
        chips.map((match) => [match[2].trim(), match[1]]),
        [
          ['Not mentioned', 'tag plain mention report-mention'],
          ['Mentioned', 'tag plain mention report-mention mentioned'],
          ['Unclear', 'tag plain mention report-mention'],
          ['Not mentioned', 'tag plain mention report-mention'],
        ],
      )
      assert.equal(html.includes(answer), false)
      assert.equal(html.includes(branded), false)
      assert.equal(html.includes('It might be Linear, but that is only implied.'), false)
      assert.equal(html.includes('The reply never names Linear.'), false)
      assert.equal(html.includes('Show full answer'), false)
      assert.equal(html.includes('Hide answer'), false)
      assert.equal(html.includes('answer-body'), false)
      assert.equal(html.includes('<strong>Jira</strong>'), false)
      assert.equal(html.includes('<strong>Height</strong>'), false)
      assert.equal(html.includes('Couldn’t get an answer.'), false)
      assert.equal((html.match(/report-q-toggle/g) || []).length, 5)
    } finally {
      await server.close()
    }
  })
})

describe('land and dig mention mark', () => {
  it('keeps the chip on mention and lists whoInstead names underneath', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { MentionMark } = (await server.ssrLoadModule('/src/MentionMark.tsx')) as typeof import('../src/MentionMark.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const copy = PRODUCT_DEFAULTS.copy
      const render = (props: {
        mention: 'mentioned' | 'not_mentioned' | 'unclear'
        whoInstead: string[]
        framing: 'unbranded' | 'branded'
      }) => renderToStaticMarkup(React.createElement(MentionMark, { ...props, copy }))

      const notMentioned = render({
        mention: 'not_mentioned',
        whoInstead: ['Jira', 'Asana'],
        framing: 'unbranded',
      })
      assert.match(notMentioned, />Not mentioned</)
      assert.equal(notMentioned.includes('Who instead'), false)
      assert.match(notMentioned, /<strong>Jira<\/strong>/)
      assert.match(notMentioned, /<strong>Asana<\/strong>/)
      assert.equal(notMentioned.includes('This answer doesn’t name you.'), false)

      const unclear = render({
        mention: 'unclear',
        whoInstead: [' Height '],
        framing: 'unbranded',
      })
      assert.match(unclear, />Unclear</)
      assert.equal(unclear.includes('Who instead'), false)
      assert.match(unclear, /<strong> Height <\/strong>/)
      assert.equal(unclear.includes('Mention is weak or only implied'), false)

      const mentioned = render({
        mention: 'mentioned',
        whoInstead: ['Jira'],
        framing: 'unbranded',
      })
      assert.match(mentioned, />Mentioned</)
      assert.equal(mentioned.includes('Who instead'), false)
      assert.equal(mentioned.includes('<strong>Jira</strong>'), false)
      assert.match(mentioned, /Your brand shows up in this answer\./)

      const branded = render({
        mention: 'not_mentioned',
        whoInstead: ['Jira'],
        framing: 'branded',
      })
      assert.match(branded, />Not mentioned</)
      assert.equal(branded.includes('Who instead'), false)
      assert.equal(branded.includes('<strong>Jira</strong>'), false)
      assert.match(branded, /This answer doesn’t name you\./)
    } finally {
      await server.close()
    }
  })
})

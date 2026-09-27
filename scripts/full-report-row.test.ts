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
                    whoInstead: [],
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
      assert.match(html, />Who instead</)
      assert.match(html, />Mentioned</)
      assert.match(html, />Unclear</)
      assert.match(html, />Not mentioned</)
      assert.match(html, /aria-expanded="false"/)
      assert.match(html, /report-q-toggle/)
      assert.match(html, /report-mention/)
      const chips = [...html.matchAll(/class="([^"]*report-mention[^"]*)">([^<]*)</g)]
      const byLabel = new Map(chips.map((match) => [match[2].trim(), match[1]]))
      assert.equal(byLabel.get('Mentioned'), 'tag plain mention report-mention mentioned')
      assert.equal(byLabel.get('Who instead'), 'tag plain mention report-mention')
      assert.equal(byLabel.get('Unclear'), 'tag plain mention report-mention')
      assert.equal(byLabel.get('Not mentioned'), 'tag plain mention report-mention')
      assert.equal(html.includes(answer), false)
      assert.equal(html.includes(branded), false)
      assert.equal(html.includes('It might be Linear, but that is only implied.'), false)
      assert.equal(html.includes('The reply never names Linear.'), false)
      assert.equal(html.includes('Show full answer'), false)
      assert.equal(html.includes('Hide answer'), false)
      assert.equal(html.includes('answer-body'), false)
      assert.equal(html.includes('<strong>Jira</strong>'), false)
      assert.equal(html.includes('Couldn’t get an answer.'), false)
      assert.equal((html.match(/report-q-toggle/g) || []).length, 5)
    } finally {
      await server.close()
    }
  })
})

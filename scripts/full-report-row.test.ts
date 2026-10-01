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
                framing: 'unbranded',
                questions: [
                  {
                    question: 'What should a team use to track issues?',
                    answer,
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Jira', 'Asana'],
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
                ],
              },
              {
                id: 'described',
                title: 'How you’re described',
                framing: 'branded',
                questions: [
                  {
                    question: 'How do people describe Linear?',
                    answer: branded,
                    framing: 'branded',
                    mention: 'mentioned',
                    whoInstead: ['Jira'],
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
          ['Unclear', 'tag plain mention report-mention'],
          ['Mentioned', 'tag plain mention report-mention mentioned'],
          ['Not mentioned', 'tag plain mention report-mention'],
        ],
      )
      assert.match(html, />Unbranded</)
      assert.match(html, />Branded</)
      assert.equal(html.includes('q-badge'), false)
      assert.equal(html.includes('tag plain live'), false)
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
      assert.equal(html.includes('Add question'), false)
      assert.equal(html.includes('>Delete<'), false)
    } finally {
      await server.close()
    }
  })

  it('keeps add and delete inside Manage questions, off the report rows', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule('/src/FullReportSection.tsx')) as typeof import('../src/FullReportSection.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const editor = {
        editingKey: null,
        editText: '',
        addText: '',
        addThemeId: 'problems' as const,
        atCap: false,
        canDelete: true,
        onEdit: () => {},
        onEditText: () => {},
        onRename: () => {},
        onDelete: () => {},
        onAddText: () => {},
        onAddTheme: () => {},
        onAdd: () => {},
        onSave: () => {},
      }
      const report = {
        domain: 'linear.app',
        model: 'gpt-4o-mini',
        includesBranded: true,
        themes: [
          {
            id: 'problems' as const,
            title: 'Problems you solve',
            framing: 'unbranded' as const,
            questions: [
              {
                question: 'What should a team use to track issues?',
                answer: 'Jira shows up.',
                framing: 'unbranded' as const,
                mention: 'not_mentioned' as const,
                whoInstead: ['Jira'],
              },
            ],
          },
        ],
      }
      const closed = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          themesOnly: true,
          editor,
          report,
        }),
      )
      assert.match(closed, /Manage questions/)
      assert.equal(closed.includes('>Edit<'), false)
      assert.equal(closed.includes('>Delete<'), false)
      assert.equal(closed.includes('>Add question<'), false)
      assert.match(closed, /0% mentioned/)
      assert.equal(closed.includes('Across runs:'), false)
      assert.match(closed, />Unbranded</)
      assert.equal(/>Branded</.test(closed), false)
      assert.equal(closed.includes('q-badge'), false)
      assert.equal(closed.includes('Generated · OpenAI'), false)
      assert.match(closed, />Not mentioned</)
      assert.equal(closed.includes('Jira shows up.'), false)
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          themesOnly: true,
          manageOpen: true,
          editor,
          report,
        }),
      )
      const panelAt = html.indexOf('manage-panel')
      assert.equal(panelAt > 0, true)
      const rows = html.slice(0, panelAt)
      assert.equal(rows.includes('>Edit<'), false)
      assert.equal(rows.includes('>Delete<'), false)
      assert.match(html, /Add, remove, or rename questions for this check\. Save, then Run again\./)
      assert.match(html, />Add question</)
      assert.match(html, />Delete</)
      assert.match(html, />Edit</)
      assert.match(html, />Save questions</)
      assert.equal(html.includes('Jira shows up.'), false)
      assert.equal(html.includes('Over time'), false)
    } finally {
      await server.close()
    }
  })

  it('puts run columns and mention share inside each theme, not a second Over time stack', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule(
        '/src/FullReportSection.tsx',
      )) as typeof import('../src/FullReportSection.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule(
        '/src/config/productConfig.ts',
      )) as typeof import('../src/config/productConfig.ts')
      const answer = 'This reply names the brand and must stay closed.'
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          themesOnly: true,
          runs: [
            {
              at: '2026-09-01T00:00:00.000Z',
              mode: 'full',
              mentions: [
                { question: 'What should a team use to track issues?', mention: 'not_mentioned', whoInstead: [] },
                { question: 'How do people describe Linear?', mention: 'mentioned', whoInstead: [] },
              ],
            },
            {
              at: '2026-09-30T15:04:00.000Z',
              mode: 'full',
              mentions: [
                { question: 'What should a team use to track issues?', mention: 'mentioned', whoInstead: [] },
                { question: 'How do teams plan a week?', mention: 'mentioned', whoInstead: [] },
                { question: 'How do people describe Linear?', mention: 'unclear', whoInstead: [] },
              ],
            },
          ],
          report: {
            domain: 'linear.app',
            model: 'gpt-4o-mini',
            includesBranded: true,
            themes: [
              {
                id: 'problems',
                title: 'Shared label',
                framing: 'unbranded',
                questions: [
                  {
                    question: 'What should a team use to track issues?',
                    answer,
                    framing: 'unbranded',
                    mention: 'mentioned',
                    whoInstead: [],
                  },
                  {
                    question: 'How do teams plan a week?',
                    answer: 'Teams plan in the tool they already use.',
                    framing: 'unbranded',
                    mention: 'mentioned',
                    whoInstead: [],
                  },
                ],
              },
              {
                id: 'trust',
                title: 'Shared label',
                framing: 'branded',
                questions: [
                  {
                    question: 'How do people describe Linear?',
                    answer: 'Linear is described as a fast tracker.',
                    framing: 'branded',
                    mention: 'unclear',
                    whoInstead: [],
                  },
                ],
              },
            ],
          },
        }),
      )
      assert.equal(html.includes('Over time'), false)
      assert.match(html, />Unbranded</)
      assert.match(html, />Branded</)
      assert.equal(html.includes('q-badge'), false)
      assert.equal(html.includes('Generated · OpenAI'), false)
      assert.equal(html.includes('>Edit<'), false)
      assert.equal(html.includes('>Delete<'), false)
      assert.match(html, /100% mentioned/)
      assert.match(html, /Across runs: 0% → 100%/)
      assert.match(html, /0% mentioned/)
      assert.match(html, /Across runs: 100% → 0%/)
      assert.equal((html.match(/Shared label/g) || []).length, 2)
      assert.match(html, />Question</)
      assert.match(html, /Sep 1, 12:00 AM/)
      assert.match(html, /Sep 30, 3:04 PM/)
      assert.match(html, />Mentioned</)
      assert.match(html, />Not mentioned</)
      assert.match(html, />Unclear</)
      assert.equal(html.includes(answer), false)
      assert.equal(html.includes('Teams plan in the tool they already use.'), false)
      assert.equal(/SOV|visibility score|monitoring/i.test(html), false)
      assert.equal((html.match(/<table class="run-grid">/g) || []).length, 2)
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

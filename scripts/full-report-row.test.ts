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
                    whoInstead: ['Slack'],
                  },
                ],
              },
            ],
          },
        }),
      )
      assert.match(html, /id="report-tab-over-time"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="report-tab-over-time"/)
      assert.match(html, />Over time</)
      assert.match(html, />Competitors</)
      assert.equal((html.match(/role="tab"/g) || []).length, 2)
      assert.equal(html.includes('>Citations<'), false)
      assert.equal(html.includes('>Glance<'), false)
      assert.equal(html.includes('>Overview<'), false)
      assert.match(html, /Problems you solve/)
      assert.match(html, /How you’re described|How you&#x27;re described/)
      assert.equal(html.includes('What should a team use to track issues?'), false)
      assert.equal(html.includes('Who instead'), false)
      assert.equal(html.includes('>Mentioned<'), false)
      assert.equal(html.includes('>Unclear<'), false)
      assert.equal(html.includes('>Not mentioned<'), false)
      assert.match(html, /aria-expanded="false"/)
      assert.match(html, />Unbranded</)
      assert.match(html, />Branded</)
      assert.match(html, />0%</)
      assert.match(html, />50%</)
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
      assert.equal(html.includes('Add question'), false)
      assert.equal(html.includes('>Delete<'), false)
      const opened = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          topicsOpen: true,
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
                    whoInstead: ['Slack'],
                  },
                ],
              },
            ],
          },
        }),
      )
      assert.match(opened, /What should a team use to track issues\?/)
      assert.match(opened, /How do people describe Linear\?/)
      const chips = [...opened.matchAll(/class="([^"]*report-mention[^"]*)">([^<]*)</g)]
      assert.deepEqual(
        chips.map((match) => [match[2].trim(), match[1]]),
        [
          ['Not mentioned', 'tag plain mention report-mention'],
          ['Unclear', 'tag plain mention report-mention'],
          ['Mentioned', 'tag plain mention report-mention mentioned'],
          ['Not mentioned', 'tag plain mention report-mention'],
        ],
      )
      assert.equal(opened.includes(answer), false)
      assert.equal(opened.includes(branded), false)
      assert.equal(opened.includes('<strong>Jira</strong>'), false)
      assert.equal(opened.includes('answer-body'), false)
    } finally {
      await server.close()
    }
  })

  it('groups substitutes by topic and shows each question’s names when opened', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule('/src/FullReportSection.tsx')) as typeof import('../src/FullReportSection.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          initialTab: 'competitors',
          whoInsteadOpen: true,
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
                    answer: 'Jira shows up for that job.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Jira', 'Asana'],
                  },
                  {
                    question: 'How do teams plan a week?',
                    answer: 'Height is the other name.',
                    framing: 'unbranded',
                    mention: 'unclear',
                    whoInstead: ['Jira'],
                  },
                ],
              },
              {
                id: 'alternatives',
                title: 'Alternatives & who else',
                framing: 'unbranded',
                questions: [
                  {
                    question: 'Who else should I look at?',
                    answer: 'Linear is one option.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Linear'],
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
                    answer: 'Linear is fast.',
                    framing: 'branded',
                    mention: 'not_mentioned',
                    whoInstead: ['Slack'],
                  },
                ],
              },
            ],
          },
        }),
      )
      assert.match(
        html,
        /Your mention rate, and names that showed up instead on unbranded questions this run\. Not market share\./,
      )
      const topics = html.split('<section class="competitors-topic">').slice(1)
      assert.equal(topics.length, 3)
      assert.match(topics[0], /Problems you solve/)
      assert.match(topics[0], /<th scope="col">You<\/th><th scope="col">Jira<\/th><th scope="col">Asana<\/th>/)
      assert.match(topics[0], /<td>0%<\/td><td>100%<\/td><td>50%<\/td>/)
      assert.equal(topics[0].includes('>Linear<'), false)
      assert.equal(topics[0].includes('Slack'), false)
      assert.match(topics[0], /What should a team use to track issues\?/)
      assert.match(topics[0], /How do teams plan a week\?/)
      assert.match(topics[0], /Who instead/)
      assert.match(topics[0], /<strong>Jira<\/strong>/)
      assert.match(topics[0], /<strong>Asana<\/strong>/)
      assert.match(topics[1], /Alternatives &amp; who else|Alternatives & who else/)
      assert.match(topics[1], /<th scope="col">Linear<\/th>/)
      assert.match(topics[1], /<td>0%<\/td><td>100%<\/td>/)
      assert.equal(topics[1].includes('>Jira<'), false)
      assert.match(topics[1], /Who else should I look at\?/)
      assert.match(topics[1], /<strong>Linear<\/strong>/)
      assert.match(topics[2], /How you’re described|How you&#x27;re described/)
      assert.match(topics[2], /<th scope="col">You<\/th>/)
      assert.equal(topics[2].includes('>Slack<'), false)
      assert.equal(html.includes('No one else showed up yet.'), false)
      assert.equal(html.includes('more in the questions'), false)
      assert.equal(html.includes('Top 5'), false)
      assert.equal(/SOV|share of voice|\brank\b/i.test(html), false)
      assert.match(html, />Unbranded</)
      assert.match(html, />Branded</)
    } finally {
      await server.close()
    }
  })

  it('shows five names on the row and keeps a sixth name under its question', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection } = (await server.ssrLoadModule('/src/FullReportSection.tsx')) as typeof import('../src/FullReportSection.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          initialTab: 'competitors',
          whoInsteadOpen: true,
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
                    answer: 'Zebra, Mango, and Delta.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Zebra', 'Mango', 'Delta'],
                  },
                  {
                    question: 'How do teams plan a week?',
                    answer: 'Zebra, Apple, and Mango.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Zebra', 'Apple', 'Mango'],
                  },
                  {
                    question: 'How do teams plan a quarter?',
                    answer: 'Zebra, Apple, and Echo.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Zebra', 'Apple', 'Echo'],
                  },
                  {
                    question: 'What is the edge case?',
                    answer: 'Foxtrot shows up here.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Foxtrot'],
                  },
                ],
              },
              {
                id: 'alternatives',
                title: 'Alternatives & who else',
                framing: 'unbranded',
                questions: [
                  {
                    question: 'Who else should I look at?',
                    answer: 'Notion is the only other name.',
                    framing: 'unbranded',
                    mention: 'not_mentioned',
                    whoInstead: ['Notion'],
                  },
                ],
              },
            ],
          },
        }),
      )
      const topics = html.split('<section class="competitors-topic">').slice(1)
      assert.equal(topics.length, 2)
      const rowNames = [...topics[0].matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1])
      assert.deepEqual(rowNames, ['Topic', 'You', 'Zebra', 'Apple', 'Mango', 'Delta', 'Echo'])
      assert.equal(rowNames.includes('Foxtrot'), false)
      assert.match(topics[0], /<td>0%<\/td><td>75%<\/td><td>50%<\/td><td>50%<\/td><td>25%<\/td><td>25%<\/td>/)
      assert.equal(topics[0].includes('Top 5'), false)
      assert.match(topics[0], /What is the edge case\?/)
      assert.match(topics[0], /Who instead/)
      assert.match(topics[0], /<strong>Foxtrot<\/strong>/)
      assert.match(topics[1], /<th scope="col">Notion<\/th>/)
      assert.match(topics[1], /<td>0%<\/td><td>100%<\/td>/)
      assert.equal(topics[1].includes('more in the questions'), false)
      assert.equal(/SOV|Top 5|\brank\b/i.test(html), false)
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
      assert.match(closed, />Over time</)
      assert.match(closed, /<td>0%<\/td>/)
      assert.equal(closed.includes('0% mentioned'), false)
      assert.equal(closed.includes('Across runs:'), false)
      assert.match(closed, />Unbranded</)
      assert.equal(/>Branded</.test(closed), false)
      assert.equal(closed.includes('q-badge'), false)
      assert.equal(closed.includes('Generated · OpenAI'), false)
      assert.equal(closed.includes('>Not mentioned<'), false)
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
      assert.match(html, />Over time</)
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
          topicsOpen: true,
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
            {
              at: '2026-10-01T00:00:00.000Z',
              mode: 'full',
              mentions: [
                { question: 'What should a team use to track issues?', mention: 'mentioned', whoInstead: [] },
                { question: 'How do teams plan a week?', mention: 'not_mentioned', whoInstead: [] },
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
      assert.match(html, />Over time</)
      assert.match(html, /aria-selected="true"/)
      assert.match(html, />Unbranded</)
      assert.match(html, />Branded</)
      assert.equal(html.includes('q-badge'), false)
      assert.equal(html.includes('Generated · OpenAI'), false)
      assert.equal(html.includes('>Edit<'), false)
      assert.equal(html.includes('>Delete<'), false)
      assert.equal(html.includes('Across runs:'), false)
      assert.equal(html.includes('100% mentioned'), false)
      assert.equal(html.includes('0% mentioned'), false)
      assert.equal(html.includes('>Theme<'), false)
      const pctRows = [...html.matchAll(/<tr class="topic-rate-row">([\s\S]*?)<\/tr>/g)].map((match) => match[1])
      assert.equal(pctRows.length, 2)
      assert.match(pctRows[0], /<td>0%<\/td><td>100%<\/td><td>50%<\/td>/)
      assert.match(pctRows[1], /<td>100%<\/td><td>0%<\/td><td><span class="muted">—<\/span><\/td>/)
      const firstPct = html.indexOf('topic-rate-row')
      const firstQuestion = html.indexOf('What should a team use to track issues?')
      const secondPct = html.indexOf('topic-rate-row', firstPct + 1)
      const trustQuestion = html.indexOf('How do people describe Linear?')
      assert.equal(firstPct >= 0 && firstPct < firstQuestion, true)
      assert.equal(secondPct > firstQuestion && secondPct < trustQuestion, true)
      assert.equal((html.match(/Shared label/g) || []).length, 2)
      assert.match(html, />Topic</)
      assert.match(html, />Question</)
      assert.match(html, /Sep 1, 12:00 AM/)
      assert.match(html, /Sep 30, 3:04 PM/)
      assert.match(html, /Oct 1, 12:00 AM/)
      assert.match(html, />Mentioned</)
      assert.match(html, />Not mentioned</)
      assert.match(html, />Unclear</)
      assert.equal(html.includes(answer), false)
      assert.equal(html.includes('Teams plan in the tool they already use.'), false)
      assert.equal(/SOV|visibility score|monitoring/i.test(html), false)
      assert.equal(html.includes('Who showed up instead'), false)
      assert.equal(html.includes('No one else showed up yet.'), false)
      assert.equal(html.includes('Appeared on'), false)
      assert.equal(html.includes('who-instead-name'), false)
      assert.equal((html.match(/class="run-grid over-time-grid"/g) || []).length, 1)
      assert.equal((html.match(/<table class="run-grid">/g) || []).length, 2)
    } finally {
      await server.close()
    }
  })
})

describe('unbranded engine blocks', () => {
  it('shows OpenAI and Gemini labels, and a miss leaves the OpenAI block', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { UnbrandedAnswers } = (await server.ssrLoadModule('/src/UnbrandedAnswers.tsx')) as typeof import('../src/UnbrandedAnswers.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule('/src/config/productConfig.ts')) as typeof import('../src/config/productConfig.ts')
      const copy = PRODUCT_DEFAULTS.copy
      const both = renderToStaticMarkup(
        React.createElement(UnbrandedAnswers, {
          mention: 'not_mentioned',
          whoInstead: ['Jira', 'Asana'],
          gemini: ['Monday and ClickUp are common picks for this job.'],
          index: 0,
          copy,
        }),
      )
      assert.match(both, /Generated · OpenAI/)
      assert.match(both, /Generated · Gemini/)
      assert.match(both, /Monday and ClickUp are common picks for this job\./)
      assert.match(both, /<strong>Jira<\/strong>/)
      assert.equal(both.includes("Gemini didn't answer."), false)
      assert.equal(both.includes('<strong>Monday</strong>'), false)
      assert.equal(both.includes('<strong>ClickUp</strong>'), false)

      const missed = renderToStaticMarkup(
        React.createElement(UnbrandedAnswers, {
          mention: 'not_mentioned',
          whoInstead: ['Jira'],
          gemini: [''],
          index: 0,
          copy,
        }),
      )
      assert.match(missed, /Generated · OpenAI/)
      assert.match(missed, /Generated · Gemini/)
      assert.match(missed, /Gemini didn&#x27;t answer\./)
      assert.match(missed, /<strong>Jira<\/strong>/)
      assert.equal(missed.includes('Monday'), false)
    } finally {
      await server.close()
    }
  })

  it('shows a Gemini block on each unbranded report answer, and a miss leaves the OpenAI answer', async () => {
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
      const { fullReportFromStored } = (await server.ssrLoadModule(
        '/src/fullReport.ts',
      )) as typeof import('../src/fullReport.ts')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule(
        '/src/config/productConfig.ts',
      )) as typeof import('../src/config/productConfig.ts')
      const openai = 'Jira and Asana show up for that job.'
      const stored = fullReportFromStored({
        report: 'full',
        fullReport: {
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
                  answer: openai,
                  framing: 'unbranded',
                  mention: 'not_mentioned',
                  whoInstead: ['Jira', 'Asana'],
                  gemini: 'Monday is a common pick for this job.',
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
                  answer: 'Linear is a fast issue tracker.',
                  framing: 'branded',
                  mention: 'mentioned',
                  whoInstead: ['Monday'],
                  gemini: 'Monday should not render on branded.',
                },
              ],
            },
          ],
        },
      })
      assert.ok(stored)
      if (!stored) return
      const hit = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report: stored,
          answersOpen: true,
          whoInsteadOpen: true,
        }),
      )
      assert.match(hit, /Generated · OpenAI/)
      assert.match(hit, /Generated · Gemini/)
      assert.match(hit, /Monday is a common pick for this job\./)
      assert.match(hit, new RegExp(openai.replace(/[.]/g, '\\.')))
      assert.equal(hit.includes("Gemini didn't answer."), false)
      assert.equal(hit.includes('Monday should not render on branded.'), false)
      assert.equal(hit.includes('<strong>Monday</strong>'), false)
      const competitors = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report: stored,
          initialTab: 'competitors',
        }),
      )
      assert.match(competitors, /<th scope="col">Jira<\/th>/)
      assert.match(competitors, /<th scope="col">Asana<\/th>/)
      assert.equal(competitors.includes('Monday'), false)

      const missedStored = fullReportFromStored({
        report: 'full',
        fullReport: {
          domain: 'linear.app',
          model: 'gpt-4o-mini',
          includesBranded: false,
          themes: [
            {
              id: 'problems',
              questions: [
                {
                  question: 'What should a team use to track issues?',
                  answer: openai,
                  mention: 'not_mentioned',
                  whoInstead: ['Jira'],
                  gemini: '',
                },
              ],
            },
          ],
        },
      })
      assert.equal(missedStored?.themes[0]?.questions[0]?.gemini, '')
      assert.equal(missedStored?.themes[0]?.questions[0]?.answer, openai)
      const missed = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report: missedStored!,
          answersOpen: true,
        }),
      )
      assert.match(missed, /Generated · OpenAI/)
      assert.match(missed, /Generated · Gemini/)
      assert.match(missed, /Gemini didn&#x27;t answer\./)
      assert.match(missed, new RegExp(openai.replace(/[.]/g, '\\.')))
      assert.match(missed, /<strong>Jira<\/strong>/)
      assert.equal(missed.includes('Monday'), false)
      assert.equal(missed.includes('(empty)'), false)
      assert.equal(missed.includes('(timeout)'), false)
      assert.equal(missed.includes('http_reject'), false)
      assert.equal(missed.includes('missing_key'), false)
    } finally {
      await server.close()
    }
  })

  it('appends the miss class on a signed-in response and leaves a guest line plain', async () => {
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
      const { UnbrandedAnswers } = (await server.ssrLoadModule(
        '/src/UnbrandedAnswers.tsx',
      )) as typeof import('../src/UnbrandedAnswers.tsx')
      const { fullReportFromStored } = (await server.ssrLoadModule(
        '/src/fullReport.ts',
      )) as typeof import('../src/fullReport.ts')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule(
        '/src/config/productConfig.ts',
      )) as typeof import('../src/config/productConfig.ts')
      const copy = PRODUCT_DEFAULTS.copy
      const stored = fullReportFromStored({
        report: 'full',
        fullReport: {
          domain: 'linear.app',
          model: 'gpt-4o-mini',
          includesBranded: false,
          themes: [
            {
              id: 'problems',
              questions: [
                {
                  question: 'What should a team use to track issues?',
                  answer: 'Jira shows up for that job.',
                  gemini: '',
                },
              ],
            },
          ],
        },
      })
      assert.ok(stored)
      if (!stored) return
      const classes: { geminiMiss: { class: string; status?: number }; suffix: string }[] = [
        { geminiMiss: { class: 'missing_key' }, suffix: '(missing_key)' },
        { geminiMiss: { class: 'http_reject', status: 404 }, suffix: '(http_reject 404)' },
        { geminiMiss: { class: 'timeout' }, suffix: '(timeout)' },
        { geminiMiss: { class: 'bad_json' }, suffix: '(bad_json)' },
        { geminiMiss: { class: 'empty' }, suffix: '(empty)' },
      ]
      for (const item of classes) {
        const html = renderToStaticMarkup(
          React.createElement(FullReportSection, {
            copy,
            report: stored,
            answersOpen: true,
            geminiMiss: item.geminiMiss,
          }),
        )
        assert.match(html, new RegExp(`Gemini didn&#x27;t answer\\. ${item.suffix.replace(/[()]/g, '\\$&')}`))
        assert.equal(html.includes('secret'), false)
      }
      const leaked = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy,
          report: stored,
          answersOpen: true,
          geminiMiss: { class: 'http_reject', status: '404 leaked body' as unknown as number },
        }),
      )
      assert.match(leaked, /Gemini didn&#x27;t answer\. \(http_reject\)/)
      assert.equal(leaked.includes('leaked'), false)
      assert.equal(leaked.includes('404'), false)
      const guest = renderToStaticMarkup(
        React.createElement(UnbrandedAnswers, {
          mention: 'not_mentioned',
          whoInstead: ['Jira'],
          gemini: [''],
          index: 0,
          copy,
        }),
      )
      assert.match(guest, /Gemini didn&#x27;t answer\./)
      assert.equal(guest.includes('(timeout)'), false)
      assert.equal(guest.includes('(empty)'), false)
      assert.equal(guest.includes('http_reject'), false)
      assert.equal(guest.includes('missing_key'), false)
      assert.equal(guest.includes('bad_json'), false)
    } finally {
      await server.close()
    }
  })

  it('shows the paused OpenAI lines and leaves the Gemini miss line alone', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { FullReportSection, OpenAIPausedNote } = (await server.ssrLoadModule(
        '/src/FullReportSection.tsx',
      )) as typeof import('../src/FullReportSection.tsx')
      const { fullReportFromStored } = (await server.ssrLoadModule('/src/fullReport.ts')) as typeof import('../src/fullReport.ts')
      const { STORY } = (await server.ssrLoadModule('/src/story.ts')) as typeof import('../src/story.ts')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule(
        '/src/config/productConfig.ts',
      )) as typeof import('../src/config/productConfig.ts')
      const copy = PRODUCT_DEFAULTS.copy
      const question = 'What should a team use to track issues?'
      const stored = fullReportFromStored({
        report: 'full',
        fullReport: {
          domain: 'linear.app',
          model: 'gpt-4o-mini',
          includesBranded: true,
          themes: [
            {
              id: 'problems',
              questions: [
                {
                  question,
                  answer: 'Jira shows up for that job.',
                  mention: 'mentioned',
                  whoInstead: ['Jira'],
                  gemini: '',
                },
              ],
            },
          ],
        },
      })
      assert.ok(stored)
      if (!stored) return
      const runs = [
        {
          at: '2026-09-01T00:00:00.000Z',
          mode: 'full' as const,
          mentions: [{ question, mention: 'mentioned' as const, whoInstead: ['Jira'] }],
        },
      ]
      const overTime = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy,
          report: stored,
          answersOpen: true,
          openaiPaused: true,
          geminiMiss: { class: 'timeout' },
          runs,
        }),
      )
      assert.match(overTime, /OpenAI is paused for this run\./)
      assert.match(overTime, /Paused while OpenAI is off\./)
      assert.match(overTime, /Gemini didn&#x27;t answer\. \(timeout\)/)
      assert.equal(overTime.includes('Jira shows up for that job.'), false)
      assert.equal(overTime.includes('Not mentioned'), false)
      assert.equal(overTime.includes('0%'), false)
      assert.match(overTime, /Mentioned/)
      const competitors = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy,
          report: stored,
          answersOpen: true,
          initialTab: 'competitors',
          openaiPaused: true,
        }),
      )
      assert.match(competitors, /OpenAI is paused for this run\./)
      assert.match(competitors, /Paused while OpenAI is off\./)
      assert.equal(competitors.includes('<strong>Jira</strong>'), false)
      assert.equal(competitors.includes('0%'), false)
      assert.equal(competitors.includes('Not mentioned'), false)
      const storedView = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy,
          report: stored,
          answersOpen: true,
          initialTab: 'competitors',
        }),
      )
      assert.equal(storedView.includes(STORY.openaiPausedAnswer), false)
      assert.equal(storedView.includes(STORY.openaiPausedMark), false)
      assert.match(storedView, /Jira shows up for that job\./)
      assert.match(storedView, /<strong>Jira<\/strong>/)
      const note = renderToStaticMarkup(React.createElement(OpenAIPausedNote))
      assert.match(note, /OpenAI is paused, so this run isn&#x27;t saved to Over time\./)
      assert.equal(note.includes(STORY.geminiMiss), false)
      assert.equal(overTime.includes('100%'), false)
      assert.equal(STORY.openaiPausedAnswer, 'OpenAI is paused for this run.')
      assert.equal(STORY.openaiPausedMark, 'Paused while OpenAI is off.')
      assert.equal(STORY.openaiPausedHistory, "OpenAI is paused, so this run isn't saved to Over time.")
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

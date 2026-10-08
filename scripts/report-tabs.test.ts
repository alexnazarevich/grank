import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { describe, it } from 'node:test'
import { competitorTopics } from '../src/mentionLabel.ts'
import { PRODUCT_DEFAULTS } from '../src/config/productConfig.ts'
import { STORY } from '../src/story.ts'
import type { FullReport } from '../src/fullReport.ts'

const HELPER =
  'Your ChatGPT mention rate, and names ChatGPT gave instead on unbranded questions this run. Not market share.'

function question(
  text: string,
  mention: 'mentioned' | 'not_mentioned' | 'unclear' | undefined,
  whoInstead: string[],
  extra: { framing?: 'unbranded' | 'branded'; gemini?: string; answer?: string } = {},
) {
  return {
    question: text,
    answer: extra.answer ?? '',
    framing: extra.framing ?? 'unbranded',
    mention,
    whoInstead,
    ...(extra.gemini !== undefined ? { gemini: extra.gemini } : {}),
  }
}

describe('competitor topics from who-instead', () => {
  it('caps each topic at five names and uses unbranded questions as the denominator', () => {
    const topics = competitorTopics([
      {
        id: 'problems',
        title: 'Problems you solve',
        framing: 'unbranded',
        questions: [
          question('Track?', 'not_mentioned', ['Zebra', 'Mango', 'Delta']),
          question('Plan?', 'not_mentioned', ['Zebra', 'Apple', 'Mango']),
          question('Week?', 'not_mentioned', ['Zebra', 'Apple', 'Echo']),
          question('Named?', 'mentioned', ['Notion']),
          question('Edge?', 'not_mentioned', ['Foxtrot']),
        ],
      },
      {
        id: 'described',
        title: 'How you’re described',
        framing: 'branded',
        questions: [question('Describe Linear?', 'mentioned', ['Slack'], { framing: 'branded' })],
      },
    ])
    assert.equal(topics[0]?.you, 20)
    assert.deepEqual(
      topics[0]?.names.map((name) => name.name),
      ['Zebra', 'Apple', 'Mango', 'Delta', 'Echo'],
    )
    assert.deepEqual(
      topics[0]?.names.map((name) => name.pct),
      [60, 40, 40, 20, 20],
    )
    assert.equal(topics[0]?.names.some((name) => name.name === 'Foxtrot' || name.name === 'Notion'), false)
    assert.equal(
      topics[0]?.questions.some((item) => item.question === 'Edge?' && item.names.includes('Foxtrot')),
      true,
    )
    assert.equal(topics[0]?.questions.find((item) => item.question === 'Named?')?.names.length, 0)
    assert.equal(topics[1]?.you, 100)
    assert.deepEqual(topics[1]?.names, [])
    assert.equal(JSON.stringify(topics).includes('Slack'), false)
  })
})

describe('full report tabs', () => {
  it('opens Over time first, filters answer blocks, and leaves cron off', async () => {
    assert.equal(STORY.competitorsTab, 'Competitors')
    assert.equal(STORY.competitorsHelper, HELPER)
    assert.equal(STORY.engineOpenAI, 'ChatGPT')
    assert.equal(STORY.engineGemini, 'Gemini')
    assert.equal(STORY.engineClaude, 'Claude')
    assert.equal(/share|SOV|\brank\b/i.test(`${STORY.competitorsTab} ${STORY.competitorsYou} ${STORY.engineOpenAI} ${STORY.engineGemini} ${STORY.engineClaude}`), false)
    assert.equal(PRODUCT_DEFAULTS.trackingCronEnabled, false)
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
      const report: FullReport = {
        domain: 'linear.app',
        model: 'gpt-4o-mini',
        includesBranded: true,
        themes: [
          {
            id: 'problems',
            title: 'Problems you solve',
            framing: 'unbranded',
            questions: [
              question('What should a team use to track issues?', 'mentioned', [], {
                answer: 'This OpenAI reply must stay inside the expand.',
                gemini: 'Monday is named only in the Gemini reply.',
              }),
              question('How do teams plan a week?', 'not_mentioned', ['Jira']),
            ],
          },
        ],
      }
      const runs = [
        {
          at: '2026-09-01T00:00:00.000Z',
          mode: 'full' as const,
          mentions: [
            { question: 'What should a team use to track issues?', mention: 'not_mentioned' as const, whoInstead: [] },
            { question: 'How do teams plan a week?', mention: 'not_mentioned' as const, whoInstead: ['Jira'] },
          ],
        },
        {
          at: '2026-09-30T15:04:00.000Z',
          mode: 'full' as const,
          mentions: [
            { question: 'What should a team use to track issues?', mention: 'mentioned' as const, whoInstead: [] },
            { question: 'How do teams plan a week?', mention: 'mentioned' as const, whoInstead: [] },
          ],
        },
      ]
      const html = renderToStaticMarkup(
        React.createElement(FullReportSection, { copy: PRODUCT_DEFAULTS.copy, report, runs }),
      )
      const overTime = html.indexOf('report-tab-over-time')
      const competitors = html.indexOf('report-tab-competitors')
      assert.equal(overTime > 0 && overTime < competitors, true)
      assert.match(html, /id="report-tab-over-time"[^>]*aria-selected="true"/)
      assert.match(html, /id="report-tab-competitors"[^>]*aria-selected="false"/)
      assert.equal((html.match(/role="tab"/g) || []).length, 2)
      assert.equal(html.includes('>Citations<'), false)
      assert.equal(html.includes('>Glance<'), false)
      assert.equal(html.includes('>Overview<'), false)
      assert.equal(html.includes('Generated · ChatGPT'), false)
      assert.equal(html.includes('>LLM<'), false)
      assert.equal((html.match(/aria-pressed="true"/g) || []).length, 3)
      assert.match(html, /Which engines show under each question\./)
      assert.match(html, />ChatGPT</)
      assert.match(html, />Gemini</)
      assert.match(html, />Claude</)
      assert.match(html, /over-time-grid/)
      assert.equal(html.includes('Generated · Claude'), false)
      assert.match(html, /<td>0%<\/td><td>100%<\/td>/)
      assert.equal(html.includes(HELPER), false)
      assert.equal(html.includes('What should a team use to track issues?'), false)
      assert.equal(html.includes('This OpenAI reply must stay inside the expand.'), false)

      const geminiOff = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          answersOpen: true,
          initialEngines: { gemini: false },
        }),
      )
      assert.match(geminiOff, /over-time-grid/)
      assert.match(geminiOff, /<td>0%<\/td><td>100%<\/td>/)
      assert.match(geminiOff, /Generated · ChatGPT/)
      assert.match(geminiOff, /This OpenAI reply must stay inside the expand\./)
      assert.match(geminiOff, /<strong>Jira<\/strong>/)
      assert.equal(geminiOff.includes('Generated · Gemini'), false)
      assert.equal(geminiOff.includes('Monday is named only in the Gemini reply.'), false)
      assert.match(geminiOff, /Generated · Claude/)
      assert.match(geminiOff, /aria-pressed="false"/)
      assert.equal((geminiOff.match(/role="tab"/g) || []).length, 2)

      const openaiOff = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          answersOpen: true,
          initialEngines: { openai: false },
        }),
      )
      assert.match(openaiOff, /over-time-grid/)
      assert.match(openaiOff, /<td>0%<\/td><td>100%<\/td>/)
      assert.match(openaiOff, /Generated · Gemini/)
      assert.match(openaiOff, /Monday is named only in the Gemini reply\./)
      assert.match(openaiOff, /<strong>Jira<\/strong>/)
      assert.equal(openaiOff.includes('Generated · ChatGPT'), false)
      assert.equal(openaiOff.includes('This OpenAI reply must stay inside the expand.'), false)

      const opened = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          topicsOpen: true,
        }),
      )
      assert.match(opened, /What should a team use to track issues\?/)
      assert.match(opened, /How do teams plan a week\?/)
      assert.equal(opened.includes('This OpenAI reply must stay inside the expand.'), false)

      const answered = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          answersOpen: true,
        }),
      )
      assert.match(answered, /Generated · ChatGPT/)
      assert.match(answered, /Generated · Gemini/)
      assert.match(answered, /Monday is named only in the Gemini reply\./)
      assert.match(answered, /This OpenAI reply must stay inside the expand\./)
      const rowOf = (source: string, question: string) => {
        const at = source.indexOf(`aria-label="${question}"`)
        const start = source.lastIndexOf('<tr', at)
        const end = source.indexOf('</tr>', at)
        return source.slice(start, end + '</tr>'.length)
      }
      const tapped = 'What should a team use to track issues?'
      const nextQuestion = 'How do teams plan a week?'
      const tappedRow = rowOf(answered, tapped)
      const nextRow = rowOf(answered, nextQuestion)
      assert.equal(tappedRow.includes('id="report-a-problems-unbranded-0"'), true)
      assert.equal(tappedRow.includes('This OpenAI reply must stay inside the expand.'), true)
      assert.equal(tappedRow.includes('Monday is named only in the Gemini reply.'), true)
      assert.equal(tappedRow.includes(nextQuestion), false)
      assert.equal(nextRow.includes('id="report-a-problems-unbranded-1"'), true)
      assert.equal(nextRow.includes('This OpenAI reply must stay inside the expand.'), false)
      assert.equal(nextRow.includes('Monday is named only in the Gemini reply.'), false)
      assert.equal(nextRow.includes('id="report-a-problems-unbranded-0"'), false)
      const panelBeforeNext =
        answered.indexOf('id="report-a-problems-unbranded-0"') < answered.indexOf(`aria-label="${nextQuestion}"`)
      assert.equal(panelBeforeNext, true)

      const competitorsHtml = renderToStaticMarkup(
        React.createElement(FullReportSection, {
          copy: PRODUCT_DEFAULTS.copy,
          report,
          runs,
          initialTab: 'competitors',
          topicsOpen: true,
        }),
      )
      assert.match(competitorsHtml, new RegExp(HELPER.replace(/[.]/g, '\\.')))
      assert.match(competitorsHtml, /<th scope="col">You<\/th><th scope="col">Jira<\/th>/)
      assert.match(competitorsHtml, /<td>50%<\/td><td>50%<\/td>/)
      assert.match(
        competitorsHtml,
        /<div class="run-grid-wrap"><table class="run-grid competitors-grid">/,
      )
      assert.match(competitorsHtml, /<th scope="col">Topic<\/th><th scope="col">You<\/th>/)
      assert.match(competitorsHtml, /<tr class="topic-rate-row"><th scope="row">/)
      const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
      assert.match(css, /\.run-grid thead th:first-child,\s*\.run-grid tbody th \{[^}]*position: sticky; left: 0/)
      assert.equal(/\.competitors-grid\s*\{[^}]*width:\s*auto/.test(css), false)
      assert.equal(competitorsHtml.includes('Monday'), false)
      assert.equal(competitorsHtml.includes('Sep 1, 12:00 AM'), false)
      assert.equal(competitorsHtml.includes('Sep 30, 3:04 PM'), false)
      assert.match(competitorsHtml, /How do teams plan a week\?/)
      assert.match(competitorsHtml, /<strong>Jira<\/strong>/)
      assert.equal(/SOV|share of voice|\brank\b/i.test(competitorsHtml), false)
      assert.equal((competitorsHtml.match(/<th scope="col">/g) || []).length <= 6, true)
    } finally {
      await server.close()
    }
  })
})

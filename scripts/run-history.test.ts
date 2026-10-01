import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { createServer, type ViteDevServer } from 'vite'
import { onRequest } from '../functions/api/checks.ts'
import { onRequest as onFullReport } from '../functions/api/full-report.ts'
import { onScheduled } from '../functions/scheduled.ts'
import { productConfigFromEnv } from '../src/config/productConfig.ts'
import { STORY } from '../src/story.ts'
import {
  appendRunHistory,
  changeSummary,
  comparedToRunLabel,
  deltaFlipKind,
  deltaVsLastRun,
  gridRuns,
  mentionGrid,
  mentionPercent,
  runColumnLabel,
  themeAcrossLabel,
  themeMentionRates,
  themeRateLabel,
  type CheckRun,
  type RunMention,
} from '../src/runHistory.ts'

const SECRET = 'service-role-test-secret'
const SUPABASE = 'https://example.supabase.co'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const QUESTION = 'What tool should a team use for issue tracking?'

function env(extra: Record<string, string> = {}) {
  return { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: SECRET, ...extra }
}

function mention(question: string, status: RunMention['mention'], whoInstead: string[]): RunMention {
  return { question, mention: status, whoInstead }
}

describe('delta vs last run', () => {
  const prior: CheckRun = {
    at: '2026-09-01T00:00:00.000Z',
    mode: 'unbranded',
    mentions: [mention(QUESTION, 'mentioned', ['Jira', 'Asana'])],
  }
  const current: CheckRun = {
    at: '2026-09-30T00:00:00.000Z',
    mode: 'unbranded',
    mentions: [mention(QUESTION, 'not_mentioned', ['Asana', 'Height'])],
  }

  it('lists mention flips and whoInstead names that appeared or dropped', () => {
    const delta = deltaVsLastRun([prior, current])
    assert.equal(delta.comparable, true)
    assert.equal(delta.empty, false)
    assert.deepEqual(delta.flips, [{ question: QUESTION, from: 'mentioned', to: 'not_mentioned' }])
    assert.deepEqual(delta.appeared, ['Height'])
    assert.deepEqual(delta.dropped, ['Jira'])
  })

  it('names each mention flip with the locked story kind', () => {
    assert.equal(deltaFlipKind('not_mentioned', 'mentioned'), 'newlyMentioned')
    assert.equal(deltaFlipKind('mentioned', 'not_mentioned'), 'noLongerMentioned')
    assert.equal(deltaFlipKind('unclear', 'mentioned'), 'nowMentioned')
    assert.equal(deltaFlipKind('mentioned', 'unclear'), 'lostMention')
    assert.equal(deltaFlipKind('not_mentioned', 'unclear'), null)
    assert.equal(comparedToRunLabel('Compared to run {date}', '2026-09-01T00:00:00.000Z'), 'Compared to run Sep 1, 2026')
    assert.equal(runColumnLabel('2026-09-01T00:00:00.000Z'), 'Sep 1, 12:00 AM')
    assert.equal(runColumnLabel('2026-09-30T15:04:00.000Z'), 'Sep 30, 3:04 PM')
    assert.equal(runColumnLabel('not-a-date'), '')
  })

  it('rolls flip kinds into counts and lays questions across run columns', () => {
    const prior: CheckRun = {
      at: '2026-09-01T00:00:00.000Z',
      mode: 'unbranded',
      mentions: [
        mention('Track issues', 'not_mentioned', ['Jira']),
        mention('Replace a tracker', 'mentioned', ['Jira']),
        mention('Pick a planner', 'unclear', ['Jira']),
        mention('Compare tools', 'mentioned', ['Jira']),
      ],
    }
    const current: CheckRun = {
      at: '2026-09-30T15:04:00.000Z',
      mode: 'unbranded',
      mentions: [
        mention('Track issues', 'mentioned', ['Height']),
        mention('Replace a tracker', 'not_mentioned', ['Height']),
        mention('Pick a planner', 'mentioned', ['Height']),
        mention('Compare tools', 'unclear', ['Height']),
      ],
    }
    const summary = changeSummary([prior, current])
    assert.equal(summary.comparable, true)
    assert.equal(summary.quiet, false)
    assert.deepEqual(summary.chips, [
      { id: 'newlyMentioned', count: 1 },
      { id: 'lostMention', count: 2 },
      { id: 'nowMentioned', count: 1 },
      { id: 'whoAppeared', count: 1 },
      { id: 'whoDropped', count: 1 },
    ])
    const quiet = changeSummary([prior, { ...prior, at: current.at }])
    assert.equal(quiet.quiet, true)
    assert.deepEqual(quiet.chips, [])
    const waiting = changeSummary([prior])
    assert.equal(waiting.comparable, false)
    const rows = mentionGrid([prior, current])
    assert.deepEqual(
      rows.map((row) => row.question),
      ['Track issues', 'Replace a tracker', 'Pick a planner', 'Compare tools'],
    )
    assert.equal(rows[0]?.cells[0]?.mention, 'not_mentioned')
    assert.equal(rows[0]?.cells[1]?.mention, 'mentioned')
    assert.equal(rows.length, 4)
    assert.equal(rows[0]?.cells.length, 2)
    const dropped = mentionGrid([
      prior,
      { ...current, mentions: current.mentions.filter((item) => item.question !== 'Compare tools') },
    ])
    assert.equal(dropped[3]?.question, 'Compare tools')
    assert.equal(dropped[3]?.cells[1], null)
    assert.equal(gridRuns([], prior).length, 1)
    assert.equal(gridRuns([prior, current], prior).length, 2)
    assert.equal(gridRuns([], null).length, 0)
  })

  it('counts theme mention share on the stable id, oldest run to newest', () => {
    assert.equal(mentionPercent([]), null)
    assert.equal(mentionPercent(['mentioned', 'unclear', 'not_mentioned']), 33)
    assert.equal(mentionPercent(['mentioned', 'mentioned', undefined]), 67)
    assert.equal(mentionPercent(['unclear', 'not_mentioned']), 0)
    const oldest: CheckRun = {
      at: '2026-09-01T00:00:00.000Z',
      mode: 'full',
      mentions: [
        mention('Track issues', 'not_mentioned', []),
        mention('How is the brand described?', 'mentioned', []),
      ],
    }
    const middle: CheckRun = {
      at: '2026-09-15T00:00:00.000Z',
      mode: 'full',
      mentions: [
        mention('Track issues', 'mentioned', []),
        mention('Plan a week', 'mentioned', []),
        mention('How is the brand described?', 'not_mentioned', []),
      ],
    }
    const newest: CheckRun = {
      at: '2026-09-30T15:04:00.000Z',
      mode: 'full',
      mentions: [
        mention('Track issues', 'mentioned', []),
        mention('Plan a week', 'mentioned', []),
        mention('How is the brand described?', 'unclear', []),
      ],
    }
    const sharedTitle = 'Shared label'
    const rates = themeMentionRates(
      [
        {
          id: 'problems',
          title: sharedTitle,
          questions: [
            { question: 'Track issues', mention: 'mentioned' },
            { question: 'Plan a week', mention: 'mentioned' },
          ],
        },
        {
          id: 'trust',
          title: sharedTitle,
          questions: [{ question: 'How is the brand described?', mention: 'unclear' }],
        },
        { id: 'buying', title: 'Empty', questions: [] },
      ],
      [oldest, middle, newest],
    )
    assert.deepEqual(
      rates.map((rate) => rate.id),
      ['problems', 'trust', 'buying'],
    )
    const problems = rates[0]
    const trust = rates[1]
    assert.equal(problems?.latest, 100)
    assert.deepEqual(problems?.across, { oldest: 0, newest: 100 })
    assert.equal(trust?.latest, 0)
    assert.deepEqual(trust?.across, { oldest: 100, newest: 0 })
    assert.equal(rates[2]?.latest, null)
    assert.equal(rates[2]?.across, null)
    assert.equal(themeRateLabel('{pct}% mentioned', 100), '100% mentioned')
    assert.equal(themeAcrossLabel('Across runs: {a}% → {b}%', 0, 100), 'Across runs: 0% → 100%')
    const firstOnly = themeMentionRates(
      [{ id: 'problems', questions: [{ question: 'Track issues', mention: 'not_mentioned' }] }],
      [oldest],
    )
    assert.equal(firstOnly[0]?.latest, 0)
    assert.equal(firstOnly[0]?.across, null)
    const fromReport = themeMentionRates(
      [
        {
          id: 'problems',
          questions: [
            { question: 'Track issues', mention: 'mentioned' },
            { question: 'Plan a week', mention: 'unclear' },
          ],
        },
      ],
      [],
    )
    assert.equal(fromReport[0]?.latest, 50)
    assert.equal(fromReport[0]?.across, null)
    const split = themeMentionRates(
      [
        {
          id: 'buying',
          framing: 'unbranded',
          questions: [
            { question: 'What should a team buy?', mention: 'mentioned', framing: 'unbranded' },
            { question: 'What do teams buy next?', mention: 'mentioned', framing: 'unbranded' },
          ],
        },
        {
          id: 'buying',
          framing: 'branded',
          questions: [{ question: 'Should we buy Linear?', mention: 'not_mentioned', framing: 'branded' }],
        },
      ],
      [],
    )
    assert.deepEqual(
      split.map((rate) => [rate.id, rate.framing, rate.latest]),
      [
        ['buying', 'unbranded', 100],
        ['buying', 'branded', 0],
      ],
    )
    const mixed = themeMentionRates(
      [
        {
          id: 'buying',
          questions: [
            { question: 'What should a team buy?', mention: 'mentioned', framing: 'unbranded' },
            { question: 'Should we buy Linear?', mention: 'not_mentioned', framing: 'branded' },
          ],
        },
      ],
      [],
    )
    assert.deepEqual(
      mixed.map((rate) => rate.latest),
      [100, 0],
    )
  })

  it('treats an unchanged run as an empty delta and a single run as not comparable', () => {
    const same = deltaVsLastRun([prior, { ...prior, at: '2026-09-30T00:00:00.000Z' }])
    assert.equal(same.comparable, true)
    assert.equal(same.empty, true)
    assert.deepEqual(same.flips, [])
    assert.deepEqual(same.appeared, [])
    assert.deepEqual(same.dropped, [])
    const waiting = deltaVsLastRun([prior])
    assert.equal(waiting.comparable, false)
    assert.equal(waiting.empty, true)
  })

  it('keeps prior and current on the first re-run, then trims to the newest runs', () => {
    const first = appendRunHistory({
      runs: [],
      prior: prior.mentions,
      next: current.mentions,
      at: current.at,
      priorAt: prior.at,
      limit: 8,
      mode: 'unbranded',
    })
    assert.equal(first.length, 2)
    assert.equal(first[0]?.mentions[0]?.mention, 'mentioned')
    assert.equal(first[1]?.mentions[0]?.mention, 'not_mentioned')
    const third = mention(QUESTION, 'unclear', ['Height'])
    const trimmed = appendRunHistory({
      runs: first,
      prior: current.mentions,
      next: [third],
      at: '2026-10-07T00:00:00.000Z',
      limit: 2,
      mode: 'unbranded',
    })
    assert.equal(trimmed.length, 2)
    assert.equal(trimmed[0]?.mentions[0]?.mention, 'not_mentioned')
    assert.equal(trimmed[1]?.mentions[0]?.mention, 'unclear')
    assert.equal(deltaVsLastRun(trimmed).flips[0]?.from, 'not_mentioned')
    assert.equal(deltaVsLastRun(trimmed).flips[0]?.to, 'unclear')
  })
})

describe('manual re-run history write', () => {
  const stored = {
    id: CHECK,
    domain: 'linear.app',
    mode: 'unbranded',
    created_at: '2026-09-01T00:00:00.000Z',
    result: {
      questionSetOwned: true,
      labels: {
        questions: 'Generated · OpenAI',
        answered: 'Live model',
        whoInstead: 'Generated · OpenAI',
        mode: 'Unbranded',
      },
      model: 'gpt-4o-mini',
      questions: [QUESTION],
      questionsGenerated: true,
      facts: [
        {
          question: QUESTION,
          framing: 'unbranded',
          id: 'problems',
          mention: 'mentioned',
          whoInstead: ['Jira', 'Asana'],
        },
      ],
      unbranded: {
        questions: [QUESTION],
        questionsGenerated: true,
        facts: [
          {
            question: QUESTION,
            framing: 'unbranded',
            id: 'problems',
            mention: 'mentioned',
            whoInstead: ['Jira', 'Asana'],
          },
        ],
      },
    },
  }

  it('stores prior and current on the owned check and does not insert a row', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([stored]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'PATCH' && url.includes('/rest/v1/checks')) {
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'PATCH',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            id: CHECK,
            recordRun: true,
            domain: 'linear.app',
            mode: 'unbranded',
            questions: [QUESTION],
            questionsGenerated: true,
            answered: 'no',
            answeredWhy: 'Other tools are named for this job.',
            answeredLive: true,
            model: 'gpt-4o-mini',
            whoInstead: ['Height'],
            whoInsteadLive: true,
            facts: [
              {
                question: QUESTION,
                framing: 'unbranded',
                id: 'problems',
                mention: 'not_mentioned',
                whoInstead: ['Height'],
              },
            ],
            unbranded: {
              questions: [QUESTION],
              questionsGenerated: true,
              answered: 'no',
              answeredWhy: 'Other tools are named for this job.',
              answeredLive: true,
              model: 'gpt-4o-mini',
              whoInstead: ['Height'],
              whoInsteadLive: true,
              facts: [
                {
                  question: QUESTION,
                  framing: 'unbranded',
                  id: 'problems',
                  mention: 'not_mentioned',
                  whoInstead: ['Height'],
                },
              ],
            },
            branded: null,
            questionSetOwned: true,
          }),
        }),
        env: env(),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(SECRET), false)
      const body = JSON.parse(text) as {
        ok?: boolean
        check?: {
          id?: string
          result?: {
            questionSetOwned?: boolean
            tracking?: { cadence?: string }
            runs?: CheckRun[]
            labels?: { questions?: string }
          }
        }
      }
      assert.equal(body.ok, true)
      assert.equal(body.check?.id, CHECK)
      assert.equal(body.check?.result?.questionSetOwned, true)
      assert.equal(body.check?.result?.labels?.questions, 'Generated · OpenAI')
      assert.equal(body.check?.result?.tracking?.cadence, 'weekly')
      const runs = body.check?.result?.runs ?? []
      assert.equal(runs.length, 2)
      assert.equal(runs[0]?.mentions[0]?.mention, 'mentioned')
      assert.deepEqual(runs[0]?.mentions[0]?.whoInstead, ['Jira', 'Asana'])
      assert.equal(runs[1]?.mentions[0]?.mention, 'not_mentioned')
      assert.deepEqual(runs[1]?.mentions[0]?.whoInstead, ['Height'])
      const delta = deltaVsLastRun(runs)
      assert.deepEqual(delta.flips, [{ question: QUESTION, from: 'mentioned', to: 'not_mentioned' }])
      assert.deepEqual(delta.dropped, ['Asana', 'Jira'])
      assert.deepEqual(delta.appeared, ['Height'])
      const patched = calls.find((call) => call.method === 'PATCH')
      assert.ok(patched)
      assert.equal(patched.body.includes(SECRET), false)
      assert.equal(
        calls.some((call) => call.method === 'POST' && call.url.includes('/rest/v1/checks')),
        false,
      )
      assert.equal(calls.some((call) => call.url.includes('/rest/v1/usage_events')), false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('refuses history on a check that is not an owned set', async () => {
    let patched = false
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (method === 'PATCH') {
        patched = true
        return new Response(null, { status: 204 })
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(JSON.stringify([{ ...stored, result: { ...stored.result, questionSetOwned: false } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    try {
      const res = await onRequest({
        request: new Request('https://grank.pages.dev/api/checks', {
          method: 'PATCH',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            id: CHECK,
            recordRun: true,
            domain: 'linear.app',
            mode: 'unbranded',
            questions: [QUESTION],
            questionsGenerated: true,
            questionSetOwned: true,
          }),
        }),
        env: env(),
      })
      assert.equal(res.status, 400)
      assert.equal(patched, false)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('owned report re-run writes history on the same check', () => {
  it('patches the saved report and does not insert another check', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, method, body })
      if (url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (url.startsWith('https://linear.app')) return new Response('no', { status: 404 })
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    themes: [
                      {
                        id: 'problems',
                        questions: [
                          {
                            question: QUESTION,
                            answer: 'Other trackers show up for that job.',
                            mention: 'not_mentioned',
                            whoInstead: ['Height'],
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (method === 'GET' && url.includes('/rest/v1/checks')) {
        return new Response(
          JSON.stringify([
            {
              id: CHECK,
              domain: 'linear.app',
              mode: 'unbranded',
              created_at: '2026-09-01T00:00:00.000Z',
              result: {
                report: 'full',
                questionSetOwned: true,
                model: 'gpt-4o-mini',
                fullReport: {
                  domain: 'linear.app',
                  model: 'gpt-4o-mini',
                  includesBranded: true,
                  themes: [
                    {
                      id: 'problems',
                      title: 'Problems you solve',
                      questions: [
                        {
                          question: QUESTION,
                          answer: 'Linear is often named for issue tracking.',
                          framing: 'unbranded',
                          mention: 'mentioned',
                          whoInstead: ['Jira'],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'PATCH' && url.includes('/rest/v1/checks')) return new Response(null, { status: 204 })
      return new Response('unexpected ' + method + ' ' + url, { status: 500 })
    }) as typeof fetch
    try {
      const res = await onFullReport({
        request: new Request('https://grank.pages.dev/api/full-report', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            domain: 'linear.app',
            checkId: CHECK,
            owned: [{ question: QUESTION, themeId: 'problems' }],
          }),
        }),
        env: env({ OPENAI_API_KEY: 'sk-openai-full-report-secret' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(SECRET), false)
      assert.equal(text.includes('sk-openai-full-report-secret'), false)
      const body = JSON.parse(text) as {
        check?: { id?: string }
        runs?: CheckRun[]
        themes?: { questions?: { mention?: string }[] }[]
      }
      assert.equal(body.check?.id, CHECK)
      assert.equal(body.runs?.length, 2)
      assert.equal(body.runs?.[0]?.mentions[0]?.mention, 'mentioned')
      assert.equal(body.runs?.[1]?.mentions[0]?.mention, 'not_mentioned')
      assert.equal(body.themes?.[0]?.questions?.[0]?.mention, 'not_mentioned')
      const patched = calls.find((call) => call.method === 'PATCH' && call.url.includes('/rest/v1/checks'))
      assert.ok(patched)
      const storedRun = JSON.parse(patched.body) as { result?: { labels?: { questions?: string }; runs?: unknown[] } }
      assert.equal(storedRun.result?.labels?.questions, 'Generated · OpenAI')
      assert.equal(storedRun.result?.runs?.length, 2)
      assert.equal(
        calls.some((call) => call.method === 'POST' && call.url.includes('/rest/v1/checks')),
        false,
      )
      assert.equal(calls.some((call) => call.url.includes('/rest/v1/usage_events')), false)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('tracking cron stays off', () => {
  it('defaults TRACKING_CRON_ENABLED to false and can store a cadence without enabling it', () => {
    const config = productConfigFromEnv({})
    assert.equal(config.trackingCronEnabled, false)
    assert.equal(config.trackingCadence, 'weekly')
    const turned = productConfigFromEnv({
      TRACKING_CRON_ENABLED: 'true',
      TRACKING_CADENCE: 'daily',
      TRACKING_HISTORY_LIMIT: '1',
    })
    assert.equal(turned.trackingCronEnabled, true)
    assert.equal(turned.trackingCadence, 'daily')
    assert.equal(turned.trackingHistoryLimit, 2)
    const junk = productConfigFromEnv({ TRACKING_CADENCE: 'hourly', TRACKING_CRON_ENABLED: 'nope' })
    assert.equal(junk.trackingCronEnabled, false)
    assert.equal(junk.trackingCadence, 'weekly')
  })

  it('does not fetch or re-run when the flag is off, and still does not re-run when it is on', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('cron must not fetch')
    }) as typeof fetch
    try {
      const off = await onScheduled({ env: {} })
      assert.deepEqual(off, { ran: false, reason: 'tracking_cron_disabled' })
      const on = await onScheduled({ env: { TRACKING_CRON_ENABLED: 'true', TRACKING_CADENCE: 'weekly' } })
      assert.equal(on.ran, false)
      assert.equal(on.reason, 'tracking_cron_scaffold')
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('ships no Pages Cron trigger', () => {
    const scheduled = readFileSync(new URL('../functions/scheduled.ts', import.meta.url), 'utf8')
    assert.equal(scheduled.includes('fetch('), false)
    assert.equal(scheduled.includes('api.openai.com'), false)
    assert.match(scheduled, /trackingCronEnabled/)
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.git') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.(toml|json|ya?ml|ts|js|md)$/.test(name)) continue
        const text = readFileSync(path, 'utf8')
        if (/^\s*crons\s*=/m.test(text) || /\[triggers\]/.test(text)) found.push(path)
      }
    }
    walk(root)
    assert.deepEqual(found, [])
  })
})

describe('what’s changed and over time story', () => {
  it('uses the rollup and grid labels and only shows them on an owned check', () => {
    assert.equal(STORY.deltaTitle, 'What’s changed')
    assert.equal(STORY.deltaHelper, 'A short read on this check since the previous run.')
    assert.equal(STORY.deltaAwaiting, 'Run again to start comparing over time.')
    assert.equal(STORY.deltaEmpty, 'No mention changes since the previous run.')
    assert.equal(STORY.deltaNewlyMentioned, 'Newly mentioned')
    assert.equal(STORY.deltaNowMentioned, 'Now mentioned')
    assert.equal(STORY.deltaLostMention, 'Lost mention')
    assert.equal(STORY.deltaWhoAppeared, 'Newly showing up instead')
    assert.equal(STORY.deltaWhoDropped, 'No longer showing up instead')
    assert.equal(STORY.overTimeTitle, 'Over time')
    assert.equal(STORY.overTimeHelper, 'Each column is one run. Same questions — mention status as you re-run.')
    assert.equal(STORY.overTimeQuestion, 'Question')
    assert.equal(STORY.overTimeLegend, 'Mentioned · Not mentioned · Unclear')
    assert.equal(STORY.themeMentionRate, '{pct}% mentioned')
    assert.equal(STORY.themeAcrossRuns, 'Across runs: {a}% → {b}%')
    assert.equal(STORY.manageQuestionsCta, 'Manage questions')
    assert.equal(STORY.manageQuestionsTitle, 'Manage questions')
    assert.equal(
      STORY.manageQuestionsHint,
      'Add, remove, or rename questions for this check. Save, then Run again.',
    )
    assert.equal(
      /SOV|visibility score|monitoring|weekly tracking/i.test(
        `${STORY.themeMentionRate} ${STORY.themeAcrossRuns} ${STORY.manageQuestionsHint}`,
      ),
      false,
    )
    assert.equal(STORY.landTitle, 'Do you show up for what you solve?')
    assert.equal(STORY.answerLabel, 'Generated · OpenAI')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const panel = readFileSync(new URL('../src/RunHistoryPanel.tsx', import.meta.url), 'utf8')
    const scheduled = readFileSync(new URL('../functions/scheduled.ts', import.meta.url), 'utf8')
    assert.match(app, /const showDelta = owning && \(ownedSet \|\| runs\.length > 0\)/)
    assert.match(app, /recordCheckRun\(/)
    assert.match(app, /showDelta \? \(/)
    assert.match(app, /<RunHistoryPanel/)
    assert.match(panel, /copy\.deltaTitle/)
    assert.match(panel, /copy\.deltaHelper/)
    assert.match(panel, /copy\.deltaEmpty/)
    assert.match(panel, /copy\.deltaAwaiting/)
    assert.match(panel, /copy\.overTimeTitle/)
    assert.match(panel, /copy\.overTimeHelper/)
    assert.match(panel, /run-over-time-label/)
    assert.equal(/<h2[^>]*>\s*\{copy\.overTimeTitle\}/.test(panel), false)
    assert.match(panel, /summaryOnly \? null/)
    const reportStart = app.indexOf('screen && fullReport && reportOnly')
    const reportBranch = app.slice(reportStart, app.indexOf(') : screen ?', reportStart))
    assert.equal(reportBranch.indexOf('RunHistoryPanel') < reportBranch.indexOf('FullReportSection'), true)
    assert.match(reportBranch, /summaryOnly/)
    assert.equal(reportBranch.includes('overTimeTitle'), false)
    assert.equal(reportBranch.includes('ownedQuestionsHint'), false)
    const section = readFileSync(new URL('../src/FullReportSection.tsx', import.meta.url), 'utf8')
    assert.match(section, /themeMentionRate/)
    assert.match(section, /themeAcrossRuns/)
    assert.match(section, /manageQuestionsCta/)
    assert.equal(section.includes('overTimeTitle'), false)
    const gridRow = section.slice(section.indexOf('function ThemeGridRow'), section.indexOf('function ManageQuestions'))
    assert.equal(gridRow.includes('editQuestionCta'), false)
    assert.equal(gridRow.includes('deleteQuestionCta'), false)
    assert.equal(gridRow.includes('q-badge'), false)
    assert.equal(gridRow.includes('landBadge'), false)
    assert.equal(gridRow.includes('digBadge'), false)
    assert.match(gridRow, /\{GENERATED\}/)
    assert.match(panel, /deltaNewlyMentioned/)
    assert.match(panel, /deltaWhoAppeared/)
    assert.match(panel, /changeSummary/)
    assert.equal(panel.includes('run-delta-list'), false)
    assert.equal(/monitoring|scheduled pulse|every week|Vs last run/i.test(panel + scheduled), false)
  })
})

describe('what’s changed and over time markup', () => {
  it('renders a rollup and a mention grid, with one column before a second run', async () => {
    const server: ViteDevServer = await createServer({
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
      ssr: { external: ['react', 'react-dom'] },
    })
    try {
      const { RunHistoryPanel } = (await server.ssrLoadModule(
        '/src/RunHistoryPanel.tsx',
      )) as typeof import('../src/RunHistoryPanel.tsx')
      const { PRODUCT_DEFAULTS } = (await server.ssrLoadModule(
        '/src/config/productConfig.ts',
      )) as typeof import('../src/config/productConfig.ts')
      const copy = PRODUCT_DEFAULTS.copy
      const prior: CheckRun = {
        at: '2026-09-01T00:00:00.000Z',
        mode: 'unbranded',
        mentions: [
          mention('Track issues', 'not_mentioned', ['Jira']),
          mention('Replace a tracker', 'mentioned', ['Jira']),
          mention('Pick a planner', 'unclear', ['Jira']),
          mention('Compare tools', 'mentioned', ['Jira']),
        ],
      }
      const current: CheckRun = {
        at: '2026-09-30T15:04:00.000Z',
        mode: 'unbranded',
        mentions: [
          mention('Track issues', 'mentioned', ['Height']),
          mention('Replace a tracker', 'not_mentioned', ['Height']),
          mention('Pick a planner', 'mentioned', ['Height']),
          mention('Compare tools', 'unclear', ['Height']),
        ],
      }
      const waiting = renderToStaticMarkup(
        React.createElement(RunHistoryPanel, {
          runs: [],
          preview: prior,
          answers: [{ question: 'Track issues', answer: 'Jira shows up for tracking.' }],
          copy,
        }),
      )
      assert.match(waiting, /What’s changed/)
      assert.match(waiting, /A short read on this check since the previous run\./)
      assert.match(waiting, /Run again to start comparing over time\./)
      assert.match(waiting, /Over time/)
      assert.match(waiting, /Each column is one run\. Same questions — mention status as you re-run\./)
      assert.match(waiting, /Mentioned · Not mentioned · Unclear/)
      assert.equal(waiting.match(/<th scope="col">/g)?.length, 2)
      assert.match(waiting, /Sep 1, 12:00 AM/)
      assert.match(waiting, /Not mentioned/)
      assert.match(waiting, /Generated · OpenAI/)
      assert.match(waiting, /Jira shows up for tracking\./)
      assert.equal(/monitoring|every week|scheduled|Vs last run/i.test(waiting), false)

      const same = renderToStaticMarkup(
        React.createElement(RunHistoryPanel, { runs: [prior, { ...prior, at: current.at }], copy }),
      )
      assert.match(same, /No mention changes since the previous run\./)
      assert.equal(same.match(/<th scope="col">/g)?.length, 3)
      assert.equal(same.includes('Newly mentioned'), false)

      const flipped = renderToStaticMarkup(
        React.createElement(RunHistoryPanel, {
          runs: [prior, current],
          answers: [{ question: 'Track issues', answer: 'This check is named in the reply.' }],
          copy,
        }),
      )
      assert.match(flipped, /1 Newly mentioned/)
      assert.match(flipped, /2 Lost mention/)
      assert.match(flipped, /1 Now mentioned/)
      assert.match(flipped, /1 Newly showing up instead/)
      assert.match(flipped, /1 No longer showing up instead/)
      assert.equal(flipped.includes('Track issues — Newly mentioned'), false)
      assert.equal(flipped.includes('No longer mentioned'), false)
      assert.equal(flipped.includes('Run again to start comparing'), false)
      assert.match(flipped, /Sep 1, 12:00 AM/)
      assert.match(flipped, /Sep 30, 3:04 PM/)
      assert.match(flipped, /class="tag plain mention mentioned"/)
      assert.match(flipped, /This check is named in the reply\./)
      assert.equal(flipped.split('This check is named in the reply.').length, 2)
      assert.equal(/monitoring|every week|Vs last run/i.test(flipped), false)
    } finally {
      await server.close()
    }
  })
})

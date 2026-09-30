import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { onRequest } from '../functions/api/checks.ts'
import { onRequest as onFullReport } from '../functions/api/full-report.ts'
import { onScheduled } from '../functions/scheduled.ts'
import { productConfigFromEnv } from '../src/config/productConfig.ts'
import { STORY } from '../src/story.ts'
import {
  appendRunHistory,
  deltaVsLastRun,
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

describe('vs last run story', () => {
  it('uses the thin labels and only shows the delta on an owned check', () => {
    assert.equal(STORY.deltaTitle, 'Vs last run')
    assert.equal(STORY.deltaEmpty, 'No mention changes vs last run.')
    assert.equal(STORY.deltaAwaiting, 'No earlier run to compare yet.')
    assert.equal(STORY.landTitle, 'Do you show up for what you solve?')
    assert.equal(STORY.answerLabel, 'Generated · OpenAI')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const delta = readFileSync(new URL('../src/RunDelta.tsx', import.meta.url), 'utf8')
    assert.match(app, /const showDelta = owning && \(ownedSet \|\| runs\.length > 0\)/)
    assert.match(app, /recordCheckRun\(/)
    assert.match(app, /showDelta \? <RunDelta/)
    assert.match(delta, /STORY\.deltaTitle/)
    assert.match(delta, /STORY\.deltaEmpty/)
    assert.match(delta, /STORY\.deltaAwaiting/)
    assert.match(delta, /deltaVsLastRun/)
    assert.equal(delta.includes('fullReport'), false)
  })
})

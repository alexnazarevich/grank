import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { onRequest as onBilling, stripeCheckoutUrl as serverCheckoutUrl } from '../functions/api/billing.ts'
import { quotaKinds, quotaWindowStart, rankInWindow } from '../functions/api/quota.ts'
import { onRequest as onWebhook } from '../functions/api/stripe-webhook.ts'
import { verifyStripeSignature } from '../functions/api/stripeSignature.ts'
import { onRequest as onVisibility } from '../functions/api/visibility.ts'
import { startCheckout, stripeCheckoutUrl } from '../src/billingClient.ts'
import { quotaAmountForPlan, productConfigFromEnv } from '../src/config/productConfig.ts'

const KEY = 'sk-openai-visibility-secret'
const SB = 'https://example.supabase.co'
const SERVICE = 'service-role-test-secret'
const ANON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OLDER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const STRIPE_SECRET = 'sk_test_billing_secret'
const PRICE = 'price_123'
const WHSEC = 'whsec_testsecret'

type Call = { url: string; method: string; body: string }

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function install(handler: (call: Call, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const prev = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: urlOf(input), method: init?.method || 'GET', body: typeof init?.body === 'string' ? init.body : '' }
    calls.push(call)
    return handler(call, init)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = prev
    },
  }
}

function completion(): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            questions: [
              'What do teams use for issue tracking?',
              'Which tool replaces a spreadsheet of bugs?',
              'How do product teams plan work?',
            ],
            answered: 'partial',
            why: 'Known category, not always cited first.',
            whoInstead: ['Jira', 'Asana'],
          }),
        },
      },
    ],
  })
}

function visibilityEnv(extra: Record<string, string> = {}) {
  return {
    OPENAI_API_KEY: KEY,
    SUPABASE_URL: SB,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    PAYWALL_ENABLED: 'true',
    ...extra,
  }
}

async function stripeHeader(payload: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`))
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `t=${ts},v1=${hex}`
}

describe('quota knobs', () => {
  it('counts checks, saves, or both, and uses the paid amount only for a paid plan', () => {
    assert.deepEqual(quotaKinds('checks'), ['check'])
    assert.deepEqual(quotaKinds('saves'), ['save'])
    assert.deepEqual(quotaKinds('both'), ['check', 'save'])
    const config = productConfigFromEnv({ FREE_QUOTA_AMOUNT: '3', PAID_QUOTA_AMOUNT: '100' })
    assert.equal(quotaAmountForPlan(config, 'free'), 3)
    assert.equal(quotaAmountForPlan(config, 'paid'), 100)
    assert.equal(quotaAmountForPlan(config, null), 3)
  })

  it('windows are UTC day, UTC month, or lifetime', () => {
    const now = new Date('2026-09-26T15:04:00.000Z')
    assert.equal(quotaWindowStart('lifetime', now), null)
    assert.equal(quotaWindowStart('day', now), '2026-09-26T00:00:00.000Z')
    assert.equal(quotaWindowStart('month', now), '2026-09-01T00:00:00.000Z')
  })

  it('ranks the reserved row inside the window', () => {
    assert.equal(rankInWindow([{ id: OLDER }, { id: USAGE }], USAGE, 4), 2)
    assert.equal(rankInWindow([{ id: USAGE }], USAGE, 4), 1)
    assert.equal(rankInWindow([{ id: OLDER }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], USAGE, 2), 3)
    assert.equal(rankInWindow([{ id: OLDER }], USAGE, 4), null)
  })
})

describe('visibility quota', () => {
  it('does not count or block while the paywall is off', async () => {
    const mock = install((call) => {
      if (call.url.includes('supabase.co')) throw new Error('quota must stay off')
      if (!call.url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      return new Response(completion(), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: visibilityEnv({ PAYWALL_ENABLED: 'false' }),
      })
      assert.equal(res.status, 200)
      assert.equal(mock.calls.some((call) => call.url.includes('supabase.co')), false)
    } finally {
      mock.restore()
    }
  })

  it('refuses the model call when the free check quota is used', async () => {
    const mock = install((call) => {
      if (call.url.includes('api.openai.com') || call.url.startsWith('https://linear.app')) {
        throw new Error('model call leaked past the quota')
      }
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.body, /"kind":"check"/)
        assert.match(call.body, new RegExp(ANON))
        assert.equal(call.body.includes(SERVICE), false)
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, /kind=eq\.check/)
        assert.equal(call.url.includes('created_at=gte.'), false)
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes('/rest/v1/usage_events')) {
        assert.equal(call.url.includes(USAGE), true)
        return new Response(null, { status: 204 })
      }
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: visibilityEnv({ FREE_QUOTA_AMOUNT: '1' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      assert.equal(text.includes(SERVICE), false)
      assert.equal(text.includes(KEY), false)
      const body = JSON.parse(text) as { code?: string; plan?: string; quota?: { amount?: number; unit?: string } }
      assert.equal(body.code, 'quota_exceeded')
      assert.equal(body.plan, 'free')
      assert.equal(body.quota?.amount, 1)
      assert.equal(body.quota?.unit, 'checks')
      assert.equal(mock.calls.some((call) => call.url.includes('api.openai.com')), false)
    } finally {
      mock.restore()
    }
  })

  it('reserves the check before OpenAI and keeps it when the call succeeds', async () => {
    const mock = install((call) => {
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, /created_at=gte\./)
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE') throw new Error('successful check must keep the usage row')
      if (!call.url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      return new Response(completion(), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: visibilityEnv({ FREE_QUOTA_WINDOW: 'day' }),
      })
      assert.equal(res.status, 200)
      const usageAt = mock.calls.findIndex((call) => call.method === 'POST' && call.url.includes('usage_events'))
      const openaiAt = mock.calls.findIndex((call) => call.url.includes('api.openai.com'))
      assert.ok(usageAt >= 0 && openaiAt > usageAt)
    } finally {
      mock.restore()
    }
  })

  it('drops the reservation when OpenAI fails', async () => {
    const mock = install((call) => {
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE' && call.url.includes(USAGE)) return new Response(null, { status: 204 })
      if (!call.url.includes('api.openai.com')) return new Response('nope', { status: 404 })
      return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: visibilityEnv(),
      })
      assert.equal(res.status, 502)
      assert.ok(mock.calls.some((call) => call.method === 'DELETE' && call.url.includes(USAGE)))
    } finally {
      mock.restore()
    }
  })

  it('blocks a check once save quota is used, without recording a check', async () => {
    const mock = install((call) => {
      if (call.url.includes('api.openai.com')) throw new Error('model call leaked')
      if (call.method === 'POST') throw new Error('saves-only quota must not insert a check row')
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, /kind=eq\.save/)
        return new Response('[]', { status: 200, headers: { 'content-range': '*/2' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: visibilityEnv({ FREE_QUOTA_UNIT: 'saves', FREE_QUOTA_AMOUNT: '1' }),
      })
      assert.equal(res.status, 402)
      const body = (await res.json()) as { quota?: { unit?: string; used?: number } }
      assert.equal(body.quota?.unit, 'saves')
      assert.equal(body.quota?.used, 2)
    } finally {
      mock.restore()
    }
  })

  it('fails closed without a browser id or Supabase', async () => {
    const mock = install(() => {
      throw new Error('should not fetch')
    })
    try {
      const missingId = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app'),
        env: visibilityEnv(),
      })
      assert.equal(missingId.status, 400)
      const missingSb = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { 'x-grank-anon': ANON },
        }),
        env: { OPENAI_API_KEY: KEY, PAYWALL_ENABLED: 'true' },
      })
      assert.equal(missingSb.status, 503)
      const text = await missingSb.text()
      assert.match(text, /Quota is not configured/)
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })

  it('uses the paid amount for a paid profile', async () => {
    const mock = install((call) => {
      if (call.url.includes('api.openai.com') || call.url.startsWith('https://linear.app')) {
        throw new Error('paid cap still blocks the model')
      }
      if (call.url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles') && call.method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'paid', stripe_customer_id: 'cus_Abc123' }]), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (call.method === 'PATCH' && call.url.includes('/rest/v1/usage_events')) return new Response(null, { status: 204 })
      if (call.method === 'POST' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.body, new RegExp(USER))
        return new Response(JSON.stringify([{ id: USAGE }]), { status: 201 })
      }
      if (call.method === 'GET' && call.url.includes('/rest/v1/usage_events')) {
        assert.match(call.url, new RegExp(`user_id=eq.${USER}`))
        return new Response(JSON.stringify([{ id: OLDER }, { id: USAGE }]), { status: 200 })
      }
      if (call.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response('unexpected ' + call.method + ' ' + call.url, { status: 500 })
    })
    try {
      const res = await onVisibility({
        request: new Request('https://grank.pages.dev/api/visibility?domain=linear.app', {
          headers: { authorization: 'Bearer user-access-token', 'x-grank-anon': ANON },
        }),
        env: visibilityEnv({ PAID_QUOTA_AMOUNT: '1' }),
      })
      const text = await res.text()
      assert.equal(res.status, 402, text)
      const body = JSON.parse(text) as { plan?: string; quota?: { amount?: number } }
      assert.equal(body.plan, 'paid')
      assert.equal(body.quota?.amount, 1)
      assert.equal(text.includes(SERVICE), false)
    } finally {
      mock.restore()
    }
  })
})

describe('stripe checkout', () => {
  it('accepts only Stripe-hosted checkout URLs', () => {
    const good = 'https://checkout.stripe.com/c/pay/cs_test_abc'
    assert.equal(stripeCheckoutUrl(good), good)
    assert.equal(serverCheckoutUrl(good), good)
    assert.equal(stripeCheckoutUrl('https://evil.example/steal'), null)
    assert.equal(stripeCheckoutUrl('http://checkout.stripe.com/c/pay/cs_test_abc'), null)
  })

  it('asks the signed-in user to start the one subscription session', async () => {
    const mock = install((call) => {
      if (call.url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles') && call.method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'free', stripe_customer_id: null }]), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      if (call.url === 'https://api.stripe.com/v1/checkout/sessions') {
        assert.match(call.body, /mode=subscription/)
        assert.match(call.body, /price_123/)
        assert.match(call.body, new RegExp(USER))
        assert.equal(call.body.includes(SERVICE), false)
        return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }), { status: 200 })
      }
      return new Response('unexpected ' + call.url, { status: 500 })
    })
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token' },
        }),
        env: {
          PAYWALL_ENABLED: 'true',
          STRIPE_SECRET_KEY: STRIPE_SECRET,
          STRIPE_PRICE_ID: PRICE,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(STRIPE_SECRET), false)
      assert.equal(text.includes(PRICE), false)
      assert.equal(text.includes(SERVICE), false)
      const body = JSON.parse(text) as { url?: string }
      assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_abc')
    } finally {
      mock.restore()
    }
  })

  it('does not call Stripe without a session, or when the profile is already paid', async () => {
    const signedOut = install(() => {
      throw new Error('stripe should not be called')
    })
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', { method: 'POST' }),
        env: {
          PAYWALL_ENABLED: 'true',
          STRIPE_SECRET_KEY: STRIPE_SECRET,
          STRIPE_PRICE_ID: PRICE,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        },
      })
      const text = await res.text()
      assert.equal(res.status, 401, text)
      assert.match(text, /Sign in to upgrade/)
      assert.equal(text.includes(STRIPE_SECRET), false)
      assert.equal(signedOut.calls.length, 0)
    } finally {
      signedOut.restore()
    }

    const paid = install((call) => {
      if (call.url.includes('api.stripe.com')) throw new Error('already paid')
      if (call.url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles') && call.method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'paid', stripe_customer_id: 'cus_Abc123' }]), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      return new Response('unexpected', { status: 500 })
    })
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token' },
        }),
        env: {
          PAYWALL_ENABLED: 'true',
          STRIPE_SECRET_KEY: STRIPE_SECRET,
          STRIPE_PRICE_ID: PRICE,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        },
      })
      const body = (await res.json()) as { alreadyPaid?: boolean; plan?: string }
      assert.equal(res.status, 200)
      assert.equal(body.alreadyPaid, true)
      assert.equal(body.plan, 'paid')
    } finally {
      paid.restore()
    }
  })

  it('scrubs a Stripe error and ignores a non-Stripe redirect', async () => {
    const mock = install((call) => {
      if (call.url.endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: USER, email: 'a@b.co' }), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles') && call.method === 'GET') {
        return new Response(JSON.stringify([{ plan: 'free' }]), { status: 200 })
      }
      if (call.url.includes('/rest/v1/profiles')) return new Response('', { status: 201 })
      return new Response(JSON.stringify({ error: { message: `bad ${STRIPE_SECRET}` } }), { status: 400 })
    })
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', {
          method: 'POST',
          headers: { authorization: 'Bearer user-access-token' },
        }),
        env: {
          PAYWALL_ENABLED: 'true',
          STRIPE_SECRET_KEY: STRIPE_SECRET,
          STRIPE_PRICE_ID: PRICE,
          SUPABASE_URL: SB,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        },
      })
      const text = await res.text()
      assert.equal(res.status, 502)
      assert.equal(text.includes(STRIPE_SECRET), false)
      assert.match(text, /\[redacted\]/)
    } finally {
      mock.restore()
    }

    const client = install(async () =>
      new Response(JSON.stringify({ url: 'https://evil.example/steal' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    try {
      const result = await startCheckout('token')
      assert.equal(result.ok, false)
    } finally {
      client.restore()
    }
  })
})

describe('stripe webhook', () => {
  it('rejects a missing secret or a bad signature without calling Supabase', async () => {
    const mock = install(() => {
      throw new Error('should not fetch')
    })
    try {
      const missing = await onWebhook({
        request: new Request('https://grank.pages.dev/api/stripe-webhook', { method: 'POST', body: '{}' }),
        env: {},
      })
      assert.equal(missing.status, 503)
      const payload = JSON.stringify({ type: 'checkout.session.completed' })
      const bad = await onWebhook({
        request: new Request('https://grank.pages.dev/api/stripe-webhook', {
          method: 'POST',
          headers: { 'stripe-signature': 't=1,v1=deadbeef' },
          body: payload,
        }),
        env: { STRIPE_WEBHOOK_SECRET: WHSEC, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE },
      })
      assert.equal(bad.status, 400)
      assert.equal(mock.calls.length, 0)
      const now = 1_700_000_000
      const header = await stripeHeader('{}', WHSEC, now)
      assert.equal(await verifyStripeSignature('{}', header, WHSEC, now), true)
      assert.equal(await verifyStripeSignature('{}', header, WHSEC, now + 301), false)
      assert.equal(await verifyStripeSignature('{"tampered":true}', header, WHSEC, now), false)
    } finally {
      mock.restore()
    }
  })

  it('sets plan paid from a completed checkout and free when the subscription ends', async () => {
    const paidPayload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          status: 'complete',
          payment_status: 'paid',
          client_reference_id: USER,
          customer: 'cus_Abc123',
          metadata: { user_id: USER },
        },
      },
    })
    const paid = install((call) => {
      assert.match(call.url, /\/rest\/v1\/profiles/)
      assert.equal(call.method, 'POST')
      const body = JSON.parse(call.body) as { plan?: string; user_id?: string; stripe_customer_id?: string }
      assert.equal(body.plan, 'paid')
      assert.equal(body.user_id, USER)
      assert.equal(body.stripe_customer_id, 'cus_Abc123')
      assert.equal(call.body.includes(WHSEC), false)
      assert.equal(call.body.includes(SERVICE), false)
      return new Response('', { status: 201 })
    })
    try {
      const res = await onWebhook({
        request: new Request('https://grank.pages.dev/api/stripe-webhook', {
          method: 'POST',
          headers: { 'stripe-signature': await stripeHeader(paidPayload, WHSEC) },
          body: paidPayload,
        }),
        env: { STRIPE_WEBHOOK_SECRET: WHSEC, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE },
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.equal(text.includes(WHSEC), false)
      assert.equal(text.includes(SERVICE), false)
    } finally {
      paid.restore()
    }

    const endedPayload = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          status: 'canceled',
          customer: 'cus_Abc123',
          metadata: { user_id: USER },
        },
      },
    })
    const ended = install((call) => {
      assert.equal(call.method, 'PATCH')
      assert.match(call.url, new RegExp(`user_id=eq.${USER}`))
      assert.equal(JSON.parse(call.body).plan, 'free')
      return new Response(null, { status: 204 })
    })
    try {
      const res = await onWebhook({
        request: new Request('https://grank.pages.dev/api/stripe-webhook', {
          method: 'POST',
          headers: { 'stripe-signature': await stripeHeader(endedPayload, WHSEC) },
          body: endedPayload,
        }),
        env: { STRIPE_WEBHOOK_SECRET: WHSEC, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE },
      })
      assert.equal(res.status, 200)
    } finally {
      ended.restore()
    }
  })

  it('acks ignored events and an unpaid checkout without changing the plan', async () => {
    const mock = install(() => {
      throw new Error('plan must stay unchanged')
    })
    try {
      for (const event of [
        { type: 'invoice.paid', data: { object: { id: 'in_1' } } },
        {
          type: 'checkout.session.completed',
          data: { object: { status: 'complete', payment_status: 'unpaid', client_reference_id: USER } },
        },
      ]) {
        const payload = JSON.stringify(event)
        const res = await onWebhook({
          request: new Request('https://grank.pages.dev/api/stripe-webhook', {
            method: 'POST',
            headers: { 'stripe-signature': await stripeHeader(payload, WHSEC) },
            body: payload,
          }),
          env: { STRIPE_WEBHOOK_SECRET: WHSEC, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE },
        })
        assert.equal(res.status, 200)
      }
      assert.equal(mock.calls.length, 0)
    } finally {
      mock.restore()
    }
  })
})

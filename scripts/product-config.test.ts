import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  historyCapForPlan,
  PRODUCT_DEFAULTS,
  productConfigFromEnv,
} from '../src/config/productConfig.ts'
import { onRequest } from '../functions/api/product-config.ts'
import { onRequest as onBilling } from '../functions/api/billing.ts'

describe('productConfigFromEnv', () => {
  it('uses safe defaults, including a disabled paywall', () => {
    const config = productConfigFromEnv({})
    assert.equal(config.paywallEnabled, false)
    assert.equal(config.saveRequiresAuth, true)
    assert.equal(config.freeChecksBeforeSave, 1)
    assert.equal(config.maxSavedChecksPerUser, 20)
    assert.equal(config.storeQuestions, true)
    assert.equal(config.storeAnswers, true)
    assert.equal(config.storeWhoInstead, true)
    assert.equal(config.storeHomepageSnippet, false)
    assert.equal(config.checkRetentionDays, 0)
    assert.equal(config.freeQuotaUnit, 'checks')
    assert.equal(config.freeQuotaAmount, PRODUCT_DEFAULTS.freeQuotaAmount)
    assert.equal(config.freeQuotaWindow, 'lifetime')
    assert.equal(config.paidInterval, 'month')
    assert.equal(config.copy.saveCta, 'Save this check')
    assert.equal(config.copy.runAgainCta, 'Run again')
    assert.equal(config.copy.historyTitle, 'Your checks')
    assert.equal(config.copy.upgradeHeadline, 'Need more checks?')
    assert.equal(
      config.copy.upgradeBody,
      'A paid plan raises your check limit. Limits come from settings, not this sentence.',
    )
    assert.equal(config.copy.upgradeCta, 'Upgrade')
    for (const text of Object.values(config.copy)) {
      assert.equal(/\b3 free\b|\$29|\$\d/.test(text), false)
    }
  })

  it('lets PRODUCT_CONFIG_JSON override copy and caps, and lets one env alias win', () => {
    const config = productConfigFromEnv({
      PRODUCT_CONFIG_JSON: JSON.stringify({
        maxSavedChecksPerUser: 5,
        paywallEnabled: true,
        copy: { saveCta: 'Keep this check', ignored: 'nope' },
        notAKnob: 1,
      }),
      MAX_SAVED_CHECKS_PER_USER: '9',
      PAYWALL_ENABLED: 'false',
    })
    assert.equal(config.maxSavedChecksPerUser, 9)
    assert.equal(config.paywallEnabled, false)
    assert.equal(config.copy.saveCta, 'Keep this check')
    assert.equal(config.copy.runAgainCta, 'Run again')
    assert.equal(config.storeHomepageSnippet, false)
  })

  it('ignores invalid JSON and invalid enums', () => {
    const config = productConfigFromEnv({
      PRODUCT_CONFIG_JSON: '{',
      FREE_QUOTA_UNIT: 'credits',
      FREE_QUOTA_WINDOW: 'week',
      PAID_INTERVAL: 'century',
      STORE_HOMEPAGE_SNIPPET: 'yes',
      CHECK_RETENTION_DAYS: '-4',
    })
    assert.equal(config.freeQuotaUnit, 'checks')
    assert.equal(config.freeQuotaWindow, 'lifetime')
    assert.equal(config.paidInterval, 'month')
    assert.equal(config.storeHomepageSnippet, true)
    assert.equal(config.checkRetentionDays, 0)
    assert.equal(config.copy.historyTitle, 'Your checks')
  })

  it('uses the paid history cap only when the paywall is on and the plan is paid', () => {
    const config = productConfigFromEnv({ PAID_MAX_SAVED_CHECKS: '40' })
    assert.equal(historyCapForPlan(config, 'free'), config.maxSavedChecksPerUser)
    assert.equal(historyCapForPlan(config, 'paid'), config.maxSavedChecksPerUser)
    const open = productConfigFromEnv({ PAYWALL_ENABLED: 'true', PAID_MAX_SAVED_CHECKS: '40' })
    assert.equal(historyCapForPlan(open, 'paid'), 40)
    assert.equal(historyCapForPlan(open, 'free'), open.maxSavedChecksPerUser)
  })
})

describe('GET /api/product-config', () => {
  it('returns knobs and does not echo a server secret', async () => {
    const secret = 'sk-super-secret-openai'
    const res = await onRequest({
      request: new Request('https://grank.pages.dev/api/product-config'),
      env: { OPENAI_API_KEY: secret, STRIPE_SECRET_KEY: 'sk_live_should_not_leak', PAYWALL_ENABLED: 'false' },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes('sk_live_should_not_leak'), false)
    const body = JSON.parse(text) as { ok?: boolean; config?: { paywallEnabled?: boolean; copy?: { saveCta?: string } } }
    assert.equal(body.ok, true)
    assert.equal(body.config?.paywallEnabled, false)
    assert.equal(body.config?.copy?.saveCta, 'Save this check')
  })
})

describe('POST /api/billing', () => {
  it('stays off without calling Stripe while the paywall flag is false', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('stripe should not be called')
    }) as typeof fetch
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', { method: 'POST' }),
        env: { STRIPE_SECRET_KEY: 'sk_test_billing_secret', STRIPE_PRICE_ID: 'price_123' },
      })
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.equal(text.includes('sk_test_billing_secret'), false)
      assert.equal(text.includes('price_123'), false)
      const body = JSON.parse(text) as { paywallEnabled?: boolean }
      assert.equal(body.paywallEnabled, false)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('reports checkout as not configured when the price id is missing, without calling Stripe', async () => {
    let called = false
    const prev = globalThis.fetch
    globalThis.fetch = (() => {
      called = true
      throw new Error('stripe should not be called')
    }) as typeof fetch
    try {
      const res = await onBilling({
        request: new Request('https://grank.pages.dev/api/billing', { method: 'POST' }),
        env: { PAYWALL_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_billing_secret' },
      })
      assert.equal(res.status, 503)
      const text = await res.text()
      assert.equal(text.includes('sk_test_billing_secret'), false)
      assert.match(text, /Checkout is not configured/)
      assert.equal(called, false)
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe('guest aha stays ungated until the paywall is on', () => {
  it('does not embed Stripe, Vite, or the service role in the visibility function', () => {
    const src = readFileSync(new URL('../functions/api/visibility.ts', import.meta.url), 'utf8')
    assert.equal(src.includes('VITE_'), false)
    assert.equal(src.includes('STRIPE_'), false)
    assert.equal(src.includes('SERVICE_ROLE'), false)
  })

  it('does not put privileged keys in client source', () => {
    const files = [
      '../src/App.tsx',
      '../src/authClient.ts',
      '../src/billingClient.ts',
      '../src/checksClient.ts',
      '../src/config/clientConfig.ts',
      '../src/config/productConfig.ts',
    ]
    for (const file of files) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      assert.equal(src.includes('SERVICE_ROLE'), false, file)
      assert.equal(src.includes('OPENAI_API_KEY'), false, file)
      assert.equal(src.includes('STRIPE_SECRET'), false, file)
      assert.equal(/\b3 free\b|\$29/.test(src), false, file)
    }
  })
})

/**
 * GET /api/billing — paywall flag and whether checkout can start.
 * POST /api/billing — one Stripe Checkout Session for the signed-in user.
 * paywallEnabled false never calls Stripe. Missing keys return a configuration error.
 */

import { productConfigFromEnv } from '../../src/config/productConfig.ts'
import { json, scrubSecret } from './http.ts'
import {
  bearer,
  ensureProfile,
  readBillingProfile,
  sbConfig,
  SERVER_AUTH_NOT_CONFIGURED,
  userFromToken,
} from './supabaseAuth.ts'

const PRICE_RE = /^price_[A-Za-z0-9]+$/
const CHECKOUT_HOST = 'checkout.stripe.com'

export function stripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== CHECKOUT_HOST) return null
    return url.toString()
  } catch {
    return null
  }
}

function configuredPrice(env: Record<string, string | undefined> | undefined): string {
  const price = env?.STRIPE_PRICE_ID?.trim() || ''
  return PRICE_RE.test(price) ? price : ''
}

function isEmail(value: string | null): value is string {
  return !!value && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function onRequest(context: {
  request: Request
  env?: Record<string, string | undefined>
}): Promise<Response> {
  const method = context.request.method
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Use GET or POST' })

  const config = productConfigFromEnv(context.env)
  const secret = context.env?.STRIPE_SECRET_KEY?.trim() || ''
  const priceId = configuredPrice(context.env)

  if (!config.paywallEnabled) {
    return json(200, { ok: true, paywallEnabled: false })
  }

  if (method === 'GET') {
    return json(200, {
      ok: true,
      paywallEnabled: true,
      checkoutConfigured: Boolean(secret && priceId),
    })
  }

  if (!secret || !priceId) {
    return json(503, {
      ok: false,
      paywallEnabled: true,
      error: 'Checkout is not configured. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID.',
    })
  }

  const sb = sbConfig(context.env)
  if (!sb) return json(503, { ok: false, error: SERVER_AUTH_NOT_CONFIGURED })

  const accessToken = bearer(context.request)
  if (!accessToken) return json(401, { ok: false, error: 'Sign in to upgrade.' })

  const authed = await userFromToken(sb, accessToken, 'Sign in to upgrade.')
  if (!authed.ok) {
    return json(authed.status, { ok: false, error: scrubSecret(authed.error, secret).slice(0, 240) })
  }

  await ensureProfile(sb, authed.user.id).catch(() => {})
  const profile = await readBillingProfile(sb, authed.user.id)
  if (profile.plan === 'paid') {
    return json(200, { ok: true, paywallEnabled: true, plan: 'paid', alreadyPaid: true })
  }

  const origin = new URL(context.request.url).origin
  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('success_url', `${origin}/?checkout=success`)
  params.set('cancel_url', `${origin}/?checkout=cancel`)
  params.set('client_reference_id', authed.user.id)
  params.set('metadata[user_id]', authed.user.id)
  params.set('subscription_data[metadata][user_id]', authed.user.id)
  if (profile.stripeCustomerId) params.set('customer', profile.stripeCustomerId)
  else if (isEmail(authed.user.email)) params.set('customer_email', authed.user.email)

  let stripeRes: Response
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return json(502, { ok: false, error: 'Could not reach Stripe.' })
  }

  if (!stripeRes.ok) {
    let detail = 'Stripe could not start checkout.'
    try {
      const errBody = (await stripeRes.json()) as { error?: { message?: string } }
      const message = errBody?.error?.message
      if (typeof message === 'string' && message.trim()) detail = scrubSecret(message, secret).slice(0, 180)
    } catch {
      detail = 'Stripe could not start checkout.'
    }
    if (!detail || detail.includes(secret)) detail = 'Stripe could not start checkout.'
    return json(502, { ok: false, error: detail })
  }

  let payload: unknown
  try {
    payload = await stripeRes.json()
  } catch {
    return json(502, { ok: false, error: 'Stripe could not start checkout.' })
  }
  const url = stripeCheckoutUrl(payload && typeof payload === 'object' ? (payload as { url?: unknown }).url : null)
  if (!url) return json(502, { ok: false, error: 'Stripe could not start checkout.' })

  const text = JSON.stringify({ ok: true, paywallEnabled: true, url })
  if (text.includes(secret) || text.includes(priceId)) {
    return json(500, { ok: false, error: 'Checkout failed.' })
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

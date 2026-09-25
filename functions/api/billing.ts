/**
 * (9) stub. paywallEnabled defaults off, and this route never calls Stripe.
 * STRIPE_SECRET_KEY stays server-only and is not read into a Checkout session here.
 */

import { productConfigFromEnv } from '../../src/config/productConfig.ts'
import { json, scrubSecret } from './http.ts'

export async function onRequest(context: {
  request: Request
  env?: Record<string, string | undefined>
}): Promise<Response> {
  if (context.request.method !== 'GET' && context.request.method !== 'POST') {
    return json(405, { error: 'Use GET or POST' })
  }
  const config = productConfigFromEnv(context.env)
  const secret = context.env?.STRIPE_SECRET_KEY?.trim() || ''
  if (!config.paywallEnabled) {
    const body = JSON.stringify({ ok: true, paywallEnabled: false })
    if (secret && body.includes(secret)) return json(200, { ok: true, paywallEnabled: false })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const message = scrubSecret('Stripe checkout is not available yet.', secret)
  return json(501, { ok: false, paywallEnabled: true, error: message })
}

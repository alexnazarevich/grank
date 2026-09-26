/**
 * POST /api/stripe-webhook
 * Verifies Stripe-Signature, then sets profiles.plan to paid (or back to free).
 * One tier. STRIPE_WEBHOOK_SECRET stays on the server.
 */

import { json, scrubSecret } from './http.ts'
import { verifyStripeSignature } from './stripeSignature.ts'
import {
  sbConfig,
  sbFetch,
  SERVER_AUTH_NOT_CONFIGURED,
  serviceHeaders,
  UUID_RE,
  type ServiceDb,
} from './supabaseAuth.ts'

const CUSTOMER_RE = /^cus_[A-Za-z0-9]+$/

type StripeObject = Record<string, unknown>

function asObject(value: unknown): StripeObject | null {
  return value && typeof value === 'object' ? (value as StripeObject) : null
}

function metadataUserId(obj: StripeObject): string | null {
  const meta = asObject(obj.metadata)
  const raw = meta && typeof meta.user_id === 'string' ? meta.user_id : ''
  return UUID_RE.test(raw) ? raw.toLowerCase() : null
}

function customerId(obj: StripeObject): string | null {
  const customer = obj.customer
  if (typeof customer === 'string' && CUSTOMER_RE.test(customer)) return customer
  const nested = asObject(customer)
  const id = nested && typeof nested.id === 'string' ? nested.id : ''
  return CUSTOMER_RE.test(id) ? id : null
}

function checkoutUserId(obj: StripeObject): string | null {
  const ref = typeof obj.client_reference_id === 'string' ? obj.client_reference_id : ''
  if (UUID_RE.test(ref)) return ref.toLowerCase()
  return metadataUserId(obj)
}

async function markPaid(sb: ServiceDb, userId: string, customer: string | null): Promise<boolean> {
  const body: Record<string, string> = { user_id: userId, plan: 'paid' }
  if (customer) body.stripe_customer_id = customer
  try {
    const res = await sbFetch(sb, '/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'resolution=merge-duplicates,return=minimal'),
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

async function userIdForCustomer(sb: ServiceDb, customer: string): Promise<string | null> {
  try {
    const res = await sbFetch(
      sb,
      `/rest/v1/profiles?stripe_customer_id=eq.${customer}&select=user_id&limit=1`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as { user_id?: string }[]
    const id = Array.isArray(rows) && typeof rows[0]?.user_id === 'string' ? rows[0].user_id : ''
    return UUID_RE.test(id) ? id.toLowerCase() : null
  } catch {
    return null
  }
}

async function markFree(sb: ServiceDb, userId: string): Promise<boolean> {
  try {
    const res = await sbFetch(sb, `/rest/v1/profiles?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      body: JSON.stringify({ plan: 'free' }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function resolveUser(sb: ServiceDb, obj: StripeObject): Promise<string | null> {
  const direct = metadataUserId(obj) || checkoutUserId(obj)
  if (direct) return direct
  const customer = customerId(obj)
  if (!customer) return null
  return userIdForCustomer(sb, customer)
}

export async function onRequest(context: {
  request: Request
  env?: Record<string, string | undefined>
}): Promise<Response> {
  if (context.request.method !== 'POST') return json(405, { error: 'Use POST' })

  const secret = context.env?.STRIPE_WEBHOOK_SECRET?.trim() || ''
  if (!secret) {
    return json(503, { error: 'Stripe webhook is not configured. Add STRIPE_WEBHOOK_SECRET.' })
  }

  const payload = await context.request.text()
  const header = context.request.headers.get('stripe-signature')
  const valid = await verifyStripeSignature(payload, header, secret)
  if (!valid) return json(400, { error: 'Invalid Stripe signature.' })

  let event: StripeObject
  try {
    const parsed = JSON.parse(payload) as unknown
    const rec = asObject(parsed)
    if (!rec || typeof rec.type !== 'string') return json(400, { error: 'Invalid Stripe event.' })
    event = rec
  } catch {
    return json(400, { error: 'Invalid Stripe event.' })
  }

  const type = event.type as string
  const data = asObject(event.data)
  const obj = data ? asObject(data.object) : null
  if (!obj) return json(200, { ok: true, received: true })

  const checkoutPaid =
    type === 'checkout.session.completed' &&
    obj.status === 'complete' &&
    (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required')
  const grantsPaid =
    checkoutPaid ||
    type === 'checkout.session.async_payment_succeeded' ||
    (type === 'customer.subscription.updated' && (obj.status === 'active' || obj.status === 'trialing'))

  const revokesPaid =
    type === 'customer.subscription.deleted' ||
    (type === 'customer.subscription.updated' &&
      (obj.status === 'canceled' || obj.status === 'unpaid' || obj.status === 'incomplete_expired'))

  if (!grantsPaid && !revokesPaid) return json(200, { ok: true, received: true })

  const sb = sbConfig(context.env)
  if (!sb) return json(503, { error: SERVER_AUTH_NOT_CONFIGURED })

  const userId = grantsPaid ? checkoutUserId(obj) || (await resolveUser(sb, obj)) : await resolveUser(sb, obj)
  if (!userId) return json(200, { ok: true, received: true, ignored: true })

  const customer = customerId(obj)
  const saved = grantsPaid ? await markPaid(sb, userId, customer) : await markFree(sb, userId)
  if (!saved) {
    const message = scrubSecret('Could not update the plan.', secret)
    return json(500, { error: message })
  }
  return json(200, { ok: true, received: true })
}

/**
 * Service-role Supabase access for Pages Functions.
 * The browser sends the user access token only. The service role never leaves the server.
 */

import type { ProductConfig } from '../../src/config/productConfig.ts'

export const SERVER_AUTH_NOT_CONFIGURED =
  'Auth not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ServiceDb = { url: string; serviceRole: string }

export type AuthUser = { id: string; email: string | null }

export type BillingProfile = {
  plan: 'free' | 'paid'
  stripeCustomerId: string | null
}

export function sbConfig(env: Record<string, string | undefined> | undefined): ServiceDb | null {
  const url = env?.SUPABASE_URL?.trim().replace(/\/$/, '') || ''
  const serviceRole = env?.SUPABASE_SERVICE_ROLE_KEY?.trim() || ''
  if (!url || !serviceRole) return null
  if (!/^https:\/\//i.test(url)) return null
  return { url, serviceRole }
}

export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(\S+)/i.exec(header.trim())
  return match?.[1] ?? null
}

export function serviceHeaders(serviceRole: string, prefer?: string): Headers {
  const headers = new Headers({
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
  })
  if (prefer) headers.set('prefer', prefer)
  return headers
}

export async function sbFetch(sb: ServiceDb, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${sb.url}${path}`, init)
}

export async function userFromToken(
  sb: ServiceDb,
  accessToken: string,
  denied = 'Sign in to save this check.',
): Promise<{ ok: true; user: AuthUser } | { ok: false; status: number; error: string }> {
  if (accessToken === sb.serviceRole) {
    return { ok: false, status: 401, error: denied }
  }
  let res: Response
  try {
    res = await sbFetch(sb, '/auth/v1/user', {
      headers: { apikey: sb.serviceRole, authorization: `Bearer ${accessToken}` },
    })
  } catch {
    return { ok: false, status: 502, error: 'Could not reach auth.' }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 401, error: denied }
  }
  if (!res.ok) return { ok: false, status: 502, error: 'Could not verify the session.' }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { ok: false, status: 502, error: 'Could not verify the session.' }
  }
  const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const id = rec && typeof rec.id === 'string' ? rec.id : ''
  if (!UUID_RE.test(id)) return { ok: false, status: 401, error: denied }
  const email = rec && typeof rec.email === 'string' ? rec.email : null
  return { ok: true, user: { id, email } }
}

export async function ensureProfile(sb: ServiceDb, userId: string): Promise<void> {
  await sbFetch(sb, '/rest/v1/profiles?on_conflict=user_id', {
    method: 'POST',
    headers: serviceHeaders(sb.serviceRole, 'resolution=ignore-duplicates,return=minimal'),
    body: JSON.stringify({ user_id: userId, plan: 'free' }),
  })
}

export async function readBillingProfile(sb: ServiceDb, userId: string): Promise<BillingProfile> {
  try {
    const res = await sbFetch(
      sb,
      `/rest/v1/profiles?user_id=eq.${userId}&select=plan,stripe_customer_id&limit=1`,
      { headers: serviceHeaders(sb.serviceRole) },
    )
    if (!res.ok) return { plan: 'free', stripeCustomerId: null }
    const rows = (await res.json()) as { plan?: string; stripe_customer_id?: string | null }[]
    const row = Array.isArray(rows) ? rows[0] : undefined
    const plan = row?.plan === 'paid' ? 'paid' : 'free'
    const raw = row && typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : ''
    const stripeCustomerId = /^cus_[A-Za-z0-9]+$/.test(raw) ? raw : null
    return { plan, stripeCustomerId }
  } catch {
    return { plan: 'free', stripeCustomerId: null }
  }
}

export async function readPlan(sb: ServiceDb, userId: string, config: ProductConfig): Promise<string> {
  if (!config.paywallEnabled) return 'free'
  const profile = await readBillingProfile(sb, userId)
  return profile.plan
}

/**
 * Free / paid quota. Runs before any OpenAI call when paywallEnabled is on.
 * paywallEnabled false is the kill switch: no count, no block.
 * Metered kinds come from freeQuotaUnit (checks, saves, or both).
 */

import {
  quotaAmountForPlan,
  type FreeQuotaUnit,
  type FreeQuotaWindow,
  type ProductConfig,
} from '../../src/config/productConfig.ts'
import { json, scrubSecret } from './http.ts'
import {
  bearer,
  ensureProfile,
  readPlan,
  sbConfig,
  sbFetch,
  serviceHeaders,
  userFromToken,
  UUID_RE,
  type ServiceDb,
} from './supabaseAuth.ts'

export const QUOTA_EXCEEDED_CODE = 'quota_exceeded'
export const QUOTA_EXCEEDED_MESSAGE = 'Check limit reached.'
export const QUOTA_NOT_CONFIGURED =
  'Quota is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'

const ANON_HEADER = 'x-grank-anon'
/** Ordered id scan stays exact through the paid default and a bit past it. */
const MAX_RANK_SCAN = 2000

export type UsageKind = 'check' | 'save'

export function anonKeyFromRequest(request: Request): string | null {
  const raw = request.headers.get(ANON_HEADER)?.trim().toLowerCase() || ''
  return UUID_RE.test(raw) ? raw : null
}

export function quotaKinds(unit: FreeQuotaUnit): UsageKind[] {
  if (unit === 'saves') return ['save']
  if (unit === 'both') return ['check', 'save']
  return ['check']
}

/** Start of the UTC day or month. Lifetime counts every row. */
export function quotaWindowStart(window: FreeQuotaWindow, now: Date): string | null {
  if (window === 'lifetime') return null
  if (window === 'day') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * 1-based position of this usage row among the oldest rows in the window.
 * A full page that does not include the id is past the scan, so the rank is over the cap.
 * Null means the id should have been visible and was not — fail closed.
 */
export function rankInWindow(rows: { id?: string }[], selfId: string, limit: number): number | null {
  const idx = rows.findIndex((row) => row.id === selfId)
  if (idx !== -1) return idx + 1
  if (rows.length >= limit) return limit + 1
  return null
}

function quotePostgrest(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

function usageFilter(opts: {
  userId: string | null
  anonKey: string | null
  kinds: UsageKind[]
  since: string | null
  limit: number
}): string {
  const parts = ['select=id', 'order=created_at.asc,id.asc', `limit=${opts.limit}`]
  if (opts.userId) parts.push(`user_id=eq.${opts.userId}`)
  else if (opts.anonKey) parts.push(`anon_key=eq.${opts.anonKey}`)
  parts.push(opts.kinds.length === 1 ? `kind=eq.${opts.kinds[0]}` : `kind=in.(${opts.kinds.join(',')})`)
  if (opts.since) parts.push(`created_at=gte.${encodeURIComponent(quotePostgrest(opts.since))}`)
  return `/rest/v1/usage_events?${parts.join('&')}`
}

async function listUsageIds(
  sb: ServiceDb,
  opts: {
    userId: string | null
    anonKey: string | null
    kinds: UsageKind[]
    since: string | null
    limit: number
  },
): Promise<{ id: string }[] | null> {
  try {
    const res = await sbFetch(sb, usageFilter(opts), { headers: serviceHeaders(sb.serviceRole) })
    if (!res.ok) return null
    const rows = (await res.json()) as { id?: string }[]
    if (!Array.isArray(rows)) return null
    return rows.filter((row): row is { id: string } => typeof row.id === 'string')
  } catch {
    return null
  }
}

async function countUsage(
  sb: ServiceDb,
  opts: { userId: string | null; anonKey: string | null; kinds: UsageKind[]; since: string | null },
): Promise<number | null> {
  try {
    const res = await sbFetch(sb, usageFilter({ ...opts, limit: 1 }), {
      headers: serviceHeaders(sb.serviceRole, 'count=exact'),
    })
    if (!res.ok) return null
    const header = res.headers.get('content-range')
    const match = header ? /\/(\d+)\s*$/.exec(header) : null
    if (!match) return null
    return Number(match[1])
  } catch {
    return null
  }
}

type UsageRow = { id: string; created_at?: string }

async function insertUsage(
  sb: ServiceDb,
  input: { userId: string | null; anonKey: string | null; kind: UsageKind },
): Promise<UsageRow | null> {
  const body: Record<string, string> = { kind: input.kind }
  if (input.userId) body.user_id = input.userId
  if (input.anonKey) body.anon_key = input.anonKey
  try {
    const res = await sbFetch(sb, '/rest/v1/usage_events', {
      method: 'POST',
      headers: serviceHeaders(sb.serviceRole, 'return=representation'),
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    const created = (await res.json()) as UsageRow | UsageRow[]
    const row = Array.isArray(created) ? created[0] : created
    if (!row || typeof row.id !== 'string' || !UUID_RE.test(row.id)) return null
    return row
  } catch {
    return null
  }
}

async function deleteUsage(sb: ServiceDb, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false
  try {
    const res = await sbFetch(sb, `/rest/v1/usage_events?id=eq.${id}`, {
      method: 'DELETE',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function linkAnonUsage(sb: ServiceDb, anonKey: string, userId: string): Promise<boolean> {
  if (!UUID_RE.test(anonKey) || !UUID_RE.test(userId)) return false
  try {
    const res = await sbFetch(sb, `/rest/v1/usage_events?anon_key=eq.${anonKey}&user_id=is.null`, {
      method: 'PATCH',
      headers: serviceHeaders(sb.serviceRole, 'return=minimal'),
      body: JSON.stringify({ user_id: userId }),
    })
    return res.ok
  } catch {
    return false
  }
}

function quotaBody(config: ProductConfig, plan: string, used: number): Record<string, unknown> {
  return {
    ok: false,
    code: QUOTA_EXCEEDED_CODE,
    error: QUOTA_EXCEEDED_MESSAGE,
    plan: plan === 'paid' ? 'paid' : 'free',
    quota: {
      unit: config.freeQuotaUnit,
      amount: quotaAmountForPlan(config, plan),
      window: config.freeQuotaWindow,
      used,
    },
  }
}

export type Admitted = {
  ok: true
  recorded: boolean
  release: () => Promise<void>
}

export type Rejected = { ok: false; response: Response }

const noopRelease = async () => {}

/**
 * Reserve one metered event, then keep it only if its rank is within the plan amount.
 * Actions outside the unit (a save while metering checks) do not consume quota.
 * A check while metering saves is blocked once those saves are used up, and is not recorded.
 */
export async function admitUsage(opts: {
  sb: ServiceDb
  userId: string | null
  anonKey: string | null
  plan: string
  config: ProductConfig
  kind: UsageKind
  now?: Date
}): Promise<Admitted | Rejected> {
  if (!opts.config.paywallEnabled) return { ok: true, recorded: false, release: noopRelease }

  const kinds = quotaKinds(opts.config.freeQuotaUnit)
  const amount = quotaAmountForPlan(opts.config, opts.plan)
  const since = quotaWindowStart(opts.config.freeQuotaWindow, opts.now ?? new Date())
  const identity = { userId: opts.userId, anonKey: opts.anonKey }

  if (!kinds.includes(opts.kind)) {
    if (opts.kind !== 'check') return { ok: true, recorded: false, release: noopRelease }
    const used = await countUsage(opts.sb, { ...identity, kinds, since })
    if (used === null) return { ok: false, response: json(503, { error: 'Could not check the free limit.' }) }
    if (used >= amount) return { ok: false, response: json(402, quotaBody(opts.config, opts.plan, used)) }
    return { ok: true, recorded: false, release: noopRelease }
  }

  const row = await insertUsage(opts.sb, {
    userId: opts.userId,
    anonKey: opts.anonKey,
    kind: opts.kind,
  })
  if (!row) return { ok: false, response: json(503, { error: 'Could not check the free limit.' }) }

  const release = async () => {
    await deleteUsage(opts.sb, row.id)
  }

  const limit = Math.min(Math.max(amount, 0) + 1, MAX_RANK_SCAN + 1)
  let rank: number | null
  if (amount > MAX_RANK_SCAN) {
    const used = await countUsage(opts.sb, { ...identity, kinds, since })
    rank = used
  } else {
    const rows = await listUsageIds(opts.sb, { ...identity, kinds, since, limit })
    rank = rows ? rankInWindow(rows, row.id, limit) : null
  }
  if (rank === null) {
    await release()
    return { ok: false, response: json(503, { error: 'Could not check the free limit.' }) }
  }
  if (rank > amount) {
    const removed = await deleteUsage(opts.sb, row.id)
    if (!removed) return { ok: false, response: json(503, { error: 'Could not check the free limit.' }) }
    return { ok: false, response: json(402, quotaBody(opts.config, opts.plan, amount)) }
  }
  return { ok: true, recorded: true, release }
}

export type ModelGate = { ok: true; release: () => Promise<void> } | Rejected

/**
 * Identity is the signed-in user, or the browser anon id for a guest.
 * Missing both refuses the model call so omitting the header is not a bypass.
 * Supabase must be configured while the paywall is on; otherwise fail closed.
 */
export async function gateModelCall(opts: {
  request: Request
  env: Record<string, string | undefined> | undefined
  config: ProductConfig
  now?: Date
}): Promise<ModelGate> {
  if (!opts.config.paywallEnabled) return { ok: true, release: noopRelease }

  const anon = anonKeyFromRequest(opts.request)
  const token = bearer(opts.request)
  if (!token && !anon) {
    return {
      ok: false,
      response: json(400, {
        ok: false,
        code: 'quota_identity_required',
        error: 'A browser id is required before a check.',
      }),
    }
  }

  const sb = sbConfig(opts.env)
  if (!sb) return { ok: false, response: json(503, { error: QUOTA_NOT_CONFIGURED }) }

  let userId: string | null = null
  if (token) {
    const authed = await userFromToken(sb, token, 'Sign in to run this check.')
    if (!authed.ok) {
      return {
        ok: false,
        response: json(authed.status, { error: scrubSecret(authed.error, sb.serviceRole).slice(0, 240) }),
      }
    }
    userId = authed.user.id
    await ensureProfile(sb, userId).catch(() => {})
    if (anon) {
      const linked = await linkAnonUsage(sb, anon, userId)
      if (!linked) return { ok: false, response: json(503, { error: 'Could not check the free limit.' }) }
    }
  }

  const plan = userId ? await readPlan(sb, userId, opts.config) : 'free'
  const admitted = await admitUsage({
    sb,
    userId,
    anonKey: anon,
    plan,
    config: opts.config,
    kind: 'check',
    now: opts.now,
  })
  if (!admitted.ok) return admitted
  return { ok: true, release: admitted.release }
}

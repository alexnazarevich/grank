import type { CheckDraft } from './savedResult.ts'

const SESSION_KEY = 'grank.auth.session'
const PENDING_KEY = 'grank.pendingSave'
const GUEST_KEY = 'grank.guestChecks'
const VERIFIER_KEY = 'grank.pkce.verifier'

export const AUTH_NOT_CONFIGURED =
  'Auth not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'

export type AuthUser = {
  id: string
  email: string | null
}

export type AuthSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: AuthUser
}

type TokenPayload = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  expires_at?: unknown
  user?: { id?: unknown; email?: unknown }
}

function viteValue(name: string): string {
  const env = import.meta.env as Record<string, string | undefined> | undefined
  if (!env) return ''
  const value = env[name]
  return typeof value === 'string' ? value.trim() : ''
}

export function supabasePublicConfig(): { url: string; anonKey: string } | null {
  const url = viteValue('VITE_SUPABASE_URL').replace(/\/$/, '')
  const anonKey = viteValue('VITE_SUPABASE_ANON_KEY')
  if (!url || !anonKey) return null
  if (!/^https:\/\//i.test(url)) return null
  return { url, anonKey }
}

function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
    const data = JSON.parse(json) as { sub?: unknown; email?: unknown; exp?: unknown }
    return {
      sub: typeof data.sub === 'string' ? data.sub : undefined,
      email: typeof data.email === 'string' ? data.email : undefined,
      exp: typeof data.exp === 'number' ? data.exp : undefined,
    }
  } catch {
    return null
  }
}

export function sessionFromTokenResponse(data: unknown, now = Date.now()): AuthSession | null {
  if (!data || typeof data !== 'object') return null
  const rec = data as TokenPayload
  const accessToken = typeof rec.access_token === 'string' ? rec.access_token : ''
  const refreshToken = typeof rec.refresh_token === 'string' ? rec.refresh_token : ''
  if (!accessToken || !refreshToken) return null
  const claims = decodeJwt(accessToken)
  const userId =
    (rec.user && typeof rec.user.id === 'string' && rec.user.id) || claims?.sub || ''
  if (!userId) return null
  const email =
    (rec.user && typeof rec.user.email === 'string' && rec.user.email) || claims?.email || null
  let expiresAt = now + 3600_000
  if (typeof rec.expires_at === 'number' && Number.isFinite(rec.expires_at)) {
    expiresAt = rec.expires_at > 10_000_000_000 ? rec.expires_at : rec.expires_at * 1000
  } else if (typeof rec.expires_in === 'number' && Number.isFinite(rec.expires_in)) {
    expiresAt = now + rec.expires_in * 1000
  } else if (claims?.exp) {
    expiresAt = claims.exp * 1000
  }
  return { accessToken, refreshToken, expiresAt, user: { id: userId, email } }
}

/** Implicit magic-link redirect: `#access_token=…&refresh_token=…`. */
export function sessionFromMagicLinkHash(hash: string, now = Date.now()): AuthSession | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const type = params.get('type')
  if (type && type !== 'magiclink' && type !== 'signup' && type !== 'email') return null
  if (!params.get('access_token')) return null
  return sessionFromTokenResponse(
    {
      access_token: params.get('access_token'),
      refresh_token: params.get('refresh_token'),
      expires_in: Number(params.get('expires_in') || 3600),
    },
    now,
  )
}

export function isValidEmail(value: string): boolean {
  const email = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320
}

function base64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

/** S256 challenge for Supabase magic-link PKCE. */
export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export function readStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session = sessionFromTokenResponse(JSON.parse(raw) as unknown)
    return session
  } catch {
    return null
  }
}

export function storeSession(session: AuthSession): void {
  try {
    const claims = decodeJwt(session.accessToken)
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_at: Math.floor(session.expiresAt / 1000),
        user: { id: session.user.id, email: session.user.email ?? claims?.email ?? null },
      }),
    )
  } catch {
    // Ignore storage failures. The in-memory session still works for this view.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // Ignore storage failures.
  }
}

async function refreshSession(session: AuthSession): Promise<AuthSession | null> {
  const cfg = supabasePublicConfig()
  if (!cfg) return null
  let res: Response
  try {
    res = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        authorization: `Bearer ${cfg.anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    })
  } catch {
    return session.expiresAt > Date.now() ? session : null
  }
  if (!res.ok) {
    clearSession()
    return null
  }
  let next: AuthSession | null = null
  try {
    next = sessionFromTokenResponse(await res.json())
  } catch {
    next = null
  }
  if (!next) {
    clearSession()
    return null
  }
  storeSession(next)
  return next
}

function rememberReturn(session: AuthSession): void {
  storeSession(session)
  const url = new URL(window.location.href)
  url.searchParams.delete('code')
  url.hash = ''
  window.history.replaceState({}, '', url.pathname + url.search)
}

async function exchangeAuthCode(code: string): Promise<AuthSession | null> {
  const cfg = supabasePublicConfig()
  if (!cfg) return null
  let verifier = ''
  try {
    verifier = localStorage.getItem(VERIFIER_KEY) || ''
    localStorage.removeItem(VERIFIER_KEY)
  } catch {
    verifier = ''
  }
  if (!verifier) return null
  let res: Response
  try {
    res = await fetch(`${cfg.url}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        authorization: `Bearer ${cfg.anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return sessionFromTokenResponse(await res.json())
  } catch {
    return null
  }
}

export async function currentSession(): Promise<AuthSession | null> {
  if (typeof window === 'undefined') return null
  const code = new URLSearchParams(window.location.search).get('code')
  if (code) {
    const exchanged = await exchangeAuthCode(code)
    if (exchanged) {
      rememberReturn(exchanged)
      return exchanged
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('code')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  }
  const fromHash = sessionFromMagicLinkHash(window.location.hash)
  if (fromHash) {
    rememberReturn(fromHash)
    return fromHash
  }
  const stored = readStoredSession()
  if (!stored) return null
  if (stored.expiresAt > Date.now() + 60_000) return stored
  return refreshSession(stored)
}

export async function sendMagicLink(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = supabasePublicConfig()
  if (!cfg) return { ok: false, error: AUTH_NOT_CONFIGURED }
  const redirectTo = `${window.location.origin}${window.location.pathname}`
  const payload: { email: string; create_user: boolean; code_challenge?: string; code_challenge_method?: string } = {
    email: email.trim(),
    create_user: true,
  }
  try {
    const verifier = createCodeVerifier()
    localStorage.setItem(VERIFIER_KEY, verifier)
    payload.code_challenge = await codeChallengeFor(verifier)
    payload.code_challenge_method = 's256'
  } catch {
    // Fall back to the hash redirect when WebCrypto or storage is unavailable.
  }
  let res: Response
  try {
    res = await fetch(`${cfg.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        authorization: `Bearer ${cfg.anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: 'Could not reach sign-in. Try again.' }
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { msg?: string; error_description?: string; message?: string }
      detail = body.msg || body.error_description || body.message || detail
    } catch {
      // Keep the status.
    }
    return { ok: false, error: `Could not send the sign-in link (${detail.slice(0, 180)}).` }
  }
  return { ok: true }
}

export async function signOut(session: AuthSession | null): Promise<void> {
  const cfg = supabasePublicConfig()
  if (cfg && session) {
    await fetch(`${cfg.url}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
      },
    }).catch(() => {})
  }
  clearSession()
}

export type AuthBoot = {
  session: AuthSession | null
  pending: CheckDraft | null
}

let bootPromise: Promise<AuthBoot> | null = null

function peekPendingRaw(): string | null {
  try {
    return localStorage.getItem(PENDING_KEY)
  } catch {
    return null
  }
}

/**
 * Restore the session once per page load. A pending check is consumed only when
 * it was already stored before boot (magic-link return), so a save started
 * while session restore is in flight is left for the next visit.
 */
export function bootAuth(): Promise<AuthBoot> {
  if (!bootPromise) {
    const pendingAtStart = peekPendingRaw()
    bootPromise = (async () => {
      const session = await currentSession()
      if (!session || !pendingAtStart || peekPendingRaw() !== pendingAtStart) {
        return { session, pending: null }
      }
      return { session, pending: takePendingSave() }
    })()
  }
  return bootPromise
}

export function stashPendingSave(draft: CheckDraft): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(draft))
  } catch {
    // The check still shows on this page. Saving needs storage for the email round trip.
  }
}

let pendingLock = false

/** Take the check waiting on a magic link. One take per page load (Strict Mode safe). */
export function takePendingSave(): CheckDraft | null {
  if (pendingLock) return null
  pendingLock = true
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    localStorage.removeItem(PENDING_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as CheckDraft
    if (!data || typeof data.domain !== 'string' || !data.domain) return null
    return data
  } catch {
    return null
  }
}

export function readGuestChecks(): number {
  try {
    const n = Number(sessionStorage.getItem(GUEST_KEY) || 0)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

export function bumpGuestChecks(): number {
  const next = readGuestChecks() + 1
  try {
    sessionStorage.setItem(GUEST_KEY, String(next))
  } catch {
    // Private mode can block storage. The nudge is optional.
  }
  return next
}

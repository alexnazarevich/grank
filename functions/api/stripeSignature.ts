/** Stripe webhook signatures (HMAC-SHA256 over `t.payload`). No Stripe SDK. */

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Accept any v1 signature in the header (Stripe may send two during a secret roll).
 * Reject timestamps outside five minutes.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret || !payload) return false
  let timestamp = ''
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = value
    if (key === 'v1' && value) signatures.push(value)
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  )
  const expected = toHex(mac)
  return signatures.some((sig) => hexEqual(sig.toLowerCase(), expected))
}

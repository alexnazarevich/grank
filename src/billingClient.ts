/** Browser helper for the one paid Checkout Session. The secret stays on the server. */

export function stripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') return null
    return url.toString()
  } catch {
    return null
  }
}

function publicNote(value: string): string {
  return value
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: true; alreadyPaid: true }
  | { ok: false; error: string }

export async function startCheckout(accessToken: string): Promise<CheckoutResult> {
  let res: Response
  try {
    res = await fetch('/api/billing', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    })
  } catch {
    return { ok: false, error: 'Checkout is not available.' }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { ok: false, error: 'Checkout is not available.' }
  }
  const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  if (rec?.alreadyPaid === true) return { ok: true, alreadyPaid: true }
  const url = stripeCheckoutUrl(rec?.url)
  if (url) return { ok: true, url }
  const error = rec && typeof rec.error === 'string' ? publicNote(rec.error) : ''
  return { ok: false, error: error || 'Checkout is not available.' }
}

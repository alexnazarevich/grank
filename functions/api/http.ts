export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function scrubSecret(value: string, secret: string): string {
  let out = value
  if (secret) out = out.split(secret).join('[redacted]')
  out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
  out = out.replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
  out = out.replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted]')
  return out.replace(/\s+/g, ' ').trim()
}

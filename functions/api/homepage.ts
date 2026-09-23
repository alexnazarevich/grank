/**
 * Cloudflare Pages Function: GET /api/homepage?domain=linear.app
 * Same-origin homepage text for the answered-by-you signal. Not an LLM call.
 */

/** Plain text returned to the client. */
const MAX_TEXT = 80_000
/**
 * Raw HTML read cap. Marketing homepages often put copy after a few hundred KB
 * of `<head>`; the response is still trimmed to MAX_TEXT.
 */
const MAX_DOWNLOAD = 1_000_000
const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = 'GrankBot/0.1 (+https://grank.pages.dev)'

const HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Hostname only (no scheme, path, port, or IP). Blocks localhost and local/internal names. */
export function canonicalHostname(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const domain = input.trim().toLowerCase()
  if (!domain || domain.length > 253) return null
  if (/[\s/?#@:\\%]/.test(domain)) return null
  if (
    domain === 'localhost' ||
    domain === 'localhost.localdomain' ||
    domain.endsWith('.localhost') ||
    domain.endsWith('.local') ||
    domain.endsWith('.internal')
  ) {
    return null
  }
  if (!HOSTNAME_RE.test(domain)) return null
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain)) return null
  return domain
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function attr(tag: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return match?.[1] ? decodeEntities(match[1]) : ''
}

function findMeta(html: string, key: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const name = (attr(tag, 'name') || attr(tag, 'property')).toLowerCase()
    if (name === key) return attr(tag, 'content').replace(/\s+/g, ' ').trim()
  }
  return ''
}

/** Rough plain text. Title is prefixed as a markdown heading so scoreText can see it. */
export function pageTextFromHtml(html: string): string {
  const capped = html.slice(0, MAX_DOWNLOAD)
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(capped)
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim())
    : ''
  const description = findMeta(capped, 'description')
  const stripped = decodeEntities(
    capped
      .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, ' ')
      .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, ' ')
      .replace(/<noscript\b[\s\S]*?(?:<\/noscript>|$)/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  const head = [
    title ? `# ${title}` : '',
    description ? `description: ${description}` : '',
  ].filter(Boolean)
  const text = head.length ? `${head.join('\n')}\n${stripped}` : stripped
  return text.slice(0, MAX_TEXT)
}

function json(status: number, body: { ok?: boolean; text?: string; error?: string }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let received = 0
  while (received < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    const room = maxBytes - received
    const piece = value.byteLength > room ? value.subarray(0, room) : value
    chunks.push(piece.slice())
    received += piece.byteLength
    if (value.byteLength > room) break
  }
  await reader.cancel().catch(() => {})
  const buf = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

function finalUrlError(url: string): string | null {
  try {
    const finalUrl = new URL(url)
    if (finalUrl.protocol !== 'https:' && finalUrl.protocol !== 'http:') {
      return 'redirected to an unsupported protocol'
    }
    if (!canonicalHostname(finalUrl.hostname)) return 'redirected to a blocked host'
    return null
  } catch {
    return 'bad redirect target'
  }
}

export async function onRequestGet(context: { request: Request }): Promise<Response> {
  const raw = new URL(context.request.url).searchParams.get('domain') ?? ''
  const domain = canonicalHostname(raw)
  if (!domain) {
    return json(400, { error: 'domain must be a simple public hostname' })
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`https://${domain}`, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal,
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    const detail = timedOut ? 'timed out' : err instanceof Error ? err.message : 'network error'
    return json(502, { error: `homepage fetch failed: ${detail}`.slice(0, 300) })
  }

  if (!res.ok) {
    return json(502, { error: `homepage fetch failed: HTTP ${res.status}` })
  }

  const blocked = finalUrlError(res.url || `https://${domain}`)
  if (blocked) return json(502, { error: `homepage fetch failed: ${blocked}` })

  try {
    const html = await readCapped(res, MAX_DOWNLOAD)
    const text = pageTextFromHtml(html)
    return json(200, { ok: true, text })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'could not read body'
    return json(502, { error: `homepage fetch failed: ${detail}`.slice(0, 300) })
  }
}

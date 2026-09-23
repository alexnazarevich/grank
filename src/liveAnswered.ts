import { brandToken, type Answered } from './demoData'

/** Live answered-by-you signal: homepage text only, never an LLM call. */
const JINA_PREFIX = 'https://r.jina.ai/'
const ALLORIGINS_PREFIX = 'https://api.allorigins.win/raw?url='
const FETCH_MS = 15_000

export type LiveAnswered = {
  answered: Answered
  answeredWhy: string
  enginesChecked: string[]
}

/**
 * Fetch the site homepage and score brand/domain mentions in the title and body.
 * Tries Jina reader text first, then AllOrigins raw HTML.
 */
export async function liveAnsweredByYou(
  pageUrl: string,
  domain: string,
  userSignal?: AbortSignal,
): Promise<LiveAnswered> {
  const jinaUrl = `${JINA_PREFIX}${pageUrl}`
  try {
    const raw = await readUrl(jinaUrl, userSignal)
    if (jinaTargetFailed(raw)) throw new Error('jina target error')
    return scoreFetched(raw, 'jina', domain)
  } catch (err) {
    if (userAborted(err, userSignal)) throw err
    const raw = await readUrl(`${ALLORIGINS_PREFIX}${encodeURIComponent(pageUrl)}`, userSignal)
    if (proxyErrorPage(raw)) throw new Error('allorigins error')
    return scoreFetched(raw, 'allorigins', domain)
  }
}

export function parseJinaText(raw: string): { title: string; body: string } {
  const title = collapse(raw.match(/^Title:\s*(.*)$/m)?.[1] ?? '')
  const parts = raw.split(/^Markdown Content:\s*$/m)
  const body = collapse(parts.length > 1 ? parts.slice(1).join('\n') : raw)
  return { title, body }
}

export function parseHtml(html: string): { title: string; body: string } {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove())
    return {
      title: collapse(doc.querySelector('title')?.textContent ?? ''),
      body: collapse(doc.body?.textContent ?? ''),
    }
  }
  const title = collapse(decodeBasic(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''))
  const body = collapse(
    decodeBasic(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
  return { title, body }
}

/** Visible wording only — link destinations and raw URLs are not mentions. */
export function visibleProse(text: string): string {
  return collapse(
    text
      .replace(/!\[([^\]]*)]\([^)]*\)/g, ' $1 ')
      .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/gi, ' '),
  )
}

/**
 * yes: brand or domain is in the title and the body.
 * partial: it shows up in only one of them.
 * no: neither the title nor the body names it.
 */
export function scoreBrandMentions(
  title: string,
  body: string,
  domain: string,
): { answered: Answered; answeredWhy: string } {
  const brand = brandToken(domain)
  const titleText = collapse(title)
  const bodyText = visibleProse(body)
  const titleHits = countBrand(titleText, domain, brand)
  const bodyHits = countBrand(bodyText, domain, brand)
  const titleClip = clip(titleText || 'no title returned', 90)

  if (titleHits > 0 && bodyHits > 0) {
    return {
      answered: 'yes',
      answeredWhy: `Live homepage read: “${brand}” is in the title (“${titleClip}”) and mentioned ${mentionPhrase(bodyHits)} in the body.`,
    }
  }
  if (titleHits > 0) {
    return {
      answered: 'partial',
      answeredWhy: `Live homepage read: “${brand}” is in the title (“${titleClip}”) but not in the body text.`,
    }
  }
  if (bodyHits > 0) {
    return {
      answered: 'partial',
      answeredWhy: `Live homepage read: the body mentions “${brand}” ${mentionPhrase(bodyHits)}, but the title (“${titleClip}”) does not.`,
    }
  }
  return {
    answered: 'no',
    answeredWhy: `Live homepage read: the title (“${titleClip}”) and body don’t mention “${brand}” or ${domain}.`,
  }
}

async function readUrl(url: string, userSignal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_MS)
  const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(url, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'text/plain' },
    })
  } catch (err) {
    if (userAborted(err, userSignal)) throw err
    throw new Error('fetch failed')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim()) throw new Error('empty')
  return text
}

function scoreFetched(raw: string, via: 'jina' | 'allorigins', domain: string): LiveAnswered {
  const parsed =
    via === 'jina' && !/^\s*</.test(raw) ? parseJinaText(raw) : parseHtml(raw)
  if (!parsed.title && !parsed.body) throw new Error('empty extract')
  const scored = scoreBrandMentions(parsed.title, parsed.body, domain)
  const enginesChecked = [
    via === 'jina'
      ? 'Not ChatGPT or Perplexity — homepage text via Jina reader'
      : 'Not ChatGPT or Perplexity — homepage HTML via AllOrigins (Jina reader failed)',
  ]
  return { ...scored, enginesChecked }
}

function jinaTargetFailed(raw: string): boolean {
  return /Warning:\s*Target URL returned error \d+/i.test(raw)
}

function proxyErrorPage(raw: string): boolean {
  return /error code:\s*5\d\d/i.test(raw) || /<title>\s*5\d\d[^<]*<\/title>/i.test(raw)
}

function countBrand(text: string, domain: string, brand: string): number {
  const needles = [domain, brand.length >= 2 ? brand : '']
    .map((n) => n.trim().toLowerCase())
    .filter((n, i, all) => n.length > 0 && all.indexOf(n) === i)
    .sort((a, b) => b.length - a.length)
  if (!needles.length || !text) return 0
  const re = new RegExp(`(?:^|[^a-z0-9])(?:${needles.map(escapeRegExp).join('|')})(?=$|[^a-z0-9])`, 'gi')
  return text.match(re)?.length ?? 0
}

function mentionPhrase(count: number): string {
  return count === 1 ? '1 time' : `${count} times`
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1).trimEnd()}…`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeBasic(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function userAborted(err: unknown, userSignal?: AbortSignal): boolean {
  if (!userSignal?.aborted) return false
  return err instanceof Error && err.name === 'AbortError'
}

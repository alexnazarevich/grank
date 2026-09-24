/** Supporting signal only: live homepage fetch. Primary answered-by-you is /api/visibility. */

import type { Answered } from './demoData'

export type LiveAnswered = {
  answered: Answered
  answeredWhy: string
  sourceLabel: string
  ok: boolean
}

function brandTokens(domain: string): string[] {
  const base = domain.split('.')[0] || domain
  const tokens = new Set<string>([base.toLowerCase(), domain.toLowerCase()])
  // split compound brands lightly: linearapp → linear
  if (base.length > 6) tokens.add(base.slice(0, Math.min(8, base.length)).toLowerCase())
  return [...tokens].filter((t) => t.length >= 2)
}

export function scoreText(text: string, domain: string): { answered: Answered; why: string } {
  const lower = text.toLowerCase()
  const brand = domain.split('.')[0] || domain
  const Brand = brand.charAt(0).toUpperCase() + brand.slice(1)
  const tokens = brandTokens(domain)

  const titleMatch = /(?:^|\n)#\s*([^\n]+)/.exec(text)
  const title = (titleMatch?.[1] || '').toLowerCase()
  const inTitle = tokens.some((t) => title.includes(t))
  const count = tokens.reduce((n, t) => n + (lower.split(t).length - 1), 0)
  const hasDesc =
    /meta(?:name|property)=["']description["']/i.test(text) ||
    /description["']?\s*[:=]/i.test(text) ||
    lower.includes('description')

  if (inTitle && count >= 3) {
    return {
      answered: 'yes',
      why: `Live homepage check: “${Brand}” shows up in the page title and repeatedly in body copy (${count} hits). Strong self-description — models often lean on this. (Not a live LLM query.)`,
    }
  }
  if (inTitle || count >= 2 || (hasDesc && count >= 1)) {
    return {
      answered: 'partial',
      why: `Live homepage check: found “${Brand}” on the page${inTitle ? ' (incl. title)' : ''} (~${count} mentions), but category-style “best of” language is thin. Models may cite you for “what is X” more than comparisons. (Not a live LLM query.)`,
    }
  }
  return {
    answered: 'no',
    why: `Live homepage check: little clear “${Brand}” self-description in title/body after fetch. Cold pages rarely get cited in AI answers. (Not a live LLM query.)`,
  }
}

const PAGE_SOURCE = 'Live homepage fetch (page content) — not ChatGPT/Perplexity'
const FAILED_SOURCE = 'Live homepage fetch failed'

function failed(domain: string, detail: string): LiveAnswered {
  const why = `Couldn’t fetch https://${domain} live (${detail}). Answered-by-you fell back to no — try again or use an example. (Fetch failed; still not an LLM query.)`
  return {
    answered: 'no',
    answeredWhy: why,
    sourceLabel: FAILED_SOURCE,
    ok: false,
  }
}

type HomepagePayload = { ok?: boolean; text?: string; error?: string }

/**
 * Same-origin Pages Function. Returns 'missing' only when `/api/homepage` is not
 * deployed (local `vite` / `vite preview`, which do not run `functions/`).
 */
async function fetchViaPagesFunction(domain: string): Promise<LiveAnswered | 'missing'> {
  let res: Response
  try {
    res = await fetch(`/api/homepage?domain=${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    return 'missing'
  }

  if (res.status === 404) return 'missing'

  const type = res.headers.get('content-type') || ''
  const raw = await res.text()
  const looksLikeHtml = type.includes('text/html') || raw.trimStart().startsWith('<')
  if (res.ok && looksLikeHtml) return 'missing'

  let data: HomepagePayload
  try {
    data = JSON.parse(raw) as HomepagePayload
  } catch {
    if (res.ok) return 'missing'
    return failed(domain, `HTTP ${res.status}`)
  }

  if (!res.ok || data.ok !== true || typeof data.text !== 'string') {
    const detail = (data.error || `HTTP ${res.status}`).slice(0, 180)
    return failed(domain, detail)
  }

  const { answered, why } = scoreText(data.text, domain)
  return {
    answered,
    answeredWhy: why,
    sourceLabel: PAGE_SOURCE,
    ok: true,
  }
}

/** Dev-only fallback when the Pages Function is not running. Jina often 401s. */
async function fetchViaPublicProxies(domain: string): Promise<LiveAnswered> {
  const pageUrl = `https://${domain}`
  try {
    const res = await fetch(`https://r.jina.ai/${pageUrl}`, {
      headers: { Accept: 'text/plain' },
    })
    if (!res.ok) throw new Error(`jina ${res.status}`)
    const text = (await res.text()).slice(0, 80_000)
    if (text.trim().length < 40) throw new Error('empty jina')
    const { answered, why } = scoreText(text, domain)
    return {
      answered,
      answeredWhy: why,
      sourceLabel: 'Live homepage fetch (Jina Reader) — not ChatGPT/Perplexity',
      ok: true,
    }
  } catch {
    try {
      const res = await fetch(
        `https://api.allorigins.win/raw?url=${encodeURIComponent(pageUrl)}`,
      )
      if (!res.ok) throw new Error(`allorigins ${res.status}`)
      const html = (await res.text()).slice(0, 80_000)
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
      const { answered, why } = scoreText(stripped, domain)
      return {
        answered,
        answeredWhy: why,
        sourceLabel: 'Live homepage fetch (HTML proxy) — not ChatGPT/Perplexity',
        ok: true,
      }
    } catch {
      return failed(domain, 'blocked or down')
    }
  }
}

/**
 * Production calls `/api/homepage` (Pages Function). Jina/AllOrigins run only when
 * that route is missing — `npm run dev` and `npm run preview` do not serve it.
 */
export async function liveAnsweredByYou(domain: string): Promise<LiveAnswered> {
  const viaFunction = await fetchViaPagesFunction(domain)
  if (viaFunction !== 'missing') return viaFunction
  return fetchViaPublicProxies(domain)
}

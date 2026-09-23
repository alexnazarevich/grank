/** One real signal: live homepage fetch → answered-by-you. Not a ChatGPT/Perplexity query. */

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

function scoreText(text: string, domain: string): { answered: Answered; why: string } {
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

/** Fetch readable page text via Jina Reader (CORS-friendly). Falls back to allorigins HTML. */
export async function liveAnsweredByYou(domain: string): Promise<LiveAnswered> {
  const pageUrl = `https://${domain}`
  const sourceLabel = 'Live homepage fetch (Jina Reader) — not ChatGPT/Perplexity'

  try {
    const res = await fetch(`https://r.jina.ai/${pageUrl}`, {
      headers: { Accept: 'text/plain' },
    })
    if (!res.ok) throw new Error(`jina ${res.status}`)
    const text = (await res.text()).slice(0, 80_000)
    if (text.trim().length < 40) throw new Error('empty jina')
    const { answered, why } = scoreText(text, domain)
    return { answered, answeredWhy: why, sourceLabel, ok: true }
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
      return {
        answered: 'no',
        answeredWhy: `Couldn’t fetch ${pageUrl} live (blocked or down). Answered-by-you fell back to no — try again or use an example. (Fetch failed; still not an LLM query.)`,
        sourceLabel: 'Live homepage fetch failed',
        ok: false,
      }
    }
  }
}

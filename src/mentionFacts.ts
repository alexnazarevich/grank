/**
 * Per-answer mention facts for land/dig (post-parse) and the full report.
 * whoInstead stays unbranded-only, capped at 3, and never includes this brand.
 */

export const THEME_IDS = ['problems', 'described', 'trust', 'alternatives', 'buying', 'edge'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export type Framing = 'unbranded' | 'branded'

export type Mention = 'mentioned' | 'not_mentioned' | 'unclear'

export type AnswerFact = {
  question: string
  framing: Framing
  /** Stable theme id — not a display title. */
  id: ThemeId
  /** Omitted when the answer failed. Never a invented label. */
  mention?: Mention
  whoInstead: string[]
}

/** Appended to the land, dig, and full-report system prompts. Do not rewrite those prompts around it. */
export const SHARPER_Q_RULES = `Use the homepage excerpt to name the category or job in the question — ban generic “What is {brand}?” / “Tell me about this company.”
Prefer buyer phrasing a real person would type into ChatGPT (short, one intent).
Unbranded: never include the brand, product, or domain in the question text.
Branded: every question must include the brand name; ask how it’s described, claims, fit — not category discovery.
Alternatives theme: only “who else for this job?” — never branded dig questions there.`

/** Unbranded land prompt only. Does not rename the existing question schema. */
export const LAND_MENTION_RULES = `Also return "mentions" aligned 1:1 with questions. Each item is "mentioned", "not_mentioned", or "unclear": whether a typical assistant reply to that question names this brand. Use "unclear" when the mention is weak or only implied.`

/** Branded dig prompt only. Empty replies must not grow a fake mention. */
export const DIG_MENTION_RULES = `Also return "mentions" aligned 1:1 with questions. Each item is "mentioned", "not_mentioned", or "unclear" for that reply. If a reply is empty, return an empty string for that row in mentions. Do not invent a mention for a missing reply.`

/** Full-report system prompt only. Branded visibility must not grow a whoInstead field. */
export const MENTION_FACT_RULES = `Each question object also includes "mention" and "whoInstead".
"mention" is "mentioned", "not_mentioned", or "unclear" from whether that answer names the brand.
"whoInstead" is an array of at most 3 real product or company names, and only on unbranded questions. Branded questions use an empty array. Never invent competitors. If you cannot name a real alternative, use an empty array.
If the answer is an empty string, do not set mention. An empty answer is a failure, not a mention label.`

const WHO_INSTEAD_MAX = 3
const WHO_INSTEAD_NAME_MAX = 80
const ALT_QUESTION = /\b(who else|alternatives?|instead of|other than|competitors?)\b/i
const HEDGE =
  /\b(might|may|unclear|not sure|unsure|possibly|sometimes|hard to say|only implied|implied|partial|could be|not clear|not certain)\b/i

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

export function mentionsBrand(text: string, domain: string): boolean {
  const stem = (domain.split('.')[0] || '').toLowerCase()
  if (stem.length < 3) return false
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text)
}

export function parseMention(value: unknown): Mention | null {
  if (value === 'mentioned' || value === 'not_mentioned' || value === 'unclear') return value
  return null
}

/** Trim, drop blanks and non-names, skip this brand, cap at 3. Missing → []. */
export function parseWhoInstead(value: unknown, domain?: string): string[] {
  if (!Array.isArray(value)) return []
  const blocked = new Set<string>()
  if (domain) {
    const host = domain.toLowerCase()
    const stem = host.split('.')[0] || host
    blocked.add(stem.replace(/[^a-z0-9]+/g, ''))
    blocked.add(host.replace(/[^a-z0-9]+/g, ''))
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.replace(/\s+/g, ' ').trim()
    if (!name || name.length > WHO_INSTEAD_NAME_MAX) continue
    const key = name.toLowerCase()
    const compact = key.replace(/[^a-z0-9]+/g, '')
    if (!compact || blocked.has(compact) || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= WHO_INSTEAD_MAX) break
  }
  return out
}

/** Land unbranded → problems, unless the question is a who-else ask. Dig → described. */
export function landThemeId(question: string, framing: Framing): ThemeId {
  if (framing === 'branded') return 'described'
  if (ALT_QUESTION.test(question)) return 'alternatives'
  return 'problems'
}

/**
 * Mention from answer text. An empty answer returns undefined — no fake label.
 * A model "mentioned" that never names the brand is not treated as a clear win.
 */
export function mentionFromAnswer(answer: string, domain: string, modelMention: unknown): Mention | undefined {
  const text = answer.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const named = mentionsBrand(text, domain)
  const hedge = HEDGE.test(text)
  const model = parseMention(modelMention)
  if (named && hedge) return 'unclear'
  if (named) return 'mentioned'
  if (model === 'unclear' || hedge) return 'unclear'
  if (model === 'mentioned') return 'unclear'
  return 'not_mentioned'
}

function runMention(answered: unknown): Mention | null {
  if (answered === 'yes') return 'mentioned'
  if (answered === 'partial') return 'unclear'
  if (answered === 'no') return 'not_mentioned'
  return null
}

/** Land/dig cards: derive mention after the model JSON is parsed. Branded whoInstead stays empty. */
export function factsFromVisibility(opts: {
  domain: string
  mode: Framing
  questions: string[]
  answers: string[]
  answered: unknown
  whoInstead: unknown
  mentions?: unknown
}): AnswerFact[] {
  const modelMentions = Array.isArray(opts.mentions) ? opts.mentions : []
  const sharedWho = opts.mode === 'unbranded' ? parseWhoInstead(opts.whoInstead, opts.domain) : []
  const fallback = runMention(opts.answered)
  return opts.questions.map((question, index) => {
    const framing = opts.mode
    const id = landThemeId(question, framing)
    if (framing === 'branded') {
      const mention = mentionFromAnswer(opts.answers[index] || '', opts.domain, modelMentions[index])
      const fact: AnswerFact = { question, framing, id, whoInstead: [] }
      if (mention) fact.mention = mention
      return fact
    }
    const mention = parseMention(modelMentions[index]) ?? fallback
    const fact: AnswerFact = { question, framing, id, whoInstead: sharedWho }
    if (mention) fact.mention = mention
    return fact
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Saved land/dig facts. Branded rows drop whoInstead. Invalid rows are skipped. */
export function cleanAnswerFacts(value: unknown, domain: string, mode: Framing): AnswerFact[] {
  if (!Array.isArray(value)) return []
  const out: AnswerFact[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const question = typeof item.question === 'string' ? item.question.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    if (!question) continue
    const id = isThemeId(item.id) ? item.id : landThemeId(question, mode)
    const mention = parseMention(item.mention) ?? undefined
    const fact: AnswerFact = {
      question,
      framing: mode,
      id,
      whoInstead: mode === 'unbranded' ? parseWhoInstead(item.whoInstead, domain) : [],
    }
    if (mention) fact.mention = mention
    out.push(fact)
    if (out.length >= 8) break
  }
  return out
}

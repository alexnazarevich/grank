/**
 * Thin run history for an owned saved check.
 * Each entry is mention + whoInstead only — not a second copy of the report.
 * The newest runs are kept. Delta compares the last two.
 */

import { parseMention, parseWhoInstead, type Mention } from './mentionFacts.ts'

export type RunMode = 'unbranded' | 'branded' | 'full'

export type RunMention = {
  question: string
  mention?: Mention
  whoInstead: string[]
}

export type CheckRun = {
  at: string
  mode: RunMode
  mentions: RunMention[]
}

export type MentionFlip = {
  question: string
  from: Mention
  to: Mention
}

export type RunDelta = {
  /** False until a prior run and a current run both exist. */
  comparable: boolean
  empty: boolean
  flips: MentionFlip[]
  appeared: string[]
  dropped: string[]
}

const MENTION_CAP = 80
const RUN_CAP = 30

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function questionKey(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Question text plus mention / whoInstead. Branded rows keep an empty name list. */
export function cleanMentions(value: unknown, domain = ''): RunMention[] {
  if (!Array.isArray(value)) return []
  const out: RunMention[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const question = typeof item.question === 'string' ? item.question.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
    if (!question) continue
    const mention = parseMention(item.mention)
    const whoInstead = item.framing === 'branded' ? [] : parseWhoInstead(item.whoInstead, domain || undefined)
    const next: RunMention = { question, whoInstead }
    if (mention) next.mention = mention
    out.push(next)
    if (out.length >= MENTION_CAP) break
  }
  return out
}

export function mentionsFromReport(
  report: { domain?: string; themes?: { questions?: unknown[] }[] } | null | undefined,
  domain = '',
): RunMention[] {
  if (!report || !Array.isArray(report.themes)) return []
  const flat: unknown[] = []
  for (const theme of report.themes) {
    if (!theme || !Array.isArray(theme.questions)) continue
    for (const question of theme.questions) flat.push(question)
  }
  return cleanMentions(flat, report.domain || domain)
}

/** Active-beat facts, or the full-report questions when this row is a report. */
export function mentionsFromStored(
  result: {
    report?: unknown
    fullReport?: { domain?: string; themes?: { questions?: unknown[] }[] }
    facts?: unknown
    unbranded?: { facts?: unknown } | null
    branded?: { facts?: unknown } | null
  },
  domain: string,
  mode: RunMode = 'unbranded',
): RunMention[] {
  if (result.report === 'full' || mode === 'full') {
    return mentionsFromReport(result.fullReport, domain)
  }
  const beat = mode === 'branded' ? result.branded : result.unbranded
  const nested = beat && Array.isArray(beat.facts) ? beat.facts : null
  const facts = nested && nested.length > 0 ? nested : result.facts
  return cleanMentions(facts, domain)
}

export function cleanRuns(value: unknown, domain = ''): CheckRun[] {
  if (!Array.isArray(value)) return []
  const out: CheckRun[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const at = typeof item.at === 'string' ? item.at.trim() : ''
    if (!at) continue
    const mode: RunMode = item.mode === 'branded' || item.mode === 'full' ? item.mode : 'unbranded'
    out.push({ at, mode, mentions: cleanMentions(item.mentions, domain) })
    if (out.length >= RUN_CAP) break
  }
  return out
}

/**
 * First re-run stores the previous snapshot and the new one.
 * Later re-runs append. The cap keeps the newest entries and never drops below two
 * so a delta still has a prior run.
 */
export function appendRunHistory(opts: {
  runs: unknown
  prior: RunMention[]
  next: RunMention[]
  at: string
  priorAt?: string
  limit: number
  mode: RunMode
  priorMode?: RunMode
}): CheckRun[] {
  const existing = cleanRuns(opts.runs)
  const nextRun: CheckRun = { at: opts.at, mode: opts.mode, mentions: opts.next }
  const seeded: CheckRun[] =
    existing.length === 0
      ? [
          {
            at: opts.priorAt && opts.priorAt.length > 0 ? opts.priorAt : opts.at,
            mode: opts.priorMode ?? opts.mode,
            mentions: opts.prior,
          },
          nextRun,
        ]
      : [...existing, nextRun]
  const cap = Math.max(2, Math.floor(opts.limit) || 2)
  return seeded.slice(-cap)
}

function collectNames(mentions: RunMention[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of mentions) {
    for (const name of item.whoInstead) {
      const key = name.trim().toLowerCase()
      if (!key || map.has(key)) continue
      map.set(key, name.trim())
    }
  }
  return map
}

/** Mention flips and whoInstead names that appeared or dropped versus the previous run. */
export function deltaVsLastRun(runs: CheckRun[]): RunDelta {
  if (runs.length < 2) {
    return { comparable: false, empty: true, flips: [], appeared: [], dropped: [] }
  }
  const prior = runs[runs.length - 2]
  const current = runs[runs.length - 1]
  const priorByQuestion = new Map<string, RunMention>()
  for (const item of prior.mentions) priorByQuestion.set(questionKey(item.question), item)
  const flips: MentionFlip[] = []
  for (const item of current.mentions) {
    const prev = priorByQuestion.get(questionKey(item.question))
    if (!prev?.mention || !item.mention || prev.mention === item.mention) continue
    flips.push({ question: item.question, from: prev.mention, to: item.mention })
  }
  const priorNames = collectNames(prior.mentions)
  const currentNames = collectNames(current.mentions)
  const appeared: string[] = []
  const dropped: string[] = []
  for (const [key, name] of currentNames) {
    if (!priorNames.has(key)) appeared.push(name)
  }
  for (const [key, name] of priorNames) {
    if (!currentNames.has(key)) dropped.push(name)
  }
  appeared.sort((a, b) => a.localeCompare(b))
  dropped.sort((a, b) => a.localeCompare(b))
  return {
    comparable: true,
    empty: flips.length === 0 && appeared.length === 0 && dropped.length === 0,
    flips,
    appeared,
    dropped,
  }
}

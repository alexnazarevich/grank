/**
 * Thin run history for an owned saved check.
 * Each entry is mention + whoInstead only — not a second copy of the report.
 * The newest runs are kept. The summary compares the last two; the grid shows every kept run.
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

/** Story label for a mention change. Unlisted pairs stay on the chip words. */
export type DeltaFlipKind = 'newlyMentioned' | 'noLongerMentioned' | 'nowMentioned' | 'lostMention'

export function deltaFlipKind(from: Mention, to: Mention): DeltaFlipKind | null {
  if (from === 'unclear' && to === 'mentioned') return 'nowMentioned'
  if (from === 'not_mentioned' && to === 'mentioned') return 'newlyMentioned'
  if (from === 'mentioned' && to === 'not_mentioned') return 'noLongerMentioned'
  if (from === 'mentioned' && to === 'unclear') return 'lostMention'
  return null
}

/** `{date}` is a calendar day in UTC. Empty when the stamp or the time is unusable. */
export function comparedToRunLabel(template: string, iso: string): string {
  if (!template.includes('{date}')) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
  return template.replaceAll('{date}', formatted)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Short UTC date and time for a run column. Empty when the stamp is unusable. */
export function runColumnLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = MONTHS[date.getUTCMonth()] ?? ''
  const day = date.getUTCDate()
  const minute = date.getUTCMinutes().toString().padStart(2, '0')
  const suffix = date.getUTCHours() >= 12 ? 'PM' : 'AM'
  let hour = date.getUTCHours() % 12
  if (hour === 0) hour = 12
  return `${month} ${day}, ${hour}:${minute} ${suffix}`
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

export function runQuestionKey(question: string): string {
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
  for (const item of prior.mentions) priorByQuestion.set(runQuestionKey(item.question), item)
  const flips: MentionFlip[] = []
  for (const item of current.mentions) {
    const prev = priorByQuestion.get(runQuestionKey(item.question))
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

export type ChangeChipId = 'newlyMentioned' | 'lostMention' | 'nowMentioned' | 'whoAppeared' | 'whoDropped'

export type ChangeChip = {
  id: ChangeChipId
  count: number
}

/** Counts for the What’s changed chips. Flip lines stay out of the primary view. */
export type ChangeSummary = {
  comparable: boolean
  /** True when a prior run exists and nothing in the chip set changed. */
  quiet: boolean
  chips: ChangeChip[]
}

export function changeSummary(runs: CheckRun[]): ChangeSummary {
  const delta = deltaVsLastRun(runs)
  if (!delta.comparable) return { comparable: false, quiet: true, chips: [] }
  let newlyMentioned = 0
  let lostMention = 0
  let nowMentioned = 0
  for (const flip of delta.flips) {
    const kind = deltaFlipKind(flip.from, flip.to)
    if (kind === 'newlyMentioned') newlyMentioned += 1
    else if (kind === 'nowMentioned') nowMentioned += 1
    else if (kind === 'noLongerMentioned' || kind === 'lostMention') lostMention += 1
  }
  const chips: ChangeChip[] = []
  if (newlyMentioned > 0) chips.push({ id: 'newlyMentioned', count: newlyMentioned })
  if (lostMention > 0) chips.push({ id: 'lostMention', count: lostMention })
  if (nowMentioned > 0) chips.push({ id: 'nowMentioned', count: nowMentioned })
  if (delta.appeared.length > 0) chips.push({ id: 'whoAppeared', count: delta.appeared.length })
  if (delta.dropped.length > 0) chips.push({ id: 'whoDropped', count: delta.dropped.length })
  return { comparable: true, quiet: delta.empty, chips }
}

export type MentionGridCell = {
  mention?: Mention
  whoInstead: string[]
}

export type MentionGridRow = {
  question: string
  cells: Array<MentionGridCell | null>
}

/**
 * Question rows in the latest run’s order, then earlier questions that dropped off.
 * A missing cell means that question was not in that run.
 */
export function mentionGrid(runs: CheckRun[]): MentionGridRow[] {
  const label = new Map<string, string>()
  const order: string[] = []
  const push = (question: string) => {
    const key = runQuestionKey(question)
    if (!key || label.has(key)) return
    label.set(key, question)
    order.push(key)
  }
  const latest = runs[runs.length - 1]
  if (latest) {
    for (const item of latest.mentions) push(item.question)
  }
  for (const run of runs) {
    for (const item of run.mentions) push(item.question)
  }
  return order.map((key) => ({
    question: label.get(key) || key,
    cells: runs.map((run) => {
      const item = run.mentions.find((mention) => runQuestionKey(mention.question) === key)
      if (!item) return null
      return { mention: item.mention, whoInstead: item.whoInstead }
    }),
  }))
}

/** Stored runs win. A preview column is only for the first run, before history exists. */
export function gridRuns(stored: CheckRun[], preview?: CheckRun | null): CheckRun[] {
  if (stored.length > 0) return stored
  if (preview && preview.mentions.length > 0) return [preview]
  return []
}

/**
 * Build the checks.result JSON from a client draft.
 * store-* knobs decide which fields are kept. Labels and model always stay
 * so a reopened check can show the same honesty badges.
 */

import { canonicalHostname } from './homepage.ts'
import { parseWhoInstead } from './visibility.ts'
import type { ProductConfig } from '../../src/config/productConfig.ts'
import {
  LABEL_BRANDED,
  LABEL_GENERATED,
  LABEL_LIVE,
  LABEL_SAMPLE,
  LABEL_UNAVAILABLE,
  LABEL_UNBRANDED,
  type CheckMode,
  type StoredBeat,
  type StoredResult,
} from '../../src/savedResult.ts'
import { scrubSecret } from './http.ts'

const SNIPPET_MAX = 8_000

function cleanQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const q = item.replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!q) continue
    out.push(q)
    if (out.length >= 8) break
  }
  return out
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanReplies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    out.push(typeof item === 'string' ? item.replace(/\s+/g, ' ').trim().slice(0, 900) : '')
    if (out.length >= 8) break
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function shapeBeat(
  value: unknown,
  mode: CheckMode,
  config: ProductConfig,
  secret: string,
  domain: string,
): StoredBeat | null {
  if (!isRecord(value)) return null
  const questions = cleanQuestions(value.questions).map((q) => scrubSecret(q, secret))
  const generated = value.questionsGenerated === true
  const replies = cleanReplies(value.replies).map((reply) => scrubSecret(reply, secret))
  const answered =
    value.answered === 'yes' || value.answered === 'partial' || value.answered === 'no' ? value.answered : null
  const why = scrubSecret(cleanText(value.answeredWhy, 500), secret)
  const answeredLive = value.answeredLive === true && answered !== null && why.length > 0
  const model = cleanText(value.model, 80) || null
  const whoInstead = parseWhoInstead(value.whoInstead, domain).map((name) => scrubSecret(name, secret))
  const beat: StoredBeat = {}
  if (config.storeQuestions) {
    beat.questions = questions
    beat.questionsGenerated = generated
  }
  if (config.storeAnswers) {
    beat.answered = answeredLive ? answered : null
    beat.answeredWhy = why
    beat.answeredLive = answeredLive
    beat.model = model
    if (mode === 'branded') beat.replies = replies
  }
  if (config.storeWhoInstead && mode === 'unbranded') {
    beat.whoInstead = whoInstead
    beat.whoInsteadLive = value.whoInsteadLive === true
  }
  return beat
}

export function shapeStoredCheck(
  body: unknown,
  config: ProductConfig,
  secret = '',
): { ok: true; domain: string; mode: CheckMode; result: StoredResult } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Check body must be JSON' }
  const rec = body as Record<string, unknown>
  const domain = canonicalHostname(rec.domain)
  if (!domain) return { ok: false, error: 'domain must be a simple public hostname' }
  const mode: CheckMode = rec.mode === 'branded' ? 'branded' : 'unbranded'
  const questions = cleanQuestions(rec.questions).map((q) => scrubSecret(q, secret))
  const generated = rec.questionsGenerated === true
  const answered =
    rec.answered === 'yes' || rec.answered === 'partial' || rec.answered === 'no' ? rec.answered : null
  const why = scrubSecret(cleanText(rec.answeredWhy, 500), secret)
  const answeredLive = rec.answeredLive === true && answered !== null && why.length > 0
  const model = cleanText(rec.model, 80) || null
  const whoInstead =
    mode === 'branded' ? [] : parseWhoInstead(rec.whoInstead, domain).map((name) => scrubSecret(name, secret))
  const whoInsteadLive = mode !== 'branded' && rec.whoInsteadLive === true
  const replies = cleanReplies(rec.replies).map((reply) => scrubSecret(reply, secret))
  const homepageSupport = scrubSecret(cleanText(rec.homepageSupport, 500), secret)
  const snippet = scrubSecret(cleanText(rec.homepageSnippet, SNIPPET_MAX), secret)

  const result: StoredResult = {
    labels: {
      questions: generated ? LABEL_GENERATED : LABEL_SAMPLE,
      answered: answeredLive ? LABEL_LIVE : LABEL_UNAVAILABLE,
      whoInstead: LABEL_GENERATED,
      mode: mode === 'branded' ? LABEL_BRANDED : LABEL_UNBRANDED,
    },
    model,
  }
  if (config.storeQuestions) {
    result.questions = questions
    result.questionsGenerated = generated
  }
  if (config.storeAnswers) {
    result.answers = {
      answered: answeredLive ? answered : null,
      why,
      live: answeredLive,
      ...(mode === 'branded' ? { replies } : {}),
    }
    if (homepageSupport) result.homepageSupport = homepageSupport
  }
  if (config.storeWhoInstead && mode !== 'branded') {
    result.whoInstead = whoInstead
    result.whoInsteadLive = whoInsteadLive
  }
  if (config.storeHomepageSnippet && snippet) result.homepageSnippet = snippet
  if (isRecord(rec.unbranded)) {
    const beat = shapeBeat(rec.unbranded, 'unbranded', config, secret, domain)
    if (beat) result.unbranded = beat
  }
  if (rec.branded === null) result.branded = null
  else if (isRecord(rec.branded)) {
    const beat = shapeBeat(rec.branded, 'branded', config, secret, domain)
    if (beat) result.branded = beat
  }
  return { ok: true, domain, mode, result }
}

export type CheckRow = { id: string; created_at: string }

/** Newest first. Ids past `cap` are the ones to delete. Cap 0 drops every row. */
export function idsBeyondCap(rows: CheckRow[], cap: number): string[] {
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  const keep = Math.max(0, cap)
  return sorted.slice(keep).map((row) => row.id)
}

/** Null means keep everything (checkRetentionDays 0). */
export function retentionCutoffIso(days: number, now = Date.now()): string | null {
  if (!Number.isFinite(days) || days <= 0) return null
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
}

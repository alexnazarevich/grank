/**
 * Mention skim labels shared by land/dig and the full report.
 * The chip follows mention only. whoInstead names stay secondary.
 */

import type { ProductCopy } from './config/productConfig.ts'
import type { Framing, Mention } from './mentionFacts.ts'

export type MentionLabelCopy = Pick<ProductCopy, 'mentionYes' | 'mentionNo' | 'mentionUnclear'>

/** Unbranded names only, capped at 3. Branded rows stay empty. */
export function whoInsteadNames(whoInstead: string[], framing: Framing): string[] {
  if (framing !== 'unbranded') return []
  return whoInstead.filter((name) => name.trim()).slice(0, 3)
}

export type WhoInsteadBoardRow = {
  name: string
  /** Distinct unbranded questions in this topic the name appeared on. */
  questions: number
}

type BoardQuestion = {
  question: string
  framing: Framing
  mention?: Mention
  whoInstead: string[]
}

export type WhoInsteadTopicQuestion = {
  question: string
  names: string[]
}

/** Names shown on one topic row. The questions underneath are not trimmed to this. */
const TOPIC_ROW_CAP = 5

export type WhoInsteadTopic = {
  id: string
  title: string
  /** At most {@link TOPIC_ROW_CAP}, highest question count first. Ties break A to Z. */
  names: WhoInsteadBoardRow[]
  /** Names that ranked past the row cap. Zero when the row shows everyone. */
  more: number
  questions: WhoInsteadTopicQuestion[]
}

/** Names already on one unbranded answer where you were not mentioned. Capped, never invented. */
function substitutesOn(item: BoardQuestion): string[] {
  if (item.framing !== 'unbranded' || !item.mention || item.mention === 'mentioned') return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of whoInsteadNames(item.whoInstead, 'unbranded')) {
    const name = raw.replace(/\s+/g, ' ').trim()
    const key = name.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/**
 * This run’s substitutes, grouped by the theme they came from.
 * Branded themes are left out. A topic with no substitutes is omitted.
 */
export function whoInsteadByTopic(
  themes: readonly {
    id: string
    title: string
    framing?: Framing
    questions: readonly BoardQuestion[]
  }[],
): WhoInsteadTopic[] {
  const topics: WhoInsteadTopic[] = []
  for (const theme of themes) {
    if (theme.framing === 'branded') continue
    const counts = new Map<string, WhoInsteadBoardRow>()
    const questions: WhoInsteadTopicQuestion[] = []
    for (const item of theme.questions) {
      const names = substitutesOn(item)
      if (names.length === 0) continue
      questions.push({ question: item.question, names })
      for (const name of names) {
        const key = name.toLowerCase()
        const existing = counts.get(key)
        if (existing) existing.questions += 1
        else counts.set(key, { name, questions: 1 })
      }
    }
    if (questions.length === 0) continue
    const ranked = [...counts.values()].sort(
      (a, b) => b.questions - a.questions || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    topics.push({
      id: theme.id,
      title: theme.title,
      names: ranked.slice(0, TOPIC_ROW_CAP),
      more: Math.max(0, ranked.length - TOPIC_ROW_CAP),
      questions,
    })
  }
  return topics
}

/** `{n}` → how many questions. The template stays plural, including when n is 1. */
export function whoInsteadCountLabel(template: string, n: number): string {
  return template.replaceAll('{n}', String(n))
}

/** Chip text is Mentioned, Not mentioned, or Unclear. Names do not change it. */
export function mentionStatusLabel(mention: Mention, copy: MentionLabelCopy): string {
  if (mention === 'mentioned') return copy.mentionYes
  if (mention === 'unclear') return copy.mentionUnclear
  return copy.mentionNo
}

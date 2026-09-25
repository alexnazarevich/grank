import type { Answered, ModeBeat, VisibilityMode } from './demoData.ts'

export const LABEL_GENERATED = 'Generated · OpenAI'
export const LABEL_SAMPLE = 'Sample'
export const LABEL_LIVE = 'Live model'
export const LABEL_UNAVAILABLE = 'Unavailable'
export const LABEL_UNBRANDED = 'Unbranded'
export const LABEL_BRANDED = 'Branded'

export type CheckMode = VisibilityMode

/** Fields the aha screen needs. Kept local so save code does not invent a second result type. */
export type FlatAha = {
  domain: string
  questions: string[]
  questionsGenerated: boolean
  answered: Answered | null
  answeredWhy: string
  answeredLive: boolean
  model: string | null
  whoInstead: string[]
  whoInsteadLive: boolean
  homepageSupport: string | null
}

export type StoredAnswers = {
  answered: Answered | null
  why: string
  live: boolean
  /** Branded per-question replies. Absent on unbranded. */
  replies?: string[]
}

export type StoredBeat = {
  questions?: string[]
  questionsGenerated?: boolean
  replies?: string[]
  answered?: Answered | null
  answeredWhy?: string
  answeredLive?: boolean
  model?: string | null
  whoInstead?: string[]
  whoInsteadLive?: boolean
}

export type StoredLabels = {
  questions: string
  answered: string
  whoInstead: string
  mode: string
}

/** JSON blob on public.checks.result. Omitted keys were not stored. */
export type StoredResult = {
  questions?: string[]
  questionsGenerated?: boolean
  answers?: StoredAnswers
  whoInstead?: string[]
  whoInsteadLive?: boolean
  homepageSupport?: string | null
  homepageSnippet?: string | null
  labels: StoredLabels
  model: string | null
  unbranded?: StoredBeat
  branded?: StoredBeat | null
}

export type BeatDraft = {
  questions: string[]
  questionsGenerated: boolean
  replies: string[]
  answered: Answered | null
  answeredWhy: string
  answeredLive: boolean
  model: string | null
  whoInstead: string[]
  whoInsteadLive: boolean
}

export type CheckDraft = {
  domain: string
  mode: CheckMode
  questions: string[]
  questionsGenerated: boolean
  replies: string[]
  answered: Answered | null
  answeredWhy: string
  answeredLive: boolean
  model: string | null
  whoInstead: string[]
  whoInsteadLive: boolean
  homepageSupport: string | null
  homepageSnippet: string | null
  unbranded: BeatDraft
  branded: BeatDraft | null
}

export type SavedCheck = {
  id: string
  domain: string
  mode: CheckMode
  createdAt: string
  result: StoredResult
}

export type ResultModel = {
  domain: string
  mode: CheckMode
  modeLabel: string
  questions: string[]
  questionsLabel: string
  questionsLive: boolean
  questionsNote: string | null
  answered: Answered | null
  answeredLabel: string
  answeredLive: boolean
  answeredWhy: string
  model: string | null
  whoInstead: string[]
  whoInsteadLabel: string
  whoInsteadLive: boolean
  whoInsteadEmpty: string
  homepageSupport: string | null
}

export function modeLabel(mode: CheckMode): string {
  return mode === 'branded' ? LABEL_BRANDED : LABEL_UNBRANDED
}

function beatDraft(beat: ModeBeat): BeatDraft {
  return {
    questions: beat.questions,
    questionsGenerated: beat.questionsGenerated,
    replies: beat.mode === 'branded' ? beat.answers : [],
    answered: beat.answered,
    answeredWhy: beat.answeredWhy,
    answeredLive: beat.answeredLive,
    model: beat.model,
    whoInstead: beat.mode === 'unbranded' ? beat.whoInstead : [],
    whoInsteadLive: beat.mode === 'unbranded' ? beat.whoInsteadLive : false,
  }
}

export function draftFromScreen(
  domain: string,
  mode: CheckMode,
  unbranded: ModeBeat,
  branded: ModeBeat | null,
  homepageSupport: string | null,
  homepageSnippet: string | null,
): CheckDraft {
  const active = mode === 'branded' && branded ? branded : unbranded
  const flat = beatDraft(active)
  return {
    domain,
    mode: active.mode,
    ...flat,
    homepageSupport,
    homepageSnippet,
    unbranded: beatDraft(unbranded),
    branded: branded ? beatDraft(branded) : null,
  }
}

export function draftFromAha(
  aha: FlatAha,
  homepageSnippet: string | null,
  mode: CheckMode = 'unbranded',
): CheckDraft {
  const unbranded: ModeBeat = {
    mode: 'unbranded',
    questions: mode === 'unbranded' ? aha.questions : [],
    answers: [],
    questionsGenerated: mode === 'unbranded' ? aha.questionsGenerated : false,
    answered: mode === 'unbranded' ? aha.answered : null,
    answeredWhy: mode === 'unbranded' ? aha.answeredWhy : '',
    answeredLive: mode === 'unbranded' ? aha.answeredLive : false,
    model: mode === 'unbranded' ? aha.model : null,
    whoInstead: mode === 'unbranded' ? aha.whoInstead : [],
    whoInsteadLive: mode === 'unbranded' ? aha.whoInsteadLive : false,
  }
  return draftFromScreen(aha.domain, mode, unbranded, null, aha.homepageSupport, homepageSnippet)
}

export function viewFromAha(aha: FlatAha, mode: CheckMode = 'unbranded'): ResultModel {
  return {
    domain: aha.domain,
    mode,
    modeLabel: modeLabel(mode),
    questions: aha.questions,
    questionsLabel: aha.questionsGenerated ? LABEL_GENERATED : LABEL_SAMPLE,
    questionsLive: aha.questionsGenerated,
    questionsNote: aha.questionsGenerated
      ? null
      : 'Sample questions — generation failed, so these are not from the model.',
    answered: aha.answered,
    answeredLabel: aha.answeredLive ? LABEL_LIVE : LABEL_UNAVAILABLE,
    answeredLive: aha.answeredLive,
    answeredWhy: aha.answeredWhy,
    model: aha.model,
    whoInstead: aha.whoInstead,
    whoInsteadLabel: LABEL_GENERATED,
    whoInsteadLive: aha.whoInsteadLive,
    whoInsteadEmpty: 'Couldn’t find alternatives',
    homepageSupport: aha.homepageSupport,
  }
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export function viewFromSaved(check: SavedCheck): ResultModel {
  const result = check.result ?? { labels: undefined, model: null }
  const labels = result.labels
  const questions = asStringList(result.questions)
  const questionsStored = questions !== null
  const answers = result.answers
  const answersStored = !!answers && typeof answers === 'object'
  const who = asStringList(result.whoInstead)
  const whoStored = who !== null
  const answered =
    answersStored && (answers.answered === 'yes' || answers.answered === 'partial' || answers.answered === 'no')
      ? answers.answered
      : null
  const answeredLive = Boolean(answersStored && answers.live && answered)
  return {
    domain: check.domain,
    mode: check.mode,
    modeLabel: labels?.mode || modeLabel(check.mode),
    questions: questionsStored ? questions : [],
    questionsLabel: labels?.questions || (result.questionsGenerated ? LABEL_GENERATED : LABEL_SAMPLE),
    questionsLive:
      questionsStored &&
      (labels?.questions === LABEL_GENERATED ||
        (result.questionsGenerated === true && labels?.questions !== LABEL_SAMPLE)),
    questionsNote: questionsStored
      ? result.questionsGenerated === false
        ? 'Sample questions — generation failed, so these are not from the model.'
        : null
      : 'Questions were not saved for this check.',
    answered,
    answeredLabel: labels?.answered || (answeredLive ? LABEL_LIVE : LABEL_UNAVAILABLE),
    answeredLive,
    answeredWhy: answersStored
      ? answers.why || ''
      : 'The model read was not saved for this check.',
    model: typeof result.model === 'string' ? result.model : null,
    whoInstead: who ?? [],
    whoInsteadLabel: labels?.whoInstead || LABEL_GENERATED,
    whoInsteadLive: whoStored && result.whoInsteadLive === true,
    whoInsteadEmpty: whoStored
      ? 'Couldn’t find alternatives'
      : 'Who-instead was not saved for this check.',
    homepageSupport:
      typeof result.homepageSupport === 'string' && result.homepageSupport.trim()
        ? result.homepageSupport
        : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function emptyBeat(mode: CheckMode): ModeBeat {
  return {
    mode,
    questions: [],
    answers: [],
    questionsGenerated: false,
    answered: null,
    answeredWhy: '',
    answeredLive: false,
    model: null,
    whoInstead: [],
    whoInsteadLive: false,
  }
}

function beatFromStored(raw: Record<string, unknown>, mode: CheckMode): ModeBeat {
  const questions = asStringList(raw.questions)
  const replies = asStringList(raw.replies) ?? []
  const answered =
    raw.answered === 'yes' || raw.answered === 'partial' || raw.answered === 'no' ? raw.answered : null
  const why = typeof raw.answeredWhy === 'string' ? raw.answeredWhy : ''
  const live = raw.answeredLive === true && answered !== null && why.length > 0
  const who = asStringList(raw.whoInstead)
  const generated = raw.questionsGenerated === true && (questions?.length ?? 0) > 0
  return {
    mode,
    questions: questions ?? [],
    answers: mode === 'branded' ? replies : [],
    questionsGenerated: generated,
    answered: live ? answered : null,
    answeredWhy:
      why ||
      (questions === null ? 'Questions were not saved for this check.' : ''),
    answeredLive: live,
    model: typeof raw.model === 'string' ? raw.model : null,
    whoInstead: mode === 'unbranded' ? (who ?? []) : [],
    whoInsteadLive: mode === 'unbranded' && raw.whoInsteadLive === true,
  }
}

function beatFromFlat(result: StoredResult, mode: CheckMode): ModeBeat {
  const questions = asStringList(result.questions)
  const replies = asStringList(result.answers?.replies) ?? []
  const answered =
    result.answers &&
    (result.answers.answered === 'yes' ||
      result.answers.answered === 'partial' ||
      result.answers.answered === 'no')
      ? result.answers.answered
      : null
  const why = result.answers?.why || ''
  const live = Boolean(result.answers?.live && answered && why)
  const who = asStringList(result.whoInstead)
  return {
    mode,
    questions: questions ?? [],
    answers: mode === 'branded' ? replies : [],
    questionsGenerated: result.questionsGenerated === true && (questions?.length ?? 0) > 0,
    answered: live ? answered : null,
    answeredWhy: why,
    answeredLive: live,
    model: typeof result.model === 'string' ? result.model : null,
    whoInstead: mode === 'unbranded' ? (who ?? []) : [],
    whoInsteadLive: mode === 'unbranded' && result.whoInsteadLive === true,
  }
}

export type ReopenedCheck = {
  domain: string
  homepageSupport: string | null
  unbranded: ModeBeat
  branded: ModeBeat | null
  activeMode: CheckMode
  digStatus: 'idle' | 'ready' | 'error'
  omittedQuestions: boolean
  omittedAnswers: boolean
  omittedWhoInstead: boolean
}

/** Rebuild the land/dig screen from a saved row, including a flat legacy blob. */
export function screenFromSaved(check: SavedCheck): ReopenedCheck {
  const result = check.result
  const activeMode: CheckMode = check.mode === 'branded' ? 'branded' : 'unbranded'
  const unbranded = isRecord(result.unbranded)
    ? beatFromStored(result.unbranded, 'unbranded')
    : activeMode === 'unbranded'
      ? beatFromFlat(result, 'unbranded')
      : emptyBeat('unbranded')
  const branded = isRecord(result.branded)
    ? beatFromStored(result.branded, 'branded')
    : activeMode === 'branded'
      ? beatFromFlat(result, 'branded')
      : null
  const digStatus = branded ? (branded.questionsGenerated ? 'ready' : 'error') : 'idle'
  const activeRaw = activeMode === 'branded' ? result.branded : result.unbranded
  const activeRec = isRecord(activeRaw) ? activeRaw : null
  const omittedQuestions = activeRec ? !('questions' in activeRec) : !('questions' in result)
  const omittedAnswers = activeRec ? !('answered' in activeRec) : !result.answers
  const omittedWhoInstead =
    activeMode === 'unbranded' &&
    (isRecord(result.unbranded) ? !('whoInstead' in result.unbranded) : !('whoInstead' in result))
  return {
    domain: check.domain,
    homepageSupport:
      typeof result.homepageSupport === 'string' && result.homepageSupport.trim()
        ? result.homepageSupport
        : null,
    unbranded,
    branded,
    activeMode,
    digStatus,
    omittedQuestions,
    omittedAnswers,
    omittedWhoInstead,
  }
}

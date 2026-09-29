/**
 * Product knobs for save/re-run (8), quota/paid (9), and the full report (10).
 * Safe defaults, then an optional JSON blob, then server env aliases.
 * Pages Functions enforce from env. The UI only displays the resolved config.
 */

export type FreeQuotaUnit = 'checks' | 'saves' | 'both'
export type FreeQuotaWindow = 'lifetime' | 'day' | 'month'
export type PaidInterval = 'month' | 'year'

export type ProductCopy = {
  saveCta: string
  runAgainCta: string
  historyTitle: string
  upgradeHeadline: string
  upgradeBody: string
  upgradeCta: string
  showFullReportCta: string
  fullReportMagicLinkHint: string
  fullReportTitle: string
  fullReportSub: string
  fullReportLoading: string
  fullReportEmptyThemes: string
  fullReportLimitHit: string
  themeSectionEyebrow: string
  mentionYes: string
  mentionNo: string
  mentionUnclear: string
  mentionWhoInstead: string
  pinQuestionCta: string
  unpinQuestionCta: string
  editQuestionCta: string
  saveEditedQuestionCta: string
  pinnedQuestionsTitle: string
  editQuestionsHint: string
  regenerateWithPinsCta: string
  addQuestionCta: string
  deleteQuestionCta: string
  saveQuestionsCta: string
  ownedQuestionsHint: string
}

export type ProductConfig = {
  saveRequiresAuth: boolean
  freeChecksBeforeSave: number
  maxSavedChecksPerUser: number
  storeQuestions: boolean
  storeAnswers: boolean
  storeWhoInstead: boolean
  storeHomepageSnippet: boolean
  checkRetentionDays: number
  paywallEnabled: boolean
  freeQuotaUnit: FreeQuotaUnit
  freeQuotaAmount: number
  freeQuotaWindow: FreeQuotaWindow
  paidPriceCents: number
  paidInterval: PaidInterval
  paidQuotaAmount: number
  paidMaxSavedChecks: number
  /** How many questions the full report asks the model for. ~50–60. */
  fullReportQuestionTarget: number
  /** Inclusive theme count bounds. Empty themes are omitted after generation. */
  fullReportThemeMin: number
  fullReportThemeMax: number
  /** Complimentary full reports per account. Further free runs do not spend check quota. */
  freeFullReports: number
  /** When false, branded dig questions are left out of the full set. */
  fullReportIncludesBranded: boolean
  /** How many questions can be pinned or edited for one full-report run. */
  pinnedQuestionMax: number
  copy: ProductCopy
}

export const PRODUCT_DEFAULTS: ProductConfig = {
  saveRequiresAuth: true,
  freeChecksBeforeSave: 1,
  maxSavedChecksPerUser: 20,
  storeQuestions: true,
  storeAnswers: true,
  storeWhoInstead: true,
  storeHomepageSnippet: false,
  checkRetentionDays: 0,
  paywallEnabled: false,
  freeQuotaUnit: 'checks',
  freeQuotaAmount: 3,
  freeQuotaWindow: 'lifetime',
  paidPriceCents: 2900,
  paidInterval: 'month',
  paidQuotaAmount: 100,
  paidMaxSavedChecks: 100,
  fullReportQuestionTarget: 55,
  fullReportThemeMin: 3,
  fullReportThemeMax: 6,
  freeFullReports: 1,
  fullReportIncludesBranded: true,
  pinnedQuestionMax: 5,
  copy: {
    saveCta: 'Save this check',
    runAgainCta: 'Run again',
    historyTitle: 'Your checks',
    upgradeHeadline: 'Free limit reached',
    upgradeBody:
      'You’ve used what’s included for free. One paid plan unlocks more full reports, saved checks, and ongoing land and dig — same labeled OpenAI checks.',
    upgradeCta: 'Upgrade',
    showFullReportCta: 'Show full report',
    fullReportMagicLinkHint: 'Sign in with a magic link to unlock your full report. No password.',
    fullReportTitle: 'Full visibility report',
    fullReportSub:
      'More questions about this site, grouped by theme. Still Generated · OpenAI — not a multi-engine scrape.',
    fullReportLoading: 'Building your full report…',
    fullReportEmptyThemes: 'No themes yet — try again.',
    fullReportLimitHit: 'You’ve used your free full report.',
    themeSectionEyebrow: 'Theme',
    mentionYes: 'Mentioned',
    mentionNo: 'Not mentioned',
    mentionUnclear: 'Unclear',
    mentionWhoInstead: 'Who instead',
    pinQuestionCta: 'Pin',
    unpinQuestionCta: 'Unpin',
    editQuestionCta: 'Edit',
    saveEditedQuestionCta: 'Save question',
    pinnedQuestionsTitle: 'Pinned for this run',
    editQuestionsHint:
      'Pin or tweak a few questions before you generate. We’ll use these for this run only — not a saved prompt library.',
    regenerateWithPinsCta: 'Run with these questions',
    addQuestionCta: 'Add question',
    deleteQuestionCta: 'Delete',
    saveQuestionsCta: 'Save questions',
    ownedQuestionsHint:
      'Add or delete questions on this check. Save them, then run again to answer this set.',
  },
}

/** Server env names. Individual vars win over PRODUCT_CONFIG_JSON. */
export const PRODUCT_ENV_ALIASES = {
  saveRequiresAuth: 'SAVE_REQUIRES_AUTH',
  freeChecksBeforeSave: 'FREE_CHECKS_BEFORE_SAVE',
  maxSavedChecksPerUser: 'MAX_SAVED_CHECKS_PER_USER',
  storeQuestions: 'STORE_QUESTIONS',
  storeAnswers: 'STORE_ANSWERS',
  storeWhoInstead: 'STORE_WHO_INSTEAD',
  storeHomepageSnippet: 'STORE_HOMEPAGE_SNIPPET',
  checkRetentionDays: 'CHECK_RETENTION_DAYS',
  paywallEnabled: 'PAYWALL_ENABLED',
  freeQuotaUnit: 'FREE_QUOTA_UNIT',
  freeQuotaAmount: 'FREE_QUOTA_AMOUNT',
  freeQuotaWindow: 'FREE_QUOTA_WINDOW',
  paidPriceCents: 'PAID_PRICE_CENTS',
  paidInterval: 'PAID_INTERVAL',
  paidQuotaAmount: 'PAID_QUOTA_AMOUNT',
  paidMaxSavedChecks: 'PAID_MAX_SAVED_CHECKS',
  fullReportQuestionTarget: 'FULL_REPORT_QUESTION_TARGET',
  fullReportThemeMin: 'FULL_REPORT_THEME_MIN',
  fullReportThemeMax: 'FULL_REPORT_THEME_MAX',
  freeFullReports: 'FREE_FULL_REPORTS',
  fullReportIncludesBranded: 'FULL_REPORT_INCLUDES_BRANDED',
  pinnedQuestionMax: 'PINNED_QUESTION_MAX',
} as const

const COPY_KEYS: (keyof ProductCopy)[] = [
  'saveCta',
  'runAgainCta',
  'historyTitle',
  'upgradeHeadline',
  'upgradeBody',
  'upgradeCta',
  'showFullReportCta',
  'fullReportMagicLinkHint',
  'fullReportTitle',
  'fullReportSub',
  'fullReportLoading',
  'fullReportEmptyThemes',
  'fullReportLimitHit',
  'themeSectionEyebrow',
  'mentionYes',
  'mentionNo',
  'mentionUnclear',
  'mentionWhoInstead',
  'pinQuestionCta',
  'unpinQuestionCta',
  'editQuestionCta',
  'saveEditedQuestionCta',
  'pinnedQuestionsTitle',
  'editQuestionsHint',
  'regenerateWithPinsCta',
  'addQuestionCta',
  'deleteQuestionCta',
  'saveQuestionsCta',
  'ownedQuestionsHint',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
  }
  return fallback
}

function parseIntMin(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.floor(n))
}

function parseIntRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, parseIntMin(value, fallback, min))
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback
  const v = value.trim().toLowerCase()
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function parseCopy(value: unknown, fallback: ProductCopy): ProductCopy {
  if (!isRecord(value)) return fallback
  const next = { ...fallback }
  for (const key of COPY_KEYS) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) next[key] = raw.trim()
  }
  return next
}

function field(patch: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in patch) return patch[camel]
  if (snake in patch) return patch[snake]
  return undefined
}

/** Apply a partial JSON object. Unknown keys are ignored. Invalid values keep the base. */
export function mergeProductConfig(base: ProductConfig, patch: unknown): ProductConfig {
  if (!isRecord(patch)) return base
  const quotaUnits = ['checks', 'saves', 'both'] as const
  const windows = ['lifetime', 'day', 'month'] as const
  const intervals = ['month', 'year'] as const
  return {
    saveRequiresAuth: parseBool(
      field(patch, 'saveRequiresAuth', 'SAVE_REQUIRES_AUTH'),
      base.saveRequiresAuth,
    ),
    freeChecksBeforeSave: parseIntMin(
      field(patch, 'freeChecksBeforeSave', 'FREE_CHECKS_BEFORE_SAVE'),
      base.freeChecksBeforeSave,
      0,
    ),
    maxSavedChecksPerUser: parseIntMin(
      field(patch, 'maxSavedChecksPerUser', 'MAX_SAVED_CHECKS_PER_USER'),
      base.maxSavedChecksPerUser,
      0,
    ),
    storeQuestions: parseBool(field(patch, 'storeQuestions', 'STORE_QUESTIONS'), base.storeQuestions),
    storeAnswers: parseBool(field(patch, 'storeAnswers', 'STORE_ANSWERS'), base.storeAnswers),
    storeWhoInstead: parseBool(
      field(patch, 'storeWhoInstead', 'STORE_WHO_INSTEAD'),
      base.storeWhoInstead,
    ),
    storeHomepageSnippet: parseBool(
      field(patch, 'storeHomepageSnippet', 'STORE_HOMEPAGE_SNIPPET'),
      base.storeHomepageSnippet,
    ),
    checkRetentionDays: parseIntMin(
      field(patch, 'checkRetentionDays', 'CHECK_RETENTION_DAYS'),
      base.checkRetentionDays,
      0,
    ),
    paywallEnabled: parseBool(field(patch, 'paywallEnabled', 'PAYWALL_ENABLED'), base.paywallEnabled),
    freeQuotaUnit: parseEnum(
      field(patch, 'freeQuotaUnit', 'FREE_QUOTA_UNIT'),
      quotaUnits,
      base.freeQuotaUnit,
    ),
    freeQuotaAmount: parseIntMin(
      field(patch, 'freeQuotaAmount', 'FREE_QUOTA_AMOUNT'),
      base.freeQuotaAmount,
      0,
    ),
    freeQuotaWindow: parseEnum(
      field(patch, 'freeQuotaWindow', 'FREE_QUOTA_WINDOW'),
      windows,
      base.freeQuotaWindow,
    ),
    paidPriceCents: parseIntMin(
      field(patch, 'paidPriceCents', 'PAID_PRICE_CENTS'),
      base.paidPriceCents,
      0,
    ),
    paidInterval: parseEnum(
      field(patch, 'paidInterval', 'PAID_INTERVAL'),
      intervals,
      base.paidInterval,
    ),
    paidQuotaAmount: parseIntMin(
      field(patch, 'paidQuotaAmount', 'PAID_QUOTA_AMOUNT'),
      base.paidQuotaAmount,
      0,
    ),
    paidMaxSavedChecks: parseIntMin(
      field(patch, 'paidMaxSavedChecks', 'PAID_MAX_SAVED_CHECKS'),
      base.paidMaxSavedChecks,
      0,
    ),
    fullReportQuestionTarget: parseIntRange(
      field(patch, 'fullReportQuestionTarget', 'FULL_REPORT_QUESTION_TARGET'),
      base.fullReportQuestionTarget,
      1,
      80,
    ),
    ...themeBounds(
      parseIntRange(
        field(patch, 'fullReportThemeMin', 'FULL_REPORT_THEME_MIN'),
        base.fullReportThemeMin,
        1,
        6,
      ),
      parseIntRange(
        field(patch, 'fullReportThemeMax', 'FULL_REPORT_THEME_MAX'),
        base.fullReportThemeMax,
        1,
        6,
      ),
    ),
    freeFullReports: parseIntRange(
      field(patch, 'freeFullReports', 'FREE_FULL_REPORTS'),
      base.freeFullReports,
      0,
      100,
    ),
    fullReportIncludesBranded: parseBool(
      field(patch, 'fullReportIncludesBranded', 'FULL_REPORT_INCLUDES_BRANDED'),
      base.fullReportIncludesBranded,
    ),
    pinnedQuestionMax: parseIntRange(
      field(patch, 'pinnedQuestionMax', 'PINNED_QUESTION_MAX'),
      base.pinnedQuestionMax,
      1,
      8,
    ),
    copy: parseCopy(patch.copy, base.copy),
  }
}

/** Min cannot sit above max. Both stay inside the six-theme catalog. */
function themeBounds(min: number, max: number): { fullReportThemeMin: number; fullReportThemeMax: number } {
  if (min > max) return { fullReportThemeMin: max, fullReportThemeMax: min }
  return { fullReportThemeMin: min, fullReportThemeMax: max }
}

export function parseConfigJson(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  return value
}

/**
 * Server source of truth: defaults, then PRODUCT_CONFIG_JSON, then env aliases.
 * A single env alias overrides just that knob without rewriting the JSON blob.
 */
export function productConfigFromEnv(env: Record<string, string | undefined> | undefined): ProductConfig {
  const source = env ?? {}
  const fromJson = mergeProductConfig(PRODUCT_DEFAULTS, parseConfigJson(envValue(source, 'PRODUCT_CONFIG_JSON')))
  const overlay: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(PRODUCT_ENV_ALIASES)) {
    const value = envValue(source, snake)
    if (value !== undefined && value.trim() !== '') overlay[camel] = value
  }
  return mergeProductConfig(fromJson, overlay)
}

/** Free history cap, or the paid cap once (9) turns the paywall on and the plan is paid. */
export function historyCapForPlan(config: ProductConfig, plan: string | null | undefined): number {
  if (config.paywallEnabled && plan === 'paid') return config.paidMaxSavedChecks
  return config.maxSavedChecksPerUser
}

/** Free allotment, or the paid allotment for a paid profile. Only enforced while the paywall is on. */
export function quotaAmountForPlan(config: ProductConfig, plan: string | null | undefined): number {
  if (plan === 'paid') return config.paidQuotaAmount
  return config.freeQuotaAmount
}

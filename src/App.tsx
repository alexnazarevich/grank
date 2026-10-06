import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  EXAMPLES,
  normalizeUrl,
  stubQuestionsFor,
  type Answered,
  type ModeBeat,
  type VisibilityMode,
} from './demoData'
import { liveAnsweredByYou } from './liveAnswered'
import { STORY } from './story'
import { UnbrandedAnswers } from './UnbrandedAnswers'
import { fetchVisibility, type VisibilityFail, type VisibilityOk } from './visibilityClient'
import { loadProductConfig } from './config/clientConfig'
import { PRODUCT_DEFAULTS, type ProductConfig } from './config/productConfig'
import {
  AUTH_NOT_CONFIGURED,
  bootAuth,
  bumpGuestChecks,
  isValidEmail,
  readGuestChecks,
  sendMagicLink,
  signOut,
  stashPendingFullReport,
  stashPendingSave,
  supabasePublicConfig,
  type AuthSession,
} from './authClient'
import { FullReportSection, OpenAIPausedNote } from './FullReportSection'
import {
  fetchFullReport,
  fetchOwnedReport,
  fullReportOpensPayGate,
  type FullReportFail,
  type FullReportOk,
  type SignedGeminiMiss,
} from './fullReportClient'
import { THEME_CATALOG, fullReportFromStored, overlayUnbrandedGemini, type FullReport, type RunPin } from './fullReport'
import {
  OWNED_QUESTION_MAX,
  SHORT_OWNED_MAX,
  applyOwnedToBeat,
  applyOwnedToReport,
  cleanOwnedQuestions,
  ownedFromReport,
  type OwnedQuestion,
} from './ownedQuestions'
import { MentionMark } from './MentionMark'
import { RunHistoryPanel } from './RunHistoryPanel'
import { landThemeId, type AnswerFact, type Framing, type ThemeId } from './mentionFacts'
import { PinnedRun, QuestionPinControls, type PinItem } from './RunPins'
import { startCheckout } from './billingClient'
import { listChecks, recordCheckRun, saveCheck, updateCheckQuestions } from './checksClient'
import { cleanRuns, mentionsFromReport, type CheckRun } from './runHistory'
import {
  draftFromScreen,
  screenFromSaved,
  type CheckDraft,
  type SavedCheck,
} from './savedResult'
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error' | 'history'
type DigStatus = 'idle' | 'loading' | 'ready' | 'error'
type SaveState = 'idle' | 'email' | 'sent' | 'saving' | 'saved' | 'error'
type ReportPhase = 'idle' | 'email' | 'sent' | 'loading' | 'ready' | 'error' | 'limit'
type EmailPurpose = 'save' | 'report' | 'history' | 'upgrade'

type Screen = {
  domain: string
  homepageSupport: string | null
  unbranded: ModeBeat
  branded: ModeBeat | null
  omittedQuestions: boolean
  omittedAnswers: boolean
  omittedWhoInstead: boolean
}

const AFTER_LOGIN_KEY = 'grank.afterLogin'

let seenCheckoutNote: string | null = null

function checkoutReturnNote(): string {
  if (seenCheckoutNote !== null) return seenCheckoutNote
  let note = ''
  try {
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    if (checkout === 'success') {
      note =
        'Stripe sent you back. Paid checks unlock after the webhook confirms — run the check again in a moment.'
    } else if (checkout === 'cancel') {
      note = 'Checkout canceled.'
    }
    if (checkout) {
      params.delete('checkout')
      const next = params.toString()
      window.history.replaceState({}, '', next ? `/?${next}` : window.location.pathname)
    }
  } catch {
    note = ''
  }
  seenCheckoutNote = note
  return note
}

function withOpenAI(text: string) {
  const word = 'OpenAI'
  const at = text.indexOf(word)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <strong>{word}</strong>
      {text.slice(at + word.length)}
    </>
  )
}

function factFor(facts: AnswerFact[] | undefined, index: number, question: string): AnswerFact | undefined {
  const fact = facts?.[index]
  if (fact?.question === question) return fact
  return facts?.find((item) => item.question === question)
}

function verdictWord(answered: Answered): string {
  if (answered === 'yes') return 'Yes'
  if (answered === 'partial') return 'Partial'
  return 'No'
}

function unbrandedBeat(domain: string, visibility: VisibilityOk | VisibilityFail): ModeBeat {
  if (visibility.ok) {
    return {
      mode: 'unbranded',
      questions: visibility.questions,
      answers: [],
      ...(visibility.gemini.length === visibility.questions.length ? { gemini: visibility.gemini } : {}),
      questionsGenerated: true,
      answered: visibility.answered,
      answeredWhy: visibility.why,
      answeredLive: true,
      model: visibility.model,
      whoInstead: visibility.whoInstead,
      whoInsteadLive: true,
      facts: visibility.facts,
    }
  }
  return {
    mode: 'unbranded',
    questions: stubQuestionsFor(domain).questions,
    answers: [],
    questionsGenerated: false,
    answered: null,
    answeredWhy: visibility.error,
    answeredLive: false,
    model: null,
    whoInstead: [],
    whoInsteadLive: false,
    facts: [],
  }
}

function brandedBeat(visibility: VisibilityOk | VisibilityFail): ModeBeat {
  if (visibility.ok && visibility.mode === 'branded') {
    return {
      mode: 'branded',
      questions: visibility.questions,
      answers: visibility.answers,
      questionsGenerated: true,
      answered: visibility.answered,
      answeredWhy: visibility.why,
      answeredLive: true,
      model: visibility.model,
      whoInstead: [],
      whoInsteadLive: false,
      facts: visibility.facts,
    }
  }
  return {
    mode: 'branded',
    questions: [],
    answers: [],
    questionsGenerated: false,
    answered: null,
    answeredWhy: visibility.ok ? STORY.digFail : visibility.error,
    answeredLive: false,
    model: null,
    whoInstead: [],
    whoInsteadLive: false,
    facts: [],
  }
}

function screenFromDraft(draft: CheckDraft): Screen {
  const beat = (source: CheckDraft['unbranded'], mode: VisibilityMode): ModeBeat => ({
    mode,
    questions: source.questions,
    answers: mode === 'branded' ? source.replies : [],
    ...(mode === 'unbranded' && source.gemini ? { gemini: source.gemini } : {}),
    questionsGenerated: source.questionsGenerated,
    answered: source.answered,
    answeredWhy: source.answeredWhy,
    answeredLive: source.answeredLive,
    model: source.model,
    whoInstead: mode === 'unbranded' ? source.whoInstead : [],
    whoInsteadLive: mode === 'unbranded' ? source.whoInsteadLive : false,
    facts: source.facts,
  })
  return {
    domain: draft.domain,
    homepageSupport: draft.homepageSupport,
    unbranded: beat(draft.unbranded, 'unbranded'),
    branded: draft.branded ? beat(draft.branded, 'branded') : null,
    omittedQuestions: false,
    omittedAnswers: false,
    omittedWhoInstead: false,
  }
}

function liveScreen(
  domain: string,
  homepageSupport: string | null,
  unbranded: ModeBeat,
  branded: ModeBeat | null,
): Screen {
  return {
    domain,
    homepageSupport,
    unbranded,
    branded,
    omittedQuestions: false,
    omittedAnswers: false,
    omittedWhoInstead: false,
  }
}

let flushPromise: Promise<
  { ok: true; check: SavedCheck } | { ok: false; error: string; code?: string; plan?: 'free' | 'paid' }
> | null = null

function flushPending(session: AuthSession, draft: CheckDraft) {
  if (!flushPromise) flushPromise = saveCheck(session.accessToken, draft)
  return flushPromise
}

function savedFromDraft(draft: CheckDraft): SavedCheck {
  return {
    id: 'pending',
    domain: draft.domain,
    mode: draft.mode,
    createdAt: new Date().toISOString(),
    result: {
      labels: {
        questions: draft.questionsGenerated ? 'Generated · OpenAI' : 'Sample',
        answered: draft.answeredLive ? 'Live model' : 'Unavailable',
        whoInstead: 'Generated · OpenAI',
        mode: draft.mode === 'branded' ? 'Branded' : 'Unbranded',
      },
      model: draft.model,
      homepageSupport: draft.homepageSupport,
      questions: draft.questions,
      questionsGenerated: draft.questionsGenerated,
      answers: {
        answered: draft.answered,
        why: draft.answeredWhy,
        live: draft.answeredLive,
        replies: draft.replies,
      },
      ...(draft.gemini ? { gemini: draft.gemini } : {}),
      whoInstead: draft.whoInstead,
      whoInsteadLive: draft.whoInsteadLive,
      unbranded: draft.unbranded,
      branded: draft.branded,
    },
  }
}

function historyKind(check: SavedCheck): string {
  if (check.result?.report === 'full') return 'Full report'
  return check.mode === 'branded' ? 'Branded' : 'Unbranded'
}

function pairedAnswers(questions: string[], replies: string[]): { question: string; answer: string }[] {
  return questions.flatMap((question, index) => {
    const answer = (replies[index] || '').replace(/\s+/g, ' ').trim()
    return answer ? [{ question, answer }] : []
  })
}

function reportAnswers(report: FullReport): { question: string; answer: string }[] {
  return report.themes.flatMap((theme) =>
    theme.questions.flatMap((item) => {
      const answer = item.answer.replace(/\s+/g, ' ').trim()
      return answer ? [{ question: item.question, answer }] : []
    }),
  )
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function App() {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('home')
  const [screen, setScreen] = useState<Screen | null>(null)
  const [error, setError] = useState('')
  const [activeMode, setActiveMode] = useState<VisibilityMode>('unbranded')
  const [digStatus, setDigStatus] = useState<DigStatus>('idle')
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<ProductConfig>(PRODUCT_DEFAULTS)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [email, setEmail] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveMessage, setSaveMessage] = useState('')
  const [guestChecks, setGuestChecks] = useState(readGuestChecks)
  const [history, setHistory] = useState<SavedCheck[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [pageText, setPageText] = useState<string | null>(null)
  const [quotaWall, setQuotaWall] = useState(false)
  const [quotaPlan, setQuotaPlan] = useState<'free' | 'paid' | null>(null)
  const [upgradeNote, setUpgradeNote] = useState(checkoutReturnNote)
  const [upgradeEmail, setUpgradeEmail] = useState(false)
  const [upgradeBusy, setUpgradeBusy] = useState(false)
  const [reportPhase, setReportPhase] = useState<ReportPhase>('idle')
  const [reportMessage, setReportMessage] = useState('')
  const [fullReport, setFullReport] = useState<FullReport | null>(null)
  const [geminiMiss, setGeminiMiss] = useState<SignedGeminiMiss | null>(null)
  const [openaiPaused, setOpenaiPaused] = useState(false)
  const [emailPurpose, setEmailPurpose] = useState<EmailPurpose>('save')
  const [pins, setPins] = useState<PinItem[]>([])
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [ranPins, setRanPins] = useState<string | null>(null)
  const [owning, setOwning] = useState(false)
  const [ownedSet, setOwnedSet] = useState(false)
  const [questionsDirty, setQuestionsDirty] = useState(false)
  const [questionsSaving, setQuestionsSaving] = useState(false)
  const [questionsNote, setQuestionsNote] = useState('')
  const [addText, setAddText] = useState('')
  const [addThemeId, setAddThemeId] = useState<ThemeId>('problems')
  const [runs, setRuns] = useState<CheckRun[]>([])
  const [checkedAt, setCheckedAt] = useState('')
  const digReq = useRef(0)
  const digState = useRef<DigStatus>('idle')

  useEffect(() => {
    void loadProductConfig().then(setConfig)
  }, [])

  async function showHistory(sess: AuthSession) {
    setHistoryLoading(true)
    setHistoryError('')
    const listed = await listChecks(sess.accessToken)
    setHistoryLoading(false)
    if (!listed.ok) {
      setHistory(null)
      setHistoryError(listed.error)
      return
    }
    setHistory(listed.checks)
  }

  function applyReportResult(result: FullReportOk | FullReportFail) {
    if (!result.ok) {
      if (result.code === 'quota_exceeded' || result.code === 'full_report_limit') {
        setReportPhase('limit')
        setReportMessage('')
        if (fullReportOpensPayGate(result)) {
          setQuotaWall(true)
          setQuotaPlan(result.plan === 'paid' ? 'paid' : 'free')
        }
        return
      }
      setReportPhase('error')
      setReportMessage(result.error)
      return
    }
    setQuotaWall(false)
    setGeminiMiss(result.geminiMiss ?? null)
    setOpenaiPaused(result.openaiPaused === true)
    if (result.openaiPaused) {
      setFullReport((current) => (current ? overlayUnbrandedGemini(current, result.report) : result.report))
    } else {
      setFullReport(result.report)
    }
    setReportPhase('ready')
    setReportMessage('')
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const booted = await bootAuth()
      if (!alive) return
      setSession(booted.session)
      let afterLogin = ''
      try {
        afterLogin = sessionStorage.getItem(AFTER_LOGIN_KEY) || ''
      } catch {
        afterLogin = ''
      }
      const reportIntent = Boolean(booted.session && booted.pendingReport)
      if (booted.session && booted.pending) {
        setSaveState('saving')
        const saved = await flushPending(booted.session, booted.pending)
        if (!alive) return
        if (saved.ok) {
          if (!reportIntent) applySaved(saved.check)
          setSaveState('saved')
          setSaveMessage('Saved.')
          if (!reportIntent) {
            setPhase('history')
            await showHistory(booted.session)
          } else {
            setSavedId(saved.check.id)
          }
        } else if (!reportIntent) {
          applySaved(savedFromDraft(booted.pending))
          setSavedId(null)
          setSaveState('error')
          setSaveMessage(saved.error)
          if (saved.code === 'quota_exceeded') {
            setQuotaWall(true)
            setQuotaPlan(saved.plan === 'paid' ? 'paid' : 'free')
          }
          setPhase('result')
        } else {
          setSaveState('error')
          setSaveMessage(saved.error)
          if (saved.code === 'quota_exceeded') {
            setQuotaWall(true)
            setQuotaPlan(saved.plan === 'paid' ? 'paid' : 'free')
          }
        }
      } else if (booted.session && afterLogin === 'history' && !reportIntent) {
        try {
          sessionStorage.removeItem(AFTER_LOGIN_KEY)
        } catch {
          // History can be opened again after the link.
        }
        setPhase('history')
        await showHistory(booted.session)
      }
      if (booted.session && booted.pendingReport) {
        const draft = booted.pendingReport.draft
        if (draft) {
          const restored = screenFromDraft(draft)
          const dig: DigStatus = restored.branded
            ? restored.branded.questionsGenerated
              ? 'ready'
              : 'error'
            : 'idle'
          digReq.current += 1
          digState.current = dig
          setScreen(restored)
          setActiveMode(draft.mode === 'branded' ? 'branded' : 'unbranded')
          setDigStatus(dig)
          setUrl(draft.domain)
          setPageText(null)
        }
        setPhase('result')
        setReportPhase('loading')
        const pendingPins = booted.pendingReport.pins ?? []
        if (pendingPins.length > 0) {
          setPins(pendingPins.map((pin, index) => ({ ...pin, key: `pending:${index}` })))
        }
        const result = await fetchFullReport(
          booted.pendingReport.domain,
          booted.session.accessToken,
          pendingPins,
        )
        if (result.ok) {
          setRanPins(pendingPins.map((pin) => `${pin.framing}:${pin.question}`).join('\n'))
        }
        if (!alive) return
        applyReportResult(result)
        return
      }
      if (!alive || !booted.session || afterLogin !== 'upgrade') return
      try {
        sessionStorage.removeItem(AFTER_LOGIN_KEY)
      } catch {
        // Checkout can be started from the button.
      }
      setQuotaWall(true)
      const checkout = await startCheckout(booted.session.accessToken)
      if (!alive) return
      if (checkout.ok && 'url' in checkout) {
        window.location.assign(checkout.url)
        return
      }
      if (checkout.ok) {
        setQuotaPlan('paid')
        setUpgradeNote('This account is already on the paid plan.')
      } else {
        setUpgradeNote(checkout.error)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  function applySaved(check: SavedCheck) {
    const reopened = screenFromSaved(check)
    digReq.current += 1
    digState.current = reopened.digStatus
    setScreen({
      domain: reopened.domain,
      homepageSupport: reopened.homepageSupport,
      unbranded: reopened.unbranded,
      branded: reopened.branded,
      omittedQuestions: reopened.omittedQuestions,
      omittedAnswers: reopened.omittedAnswers,
      omittedWhoInstead: reopened.omittedWhoInstead,
    })
    setActiveMode(reopened.activeMode)
    setDigStatus(reopened.digStatus)
    setSavedId(check.id)
    setRuns(cleanRuns(check.result.runs, check.domain))
    setCheckedAt(check.createdAt)
    setUrl(check.domain)
    setPageText(null)
    setPins([])
    setEditingKey(null)
    setRanPins(null)
    setFullReport(null)
    setGeminiMiss(null)
    setOpenaiPaused(false)
    setReportPhase('idle')
    setReportMessage('')
  }

  function currentDraft(next = screen, mode = activeMode): CheckDraft | null {
    if (!next) return null
    const snippet = config.storeHomepageSnippet ? pageText : null
    return draftFromScreen(next.domain, mode, next.unbranded, next.branded, next.homepageSupport, snippet)
  }

  async function persist(sess: AuthSession, draft: CheckDraft) {
    setSaveState('saving')
    setSaveMessage('')
    const saved = await saveCheck(sess.accessToken, draft)
    if (!saved.ok) {
      if (saved.code === 'quota_exceeded') {
        setQuotaWall(true)
        setQuotaPlan(saved.plan === 'paid' ? 'paid' : 'free')
      }
      setSaveState('error')
      setSaveMessage(saved.error)
      return
    }
    setSavedId(saved.check.id)
    setSaveState('saved')
    setSaveMessage('Saved.')
  }

  async function runCheck(raw: string, opts?: { autosave?: boolean }) {
    const domain = normalizeUrl(raw)
    if (!domain) {
      setError('That URL didn’t load. Try again or use an example.')
      setPhase('error')
      setScreen(null)
      return
    }
    setError('')
    setSaveState('idle')
    setSaveMessage('')
    setSavedId(null)
    setRuns([])
    setCheckedAt('')
    setFullReport(null)
    setGeminiMiss(null)
    setOpenaiPaused(false)
    setReportPhase('idle')
    setReportMessage('')
    setPins([])
    setEditingKey(null)
    setEditText('')
    setRanPins(null)
    setOwning(false)
    setOwnedSet(false)
    setQuestionsDirty(false)
    setQuestionsNote('')
    setAddText('')
    setActiveMode('unbranded')
    digState.current = 'idle'
    setDigStatus('idle')
    digReq.current += 1
    const keep = Boolean(opts?.autosave && screen)
    setBusy(true)
    if (!keep) setPhase('loading')

    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain, 'unbranded', session?.accessToken),
      liveAnsweredByYou(domain),
    ])
    if (!visibility.ok && visibility.code === 'quota_exceeded') {
      setQuotaWall(true)
      setQuotaPlan(visibility.plan === 'paid' ? 'paid' : 'free')
      setBusy(false)
      if (!keep) setPhase('home')
      return
    }
    if (visibility.ok) setQuotaWall(false)
    const homepageSupport = homepage.ok
      ? `Supporting homepage fetch: ${verdictWord(homepage.answered)}. Page content only — not the model read.`
      : null
    const text = homepage.ok && homepage.pageText ? homepage.pageText : null
    const next = liveScreen(domain, homepageSupport, unbrandedBeat(domain, visibility), null)
    setPageText(text)
    setScreen(next)
    setPhase('result')
    setBusy(false)
    if (!session) setGuestChecks(bumpGuestChecks())
    if (opts?.autosave && session) {
      const draft = draftFromScreen(
        domain,
        'unbranded',
        next.unbranded,
        null,
        homepageSupport,
        config.storeHomepageSnippet ? text : null,
      )
      void persist(session, draft)
    }
  }

  async function showBranded(force = false, opts?: { autosave?: boolean }) {
    if (!screen) return
    setActiveMode('branded')
    if (!force && digState.current === 'ready' && screen.branded?.questionsGenerated) return
    if (!force && digState.current === 'loading') return
    setOwning(false)
    setOwnedSet(false)
    setQuestionsDirty(false)
    setRuns([])
    setCheckedAt('')
    const domain = screen.domain
    const req = ++digReq.current
    digState.current = 'loading'
    setDigStatus('loading')
    setBusy(true)
    setSavedId(null)
    setSaveState('idle')
    setSaveMessage('')
    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain, 'branded', session?.accessToken),
      liveAnsweredByYou(domain),
    ])
    if (req !== digReq.current) return
    if (!visibility.ok && visibility.code === 'quota_exceeded') {
      setQuotaWall(true)
      setQuotaPlan(visibility.plan === 'paid' ? 'paid' : 'free')
      const back = screen.branded?.questionsGenerated ? 'ready' : 'idle'
      digState.current = back
      setDigStatus(back)
      setBusy(false)
      return
    }
    if (visibility.ok) setQuotaWall(false)
    const beat = brandedBeat(visibility)
    const nextStatus = beat.questionsGenerated ? 'ready' : 'error'
    digState.current = nextStatus
    const homepageSupport = homepage.ok
      ? `Supporting homepage fetch: ${verdictWord(homepage.answered)}. Page content only — not the model read.`
      : screen.homepageSupport
    const text = homepage.ok && homepage.pageText ? homepage.pageText : pageText
    const next = liveScreen(domain, homepageSupport, screen.unbranded, beat)
    setScreen((prev) => (prev && prev.domain === domain ? next : prev))
    setPageText(text)
    setDigStatus(nextStatus)
    setBusy(false)
    if (!session) setGuestChecks(bumpGuestChecks())
    if (opts?.autosave && session) {
      const draft = draftFromScreen(
        domain,
        'branded',
        screen.unbranded,
        beat,
        homepageSupport,
        config.storeHomepageSnippet ? text : null,
      )
      void persist(session, draft)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!url.trim()) {
      setError('Add a website to check.')
      setPhase('error')
      return
    }
    void runCheck(url)
  }

  function reset() {
    digReq.current += 1
    digState.current = 'idle'
    setPhase('home')
    setScreen(null)
    setError('')
    setBusy(false)
    setActiveMode('unbranded')
    setDigStatus('idle')
    setSavedId(null)
    setRuns([])
    setCheckedAt('')
    setSaveState('idle')
    setSaveMessage('')
    setPageText(null)
    setUpgradeEmail(false)
    setFullReport(null)
    setGeminiMiss(null)
    setOpenaiPaused(false)
    setReportPhase('idle')
    setReportMessage('')
    setPins([])
    setEditingKey(null)
    setEditText('')
    setRanPins(null)
    setOwning(false)
    setOwnedSet(false)
    setQuestionsDirty(false)
    setQuestionsNote('')
    setAddText('')
    setEmailPurpose('save')
  }

  async function goCheckout(accessToken: string) {
    setUpgradeBusy(true)
    setUpgradeNote('')
    const result = await startCheckout(accessToken)
    if (result.ok && 'url' in result) {
      window.location.assign(result.url)
      return
    }
    setUpgradeBusy(false)
    if (result.ok) {
      setQuotaPlan('paid')
      setUpgradeNote('This account is already on the paid plan.')
      return
    }
    setUpgradeNote(result.error)
  }

  function onUpgrade() {
    if (quotaPlan === 'paid' || upgradeBusy) return
    if (!supabasePublicConfig()) {
      setUpgradeNote(AUTH_NOT_CONFIGURED)
      return
    }
    if (!session) {
      try {
        sessionStorage.setItem(AFTER_LOGIN_KEY, 'upgrade')
      } catch {
        // They can send the link again.
      }
      setEmailPurpose('upgrade')
      setUpgradeEmail(true)
      setQuotaWall(true)
      return
    }
    void goCheckout(session.accessToken)
  }

  async function onSave() {
    if (busy) return
    const draft = currentDraft()
    if (savedId && !draft) {
      setSaveState('saved')
      setSaveMessage('Already in your checks.')
      return
    }
    if (!draft) return
    if (savedId) {
      setSaveState('saved')
      setSaveMessage('Already in your checks.')
      return
    }
    if (!supabasePublicConfig()) {
      setSaveState('error')
      setSaveMessage(AUTH_NOT_CONFIGURED)
      return
    }
    if (!session) {
      setEmailPurpose('save')
      setReportPhase((prev) => (prev === 'email' || prev === 'sent' ? 'idle' : prev))
      setSaveState('email')
      setSaveMessage(
        config.saveRequiresAuth
          ? 'Sign in with a magic link to keep this check. No password.'
          : 'An account is optional. A magic link saves this check to your email.',
      )
      return
    }
    await persist(session, draft)
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault()
    if (!isValidEmail(email)) {
      if (emailPurpose === 'report') {
        setReportMessage('Enter a valid email.')
        return
      }
      setSaveState('error')
      setSaveMessage('Enter a valid email.')
      return
    }
    if (!supabasePublicConfig()) {
      setSaveState('error')
      setSaveMessage(AUTH_NOT_CONFIGURED)
      return
    }
    if (emailPurpose === 'report') {
      const draft = currentDraft()
      const domain = draft?.domain || screen?.domain || ''
      if (!domain) {
        setReportPhase('error')
        setReportMessage('Add a website to check.')
        return
      }
      stashPendingFullReport({
        domain,
        draft,
        pins: pins.map((pin) => ({ question: pin.question, framing: pin.framing })),
      })
      const sentReport = await sendMagicLink(email.trim())
      if (!sentReport.ok) {
        setReportPhase('error')
        setReportMessage(sentReport.error)
        return
      }
      setReportPhase('sent')
      setReportMessage('Check your email for a sign-in link. This page will build your full report when you come back.')
      return
    }
    const draft = currentDraft()
    if (draft && phase === 'result') stashPendingSave(draft)
    if (phase === 'history') {
      try {
        sessionStorage.setItem(AFTER_LOGIN_KEY, 'history')
      } catch {
        // History can be opened again after the link.
      }
    }
    const sent = await sendMagicLink(email.trim())
    if (!sent.ok) {
      setSaveState('error')
      setSaveMessage(sent.error)
      return
    }
    setSaveState('sent')
    setSaveMessage('Check your email for a sign-in link. This page will save the check when you come back.')
  }

  async function openHistory() {
    setEmailPurpose('history')
    setPhase('history')
    setHistory(null)
    setHistoryError('')
    setSaveState('idle')
    setSaveMessage('')
    if (!supabasePublicConfig()) {
      setHistoryError(AUTH_NOT_CONFIGURED)
      return
    }
    if (!session) return
    await showHistory(session)
  }

  function openSaved(check: SavedCheck) {
    const report = fullReportFromStored(check.result)
    if (report) {
      digReq.current += 1
      digState.current = 'idle'
      setScreen({
        domain: check.domain,
        homepageSupport: null,
        unbranded: {
          mode: 'unbranded',
          questions: [],
          answers: [],
          questionsGenerated: false,
          answered: null,
          answeredWhy: '',
          answeredLive: false,
          model: report.model,
          whoInstead: [],
          whoInsteadLive: false,
        },
        branded: null,
        omittedQuestions: true,
        omittedAnswers: true,
        omittedWhoInstead: true,
      })
      setFullReport(report)
      setGeminiMiss(null)
    setOpenaiPaused(false)
      setReportPhase('ready')
      setReportMessage('')
      setActiveMode('unbranded')
      setDigStatus('idle')
      setSavedId(check.id)
      setRuns(cleanRuns(check.result.runs, check.domain))
      setCheckedAt(check.createdAt)
      setUrl(check.domain)
      setPageText(null)
      setPins([])
      setEditingKey(null)
      setRanPins(null)
      setOwning(true)
      setOwnedSet(true)
      setQuestionsDirty(false)
      setQuestionsNote('')
      setAddText('')
      setAddThemeId(report.themes[0]?.id ?? 'problems')
      setSaveState('saved')
      setSaveMessage('Saved.')
      setPhase('result')
      return
    }
    setFullReport(null)
    setGeminiMiss(null)
    setOpenaiPaused(false)
    setReportPhase('idle')
    setReportMessage('')
    setPins([])
    setEditingKey(null)
    setRanPins(null)
    applySaved(check)
    setOwning(true)
    setOwnedSet(check.result.questionSetOwned === true)
    setQuestionsDirty(false)
    setQuestionsNote('')
    setAddText('')
    setAddThemeId('problems')
    setSaveState('saved')
    setSaveMessage('Saved.')
    setPhase('result')
  }

  function pinSignature(list: PinItem[] = pins): string {
    return list.map((pin) => `${pin.framing}:${pin.question}`).join('\n')
  }

  function reportPins(): RunPin[] {
    return pins.map((pin) => ({ question: pin.question, framing: pin.framing }))
  }

  async function onShowFullReport() {
    if (!screen || reportPhase === 'loading' || busy) return
    const signature = pinSignature()
    if (reportPhase === 'ready' && fullReport?.domain === screen.domain && signature === (ranPins ?? '')) return
    if (!supabasePublicConfig()) {
      setReportPhase('error')
      setReportMessage(AUTH_NOT_CONFIGURED)
      return
    }
    if (!session) {
      setEmailPurpose('report')
      setSaveState((prev) => (prev === 'email' || prev === 'sent' ? 'idle' : prev))
      setSaveMessage('')
      setReportPhase('email')
      setReportMessage('')
      return
    }
    setReportPhase('loading')
    setReportMessage('')
    const result = await fetchFullReport(screen.domain, session.accessToken, reportPins())
    if (result.ok) setRanPins(signature)
    applyReportResult(result)
  }

  async function onSignOut() {
    await signOut(session)
    setSession(null)
    setHistory(null)
  }

  function activeBeat() {
    if (!screen) return null
    return activeMode === 'branded' && screen.branded ? screen.branded : screen.unbranded
  }

  function ownedPayload(): OwnedQuestion[] {
    if (fullReport) return ownedFromReport(fullReport)
    const beat = activeBeat()
    if (!beat) return []
    return beat.questions.map((question, index) => ({
      question,
      themeId: beat.facts?.[index]?.id || landThemeId(question, beat.mode),
    }))
  }

  function applyQuestionSave(check: SavedCheck) {
    const report = fullReportFromStored(check.result)
    setSavedId(check.id)
    setOwnedSet(true)
    setQuestionsDirty(false)
    if (report) {
      setFullReport(report)
      setGeminiMiss(null)
    setOpenaiPaused(false)
      return
    }
    const reopened = screenFromSaved(check)
    setScreen({
      domain: reopened.domain,
      homepageSupport: reopened.homepageSupport,
      unbranded: reopened.unbranded,
      branded: reopened.branded,
      omittedQuestions: reopened.omittedQuestions,
      omittedAnswers: reopened.omittedAnswers,
      omittedWhoInstead: reopened.omittedWhoInstead,
    })
    setActiveMode(reopened.activeMode)
  }

  async function saveQuestions(): Promise<boolean> {
    if (!session || !savedId) {
      setQuestionsNote('Sign in to save these questions.')
      return false
    }
    const questions = ownedPayload()
    if (questions.length < 1) {
      setQuestionsNote('Keep at least one question.')
      return false
    }
    setQuestionsSaving(true)
    setQuestionsNote('')
    const saved = await updateCheckQuestions(
      session.accessToken,
      savedId,
      questions,
      fullReport ? undefined : activeBeat()?.mode,
    )
    setQuestionsSaving(false)
    if (!saved.ok) {
      setQuestionsNote(saved.error)
      return false
    }
    applyQuestionSave(saved.check)
    setQuestionsNote('Questions saved.')
    return true
  }

  function markQuestions(next: () => void) {
    next()
    setQuestionsDirty(true)
    setOwnedSet(true)
    setQuestionsNote('')
    setEditingKey(null)
    setEditText('')
  }

  function ownedFlatIndex(themeId: ThemeId, index: number, framing?: Framing): number {
    if (!fullReport) return -1
    const themeIndex = fullReport.themes.findIndex(
      (entry) => entry.id === themeId && (framing == null || entry.framing === framing),
    )
    if (themeIndex < 0) return -1
    const offset = fullReport.themes
      .slice(0, themeIndex)
      .reduce((sum, entry) => sum + entry.questions.length, 0)
    return offset + index
  }

  function onDeleteOwned(themeId: ThemeId, index: number, framing?: Framing) {
    if (!fullReport) return
    const target = ownedFlatIndex(themeId, index, framing)
    if (target < 0) return
    const owned = ownedFromReport(fullReport).filter((_item, itemIndex) => itemIndex !== target)
    if (owned.length < 1) return
    markQuestions(() => setFullReport(applyOwnedToReport(fullReport, owned)))
  }

  function onRenameOwned(themeId: ThemeId, index: number, framing?: Framing) {
    if (!fullReport) return
    const text = editText.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 240) return
    const target = ownedFlatIndex(themeId, index, framing)
    if (target < 0) return
    const flat = ownedFromReport(fullReport)
    const next = flat.map((item, itemIndex) =>
      itemIndex === target ? { question: text, themeId: item.themeId } : item,
    )
    const cleaned = cleanOwnedQuestions(next, fullReport.domain, OWNED_QUESTION_MAX)
    if (cleaned.length < next.length) {
      setQuestionsNote('That question is already in this set.')
      return
    }
    markQuestions(() => setFullReport(applyOwnedToReport(fullReport, cleaned)))
  }

  function onAddOwned() {
    if (!fullReport) return
    const text = addText.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 240) return
    const current = ownedFromReport(fullReport)
    if (current.length >= OWNED_QUESTION_MAX) return
    if (current.some((item) => item.question.toLowerCase() === text.toLowerCase())) {
      setQuestionsNote('That question is already in this set.')
      return
    }
    const cleaned = cleanOwnedQuestions(
      [...current, { question: text, themeId: addThemeId }],
      fullReport.domain,
      OWNED_QUESTION_MAX,
    )
    markQuestions(() => {
      setFullReport(applyOwnedToReport(fullReport, cleaned))
      setAddText('')
    })
  }

  function onDeleteShort(index: number) {
    if (!screen) return
    const beat = activeBeat()
    if (!beat || beat.questions.length < 2) return
    const owned = beat.questions
      .map((question, itemIndex) => ({
        question,
        themeId: beat.facts?.[itemIndex]?.id || landThemeId(question, beat.mode),
      }))
      .filter((_, itemIndex) => itemIndex !== index)
    const nextBeat = applyOwnedToBeat(beat, cleanOwnedQuestions(owned, screen.domain, SHORT_OWNED_MAX))
    markQuestions(() => {
      setScreen((prev) => {
        if (!prev) return prev
        return beat.mode === 'branded' ? { ...prev, branded: nextBeat } : { ...prev, unbranded: nextBeat }
      })
    })
  }

  function onRenameShort() {
    if (!screen || editingKey === null) return
    const beat = activeBeat()
    if (!beat) return
    const index = Number(editingKey.split(':')[1])
    if (!Number.isInteger(index) || index < 0) return
    const text = editText.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 240) return
    const owned = beat.questions.map((question, itemIndex) => ({
      question: itemIndex === index ? text : question,
      themeId: beat.facts?.[itemIndex]?.id || landThemeId(question, beat.mode),
    }))
    const cleaned = cleanOwnedQuestions(owned, screen.domain, SHORT_OWNED_MAX)
    if (cleaned.length < owned.length) {
      setQuestionsNote('That question is already in this set.')
      return
    }
    const nextBeat = applyOwnedToBeat(beat, cleaned)
    markQuestions(() => {
      setScreen((prev) => {
        if (!prev) return prev
        return beat.mode === 'branded' ? { ...prev, branded: nextBeat } : { ...prev, unbranded: nextBeat }
      })
    })
  }

  function onAddShort(event: FormEvent) {
    event.preventDefault()
    if (!screen) return
    const beat = activeBeat()
    if (!beat || beat.questions.length >= SHORT_OWNED_MAX) return
    const text = addText.replace(/\s+/g, ' ').trim()
    if (!text || text.length > 240) return
    if (beat.questions.some((question) => question.toLowerCase() === text.toLowerCase())) {
      setQuestionsNote('That question is already in this set.')
      return
    }
    const owned = [
      ...beat.questions.map((question, index) => ({
        question,
        themeId: beat.facts?.[index]?.id || landThemeId(question, beat.mode),
      })),
      { question: text, themeId: addThemeId },
    ]
    const nextBeat = applyOwnedToBeat(beat, cleanOwnedQuestions(owned, screen.domain, SHORT_OWNED_MAX))
    markQuestions(() => {
      setScreen((prev) => {
        if (!prev) return prev
        return beat.mode === 'branded' ? { ...prev, branded: nextBeat } : { ...prev, unbranded: nextBeat }
      })
      setAddText('')
    })
  }

  async function runOwnedReport() {
    if (!session) {
      setQuestionsNote('Sign in to run this question set.')
      return
    }
    if (!fullReport || busy) return
    const questions = ownedFromReport(fullReport)
    if (questions.length < 1) return
    setBusy(true)
    setQuestionsNote('')
    setReportMessage('')
    if (savedId) {
      const saved = await updateCheckQuestions(session.accessToken, savedId, questions)
      if (!saved.ok) {
        setBusy(false)
        setQuestionsNote(saved.error)
        return
      }
      setQuestionsDirty(false)
      setOwnedSet(true)
    }
    const result = await fetchOwnedReport(fullReport.domain, session.accessToken, questions, savedId)
    setBusy(false)
    if (result.ok) {
      setOwnedSet(true)
      setQuestionsDirty(false)
      if (result.checkId) setSavedId(result.checkId)
      if (!result.openaiPaused && result.runs.length > 0) setRuns(result.runs)
    }
    // This response's geminiMiss stays until the next stored load. Do not clear it here.
    applyReportResult(result)
  }

  async function runOwnedShort() {
    if (!session) {
      setQuestionsNote('Sign in to run this question set.')
      return
    }
    if (!screen || busy) return
    const beat = activeBeat()
    if (!beat || beat.questions.length < 1) return
    const questions = beat.questions
    setBusy(true)
    setQuestionsNote('')
    if (savedId) {
      const saved = await updateCheckQuestions(session.accessToken, savedId, ownedPayload(), beat.mode)
      if (!saved.ok) {
        setBusy(false)
        setQuestionsNote(saved.error)
        return
      }
      setQuestionsDirty(false)
      setOwnedSet(true)
    }
    const visibility = await fetchVisibility(screen.domain, beat.mode, session.accessToken, questions)
    if (!visibility.ok) {
      if (visibility.code === 'quota_exceeded') {
        setQuotaWall(true)
        setQuotaPlan(visibility.plan === 'paid' ? 'paid' : 'free')
      }
      setBusy(false)
      setQuestionsNote(visibility.ok ? '' : visibility.error)
      return
    }
    setQuotaWall(false)
    const homepage = await liveAnsweredByYou(screen.domain)
    const homepageSupport = homepage.ok
      ? `Supporting homepage fetch: ${verdictWord(homepage.answered)}. Page content only — not the model read.`
      : screen.homepageSupport
    const next = liveScreen(
      screen.domain,
      homepageSupport,
      beat.mode === 'unbranded' ? unbrandedBeat(screen.domain, visibility) : screen.unbranded,
      beat.mode === 'branded' ? brandedBeat(visibility) : screen.branded,
    )
    setScreen(next)
    setPhase('result')
    setOwnedSet(true)
    setQuestionsDirty(false)
    const draft = draftFromScreen(
      screen.domain,
      beat.mode,
      next.unbranded,
      next.branded,
      homepageSupport,
      config.storeHomepageSnippet ? pageText : null,
      true,
    )
    if (savedId) {
      const saved = await recordCheckRun(session.accessToken, savedId, draft)
      setBusy(false)
      if (!saved.ok) {
        setSaveState('error')
        setSaveMessage(saved.error)
        return
      }
      setRuns(cleanRuns(saved.check.result.runs, saved.check.domain))
      setSavedId(saved.check.id)
      setSaveState('saved')
      setSaveMessage('Saved.')
      return
    }
    setBusy(false)
    void persist(session, draft)
  }

  function onRunAgain() {
    if (busy) return
    const savedReport =
      owning && fullReport && screen && screen.unbranded.questions.length === 0 && !screen.branded?.questions.length
    if (savedReport) {
      void runOwnedReport()
      return
    }
    if (!screen) return
    if (owning && !fullReport && (ownedSet || questionsDirty)) {
      void runOwnedShort()
      return
    }
    if (activeMode === 'branded') {
      void showBranded(true, { autosave: true })
      return
    }
    void runCheck(screen.domain, { autosave: true })
  }

  useEffect(() => {
    document.title = STORY.documentTitle
  }, [])

  const land = activeMode === 'unbranded'
  const brandedLoading = activeMode === 'branded' && digStatus === 'loading'
  const beat = screen ? (land ? screen.unbranded : screen.branded) : null
  const emphasizeSave = !session && guestChecks >= config.freeChecksBeforeSave
  const authConfigured = supabasePublicConfig() !== null
  const reportOnly = Boolean(
    fullReport && screen && screen.unbranded.questions.length === 0 && !screen.branded?.questions.length,
  )
  const pinRunMatches = pinSignature() === (ranPins ?? '')
  const ownedCount = fullReport ? ownedFromReport(fullReport).length : (activeBeat()?.questions.length ?? 0)
  const questionToolsBusy = busy || questionsSaving
  const showDelta = owning && (ownedSet || runs.length > 0)
  const runPreview: CheckRun | null = (() => {
    if (runs.length > 0) return null
    if (reportOnly && fullReport) {
      const mentions = mentionsFromReport(fullReport, fullReport.domain)
      if (mentions.length === 0) return null
      return { at: checkedAt, mode: 'full', mentions }
    }
    if (!beat || beat.questions.length === 0) return null
    const mentions: CheckRun['mentions'] = beat.questions.map((question, index) => {
      const fact = factFor(beat.facts, index, question)
      const next: CheckRun['mentions'][number] = { question, whoInstead: fact?.whoInstead ?? [] }
      if (fact?.mention) next.mention = fact.mention
      return next
    })
    return { at: checkedAt, mode: beat.mode, mentions }
  })()
  const latestMode = (runs.length > 0 ? runs[runs.length - 1]?.mode : runPreview?.mode) ?? null
  const runAnswers =
    latestMode === 'full' && fullReport
      ? reportAnswers(fullReport)
      : latestMode === 'branded' && screen?.branded
        ? pairedAnswers(screen.branded.questions, screen.branded.answers)
        : []
  const reportEditor =
    owning && fullReport
      ? {
          disabled: questionToolsBusy,
          editingKey,
          editText,
          addText,
          addThemeId,
          atCap: ownedCount >= OWNED_QUESTION_MAX,
          canDelete: ownedCount > 1,
          onEdit: (key: string, question: string) => {
            setEditingKey(key)
            setEditText(question)
          },
          onEditText: setEditText,
          onRename: onRenameOwned,
          onDelete: onDeleteOwned,
          onAddText: setAddText,
          onAddTheme: setAddThemeId,
          onAdd: onAddOwned,
          onSave: () => {
            void saveQuestions()
          },
          saving: questionsSaving,
          saveDisabled: !questionsDirty,
        }
      : undefined

  function onPin(item: PinItem) {
    setPins((prev) => {
      if (prev.some((pin) => pin.key === item.key) || prev.length >= config.pinnedQuestionMax) return prev
      return [...prev, item]
    })
  }

  function onUnpin(key: string) {
    setPins((prev) => prev.filter((pin) => pin.key !== key))
    if (editingKey === key) {
      setEditingKey(null)
      setEditText('')
    }
  }

  function onEditPin(key: string, question: string) {
    const current = pins.find((pin) => pin.key === key)
    setEditingKey(key)
    setEditText(current?.question || question)
  }

  function onSavePin(item: PinItem) {
    setPins((prev) => {
      const without = prev.filter((pin) => pin.key !== item.key)
      if (!prev.some((pin) => pin.key === item.key) && without.length >= config.pinnedQuestionMax) return prev
      return [...without, item]
    })
    setEditingKey(null)
    setEditText('')
  }

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="logo" onClick={reset}>
          Grank
        </button>
        <div className="top-actions">
          <button type="button" className="text-btn" onClick={() => void openHistory()}>
            {config.copy.historyTitle}
          </button>
          {session?.user.email ? (
            <>
              <span className="whoami">{session.user.email}</span>
              <button type="button" className="text-btn" onClick={() => void onSignOut()}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
        <span className="badge site-badge">{STORY.headerBadge}</span>
      </header>

      {phase === 'history' ? (
        <main className="hero">
          <button type="button" className="back" onClick={reset}>
            ← Check a site
          </button>
          <h1>{config.copy.historyTitle}</h1>
          <p className="sub">Open a saved check, or run it again for a fresh read.</p>
          {historyError ? <p className="err">{historyError}</p> : null}
          {historyLoading ? <p className="status">Loading…</p> : null}
          {!session && authConfigured && !historyError ? (
            <EmailForm
              email={email}
              onEmail={setEmail}
              onSubmit={onEmail}
              saveState={saveState}
              saveMessage={saveMessage}
              submitLabel="Send magic link"
              hint="Sign in with a magic link to see saved checks. No password."
            />
          ) : null}
          {session && history && history.length === 0 ? <p className="muted">No saved checks yet.</p> : null}
          {history && history.length > 0 ? (
            <ul className="history">
              {history.map((check) => (
                <li key={check.id}>
                  <button type="button" className="history-item" onClick={() => openSaved(check)}>
                    <strong>{check.domain}</strong>
                    <span className={check.result?.report === 'full' ? 'full-badge' : undefined}>
                      {historyKind(check)}
                    </span>
                    <span>{formatWhen(check.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </main>
      ) : phase !== 'result' ? (
        <main className="hero home">
          <div className="above">
            <h1>{STORY.homeH1}</h1>
            <p className="sub">{STORY.homeSub}</p>

            <form className="cta" onSubmit={onSubmit} aria-busy={phase === 'loading' || busy}>
              <input
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder={STORY.urlPlaceholder}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Website URL"
              />
              <button type="submit" disabled={phase === 'loading' || busy}>
                {STORY.cta}
              </button>
            </form>

            {phase === 'loading' || busy ? (
              <p className="status" role="status">
                {STORY.homeLoading}
              </p>
            ) : null}
          {phase === 'error' && error ? <p className="err">{error}</p> : null}
          {upgradeNote && !quotaWall ? <p className="status">{upgradeNote}</p> : null}
          {quotaWall ? (
            <UpgradeWall
              config={config}
              plan={quotaPlan}
              note={upgradeNote}
              busy={upgradeBusy}
              onUpgrade={onUpgrade}
              showEmail={upgradeEmail && authConfigured}
              email={email}
              onEmail={setEmail}
              onSubmitEmail={onEmail}
              saveState={saveState}
              saveMessage={saveMessage}
            />
          ) : null}

          <p className="proof">{withOpenAI(STORY.homeProof)}</p>

          <div className="examples">
            <span className="muted lead">{STORY.exampleLead}</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="chip"
                onClick={() => {
                  setUrl(ex.url)
                  void runCheck(ex.url)
                }}
              >
                {ex.label}
              </button>
            ))}
            </div>
          </div>

          <section className="foil">
            <h2>{STORY.foilTitle}</h2>
            <p className="foil-body">{STORY.foilBody}</p>
            <p className="foil-foot">{STORY.foilFoot}</p>
          </section>
        </main>
      ) : !screen && reportPhase === 'loading' ? (
        <main className="result-wrap">
          <p className="status" role="status">
            {config.copy.fullReportLoading}
          </p>
        </main>
      ) : !screen && (reportPhase === 'error' || reportPhase === 'limit') ? (
        <main className="result-wrap">
          <button type="button" className="back" onClick={reset}>
            ← Check another site
          </button>
          {reportPhase === 'limit' ? <p className="why">{config.copy.fullReportLimitHit}</p> : null}
          {reportPhase === 'error' && reportMessage ? <p className="err">{reportMessage}</p> : null}
          {quotaWall ? (
            <UpgradeWall
              config={config}
              plan={quotaPlan}
              note={upgradeNote}
              busy={upgradeBusy}
              onUpgrade={onUpgrade}
              showEmail={upgradeEmail && authConfigured}
              email={email}
              onEmail={setEmail}
              onSubmitEmail={onEmail}
              saveState={saveState}
              saveMessage={saveMessage}
            />
          ) : null}
        </main>
      ) : screen && fullReport && reportOnly ? (
        <main className="result-wrap">
          <button type="button" className="back" onClick={reset}>
            ← Check another site
          </button>
          <article className="result">
            <div className="result-head">
              <div>
                <h1>{config.copy.fullReportTitle}</h1>
                <p className="engines">{screen.domain}</p>
              </div>
              <span className="badge live">Generated · OpenAI</span>
            </div>
            <p className="why">{config.copy.fullReportSub}</p>
            {showDelta ? (
              <RunHistoryPanel
                runs={runs}
                preview={runPreview}
                answers={runAnswers}
                copy={config.copy}
                summaryOnly
              />
            ) : null}
            <FullReportSection
              report={fullReport}
              copy={config.copy}
              themesOnly
              editor={reportEditor}
              runs={runs}
              preview={runPreview}
              geminiMiss={geminiMiss}
              openaiPaused={openaiPaused}
            />
            {owning ? (
              <div className="save-row">
                {openaiPaused ? <OpenAIPausedNote /> : null}
                <button type="button" onClick={onRunAgain} disabled={questionToolsBusy}>
                  {busy ? 'Generating…' : config.copy.runAgainCta}
                </button>
              </div>
            ) : null}
            {reportPhase === 'error' && reportMessage ? <p className="err">{reportMessage}</p> : null}
            {questionsNote ? <p className={questionsNote === 'Questions saved.' ? 'status' : 'err'}>{questionsNote}</p> : null}
          </article>
        </main>
      ) : screen ? (
        <main className="result-wrap">
          <button type="button" className="back" onClick={reset}>
            ← Check another site
          </button>
          <article className="result">
            <div className="result-head">
              <div>
                <h1>AI visibility for {screen.domain}</h1>
                <p className="engines">
                  {brandedLoading
                    ? STORY.digLoading
                    : beat?.answeredLive
                      ? `OpenAI · ${beat.model} · ${land ? 'Unbranded' : 'Branded'}`
                      : land
                        ? 'Model call failed — questions below are a labeled sample. Answered-by-you is unavailable.'
                        : STORY.digFail}
                </p>
              </div>
              <span className={`badge ${beat?.answeredLive ? 'live' : 'warn'}`}>
                {brandedLoading
                  ? 'Branded'
                  : beat?.answeredLive
                    ? `${land ? 'Unbranded' : 'Branded'} · Live model · gpt-4o-mini`
                    : 'Model unavailable'}
              </span>
            </div>

            <div className="segments" role="tablist" aria-label="Question set">
              <button
                type="button"
                role="tab"
                aria-selected={land}
                onClick={() => setActiveMode('unbranded')}
              >
                Unbranded
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!land}
                onClick={() => void showBranded(digStatus === 'error')}
              >
                Branded
              </button>
            </div>

            <section className="block beat" aria-busy={brandedLoading}>
              <p className="eyebrow">{land ? STORY.landEyebrow : STORY.digEyebrow}</p>
              <h2 className="beat-title">
                {land ? STORY.landTitle : STORY.digTitle}{' '}
                {beat?.questionsGenerated ? (
                  <span className="tag plain live">Generated · OpenAI</span>
                ) : land && beat && !screen.omittedQuestions ? (
                  <span className="tag plain">Sample</span>
                ) : null}
              </h2>
              <p className="why">{land ? STORY.landHelper : STORY.digHelper}</p>

              {brandedLoading ? <p className="status">{STORY.digLoading}</p> : null}
              {!brandedLoading && screen.omittedQuestions ? (
                <p className="why">Questions were not saved for this check.</p>
              ) : null}
              {!brandedLoading && !screen.omittedQuestions && land && beat && !beat.questionsGenerated ? (
                <p className="why">
                  Sample questions — generation failed, so these are not from the model.
                </p>
              ) : null}
              {!brandedLoading && !screen.omittedQuestions && !land && beat && !beat.questionsGenerated ? (
                <p className="why">{STORY.digFail}</p>
              ) : null}

              {!brandedLoading && !land && beat && beat.questions.length > 0 ? (
                <p className="why answer-helper">{STORY.answerHelper}</p>
              ) : null}

              {!brandedLoading && beat && beat.questions.length > 0 ? (
                <ul className={land ? undefined : 'answers'}>
                  {beat.questions.map((q, i) => {
                    const answer = land ? '' : (beat.answers[i] || '').trim()
                    const fact = factFor(beat.facts, i, q)
                    const gemini = land && beat.questionsGenerated ? beat.gemini : undefined
                    const rowKey = `${beat.mode}:${i}`
                    const pinned = pins.find((pin) => pin.key === rowKey)
                    const shown = pinned?.question || q
                    return (
                      <li key={rowKey} className={land ? (gemini ? 'q with-answer' : 'q') : 'q with-answer'}>
                        <div className="q-line">
                          <span className="tag plain q-badge">
                            {land ? STORY.landBadge : STORY.digBadge}
                          </span>
                          <span>{shown}</span>
                        </div>
                        {land && beat.questionsGenerated ? (
                          <UnbrandedAnswers
                            mention={fact?.mention}
                            whoInstead={fact?.whoInstead ?? []}
                            gemini={gemini}
                            index={i}
                            copy={config.copy}
                          />
                        ) : null}
                        {land ? null : (
                          <div className={answer ? 'answer' : 'answer miss'}>
                            {answer ? (
                              <div className="answer-meta">
                                <span className="tag plain live">{STORY.answerLabel}</span>
                              </div>
                            ) : null}
                            {answer && fact?.mention ? (
                              <MentionMark
                                mention={fact.mention}
                                whoInstead={fact.whoInstead}
                                framing="branded"
                                copy={config.copy}
                              />
                            ) : null}
                            <p className="answer-body">{answer || STORY.answerMiss}</p>
                          </div>
                        )}
                        {owning ? (
                          editingKey === `short:${i}` ? (
                            <div className="pin-edit">
                              <input
                                aria-label="Question"
                                value={editText}
                                maxLength={240}
                                disabled={questionToolsBusy}
                                onChange={(event) => setEditText(event.target.value)}
                              />
                              <button
                                type="button"
                                disabled={questionToolsBusy || !editText.replace(/\s+/g, ' ').trim()}
                                onClick={onRenameShort}
                              >
                                {config.copy.saveEditedQuestionCta}
                              </button>
                            </div>
                          ) : (
                            <div className="q-tools">
                              <button
                                type="button"
                                disabled={questionToolsBusy}
                                onClick={() => {
                                  setEditingKey(`short:${i}`)
                                  setEditText(q)
                                }}
                              >
                                {config.copy.editQuestionCta}
                              </button>
                              <button
                                type="button"
                                disabled={questionToolsBusy || beat.questions.length < 2}
                                onClick={() => onDeleteShort(i)}
                              >
                                {config.copy.deleteQuestionCta}
                              </button>
                            </div>
                          )
                        ) : (
                          <QuestionPinControls
                            rowKey={rowKey}
                            question={shown}
                            framing={beat.mode}
                            pins={pins}
                            max={config.pinnedQuestionMax}
                            editing={editingKey === rowKey}
                            editText={editText}
                            copy={config.copy}
                            disabled={busy}
                            onPin={onPin}
                            onUnpin={onUnpin}
                            onEdit={onEditPin}
                            onEditText={setEditText}
                            onSave={onSavePin}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : null}

              {owning && !brandedLoading && beat && !screen.omittedQuestions ? (
                <form className="owned-add" onSubmit={onAddShort}>
                  <label>
                    Theme
                    <select
                      aria-label="Theme"
                      value={addThemeId}
                      disabled={questionToolsBusy || beat.questions.length >= SHORT_OWNED_MAX}
                      onChange={(event) => setAddThemeId(event.target.value as ThemeId)}
                    >
                      {THEME_CATALOG.map((theme) => (
                        <option key={theme.id} value={theme.id}>
                          {theme.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    aria-label="New question"
                    value={addText}
                    maxLength={240}
                    disabled={questionToolsBusy || beat.questions.length >= SHORT_OWNED_MAX}
                    onChange={(event) => setAddText(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={questionToolsBusy || beat.questions.length >= SHORT_OWNED_MAX || !addText.trim()}
                  >
                    {config.copy.addQuestionCta}
                  </button>
                </form>
              ) : null}

              {land ? (
                <button type="button" className="ask" onClick={() => void showBranded()} disabled={busy}>
                  {STORY.ask}
                </button>
              ) : null}
              {!land && !brandedLoading && beat && !beat.questionsGenerated && !screen.omittedQuestions ? (
                <button type="button" className="ask" onClick={() => void showBranded(true)} disabled={busy}>
                  {STORY.ask}
                </button>
              ) : null}
            </section>

            {!brandedLoading && beat ? (
              <section className="block">
                <h2>
                  Answered by you?{' '}
                  <span className="tag plain">{land ? STORY.landBadge : STORY.digBadge}</span>
                  <span className={`tag plain ${beat.answeredLive ? 'live' : ''}`}>
                    {beat.answeredLive ? 'Live model' : 'Unavailable'}
                  </span>
                  {beat.answeredLive ? (
                    <span className="tag plain live">OpenAI · gpt-4o-mini</span>
                  ) : null}
                </h2>
                {screen.omittedAnswers ? (
                  <p className="why">The model read was not saved for this check.</p>
                ) : beat.answeredLive && beat.answered ? (
                  <div className={`signal ${beat.answered}`}>{verdictWord(beat.answered)}</div>
                ) : (
                  <div className="signal unavailable">Unavailable</div>
                )}
                {screen.omittedAnswers ? null : (
                  <p className="why">{!land && !beat.questionsGenerated ? STORY.digFail : beat.answeredWhy}</p>
                )}
                {!screen.omittedAnswers && !land && !beat.questionsGenerated && beat.answeredWhy !== STORY.digFail ? (
                  <p className="support">{beat.answeredWhy}</p>
                ) : null}
                <p className="support">
                  {land
                    ? 'This read is for the Unbranded questions on this screen.'
                    : 'This read is for the Branded questions on this screen.'}
                </p>
                {screen.homepageSupport ? <p className="support">{screen.homepageSupport}</p> : null}
              </section>
            ) : null}

            {showDelta ? (
              <RunHistoryPanel runs={runs} preview={runPreview} answers={runAnswers} copy={config.copy} />
            ) : null}

            <div className={`save-row${emphasizeSave && !savedId ? ' nudge' : ''}`}>
              {openaiPaused ? <OpenAIPausedNote /> : null}
              <button type="button" onClick={onRunAgain} disabled={questionToolsBusy}>
                {busy ? 'Generating…' : config.copy.runAgainCta}
              </button>
              {owning ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void saveQuestions()}
                  disabled={questionToolsBusy || !questionsDirty}
                >
                  {questionsSaving ? 'Saving…' : config.copy.saveQuestionsCta}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary"
                onClick={() => void onSave()}
                disabled={questionToolsBusy || saveState === 'saving'}
              >
                {saveState === 'saving' ? 'Saving…' : config.copy.saveCta}
              </button>
            </div>
            {emailPurpose === 'report' ? null : saveMessage && !(quotaWall && saveState === 'error') ? (
              <p className={saveState === 'error' ? 'err' : 'status'}>{saveMessage}</p>
            ) : saveMessage ? null : (
              <p className="footer-micro">
                {session
                  ? 'Run again checks the live model and saves a new result.'
                  : 'The first look does not need an account. Save keeps this check under your email.'}
              </p>
            )}
            {saveState === 'email' && emailPurpose === 'save' && authConfigured ? (
              <EmailForm
                email={email}
                onEmail={setEmail}
                onSubmit={onEmail}
                saveState={saveState}
                saveMessage=""
                submitLabel="Send magic link"
                hint=""
              />
            ) : null}
            {owning && questionsNote ? (
              <p className={questionsNote === 'Questions saved.' ? 'status' : 'err'}>{questionsNote}</p>
            ) : null}
            <div className="full-report-door">
              {owning ? (
                <p className="why">{config.copy.ownedQuestionsHint}</p>
              ) : (
                <>
                  <p className="why">{config.copy.editQuestionsHint}</p>
                  <PinnedRun pins={pins} copy={config.copy} disabled={busy} onUnpin={onUnpin} />
                </>
              )}
              <button
                type="button"
                className="ask"
                onClick={() => void onShowFullReport()}
                disabled={busy || reportPhase === 'loading' || reportPhase === 'limit' || (reportPhase === 'ready' && pinRunMatches)}
              >
                {reportPhase === 'loading'
                  ? config.copy.fullReportLoading
                  : pins.length > 0
                    ? config.copy.regenerateWithPinsCta
                    : config.copy.showFullReportCta}
              </button>
              {reportPhase === 'loading' ? (
                <p className="status" role="status">
                  {config.copy.fullReportLoading}
                </p>
              ) : null}
              {reportPhase === 'limit' ? <p className="why">{config.copy.fullReportLimitHit}</p> : null}
              {reportPhase === 'error' && reportMessage ? <p className="err">{reportMessage}</p> : null}
              {reportPhase === 'sent' && reportMessage ? <p className="status">{reportMessage}</p> : null}
              {(reportPhase === 'email' || reportPhase === 'sent') && emailPurpose === 'report' && authConfigured ? (
                <EmailForm
                  email={email}
                  onEmail={setEmail}
                  onSubmit={onEmail}
                  saveState={reportPhase === 'sent' ? 'sent' : reportMessage ? 'error' : 'idle'}
                  saveMessage={reportPhase === 'sent' ? '' : reportMessage}
                  submitLabel="Send magic link"
                  hint={config.copy.fullReportMagicLinkHint}
                />
              ) : null}
            </div>
            {fullReport && !reportOnly ? (
              <FullReportSection
                report={fullReport}
                copy={config.copy}
                geminiMiss={geminiMiss}
                openaiPaused={openaiPaused}
              />
            ) : null}
            {quotaWall ? (
              <UpgradeWall
                config={config}
                plan={quotaPlan}
                note={upgradeNote}
                busy={upgradeBusy}
                onUpgrade={onUpgrade}
                showEmail={upgradeEmail && authConfigured}
                email={email}
                onEmail={setEmail}
                onSubmitEmail={onEmail}
                saveState={saveState}
                saveMessage={saveMessage}
              />
            ) : null}
          </article>
        </main>
      ) : null}

      <footer className="foot">
        Grank — simple AEO for thin marketing teams. Unbranded category questions first, branded
        when you ask. One OpenAI model — not a blended score.
      </footer>
    </div>
  )
}

function EmailForm({
  email,
  onEmail,
  onSubmit,
  saveState,
  saveMessage,
  submitLabel,
  hint,
}: {
  email: string
  onEmail: (value: string) => void
  onSubmit: (e: FormEvent) => void
  saveState: SaveState
  saveMessage: string
  submitLabel: string
  hint: string
}) {
  return (
    <form className="email-form" onSubmit={onSubmit}>
      {hint ? <p className="why">{hint}</p> : null}
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@company.com"
        aria-label="Email"
        value={email}
        onChange={(e) => onEmail(e.target.value)}
        required
      />
      <button type="submit" disabled={saveState === 'sent'}>
        {saveState === 'sent' ? 'Link sent' : submitLabel}
      </button>
      {saveMessage ? <p className={saveState === 'error' ? 'err' : 'status'}>{saveMessage}</p> : null}
    </form>
  )
}

function UpgradeWall({
  config,
  plan,
  note,
  busy,
  onUpgrade,
  showEmail,
  email,
  onEmail,
  onSubmitEmail,
  saveState,
  saveMessage,
}: {
  config: ProductConfig
  plan: 'free' | 'paid' | null
  note: string
  busy: boolean
  onUpgrade: () => void
  showEmail: boolean
  email: string
  onEmail: (value: string) => void
  onSubmitEmail: (e: FormEvent) => void
  saveState: SaveState
  saveMessage: string
}) {
  return (
    <section className="foil upgrade" role="status">
      <h2>{config.copy.upgradeHeadline}</h2>
      <p>{config.copy.upgradeBody}</p>
      {plan === 'paid' ? (
        <p className="why">This paid plan has nothing left in the current window.</p>
      ) : (
        <button type="button" onClick={onUpgrade} disabled={busy}>
          {busy ? 'Opening checkout…' : config.copy.upgradeCta}
        </button>
      )}
      {note ? <p className="why">{note}</p> : null}
      {showEmail ? (
        <EmailForm
          email={email}
          onEmail={onEmail}
          onSubmit={onSubmitEmail}
          saveState={saveState}
          saveMessage={saveMessage}
          submitLabel="Send magic link"
          hint="Sign in with a magic link to upgrade. No password."
        />
      ) : null}
    </section>
  )
}

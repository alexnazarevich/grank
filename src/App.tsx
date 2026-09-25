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
  stashPendingSave,
  supabasePublicConfig,
  type AuthSession,
} from './authClient'
import { listChecks, saveCheck } from './checksClient'
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
      questionsGenerated: true,
      answered: visibility.answered,
      answeredWhy: visibility.why,
      answeredLive: true,
      model: visibility.model,
      whoInstead: visibility.whoInstead,
      whoInsteadLive: true,
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

let flushPromise: Promise<{ ok: true; check: SavedCheck } | { ok: false; error: string }> | null = null

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
      whoInstead: draft.whoInstead,
      whoInsteadLive: draft.whoInsteadLive,
      unbranded: draft.unbranded,
      branded: draft.branded,
    },
  }
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

  useEffect(() => {
    let alive = true
    void (async () => {
      const booted = await bootAuth()
      if (!alive) return
      setSession(booted.session)
      let openHistoryAfter = false
      try {
        openHistoryAfter = sessionStorage.getItem(AFTER_LOGIN_KEY) === 'history'
      } catch {
        openHistoryAfter = false
      }
      if (booted.session && booted.pending) {
        setSaveState('saving')
        const saved = await flushPending(booted.session, booted.pending)
        if (!alive) return
        if (saved.ok) {
          applySaved(saved.check)
          setSaveState('saved')
          setSaveMessage('Saved.')
          setPhase('history')
          await showHistory(booted.session)
        } else {
          applySaved(savedFromDraft(booted.pending))
          setSavedId(null)
          setSaveState('error')
          setSaveMessage(saved.error)
          setPhase('result')
        }
      } else if (booted.session && openHistoryAfter) {
        try {
          sessionStorage.removeItem(AFTER_LOGIN_KEY)
        } catch {
          // History can be opened again after the link.
        }
        setPhase('history')
        await showHistory(booted.session)
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
    setUrl(check.domain)
    setPageText(null)
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
    setActiveMode('unbranded')
    digState.current = 'idle'
    setDigStatus('idle')
    digReq.current += 1
    const keep = Boolean(opts?.autosave && screen)
    setBusy(true)
    if (!keep) setPhase('loading')

    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain, 'unbranded'),
      liveAnsweredByYou(domain),
    ])
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
    const domain = screen.domain
    const req = ++digReq.current
    digState.current = 'loading'
    setDigStatus('loading')
    setBusy(true)
    setSavedId(null)
    setSaveState('idle')
    setSaveMessage('')
    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain, 'branded'),
      liveAnsweredByYou(domain),
    ])
    if (req !== digReq.current) return
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
    setSaveState('idle')
    setSaveMessage('')
    setPageText(null)
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
      setSaveState('error')
      setSaveMessage('Enter a valid email.')
      return
    }
    if (!supabasePublicConfig()) {
      setSaveState('error')
      setSaveMessage(AUTH_NOT_CONFIGURED)
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
    applySaved(check)
    setSaveState('saved')
    setSaveMessage('Saved.')
    setPhase('result')
  }

  async function onSignOut() {
    await signOut(session)
    setSession(null)
    setHistory(null)
  }

  function onRunAgain() {
    if (!screen || busy) return
    if (activeMode === 'branded') {
      void showBranded(true, { autosave: true })
      return
    }
    void runCheck(screen.domain, { autosave: true })
  }

  const land = activeMode === 'unbranded'
  const brandedLoading = activeMode === 'branded' && digStatus === 'loading'
  const beat = screen ? (land ? screen.unbranded : screen.branded) : null
  const emphasizeSave = !session && guestChecks >= config.freeChecksBeforeSave
  const authConfigured = supabasePublicConfig() !== null

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
        <span className="badge">Unbranded first · Branded on ask · OpenAI gpt-4o-mini</span>
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
                    <span>{check.mode === 'branded' ? 'Branded' : 'Unbranded'}</span>
                    <span>{formatWhen(check.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </main>
      ) : phase !== 'result' ? (
        <main className="hero">
          <h1>See if AI answers with you</h1>
          <p className="sub">{STORY.homeSub}</p>

          <form className="cta" onSubmit={onSubmit}>
            <input
              type="text"
              inputMode="url"
              placeholder="https://yourbrand.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Website URL"
            />
            <button type="submit" disabled={phase === 'loading' || busy}>
              {phase === 'loading' || busy ? 'Generating…' : 'Check visibility'}
            </button>
          </form>

          {phase === 'loading' || busy ? <p className="status">Generating questions…</p> : null}
          {phase === 'error' && error ? <p className="err">{error}</p> : null}

          <div className="examples">
            <span className="muted">Try an example:</span>
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
                Try: {ex.label}
              </button>
            ))}
          </div>

          <p className="proof">{STORY.proof}</p>

          <section className="foil">
            <h2>Built for thin teams</h2>
            <p>
              “Are we in AI answers?” shouldn’t need a $499 demo or a prompt lab. Suites sell ops.
              You need a glance: category questions about what you solve, then — if you want —
              questions that name your brand.
            </p>
            <p className="muted small">
              Not Cognizo/Profound suite pricing — and simpler than Gumshoe’s audit setup.
            </p>
          </section>
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
            <p className="proof in-result">{STORY.proof}</p>

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
                    return (
                      <li key={`${beat.mode}-${i}`} className={land ? 'q' : 'q with-answer'}>
                        <div className="q-line">
                          <span className="tag plain q-badge">
                            {land ? STORY.landBadge : STORY.digBadge}
                          </span>
                          <span>{q}</span>
                        </div>
                        {land ? null : (
                          <div className={answer ? 'answer' : 'answer miss'}>
                            {answer ? (
                              <div className="answer-meta">
                                <span className="tag plain live">{STORY.answerLabel}</span>
                              </div>
                            ) : null}
                            <p className="answer-body">{answer || STORY.answerMiss}</p>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
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

            {land && beat ? (
              <section className="block">
                <h2>
                  Who shows up instead{' '}
                  <span className={`tag plain ${beat.whoInsteadLive ? 'live' : ''}`}>
                    {beat.whoInsteadLive ? 'Generated · OpenAI' : 'Unavailable'}
                  </span>
                </h2>
                {screen.omittedWhoInstead ? (
                  <p className="why">Who-instead was not saved for this check.</p>
                ) : beat.whoInstead.length > 0 ? (
                  <ul className="who">
                    {beat.whoInstead.map((name) => (
                      <li key={name}>
                        <strong>{name}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="why">Couldn’t find alternatives</p>
                )}
              </section>
            ) : null}

            <div className={`save-row${emphasizeSave && !savedId ? ' nudge' : ''}`}>
              <button type="button" onClick={onRunAgain} disabled={busy}>
                {busy ? 'Generating…' : config.copy.runAgainCta}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void onSave()}
                disabled={busy || saveState === 'saving'}
              >
                {saveState === 'saving' ? 'Saving…' : config.copy.saveCta}
              </button>
            </div>
            {saveMessage ? (
              <p className={saveState === 'error' ? 'err' : 'status'}>{saveMessage}</p>
            ) : (
              <p className="footer-micro">
                {session
                  ? 'Run again checks the live model and saves a new result.'
                  : 'The first look does not need an account. Save keeps this check under your email.'}
              </p>
            )}
            {saveState === 'email' && authConfigured ? (
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
            {config.paywallEnabled ? <UpgradeStub config={config} /> : null}
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

function UpgradeStub({ config }: { config: ProductConfig }) {
  const [note, setNote] = useState('')
  async function onUpgrade() {
    setNote('')
    try {
      const res = await fetch('/api/billing', { headers: { Accept: 'application/json' } })
      const data = (await res.json()) as { error?: string; paywallEnabled?: boolean }
      setNote(data.error || (data.paywallEnabled ? 'Checkout is not available yet.' : ''))
    } catch {
      setNote('Checkout is not available yet.')
    }
  }
  return (
    <section className="foil upgrade">
      <h2>{config.copy.upgradeHeadline}</h2>
      <p>{config.copy.upgradeBody}</p>
      <button type="button" onClick={() => void onUpgrade()}>
        {config.copy.upgradeCta}
      </button>
      {note ? <p className="why">{note}</p> : null}
    </section>
  )
}

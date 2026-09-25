import { useRef, useState } from 'react'
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
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error'
type DigStatus = 'idle' | 'loading' | 'ready' | 'error'

type Screen = {
  domain: string
  homepageSupport: string | null
  unbranded: ModeBeat
  branded: ModeBeat | null
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
    questionsGenerated: false,
    answered: null,
    answeredWhy: visibility.ok ? STORY.digFail : visibility.error,
    answeredLive: false,
    model: null,
    whoInstead: [],
    whoInsteadLive: false,
  }
}

export default function App() {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('home')
  const [screen, setScreen] = useState<Screen | null>(null)
  const [error, setError] = useState('')
  const [activeMode, setActiveMode] = useState<VisibilityMode>('unbranded')
  const [digStatus, setDigStatus] = useState<DigStatus>('idle')
  const digReq = useRef(0)
  const digState = useRef<DigStatus>('idle')

  async function runCheck(raw: string) {
    const domain = normalizeUrl(raw)
    if (!domain) {
      setError('That URL didn’t load. Try again or use an example.')
      setPhase('error')
      setScreen(null)
      return
    }
    setError('')
    setPhase('loading')
    setActiveMode('unbranded')
    digState.current = 'idle'
    setDigStatus('idle')
    digReq.current += 1

    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain, 'unbranded'),
      liveAnsweredByYou(domain),
    ])
    const homepageSupport = homepage.ok
      ? `Supporting homepage fetch: ${verdictWord(homepage.answered)}. Page content only — not the model read.`
      : null
    setScreen({
      domain,
      homepageSupport,
      unbranded: unbrandedBeat(domain, visibility),
      branded: null,
    })
    setPhase('result')
  }

  async function showBranded(force = false) {
    if (!screen) return
    setActiveMode('branded')
    if (!force && digState.current === 'ready' && screen.branded?.questionsGenerated) return
    if (!force && digState.current === 'loading') return
    const domain = screen.domain
    const req = ++digReq.current
    digState.current = 'loading'
    setDigStatus('loading')
    const visibility = await fetchVisibility(domain, 'branded')
    if (req !== digReq.current) return
    const beat = brandedBeat(visibility)
    const next = beat.questionsGenerated ? 'ready' : 'error'
    digState.current = next
    setScreen((prev) => (prev && prev.domain === domain ? { ...prev, branded: beat } : prev))
    setDigStatus(next)
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
    setActiveMode('unbranded')
    setDigStatus('idle')
  }

  const land = activeMode === 'unbranded'
  const brandedLoading = activeMode === 'branded' && digStatus === 'loading'
  const beat = screen ? (land ? screen.unbranded : screen.branded) : null

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="logo" onClick={reset}>
          Grank
        </button>
        <span className="badge">Unbranded first · Branded on ask · OpenAI gpt-4o-mini</span>
      </header>

      {phase !== 'result' ? (
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
            <button type="submit" disabled={phase === 'loading'}>
              {phase === 'loading' ? 'Generating…' : 'Check visibility'}
            </button>
          </form>

          {phase === 'loading' ? <p className="status">Generating questions…</p> : null}
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
                ) : land && beat ? (
                  <span className="tag plain">Sample</span>
                ) : null}
              </h2>
              <p className="why">{land ? STORY.landHelper : STORY.digHelper}</p>

              {brandedLoading ? <p className="status">{STORY.digLoading}</p> : null}
              {!brandedLoading && land && beat && !beat.questionsGenerated ? (
                <p className="why">
                  Sample questions — generation failed, so these are not from the model.
                </p>
              ) : null}
              {!brandedLoading && !land && beat && !beat.questionsGenerated ? (
                <p className="why">{STORY.digFail}</p>
              ) : null}

              {!brandedLoading && beat && beat.questions.length > 0 ? (
                <ul>
                  {beat.questions.map((q, i) => (
                    <li key={`${beat.mode}-${i}`} className="q">
                      <span className="tag plain q-badge">
                        {land ? STORY.landBadge : STORY.digBadge}
                      </span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {land ? (
                <button type="button" className="ask" onClick={() => void showBranded()}>
                  {STORY.ask}
                </button>
              ) : null}
              {!land && !brandedLoading && beat && !beat.questionsGenerated ? (
                <button type="button" className="ask" onClick={() => void showBranded(true)}>
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
                {beat.answeredLive && beat.answered ? (
                  <div className={`signal ${beat.answered}`}>{verdictWord(beat.answered)}</div>
                ) : (
                  <div className="signal unavailable">Unavailable</div>
                )}
                <p className="why">{!land && !beat.questionsGenerated ? STORY.digFail : beat.answeredWhy}</p>
                {!land && !beat.questionsGenerated && beat.answeredWhy !== STORY.digFail ? (
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
                {beat.whoInstead.length > 0 ? (
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

            <p className="footer-micro">
              Save / re-run needs an account later. First aha stays free of setup wizards.
            </p>
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

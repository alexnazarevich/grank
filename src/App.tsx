import { useState } from 'react'
import type { FormEvent } from 'react'
import { EXAMPLES, normalizeUrl, stubQuestionsFor, type AhaResult, type Answered } from './demoData'
import { liveAnsweredByYou } from './liveAnswered'
import { fetchVisibility } from './visibilityClient'
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error'

function verdictWord(answered: Answered): string {
  if (answered === 'yes') return 'Yes'
  if (answered === 'partial') return 'Partial'
  return 'No'
}

export default function App() {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('home')
  const [result, setResult] = useState<AhaResult | null>(null)
  const [error, setError] = useState('')

  async function runCheck(raw: string) {
    const domain = normalizeUrl(raw)
    if (!domain) {
      setError('That URL didn’t load. Try again or use an example.')
      setPhase('error')
      setResult(null)
      return
    }
    setError('')
    setPhase('loading')

    const [visibility, homepage] = await Promise.all([
      fetchVisibility(domain),
      liveAnsweredByYou(domain),
    ])
    const stubs = stubQuestionsFor(domain)
    const homepageSupport = homepage.ok
      ? `Supporting homepage fetch: ${verdictWord(homepage.answered)}. Page content only — not the model read.`
      : null

    if (visibility.ok) {
      setResult({
        domain,
        questions: visibility.questions,
        questionsGenerated: true,
        answered: visibility.answered,
        answeredWhy: visibility.why,
        answeredLive: true,
        model: visibility.model,
        whoInstead: stubs.whoInstead,
        homepageSupport,
      })
    } else {
      setResult({
        domain,
        questions: stubs.questions,
        questionsGenerated: false,
        answered: null,
        answeredWhy: visibility.error,
        answeredLive: false,
        model: null,
        whoInstead: stubs.whoInstead,
        homepageSupport,
      })
    }
    setPhase('result')
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
    setPhase('home')
    setResult(null)
    setError('')
  }

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="logo" onClick={reset}>
          Grank
        </button>
        <span className="badge">
          Questions: Generated · OpenAI · Answered-by-you: Live model · Who-instead: Sample
        </span>
      </header>

      {phase !== 'result' ? (
        <main className="hero">
          <h1>See if AI answers with you</h1>
          <p className="sub">
            Paste a URL. Get questions generated for your site, a live model read on whether you’re
            in the answer, and a sample of who shows up instead — without setup.
          </p>

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

          <p className="proof">
            Questions are generated for your site with <strong>gpt-4o-mini</strong>. Answered-by-you
            is a <strong>live model</strong> read (OpenAI). Who shows up instead is still a{' '}
            <strong>sample</strong>.
          </p>

          <section className="foil">
            <h2>Built for thin teams</h2>
            <p>
              “Are we in AI answers?” shouldn’t need a $499 demo or a prompt lab. Suites sell ops.
              You need a glance: your site → questions generated for you → are you answered → who
              shows up instead (sample).
            </p>
            <p className="muted small">
              Not Cognizo/Profound suite pricing — and simpler than Gumshoe’s audit setup.
            </p>
          </section>
        </main>
      ) : result ? (
        <main className="result-wrap">
          <button type="button" className="back" onClick={reset}>
            ← Check another site
          </button>
          <article className="result">
            <div className="result-head">
              <div>
                <h1>AI visibility for {result.domain}</h1>
                <p className="engines">
                  {result.answeredLive
                    ? `OpenAI · ${result.model}`
                    : 'Model call failed — questions below are a labeled sample'}
                </p>
              </div>
              <span className={`badge ${result.answeredLive ? 'live' : 'warn'}`}>
                {result.answeredLive ? 'Live model · gpt-4o-mini' : 'Model unavailable'}
              </span>
            </div>

            <section className="block">
              <h2>
                Questions people ask{' '}
                <span className={`tag plain ${result.questionsGenerated ? 'live' : ''}`}>
                  {result.questionsGenerated ? 'Generated · OpenAI' : 'Sample'}
                </span>
              </h2>
              {!result.questionsGenerated ? (
                <p className="why">Sample questions — generation failed, so these are not from the model.</p>
              ) : null}
              <ul>
                {result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </section>

            <section className="block">
              <h2>
                Answered by you?{' '}
                <span className={`tag plain ${result.answeredLive ? 'live' : ''}`}>
                  {result.answeredLive ? 'Live model' : 'Unavailable'}
                </span>
                {result.answeredLive ? (
                  <span className="tag plain live">OpenAI · gpt-4o-mini</span>
                ) : null}
              </h2>
              {result.answeredLive && result.answered ? (
                <div className={`signal ${result.answered}`}>{verdictWord(result.answered)}</div>
              ) : (
                <div className="signal unavailable">Unavailable</div>
              )}
              <p className="why">{result.answeredWhy}</p>
              {result.homepageSupport ? <p className="support">{result.homepageSupport}</p> : null}
            </section>

            <section className="block">
              <h2>
                Who shows up instead <span className="tag plain">Sample</span>
              </h2>
              <ul className="who">
                {result.whoInstead.map((w) => (
                  <li key={w.name}>
                    <strong>{w.name}</strong>
                    <span>{w.note}</span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="footer-micro">
              Save / re-run needs an account later. First aha stays free of setup wizards.
            </p>
          </article>
        </main>
      ) : null}

      <footer className="foot">
        Grank — simple AEO for thin marketing teams. Live questions and a live model read.
        Who-instead is a sample — not a multi-engine suite.
      </footer>
    </div>
  )
}

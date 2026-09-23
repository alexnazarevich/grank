import { useState } from 'react'
import type { FormEvent } from 'react'
import { EXAMPLES, normalizeUrl, stubQuestionsFor, type AhaResult } from './demoData'
import { liveAnsweredByYou } from './liveAnswered'
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error'

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
    const q = stubQuestionsFor(domain)
    const live = await liveAnsweredByYou(domain)
    setResult({
      domain,
      ...q,
      answered: live.answered,
      answeredWhy: live.answeredWhy,
      enginesChecked: [live.sourceLabel],
      answeredLive: live.ok,
    })
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
        <span className="badge">ANSWERED-BY-YOU: LIVE FETCH · OTHER BLOCKS: STUBS</span>
      </header>

      {phase !== 'result' ? (
        <main className="hero">
          <h1>See if AI answers with you</h1>
          <p className="sub">
            Paste a URL. Get a clear read on sample questions, whether you’re in the answer, and who
            shows up instead — without setup.
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
              {phase === 'loading' ? 'Checking…' : 'Check visibility'}
            </button>
          </form>

          {phase === 'loading' ? (
            <p className="status">Fetching your homepage for a live answered-by-you signal…</p>
          ) : null}
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
            Answered-by-you uses a <strong>live homepage fetch</strong> (single source). Sample
            questions and “who shows up instead” are still labeled stubs — never “11 models”
            theater.
          </p>

          <section className="foil">
            <h2>Built for thin teams</h2>
            <p>
              “Are we in AI answers?” shouldn’t need a $499 demo or a prompt lab. Suites sell ops.
              You need a glance: your site → sample questions → are you answered → who shows up
              instead.
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
                <p className="engines">Signal: {result.enginesChecked.join(', ')}</p>
              </div>
              <span className={`badge ${result.answeredLive ? 'live' : 'warn'}`}>
                {result.answeredLive ? 'Answered-by-you: live' : 'Fetch failed'}
              </span>
            </div>

            <section className="block">
              <h2>Questions people ask <span className="tag">stub</span></h2>
              <ul>
                {result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </section>

            <section className="block">
              <h2>
                Answered by you?{' '}
                <span className="tag live">{result.answeredLive ? 'live' : 'fallback'}</span>
              </h2>
              <div className={`signal ${result.answered}`}>
                {result.answered === 'yes' ? 'Yes' : result.answered === 'partial' ? 'Partial' : 'No'}
              </div>
              <p className="why">{result.answeredWhy}</p>
            </section>

            <section className="block">
              <h2>Who shows up instead <span className="tag">stub</span></h2>
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
        Grank — simple AEO for thin marketing teams. One live homepage signal; not a multi-engine
        suite.
      </footer>
    </div>
  )
}

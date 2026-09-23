import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { EXAMPLES, parseSite, stubQuestions, stubWhoInstead, type AhaResult } from './demoData'
import { liveAnsweredByYou } from './liveAnswered'
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error'

export default function App() {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('home')
  const [result, setResult] = useState<AhaResult | null>(null)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  function runCheck(raw: string) {
    const site = parseSite(raw)
    if (!site) {
      abortRef.current?.abort()
      requestRef.current += 1
      setError('That URL didn’t load. Try again or use an example.')
      setPhase('error')
      setResult(null)
      return
    }

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const requestId = ++requestRef.current
    setError('')
    setPhase('loading')

    void liveAnsweredByYou(site.href, site.domain, ctrl.signal)
      .then((live) => {
        if (requestId !== requestRef.current) return
        setResult({
          domain: site.domain,
          questions: stubQuestions(site.domain),
          answered: live.answered,
          answeredWhy: live.answeredWhy,
          whoInstead: stubWhoInstead(site.domain),
          enginesChecked: live.enginesChecked,
        })
        setPhase('result')
      })
      .catch((err: unknown) => {
        if (requestId !== requestRef.current) return
        if (err instanceof Error && err.name === 'AbortError') return
        setResult(null)
        setError('That URL didn’t load. Try again or use an example.')
        setPhase('error')
      })
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!url.trim()) {
      setError('Add a website to check.')
      setPhase('error')
      return
    }
    runCheck(url)
  }

  function reset() {
    abortRef.current?.abort()
    requestRef.current += 1
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
        <span className="badge live">Answered-by-you live · other blocks stub</span>
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
            <p className="status">Reading the homepage for brand mentions…</p>
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
                  runCheck(ex.url)
                }}
              >
                Try: {ex.label}
              </button>
            ))}
          </div>

          <p className="proof">
            Answered-by-you reads the homepage (not ChatGPT or Perplexity). Questions and who shows
            up instead stay labeled stubs — never “11 models” theater.
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
                <p className="engines">Engines checked: {result.enginesChecked.join(', ')}</p>
              </div>
            </div>

            <section className="block">
              <h2>
                Questions people ask
                <span className="tag stub">Stub</span>
              </h2>
              <ul>
                {result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </section>

            <section className="block">
              <h2>
                Answered by you?
                <span className="tag live">Live</span>
              </h2>
              <div className={`signal ${result.answered}`}>
                {result.answered === 'yes' ? 'Yes' : result.answered === 'partial' ? 'Partial' : 'No'}
              </div>
              <p className="why">{result.answeredWhy}</p>
            </section>

            <section className="block">
              <h2>
                Who shows up instead
                <span className="tag stub">Stub</span>
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
        Grank — simple AEO for thin marketing teams. Not a live multi-engine AEO suite.
      </footer>
    </div>
  )
}

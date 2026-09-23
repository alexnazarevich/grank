import { useState } from 'react'
import type { FormEvent } from 'react'
import { EXAMPLES, normalizeUrl, stubForDomain, type AhaResult } from './demoData'
import './App.css'

type Phase = 'home' | 'loading' | 'result' | 'error'

export default function App() {
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('home')
  const [result, setResult] = useState<AhaResult | null>(null)
  const [error, setError] = useState('')

  function runCheck(raw: string) {
    const domain = normalizeUrl(raw)
    if (!domain) {
      setError('That URL didn’t load. Try again or use an example.')
      setPhase('error')
      setResult(null)
      return
    }
    setError('')
    setPhase('loading')
    const canned = EXAMPLES.find((e) => normalizeUrl(e.url) === domain)
    window.setTimeout(() => {
      setResult(canned ? canned.result : stubForDomain(domain))
      setPhase('result')
    }, 700)
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
        <span className="badge">SAMPLE / DEMO · labeled stubs</span>
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
            <p className="status">Checking how AI might talk about you…</p>
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
            Demo results use labeled sample / stubbed model output. We show the engines we actually
            check — never “11 models” theater.
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
              <span className="badge warn">Sample / demo data</span>
            </div>

            <section className="block">
              <h2>Questions people ask</h2>
              <ul>
                {result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </section>

            <section className="block">
              <h2>Answered by you?</h2>
              <div className={`signal ${result.answered}`}>
                {result.answered === 'yes' ? 'Yes' : result.answered === 'partial' ? 'Partial' : 'No'}
              </div>
              <p className="why">{result.answeredWhy}</p>
            </section>

            <section className="block">
              <h2>Who shows up instead</h2>
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

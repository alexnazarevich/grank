import type { ResultModel } from './savedResult.ts'
import type { Answered } from './demoData.ts'

function verdictWord(answered: Answered): string {
  if (answered === 'yes') return 'Yes'
  if (answered === 'partial') return 'Partial'
  return 'No'
}

export default function ResultCard({ view }: { view: ResultModel }) {
  return (
    <article className="result">
      <div className="result-head">
        <div>
          <h1>AI visibility for {view.domain}</h1>
          <p className="engines">
            {view.answeredLive
              ? `${view.modeLabel} · OpenAI · ${view.model || 'gpt-4o-mini'}`
              : 'Model call failed — questions below are a labeled sample. Answered-by-you is unavailable.'}
          </p>
        </div>
        <span className="badge-row">
          <span className={`badge ${view.answeredLive ? 'live' : 'warn'}`}>
            {view.answeredLive ? `Live model · ${view.model || 'gpt-4o-mini'}` : 'Model unavailable'}
          </span>
          <span className="badge">{view.modeLabel}</span>
        </span>
      </div>

      <section className="block">
        <h2>
          Questions people ask{' '}
          <span className={`tag plain ${view.questionsLive ? 'live' : ''}`}>{view.questionsLabel}</span>
        </h2>
        {view.questionsNote ? <p className="why">{view.questionsNote}</p> : null}
        {view.questions.length > 0 ? (
          <ul>
            {view.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="block">
        <h2>
          Answered by you?{' '}
          <span className={`tag plain ${view.answeredLive ? 'live' : ''}`}>{view.answeredLabel}</span>
          {view.answeredLive && view.model ? (
            <span className="tag plain live">OpenAI · {view.model}</span>
          ) : null}
        </h2>
        {view.answeredLive && view.answered ? (
          <div className={`signal ${view.answered}`}>{verdictWord(view.answered)}</div>
        ) : (
          <div className="signal unavailable">Unavailable</div>
        )}
        {view.answeredWhy ? <p className="why">{view.answeredWhy}</p> : null}
        {view.homepageSupport ? <p className="support">{view.homepageSupport}</p> : null}
      </section>

      <section className="block">
        <h2>
          Who shows up instead{' '}
          <span className={`tag plain ${view.whoInsteadLive ? 'live' : ''}`}>{view.whoInsteadLabel}</span>
        </h2>
        {view.whoInstead.length > 0 ? (
          <ul className="who">
            {view.whoInstead.map((name) => (
              <li key={name}>
                <strong>{name}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="why">{view.whoInsteadEmpty}</p>
        )}
      </section>
    </article>
  )
}

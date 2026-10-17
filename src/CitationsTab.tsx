import { useState } from 'react'
import {
  CITATION_COPY,
  chipAriaLabel,
  citationTab,
  questionCitationViews,
  type CitedSite,
} from './citations.ts'
import type { CitationEngine, FullReport, FullReportQuestion } from './fullReport.ts'

function SourceLink({ url, title, domain, engine }: { url: string; title: string; domain: string; engine?: CitationEngine }) {
  const text = title.trim() || domain
  return (
    <span className="citation-link">
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={chipAriaLabel(domain)}>
        {text}
      </a>
      {engine ? <span className="tag plain">{engine === 'chatgpt' ? 'ChatGPT' : 'Gemini'}</span> : null}
    </span>
  )
}

function SiteRow({ site }: { site: CitedSite }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={site.own ? 'citation-site citation-own' : 'citation-site'}>
      <div className="citation-site-head">
        <strong>{site.domain}</strong>
        {site.own ? <span className="tag plain">{CITATION_COPY.yourSite}</span> : null}
        {site.counts.map((count) => (
          <span key={count.engine} className="citation-count">
            {count.text}
          </span>
        ))}
        <button type="button" className="report-q-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? CITATION_COPY.hideQuestions : CITATION_COPY.showQuestions}
        </button>
      </div>
      {open ? (
        <ul className="citation-questions">
          {site.questions.map((row) => (
            <li key={row.question}>
              <p>{row.question}</p>
              <div className="citation-sources">
                {row.sources.map((item) => (
                  <SourceLink
                    key={`${item.engine}:${item.source.url}`}
                    url={item.source.url}
                    title={item.source.title}
                    domain={item.source.domain}
                    engine={item.engine}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function CitationsPanel({ report }: { report: FullReport }) {
  const tab = citationTab(report)
  if (tab.kind === 'before') return <p className="why">{CITATION_COPY.before}</p>
  if (tab.kind === 'unbranded') return <p className="why">{CITATION_COPY.unbrandedOnly}</p>
  return (
    <div className="citations-panel">
      <p className="why">{tab.engines}</p>
      <p className="why">{tab.helper}</p>
      {tab.summaries.map((line) => (
        <p key={line.engine}>{line.text}</p>
      ))}
      <h3>{CITATION_COPY.sitesTitle}</h3>
      {tab.neither ? <p>{tab.neither}</p> : null}
      {tab.sites.length === 0 ? <p className="why">{CITATION_COPY.noSources}</p> : null}
      <ul className="citation-sites">
        {tab.sites.map((site) => (
          <SiteRow key={site.domain} site={site} />
        ))}
      </ul>
      <p className="why">{tab.footnote}</p>
    </div>
  )
}

/** Searched blocks under the plain engine block. Follows that engine's chip. */
export function CitationAnswers({
  report,
  item,
  showChatGpt,
  showGemini,
}: {
  report: FullReport
  item: FullReportQuestion
  showChatGpt: boolean
  showGemini: boolean
}) {
  const views = questionCitationViews(report, item).filter((view) =>
    view.engine === 'chatgpt' ? showChatGpt : showGemini,
  )
  if (views.length === 0) return null
  return (
    <>
      {views.map((view) => (
        <div key={view.engine} className={view.state === 'answer' ? 'answer' : 'answer miss'}>
          <div className="answer-meta">
            <span className="tag plain live">{view.block}</span>
          </div>
          {view.state === 'answer' ? (
            <p className="answer-body">
              {view.text}{' '}
              {view.sources.map((source) => (
                <SourceLink key={source.url} url={source.url} title={source.title} domain={source.domain} />
              ))}
            </p>
          ) : (
            <p className="answer-body">{view.text}</p>
          )}
          {view.state !== 'not-searched' ? (
            <div className="citation-sources">
              <p className="citation-sources-label">{CITATION_COPY.sources}</p>
              {view.sources.length === 0 ? (
                <p className="answer-body">{CITATION_COPY.noSources}</p>
              ) : (
                view.sources.map((source) => (
                  <SourceLink
                    key={`${view.engine}:${source.url}`}
                    url={source.url}
                    title={source.title}
                    domain={source.domain}
                    engine={view.engine}
                  />
                ))
              )}
            </div>
          ) : null}
          {view.engine === 'gemini' && view.suggestionsHtml ? (
            <div className="citation-suggestions">
              <p>{CITATION_COPY.suggestions}</p>
              <iframe title={CITATION_COPY.suggestions} sandbox="" srcDoc={view.suggestionsHtml} />
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}

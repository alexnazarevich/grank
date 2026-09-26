import type { ProductCopy } from './config/productConfig.ts'
import type { FullReport } from './fullReport.ts'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

export function FullReportSection({
  report,
  copy,
  themesOnly = false,
}: {
  report: FullReport
  copy: ProductCopy
  themesOnly?: boolean
}) {
  return (
    <section className="full-report" aria-label={copy.fullReportTitle}>
      {themesOnly ? null : (
        <>
          <h2 className="beat-title">{copy.fullReportTitle}</h2>
          <p className="why">{copy.fullReportSub}</p>
        </>
      )}
      {report.themes.length === 0 ? <p className="why">{copy.fullReportEmptyThemes}</p> : null}
      {report.themes.map((theme) => (
        <section key={theme.id} className="block theme-block">
          <p className="eyebrow">{copy.themeSectionEyebrow}</p>
          <h2 className="theme-title">{theme.title}</h2>
          <p className="theme-count">
            {theme.questions.length} {theme.questions.length === 1 ? 'question' : 'questions'}
          </p>
          <ul className="answers">
            {theme.questions.map((item, index) => (
              <li key={`${theme.id}-${index}`} className="q with-answer">
                <div className="q-line">
                  <span className="tag plain live">{GENERATED}</span>
                  {report.includesBranded ? (
                    <span className="tag plain q-badge">
                      {item.framing === 'branded' ? STORY.digBadge : STORY.landBadge}
                    </span>
                  ) : null}
                  <span>{item.question}</span>
                </div>
                <div className={item.answer ? 'answer' : 'answer miss'}>
                  <div className="answer-meta">
                    <span className="tag plain live">{GENERATED}</span>
                  </div>
                  <p className="answer-body">{item.answer || STORY.answerMiss}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

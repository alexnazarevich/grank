import { useState } from 'react'
import type { ProductCopy } from './config/productConfig.ts'
import type { FullReport, FullReportQuestion } from './fullReport.ts'
import { mentionStatusLabel, whoInsteadNames } from './mentionLabel.ts'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

/** Question toggles the answer already on the row. No extra model call. */
function ReportQuestion({
  item,
  copy,
  panelId,
  chipId,
  showFraming,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  panelId: string
  chipId: string
  showFraming: boolean
}) {
  const [open, setOpen] = useState(false)
  const text = item.answer.trim()
  const label = item.mention ? mentionStatusLabel(item.mention, copy) : ''
  const names =
    open && item.mention && item.mention !== 'mentioned' ? whoInsteadNames(item.whoInstead, item.framing) : []
  return (
    <li className="q with-answer report-q">
      <div className="report-q-head">
        <button
          type="button"
          className="report-q-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={item.question}
          aria-describedby={label ? chipId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tag plain live">{GENERATED}</span>
          {showFraming ? (
            <span className="tag plain q-badge">{item.framing === 'branded' ? STORY.digBadge : STORY.landBadge}</span>
          ) : null}
          <span className="report-q-text">{item.question}</span>
        </button>
        {label ? (
          <span
            id={chipId}
            className={`tag plain mention report-mention${item.mention === 'mentioned' ? ' mentioned' : ''}`}
          >
            {label}
          </span>
        ) : null}
      </div>
      {open ? (
        <div id={panelId} className="report-q-panel">
          {names.length > 0 ? (
            <ul className="mention-names report-who">
              {names.map((name) => (
                <li key={name}>
                  <strong>{name}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={text ? 'answer' : 'answer miss'}>
            <div className="answer-meta">
              <span className="tag plain live">{GENERATED}</span>
            </div>
            <p className="answer-body">{text || STORY.answerMiss}</p>
          </div>
        </div>
      ) : null}
    </li>
  )
}

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
              <ReportQuestion
                key={`${theme.id}-${index}`}
                item={item}
                copy={copy}
                panelId={`report-a-${theme.id}-${index}`}
                chipId={`report-m-${theme.id}-${index}`}
                showFraming={report.includesBranded}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

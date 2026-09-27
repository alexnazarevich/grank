import { useState } from 'react'
import { splitAnswerSkim } from './answerSkim.ts'
import type { ProductCopy } from './config/productConfig.ts'
import type { FullReport, FullReportQuestion } from './fullReport.ts'
import { MentionMark } from './MentionMark.tsx'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

/** Expand/collapse text already on the row. No extra model call. */
function ReportAnswer({
  item,
  copy,
  bodyId,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  bodyId: string
}) {
  const [open, setOpen] = useState(false)
  const text = item.answer.trim()
  const skim = text && item.mention ? splitAnswerSkim(text) : { preview: text, long: false }
  const shown = skim.long && !open ? skim.preview : text
  return (
    <div className={text ? 'answer' : 'answer miss'}>
      <div className="answer-meta">
        <span className="tag plain live">{GENERATED}</span>
      </div>
      {text && item.mention ? (
        <MentionMark
          mention={item.mention}
          whoInstead={item.whoInstead}
          framing={item.framing}
          copy={copy}
        >
          {skim.long ? (
            <button
              type="button"
              className="text-btn answer-expand"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? STORY.hideAnswer : STORY.showFullAnswer}
            </button>
          ) : null}
        </MentionMark>
      ) : null}
      <p id={bodyId} className="answer-body">
        {shown || STORY.answerMiss}
      </p>
    </div>
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
                <ReportAnswer item={item} copy={copy} bodyId={`${theme.id}-${index}`} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

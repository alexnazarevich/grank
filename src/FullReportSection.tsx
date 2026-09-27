import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ProductCopy } from './config/productConfig.ts'
import { THEME_CATALOG, type FullReport, type FullReportQuestion } from './fullReport.ts'
import type { ThemeId } from './mentionFacts.ts'
import { mentionStatusLabel, whoInsteadNames } from './mentionLabel.ts'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

export type ReportEditor = {
  disabled?: boolean
  editingKey: string | null
  editText: string
  addText: string
  addThemeId: ThemeId
  atCap: boolean
  canDelete: boolean
  onEdit: (key: string, question: string) => void
  onEditText: (value: string) => void
  onRename: (themeId: ThemeId, index: number) => void
  onDelete: (themeId: ThemeId, index: number) => void
  onAddText: (value: string) => void
  onAddTheme: (id: ThemeId) => void
  onAdd: () => void
}

/** Question toggles the answer already on the row. No extra model call. */
function ReportQuestion({
  item,
  copy,
  panelId,
  chipId,
  showFraming,
  editor,
  rowKey,
  themeId,
  index,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  panelId: string
  chipId: string
  showFraming: boolean
  editor?: ReportEditor
  rowKey: string
  themeId: ThemeId
  index: number
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
      {editor && editor.editingKey === rowKey ? (
        <div className="pin-edit">
          <input
            aria-label="Question"
            value={editor.editText}
            maxLength={240}
            disabled={editor.disabled}
            onChange={(event) => editor.onEditText(event.target.value)}
          />
          <button
            type="button"
            disabled={editor.disabled || !editor.editText.replace(/\s+/g, ' ').trim()}
            onClick={() => editor.onRename(themeId, index)}
          >
            {copy.saveEditedQuestionCta}
          </button>
        </div>
      ) : editor ? (
        <div className="q-tools">
          <button type="button" disabled={editor.disabled} onClick={() => editor.onEdit(rowKey, item.question)}>
            {copy.editQuestionCta}
          </button>
          <button
            type="button"
            disabled={editor.disabled || !editor.canDelete}
            onClick={() => editor.onDelete(themeId, index)}
          >
            {copy.deleteQuestionCta}
          </button>
        </div>
      ) : null}
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
  editor,
}: {
  report: FullReport
  copy: ProductCopy
  themesOnly?: boolean
  editor?: ReportEditor
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
                editor={editor}
                rowKey={`${theme.id}:${index}`}
                themeId={theme.id}
                index={index}
              />
            ))}
          </ul>
        </section>
      ))}
      {editor ? (
        <form
          className="owned-add"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            editor.onAdd()
          }}
        >
          <label>
            Theme
            <select
              aria-label="Theme"
              value={editor.addThemeId}
              disabled={editor.disabled || editor.atCap}
              onChange={(event) => editor.onAddTheme(event.target.value as ThemeId)}
            >
              {THEME_CATALOG.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.title}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label="New question"
            value={editor.addText}
            maxLength={240}
            disabled={editor.disabled || editor.atCap}
            onChange={(event) => editor.onAddText(event.target.value)}
          />
          <button type="submit" disabled={editor.disabled || editor.atCap || !editor.addText.trim()}>
            {copy.addQuestionCta}
          </button>
        </form>
      ) : null}
    </section>
  )
}

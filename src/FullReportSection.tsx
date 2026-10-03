import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ProductCopy } from './config/productConfig.ts'
import { THEME_CATALOG, type FullReport, type FullReportQuestion } from './fullReport.ts'
import type { Framing, ThemeId } from './mentionFacts.ts'
import { mentionStatusLabel, whoInsteadByTopic, whoInsteadNames } from './mentionLabel.ts'
import { WhoInsteadBoard } from './WhoInsteadBoard.tsx'
import {
  gridRuns,
  runColumnLabel,
  runQuestionKey,
  themeMentionRates,
  themeRateLabel,
  type CheckRun,
  type MentionGridCell,
} from './runHistory.ts'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

function themeFramingOf(theme: { framing?: Framing; questions: { framing: Framing }[] }): Framing | null {
  const first = theme.questions[0]?.framing
  if (!first || theme.questions.some((item) => item.framing !== first)) return null
  if (theme.framing === 'branded' || theme.framing === 'unbranded') {
    return theme.framing === first ? theme.framing : null
  }
  return first
}

/** Land/dig words. Unbranded and Branded — nothing else. */
function framingLabel(framing: Framing | null): string | null {
  if (framing === 'branded') return STORY.digEyebrow
  if (framing === 'unbranded') return STORY.landEyebrow
  return null
}

export type ReportEditor = {
  disabled?: boolean
  saving?: boolean
  editingKey: string | null
  editText: string
  addText: string
  addThemeId: ThemeId
  atCap: boolean
  canDelete: boolean
  onEdit: (key: string, question: string) => void
  onEditText: (value: string) => void
  onRename: (themeId: ThemeId, index: number, framing: Framing) => void
  onDelete: (themeId: ThemeId, index: number, framing: Framing) => void
  onAddText: (value: string) => void
  onAddTheme: (id: ThemeId) => void
  onAdd: () => void
  onSave?: () => void
  saveDisabled?: boolean
}

function cellsForQuestion(question: string, runs: CheckRun[]): Array<MentionGridCell | null> {
  const key = runQuestionKey(question)
  return runs.map((run) => {
    const item = run.mentions.find((mention) => runQuestionKey(mention.question) === key)
    if (!item) return null
    return { mention: item.mention, whoInstead: item.whoInstead }
  })
}

/** Question toggles the answer already on the row. No extra model call. */
function ReportQuestion({
  item,
  copy,
  panelId,
  chipId,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  panelId: string
  chipId: string
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

/** Same answer expand as the list row. History stores mention status, not the reply. */
function ThemeGridRow({
  item,
  copy,
  runs,
  panelId,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  runs: CheckRun[]
  panelId: string
}) {
  const [open, setOpen] = useState(false)
  const text = item.answer.trim()
  const names =
    open && item.mention && item.mention !== 'mentioned' ? whoInsteadNames(item.whoInstead, item.framing) : []
  const cells = cellsForQuestion(item.question, runs)
  return (
    <>
      <tr>
        <th scope="row">
          <button
            type="button"
            className="report-q-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={item.question}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="report-q-text">{item.question}</span>
          </button>
        </th>
        {cells.map((cell, index) => (
          <td key={`${runQuestionKey(item.question)}:${index}`}>
            {cell?.mention ? (
              <span className={`tag plain mention${cell.mention === 'mentioned' ? ' mentioned' : ''}`}>
                {mentionStatusLabel(cell.mention, copy)}
              </span>
            ) : (
              <span className="muted">—</span>
            )}
          </td>
        ))}
      </tr>
      {open ? (
        <tr className="theme-answer-row">
          <td colSpan={runs.length + 1}>
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
          </td>
        </tr>
      ) : null}
    </>
  )
}

/** First data row under the date headers. One % per run; Unclear and Not are not mentioned. */
function ThemePercentRow({
  label,
  template,
  percents,
  columnCount,
}: {
  label: string
  template: string
  percents: Array<number | null | undefined>
  columnCount: number
}) {
  return (
    <tr className="theme-pct-row">
      <th scope="row">{label}</th>
      {Array.from({ length: columnCount }, (_, index) => {
        const pct = percents[index]
        const text = typeof pct === 'number' ? themeRateLabel(template, pct) : null
        return <td key={index}>{text === null ? <span className="muted">—</span> : text}</td>
      })}
    </tr>
  )
}

function ManageQuestions({
  editor,
  report,
  copy,
  initialOpen = false,
}: {
  editor: ReportEditor
  report: FullReport
  copy: ProductCopy
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div className="manage-questions">
      <button
        type="button"
        className="ask"
        aria-expanded={open}
        aria-controls="manage-questions-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {copy.manageQuestionsCta}
      </button>
      {open ? (
        <div id="manage-questions-panel" className="manage-panel">
          <h3>{copy.manageQuestionsTitle}</h3>
          <p className="why">{copy.manageQuestionsHint}</p>
          {report.themes.map((theme) => {
            const word = framingLabel(themeFramingOf(theme))
            const framing = themeFramingOf(theme) ?? theme.framing
            return (
              <div key={`${theme.id}:${theme.framing}`}>
                <p className="manage-theme">
                {word ? <span className="eyebrow theme-framing">{word}</span> : null}
                {theme.title}
              </p>
              <ul className="manage-list">
                {theme.questions.map((item, index) => {
                  const rowKey = `${theme.id}:${theme.framing}:${index}`
                  return (
                    <li key={rowKey} className="manage-q">
                      {editor.editingKey === rowKey ? (
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
                            onClick={() => editor.onRename(theme.id, index, framing)}
                          >
                            {copy.saveEditedQuestionCta}
                          </button>
                        </div>
                      ) : (
                        <>
                          <span>{item.question}</span>
                          <span className="q-tools">
                            <button
                              type="button"
                              disabled={editor.disabled}
                              onClick={() => editor.onEdit(rowKey, item.question)}
                            >
                              {copy.editQuestionCta}
                            </button>
                            <button
                              type="button"
                              disabled={editor.disabled || !editor.canDelete}
                              onClick={() => editor.onDelete(theme.id, index, framing)}
                            >
                              {copy.deleteQuestionCta}
                            </button>
                          </span>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
            )
          })}
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
          {editor.onSave ? (
            <div className="save-row">
              <button
                type="button"
                className="secondary"
                disabled={editor.disabled || editor.saveDisabled}
                onClick={editor.onSave}
              >
                {editor.saving ? 'Saving…' : copy.saveQuestionsCta}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function FullReportSection({
  report,
  copy,
  themesOnly = false,
  editor,
  runs = [],
  preview = null,
  manageOpen = false,
  whoInsteadOpen = false,
}: {
  report: FullReport
  copy: ProductCopy
  themesOnly?: boolean
  editor?: ReportEditor
  runs?: CheckRun[]
  preview?: CheckRun | null
  /** Opens the manage panel for tests. The report grid stays free of row edit controls. */
  manageOpen?: boolean
  /** Opens who-instead topics for tests. The report starts collapsed. */
  whoInsteadOpen?: boolean
}) {
  const shown = gridRuns(runs, preview)
  const rates = themeMentionRates(
    report.themes.map((theme) => ({
      id: theme.id,
      title: theme.title,
      framing: themeFramingOf(theme) ?? undefined,
      questions: theme.questions,
    })),
    shown,
  )
  const rateByKey = new Map(rates.map((rate) => [rate.framing ? `${rate.id}:${rate.framing}` : rate.id, rate]))
  return (
    <section className="full-report" aria-label={copy.fullReportTitle}>
      {themesOnly ? null : (
        <>
          <h2 className="beat-title">{copy.fullReportTitle}</h2>
          <p className="why">{copy.fullReportSub}</p>
        </>
      )}
      <WhoInsteadBoard
        copy={copy}
        titleId="who-instead-report"
        topics={whoInsteadByTopic(report.themes)}
        initialOpen={whoInsteadOpen}
      />
      {report.themes.length === 0 ? <p className="why">{copy.fullReportEmptyThemes}</p> : null}
      {report.themes.map((theme) => {
        const framing = themeFramingOf(theme)
        const rate = rateByKey.get(framing ? `${theme.id}:${framing}` : theme.id)
        const latest = rate?.latest
        const word = framingLabel(framing)
        const inGrid = shown.length > 0
        return (
          <section key={`${theme.id}:${theme.framing}`} className="block theme-block">
            <div className="theme-heading">
              <h2 className="theme-title">
                {word ? <span className="eyebrow theme-framing">{word}</span> : null}
                <span>{theme.title}</span>
              </h2>
              {inGrid ? null : latest === null || latest === undefined ? (
                <p className="theme-rate">—</p>
              ) : (
                <p className="theme-rate">{themeRateLabel(copy.themeMentionRate, latest)}</p>
              )}
            </div>
            <p className="theme-count">
              {theme.questions.length} {theme.questions.length === 1 ? 'question' : 'questions'}
            </p>
            {shown.length > 0 ? (
              <div className="run-grid-wrap">
                <table className="run-grid">
                  <thead>
                    <tr>
                      <th scope="col">{copy.overTimeQuestion}</th>
                      {shown.map((run, index) => (
                        <th key={`${theme.id}:${run.at}:${index}`} scope="col">
                          {runColumnLabel(run.at)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <ThemePercentRow
                      label={copy.themeMentionRow}
                      template={copy.themeMentionCell}
                      percents={rate?.byRun ?? []}
                      columnCount={shown.length}
                    />
                    {theme.questions.map((item, index) => (
                      <ThemeGridRow
                        key={`${theme.id}-${theme.framing}-${index}`}
                        item={item}
                        copy={copy}
                        runs={shown}
                        panelId={`report-a-${theme.id}-${theme.framing}-${index}`}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul className="answers">
                {theme.questions.map((item, index) => (
                  <ReportQuestion
                    key={`${theme.id}-${theme.framing}-${index}`}
                    item={item}
                    copy={copy}
                    panelId={`report-a-${theme.id}-${theme.framing}-${index}`}
                    chipId={`report-m-${theme.id}-${theme.framing}-${index}`}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {editor ? (
        <ManageQuestions editor={editor} report={report} copy={copy} initialOpen={manageOpen} />
      ) : null}
    </section>
  )
}

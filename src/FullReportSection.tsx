import { createContext, useContext, useState } from 'react'
import type { FormEvent } from 'react'
import type { ProductCopy } from './config/productConfig.ts'
import { THEME_CATALOG, type FullReport, type FullReportQuestion, type FullReportTheme } from './fullReport.ts'
import type { Framing, ThemeId } from './mentionFacts.ts'
import { competitorTopics, mentionStatusLabel, whoInsteadNames, type CompetitorTopic } from './mentionLabel.ts'
import {
  gridRuns,
  runColumnLabel,
  runQuestionKey,
  themeMentionRates,
  themeRateLabel,
  type CheckRun,
  type MentionGridCell,
  type ThemeMentionRate,
} from './runHistory.ts'
import { geminiMissLine, geminiRow } from './engineBlock.ts'
import type { SignedGeminiMiss } from './fullReportClient.ts'
import { STORY } from './story.ts'

const GENERATED = 'Generated · OpenAI'

/** Present only for the signed-in response that just ran. Stored checks leave this null. */
const GeminiMissContext = createContext<SignedGeminiMiss | null>(null)

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
function NameList({ names }: { names: string[] }) {
  if (names.length === 0) return null
  return (
    <ul className="mention-names report-who">
      {names.map((name) => (
        <li key={name}>
          <strong>{name}</strong>
        </li>
      ))}
    </ul>
  )
}

function ReportQuestion({
  item,
  copy,
  panelId,
  chipId,
  startOpen = false,
  besideNames,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  panelId: string
  chipId: string
  startOpen?: boolean
  /** Names already listed on the competitors expand, so the answer panel does not repeat them. */
  besideNames?: string[]
}) {
  const [open, setOpen] = useState(startOpen)
  const text = item.answer.trim()
  const label = item.mention ? mentionStatusLabel(item.mention, copy) : ''
  const names =
    open && !besideNames && item.mention && item.mention !== 'mentioned'
      ? whoInsteadNames(item.whoInstead, item.framing)
      : []
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
      {besideNames && besideNames.length > 0 ? (
        <>
          <p className="who-instead-under">{copy.mentionWhoInstead}</p>
          <NameList names={besideNames} />
        </>
      ) : null}
      {open ? (
        <div id={panelId} className="report-q-panel">
          {names.length > 0 ? <NameList names={names} /> : null}
          <div className={text ? 'answer' : 'answer miss'}>
            <div className="answer-meta">
              <span className="tag plain live">{GENERATED}</span>
            </div>
            <p className="answer-body">{text || STORY.answerMiss}</p>
          </div>
          {item.framing === 'unbranded' ? <GeminiBlock text={item.gemini ?? ''} /> : null}
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
  startOpen = false,
}: {
  item: FullReportQuestion
  copy: ProductCopy
  runs: CheckRun[]
  panelId: string
  startOpen?: boolean
}) {
  const [open, setOpen] = useState(startOpen)
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
              {item.framing === 'unbranded' ? <GeminiBlock text={item.gemini ?? ''} /> : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

function PercentCell({ template, pct }: { template: string; pct: number | null | undefined }) {
  if (typeof pct !== 'number') return <span className="muted">—</span>
  return themeRateLabel(template, pct)
}

/** Topic × run. The cells are mention rates. Questions and answers stay in the expand. */
function TopicOverTimeRow({
  theme,
  copy,
  runs,
  percents,
  columnCount,
  startOpen,
  answersOpen,
}: {
  theme: FullReportTheme
  copy: ProductCopy
  runs: CheckRun[]
  percents: Array<number | null | undefined>
  columnCount: number
  startOpen: boolean
  answersOpen: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  const framing = themeFramingOf(theme)
  const word = framingLabel(framing)
  const panelId = `topic-${theme.id}-${theme.framing}`
  return (
    <>
      <tr className="topic-rate-row">
        <th scope="row">
          <button
            type="button"
            className="report-q-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {word ? <span className="eyebrow theme-framing">{word}</span> : null}
            <span className="report-q-text">{theme.title}</span>
          </button>
        </th>
        {Array.from({ length: columnCount }, (_, index) => (
          <td key={`${theme.id}:${theme.framing}:${index}`}>
            <PercentCell template={copy.themeMentionCell} pct={percents[index]} />
          </td>
        ))}
      </tr>
      {open ? (
        <tr className="theme-answer-row">
          <td colSpan={columnCount + 1}>
            <div id={panelId} className="topic-questions">
              {runs.length > 0 ? (
                <div className="run-grid-wrap">
                  <table className="run-grid">
                    <thead>
                      <tr>
                        <th scope="col">{copy.overTimeQuestion}</th>
                        {runs.map((run, index) => (
                          <th key={`${theme.id}:${run.at}:${index}`} scope="col">
                            {runColumnLabel(run.at) || copy.reportThisCheck}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {theme.questions.map((item, index) => (
                        <ThemeGridRow
                          key={`${theme.id}-${theme.framing}-${index}`}
                          item={item}
                          copy={copy}
                          runs={runs}
                          panelId={`report-a-${theme.id}-${theme.framing}-${index}`}
                          startOpen={answersOpen}
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
                      startOpen={answersOpen}
                    />
                  ))}
                </ul>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

/** This run only. You, then at most five names for this topic. */
function CompetitorTopicBlock({
  theme,
  row,
  copy,
  startOpen,
  answersOpen,
}: {
  theme: FullReportTheme
  row: CompetitorTopic
  copy: ProductCopy
  startOpen: boolean
  answersOpen: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  const framing = themeFramingOf(theme)
  const word = framingLabel(framing)
  const panelId = `competitors-${theme.id}-${theme.framing}`
  const namesByQuestion = row.questions.map((item) => item.names)
  return (
    <section className="competitors-topic">
      <div className="run-grid-wrap">
        <table className="run-grid competitors-grid">
          <thead>
            <tr>
              <th scope="col">{copy.reportTopicColumn}</th>
              <th scope="col">{copy.competitorsYou}</th>
              {row.names.map((name) => (
                <th key={name.name} scope="col">
                  {name.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="topic-rate-row">
              <th scope="row">
                <button
                  type="button"
                  className="report-q-toggle"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setOpen((value) => !value)}
                >
                  {word ? <span className="eyebrow theme-framing">{word}</span> : null}
                  <span className="report-q-text">{theme.title}</span>
                </button>
              </th>
              <td>
                <PercentCell template={copy.themeMentionCell} pct={row.you} />
              </td>
              {row.names.map((name) => (
                <td key={name.name}>
                  <PercentCell template={copy.themeMentionCell} pct={name.pct} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {open ? (
        <div id={panelId} className="topic-questions">
          <ul className="answers">
            {theme.questions.map((item, index) => (
              <ReportQuestion
                key={`${theme.id}-${theme.framing}-${index}`}
                item={item}
                copy={copy}
                panelId={`competitors-a-${theme.id}-${theme.framing}-${index}`}
                chipId={`competitors-m-${theme.id}-${theme.framing}-${index}`}
                startOpen={answersOpen}
                besideNames={namesByQuestion[index] ?? []}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

type ReportTab = 'over-time' | 'competitors'
type ReportEngine = 'openai' | 'gemini'

function ratePercents(rate: ThemeMentionRate | undefined, runCount: number): Array<number | null | undefined> {
  if (runCount > 0) return rate?.byRun ?? []
  return [rate?.latest ?? null]
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
  answersOpen = false,
  initialTab = 'over-time',
  initialEngine = 'openai',
  topicsOpen = false,
  geminiMiss = null,
}: {
  report: FullReport
  copy: ProductCopy
  themesOnly?: boolean
  editor?: ReportEditor
  runs?: CheckRun[]
  preview?: CheckRun | null
  /** Opens the manage panel for tests. The report grid stays free of row edit controls. */
  manageOpen?: boolean
  /** Opens topic expands for tests. Grids start collapsed. */
  whoInsteadOpen?: boolean
  /** Opens each answer for tests. Topic rows start closed unless this is set. */
  answersOpen?: boolean
  /** In-page tab. Over time is first. No URL change. */
  initialTab?: ReportTab
  /** Engine filter on Over time. Gemini has no stored mentions. */
  initialEngine?: ReportEngine
  /** Opens topic expands on the active tab. */
  topicsOpen?: boolean
  /** Class from this Run again response. Omitted for a stored check. */
  geminiMiss?: SignedGeminiMiss | null
}) {
  const [tab, setTab] = useState<ReportTab>(initialTab)
  const [engine, setEngine] = useState<ReportEngine>(initialEngine)
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
  const competitors = competitorTopics(report.themes)
  const columnCount = shown.length > 0 ? shown.length : 1
  const topicsStartOpen = topicsOpen || whoInsteadOpen || answersOpen
  return (
    <GeminiMissContext.Provider value={geminiMiss}>
    <section className="full-report" aria-label={copy.fullReportTitle}>
      {themesOnly ? null : (
        <>
          <h2 className="beat-title">{copy.fullReportTitle}</h2>
          <p className="why">{copy.fullReportSub}</p>
        </>
      )}
      <div className="segments report-tabs" role="tablist" aria-label="Full report">
        <button
          type="button"
          role="tab"
          id="report-tab-over-time"
          aria-selected={tab === 'over-time'}
          aria-controls="report-panel-over-time"
          onClick={() => setTab('over-time')}
        >
          {copy.overTimeTitle}
        </button>
        <button
          type="button"
          role="tab"
          id="report-tab-competitors"
          aria-selected={tab === 'competitors'}
          aria-controls="report-panel-competitors"
          onClick={() => setTab('competitors')}
        >
          {copy.competitorsTab}
        </button>
      </div>
      {tab === 'over-time' ? (
        <div role="tabpanel" id="report-panel-over-time" aria-labelledby="report-tab-over-time">
          <div className="segments engine-filter" role="group" aria-label="Engine">
            <button
              type="button"
              aria-pressed={engine === 'openai'}
              onClick={() => setEngine('openai')}
            >
              {copy.engineOpenAI}
            </button>
            <button
              type="button"
              aria-pressed={engine === 'gemini'}
              onClick={() => setEngine('gemini')}
            >
              {copy.engineGemini}
            </button>
          </div>
          {engine === 'gemini' ? (
            <p className="why">{copy.geminiMentionsEmpty}</p>
          ) : report.themes.length === 0 ? (
            <p className="why">{copy.fullReportEmptyThemes}</p>
          ) : (
            <div className="run-grid-wrap">
              <table className="run-grid over-time-grid">
                <thead>
                  <tr>
                    <th scope="col">{copy.reportTopicColumn}</th>
                    {shown.length > 0 ? (
                      shown.map((run, index) => (
                        <th key={`${run.at}:${index}`} scope="col">
                          {runColumnLabel(run.at) || copy.reportThisCheck}
                        </th>
                      ))
                    ) : (
                      <th scope="col">{copy.reportThisCheck}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {report.themes.map((theme) => {
                    const framing = themeFramingOf(theme)
                    const rate = rateByKey.get(framing ? `${theme.id}:${framing}` : theme.id)
                    return (
                      <TopicOverTimeRow
                        key={`${theme.id}:${theme.framing}`}
                        theme={theme}
                        copy={copy}
                        runs={shown}
                        percents={ratePercents(rate, shown.length)}
                        columnCount={columnCount}
                        startOpen={topicsStartOpen}
                        answersOpen={answersOpen}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="report-panel-competitors" aria-labelledby="report-tab-competitors">
          <p className="why">{copy.competitorsHelper}</p>
          {report.themes.length === 0 ? <p className="why">{copy.fullReportEmptyThemes}</p> : null}
          {report.themes.map((theme, index) => (
            <CompetitorTopicBlock
              key={`${theme.id}:${theme.framing}`}
              theme={theme}
              row={competitors[index] ?? { id: theme.id, title: theme.title, you: null, names: [], questions: [] }}
              copy={copy}
              startOpen={topicsStartOpen}
              answersOpen={answersOpen}
            />
          ))}
        </div>
      )}
      {editor ? (
        <ManageQuestions editor={editor} report={report} copy={copy} initialOpen={manageOpen} />
      ) : null}
    </section>
    </GeminiMissContext.Provider>
  )
}

/** Second block on an unbranded row. Empty text is the miss line. */
function GeminiBlock({ text }: { text: string }) {
  const miss = useContext(GeminiMissContext)
  const row = geminiRow([text], 0)
  if (!row) return null
  return (
    <div className={row.miss ? 'answer miss' : 'answer'}>
      <div className="answer-meta">
        <span className="tag plain live">{row.label}</span>
      </div>
      <p className="answer-body">{row.miss ? geminiMissLine(miss) : row.body}</p>
    </div>
  )
}

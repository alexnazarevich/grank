import type { ProductCopy } from './config/productConfig.ts'
import { mentionStatusLabel } from './mentionLabel.ts'
import { STORY } from './story.ts'
import {
  changeSummary,
  gridRuns,
  mentionGrid,
  runColumnLabel,
  runQuestionKey,
  type ChangeChipId,
  type CheckRun,
  type MentionGridCell,
} from './runHistory.ts'

const CHIP_KEY: Record<ChangeChipId, keyof ProductCopy> = {
  newlyMentioned: 'deltaNewlyMentioned',
  lostMention: 'deltaLostMention',
  nowMentioned: 'deltaNowMentioned',
  whoAppeared: 'deltaWhoAppeared',
  whoDropped: 'deltaWhoDropped',
}

function chipText(id: ChangeChipId, count: number, copy: ProductCopy): string {
  const label = copy[CHIP_KEY[id]]
  return `${count} ${label}`
}

function MentionCell({
  question,
  column,
  cell,
  answer,
  copy,
}: {
  question: string
  column: string
  cell: MentionGridCell
  answer: string
  copy: ProductCopy
}) {
  if (!cell.mention) return <span className="muted">—</span>
  const status = mentionStatusLabel(cell.mention, copy)
  const chip = (
    <span className={`tag plain mention${cell.mention === 'mentioned' ? ' mentioned' : ''}`}>{status}</span>
  )
  if (!answer) return chip
  const when = column ? `, ${column}` : ''
  return (
    <details className="run-cell">
      <summary aria-label={`${question}${when}: ${status}`}>{chip}</summary>
      <div className="answer run-answer">
        <div className="answer-meta">
          <span className="tag plain live">{STORY.answerLabel}</span>
        </div>
        <p className="answer-body">{answer}</p>
      </div>
    </details>
  )
}

/** What’s changed is a rollup. Over time is the mention grid. Flips are not the view. */
export function RunHistoryPanel({
  runs,
  preview = null,
  answers = [],
  copy,
  summaryOnly = false,
}: {
  runs: CheckRun[]
  preview?: CheckRun | null
  answers?: { question: string; answer: string }[]
  copy: ProductCopy
  /** Full report keeps the rollup and draws run columns inside each theme. */
  summaryOnly?: boolean
}) {
  const shown = gridRuns(runs, preview)
  const summary = changeSummary(shown)
  const rows = mentionGrid(shown)
  const answerByQuestion = new Map<string, string>()
  for (const item of answers) {
    const key = runQuestionKey(item.question)
    const text = item.answer.replace(/\s+/g, ' ').trim()
    if (!key || !text || answerByQuestion.has(key)) continue
    answerByQuestion.set(key, text)
  }
  const lastIndex = shown.length - 1
  // History keeps mention status, not the reply. The latest column can open the current answer.
  return (
    <>
      <section className="block run-changed" aria-labelledby="whats-changed-title">
        <h2 className="beat-title" id="whats-changed-title">
          {copy.deltaTitle}
        </h2>
        <p className="why">{copy.deltaHelper}</p>
        {summary.chips.length > 0 ? (
          <p className="change-chips">
            {summary.chips.map((chip) => (
              <span key={chip.id} className="tag plain change-chip">
                {chipText(chip.id, chip.count, copy)}
              </span>
            ))}
          </p>
        ) : !summary.comparable ? (
          <p className="why">{copy.deltaAwaiting}</p>
        ) : summary.quiet ? (
          <p className="why">{copy.deltaEmpty}</p>
        ) : null}
      </section>
      {summaryOnly ? null : (
        <section className="block run-over-time" aria-labelledby="over-time-title">
          <p className="run-over-time-label" id="over-time-title">
            {copy.overTimeTitle}
          </p>
          <p className="why">{copy.overTimeHelper}</p>
          <p className="why run-legend">{copy.overTimeLegend}</p>
          {shown.length > 0 && rows.length > 0 ? (
            <div className="run-grid-wrap">
              <table className="run-grid">
                <thead>
                  <tr>
                    <th scope="col">{copy.overTimeQuestion}</th>
                    {shown.map((run, index) => (
                      <th key={`${run.at}:${index}`} scope="col">
                        {runColumnLabel(run.at)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={runQuestionKey(row.question)}>
                      <th scope="row">{row.question}</th>
                      {row.cells.map((cell, index) => {
                        const column = runColumnLabel(shown[index]?.at || '')
                        const answer =
                          index === lastIndex ? answerByQuestion.get(runQuestionKey(row.question)) || '' : ''
                        return (
                          <td key={`${runQuestionKey(row.question)}:${index}`}>
                            {cell ? (
                              <MentionCell
                                question={row.question}
                                column={column}
                                cell={cell}
                                answer={answer}
                                copy={copy}
                              />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      )}
    </>
  )
}

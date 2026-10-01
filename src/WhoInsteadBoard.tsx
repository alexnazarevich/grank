import type { ProductCopy } from './config/productConfig.ts'
import { whoInsteadCountLabel, type WhoInsteadBoardRow } from './mentionLabel.ts'

/** One run-level list of substitutes. Counts only when the caller has a real per-question tally. */
export function WhoInsteadBoard({
  copy,
  rows,
  titleId,
  engine,
  omitted = false,
}: {
  copy: ProductCopy
  rows: WhoInsteadBoardRow[]
  titleId: string
  /** Land keeps the existing Generated · OpenAI label. The full report leaves it off this board. */
  engine?: { live: boolean; label: string }
  omitted?: boolean
}) {
  return (
    <section className="block who-instead-board" aria-labelledby={titleId}>
      <h2 className="beat-title" id={titleId}>
        {copy.whoInsteadBoardTitle}
        {engine ? (
          <>
            {' '}
            <span className={`tag plain ${engine.live ? 'live' : ''}`}>{engine.label}</span>
          </>
        ) : null}
      </h2>
      <p className="why">{copy.whoInsteadBoardHelper}</p>
      {omitted ? (
        <p className="why">Who-instead was not saved for this check.</p>
      ) : rows.length === 0 ? (
        <p className="why">{copy.whoInsteadBoardEmpty}</p>
      ) : (
        <ul className="who-instead-list">
          {rows.map((row) => (
            <li key={row.name}>
              <span className="who-instead-name">{row.name}</span>
              {row.questions > 0 ? (
                <span className="who-instead-count">
                  {whoInsteadCountLabel(copy.whoInsteadBoardCount, row.questions)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

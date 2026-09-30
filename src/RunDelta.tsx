import type { ProductCopy } from './config/productConfig.ts'
import { mentionStatusLabel } from './mentionLabel.ts'
import { deltaVsLastRun, type CheckRun } from './runHistory.ts'
import { STORY } from './story.ts'

/** Mention / who-appeared changes versus the previous run. Not a report rewrite. */
export function RunDelta({ runs, copy }: { runs: CheckRun[]; copy: ProductCopy }) {
  const delta = deltaVsLastRun(runs)
  return (
    <section className="block run-delta" aria-label={STORY.deltaTitle}>
      <h2>{STORY.deltaTitle}</h2>
      {!delta.comparable ? (
        <p className="why">{STORY.deltaAwaiting}</p>
      ) : delta.empty ? (
        <p className="why">{STORY.deltaEmpty}</p>
      ) : (
        <ul className="run-delta-list">
          {delta.flips.map((flip) => (
            <li key={`${flip.question}:${flip.from}:${flip.to}`}>
              {flip.question} — {mentionStatusLabel(flip.from, copy)} → {mentionStatusLabel(flip.to, copy)}
            </li>
          ))}
          {delta.appeared.map((name) => (
            <li key={`appeared:${name}`}>{name} appeared</li>
          ))}
          {delta.dropped.map((name) => (
            <li key={`dropped:${name}`}>{name} dropped</li>
          ))}
        </ul>
      )}
    </section>
  )
}

import type { ProductCopy } from './config/productConfig.ts'
import { mentionStatusLabel } from './mentionLabel.ts'
import type { Mention } from './mentionFacts.ts'
import {
  comparedToRunLabel,
  deltaFlipKind,
  deltaVsLastRun,
  type CheckRun,
  type DeltaFlipKind,
} from './runHistory.ts'

function flipPhrase(kind: DeltaFlipKind, copy: ProductCopy): string {
  if (kind === 'newlyMentioned') return copy.deltaNewlyMentioned
  if (kind === 'noLongerMentioned') return copy.deltaNoLongerMentioned
  if (kind === 'nowMentioned') return copy.deltaNowMentioned
  return copy.deltaLostMention
}

function flipLine(question: string, from: Mention, to: Mention, copy: ProductCopy): string {
  const kind = deltaFlipKind(from, to)
  const phrase = kind ? flipPhrase(kind, copy) : `${mentionStatusLabel(from, copy)} → ${mentionStatusLabel(to, copy)}`
  return `${question} — ${phrase}`
}

/** Mention / who-appeared changes versus the previous run. Not a report rewrite. */
export function RunDelta({ runs, copy }: { runs: CheckRun[]; copy: ProductCopy }) {
  const delta = deltaVsLastRun(runs)
  const priorAt = runs.length >= 2 ? runs[runs.length - 2]?.at : ''
  const stamp = delta.comparable && priorAt ? comparedToRunLabel(copy.deltaComparedTo, priorAt) : ''
  return (
    <section className="block run-delta" aria-label={copy.deltaTitle}>
      <h2>{copy.deltaTitle}</h2>
      <p className="why">{copy.deltaHelper}</p>
      {stamp ? <p className="why">{stamp}</p> : null}
      {!delta.comparable ? (
        <p className="why">{copy.deltaAwaiting}</p>
      ) : delta.empty ? (
        <p className="why">{copy.deltaEmpty}</p>
      ) : (
        <ul className="run-delta-list">
          {delta.flips.map((flip) => (
            <li key={`${flip.question}:${flip.from}:${flip.to}`}>{flipLine(flip.question, flip.from, flip.to, copy)}</li>
          ))}
          {delta.appeared.map((name) => (
            <li key={`appeared:${name}`}>
              {name} — {copy.deltaWhoAppeared}
            </li>
          ))}
          {delta.dropped.map((name) => (
            <li key={`dropped:${name}`}>
              {name} — {copy.deltaWhoDropped}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

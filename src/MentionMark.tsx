import type { ProductCopy } from './config/productConfig.ts'
import type { Framing, Mention } from './mentionFacts.ts'
import { mentionStatusLabel, whoInsteadNames } from './mentionLabel.ts'

const HELP: Record<Mention, string> = {
  mentioned: 'Your brand shows up in this answer.',
  not_mentioned: 'This answer doesn’t name you.',
  unclear: 'Mention is weak or only implied — treat as not a clear win.',
}

/** One skim state under Generated · OpenAI. Failed answers pass no mention. */
export function MentionMark({
  mention,
  whoInstead,
  framing,
  copy,
}: {
  mention?: Mention
  whoInstead: string[]
  framing: Framing
  copy: ProductCopy
}) {
  if (!mention) return null
  const names = whoInsteadNames(whoInstead, framing)
  const who = names.length > 0 && mention !== 'mentioned'
  const label = mentionStatusLabel(mention, copy)
  return (
    <div className="mention-skim">
      <span className="tag plain mention">{label}</span>
      {who ? (
        <ul className="mention-names">
          {names.map((name) => (
            <li key={name}>
              <strong>{name}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mention-help">{HELP[mention]}</p>
      )}
    </div>
  )
}

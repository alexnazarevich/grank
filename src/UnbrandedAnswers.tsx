import type { ProductCopy } from './config/productConfig.ts'
import { geminiRow } from './engineBlock.ts'
import type { Mention } from './mentionFacts.ts'
import { MentionMark } from './MentionMark.tsx'
import { STORY } from './story.ts'

/** OpenAI mention block, then a separate Gemini block. Gemini text is not a mention or a name list. */
export function UnbrandedAnswers({
  mention,
  whoInstead,
  gemini,
  index,
  copy,
}: {
  mention?: Mention
  whoInstead: string[]
  /** Aligned Gemini replies for this run. Omit when Gemini was not asked. */
  gemini?: readonly string[]
  index: number
  copy: ProductCopy
}) {
  const row = geminiRow(gemini, index)
  return (
    <>
      {mention ? (
        <>
          <div className="answer-meta">
            <span className="tag plain live">{STORY.answerLabel}</span>
          </div>
          <MentionMark mention={mention} whoInstead={whoInstead} framing="unbranded" copy={copy} />
        </>
      ) : null}
      {row ? (
        <div className={row.miss ? 'answer miss' : 'answer'}>
          <div className="answer-meta">
            <span className="tag plain live">{row.label}</span>
          </div>
          <p className="answer-body">{row.body}</p>
        </div>
      ) : null}
    </>
  )
}

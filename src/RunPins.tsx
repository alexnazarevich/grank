import type { ProductCopy } from './config/productConfig.ts'
import type { Framing } from './mentionFacts.ts'

export type PinItem = {
  key: string
  question: string
  framing: Framing
}

export function QuestionPinControls({
  rowKey,
  question,
  framing,
  pins,
  max,
  editing,
  editText,
  copy,
  disabled,
  onPin,
  onUnpin,
  onEdit,
  onEditText,
  onSave,
}: {
  rowKey: string
  question: string
  framing: Framing
  pins: PinItem[]
  max: number
  editing: boolean
  editText: string
  copy: ProductCopy
  disabled?: boolean
  onPin: (item: PinItem) => void
  onUnpin: (key: string) => void
  onEdit: (key: string, question: string) => void
  onEditText: (value: string) => void
  onSave: (item: PinItem) => void
}) {
  const pinned = pins.some((item) => item.key === rowKey)
  const atMax = pins.length >= max && !pinned
  if (editing) {
    const text = editText.replace(/\s+/g, ' ').trim()
    return (
      <div className="pin-edit">
        <input
          aria-label="Question"
          value={editText}
          maxLength={240}
          onChange={(event) => onEditText(event.target.value)}
        />
        <button
          type="button"
          disabled={disabled || !text || text.length > 240 || atMax}
          onClick={() => onSave({ key: rowKey, question: text, framing })}
        >
          {copy.saveEditedQuestionCta}
        </button>
      </div>
    )
  }
  return (
    <div className="q-tools">
      {pinned ? (
        <button type="button" disabled={disabled} onClick={() => onUnpin(rowKey)}>
          {copy.unpinQuestionCta}
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled || atMax}
          onClick={() => onPin({ key: rowKey, question, framing })}
        >
          {copy.pinQuestionCta}
        </button>
      )}
      <button type="button" disabled={disabled} onClick={() => onEdit(rowKey, question)}>
        {copy.editQuestionCta}
      </button>
    </div>
  )
}

/** Hidden until at least one question is pinned for this run. */
export function PinnedRun({
  pins,
  copy,
  disabled,
  onUnpin,
}: {
  pins: PinItem[]
  copy: ProductCopy
  disabled?: boolean
  onUnpin: (key: string) => void
}) {
  if (pins.length < 1) return null
  return (
    <div className="pinned-run">
      <h3>{copy.pinnedQuestionsTitle}</h3>
      <ul>
        {pins.map((item) => (
          <li key={item.key}>
            <span>{item.question}</span>
            <button type="button" disabled={disabled} onClick={() => onUnpin(item.key)}>
              {copy.unpinQuestionCta}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

import { useState } from 'react'
import type { ProductCopy } from './config/productConfig.ts'
import { whoInsteadCountLabel, type WhoInsteadTopic } from './mentionLabel.ts'

/** One topic on this run. The theme title is the control. Names stay on the row. */
function WhoInsteadTopicRow({
  topic,
  copy,
  panelId,
  initialOpen,
}: {
  topic: WhoInsteadTopic
  copy: ProductCopy
  panelId: string
  initialOpen: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <li className="who-instead-topic">
      <button
        type="button"
        className="who-instead-topic-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {topic.title}
      </button>
      <ul className="who-instead-list">
        {topic.names.map((row) => (
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
      {topic.more > 0 ? (
        <p className="who-instead-more">{whoInsteadCountLabel(copy.whoInsteadBoardMore, topic.more)}</p>
      ) : null}
      {open ? (
        <ul id={panelId} className="who-instead-questions">
          {topic.questions.map((item, index) => (
            <li key={`${index}:${item.question}`}>
              <p className="who-instead-question">{item.question}</p>
              <p className="who-instead-under">{copy.mentionWhoInstead}</p>
              <ul className="mention-names">
                {item.names.map((name) => (
                  <li key={name}>
                    <strong>{name}</strong>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** Full report only. Unbranded substitutes for this run, grouped by theme. */
export function WhoInsteadBoard({
  copy,
  topics,
  titleId,
  initialOpen = false,
}: {
  copy: ProductCopy
  topics: WhoInsteadTopic[]
  titleId: string
  /** Opens every topic for tests. The report starts collapsed. */
  initialOpen?: boolean
}) {
  return (
    <section className="block who-instead-board" aria-labelledby={titleId}>
      <h2 className="beat-title" id={titleId}>
        {copy.whoInsteadBoardTitle}
      </h2>
      <p className="why">{copy.whoInsteadBoardHelper}</p>
      {topics.length === 0 ? (
        <p className="why">{copy.whoInsteadBoardEmpty}</p>
      ) : (
        <ul className="who-instead-topics">
          {topics.map((topic, index) => (
            <WhoInsteadTopicRow
              key={`${topic.id}:${index}`}
              topic={topic}
              copy={copy}
              panelId={`who-instead-${topic.id}-${index}`}
              initialOpen={initialOpen}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

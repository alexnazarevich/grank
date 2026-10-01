import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FullReport } from '../src/fullReport.ts'
import {
  LABEL_GENERATED,
  LABEL_UNBRANDED,
  type StoredResult,
} from '../src/savedResult.ts'
import {
  applyOwnedToReport,
  applyOwnedToStoredShort,
  cleanOwnedQuestions,
  mergeOwnedAnswers,
  ownedAnswerPrompt,
  ownedFromReport,
} from '../src/ownedQuestions.ts'

const report: FullReport = {
  domain: 'linear.app',
  model: 'gpt-4o-mini',
  includesBranded: true,
  themes: [
    {
      id: 'problems',
      title: 'Problems you solve',
      questions: [
        {
          question: 'What should a team use for issue tracking?',
          answer: 'Jira and Asana show up for that job.',
          framing: 'unbranded',
          mention: 'not_mentioned',
          whoInstead: ['Jira', 'Asana'],
        },
        {
          question: 'What do product teams use to plan work?',
          answer: 'Several tools get named.',
          framing: 'unbranded',
          mention: 'not_mentioned',
          whoInstead: ['Jira'],
        },
      ],
    },
    {
      id: 'described',
      title: 'How you’re described',
      questions: [
        {
          question: 'How do teams describe Linear?',
          answer: 'Linear is a fast issue tracker.',
          framing: 'branded',
          mention: 'mentioned',
          whoInstead: [],
        },
      ],
    },
  ],
}

describe('owned question set', () => {
  it('keeps a stable theme id, and moves a branded question off alternatives', () => {
    const owned = cleanOwnedQuestions(
      [
        { question: 'What should a team use for issue tracking?', themeId: 'problems' },
        { question: 'How do teams describe Linear?', themeId: 'alternatives' },
        { question: 'Who else should a team use for issue tracking?', id: 'alternatives' },
      ],
      'linear.app',
    )
    assert.deepEqual(
      owned.map((item) => item.themeId),
      ['problems', 'described', 'alternatives'],
    )
    assert.equal(owned[1]?.question, 'How do teams describe Linear?')
  })

  it('adds and deletes questions and keeps mention on text that did not change', () => {
    const current = ownedFromReport(report).filter((item) => item.question !== 'What do product teams use to plan work?')
    const edited = cleanOwnedQuestions(
      [...current, { question: 'What tools do support teams use for tickets?', themeId: 'problems' }],
      'linear.app',
    )
    const next = applyOwnedToReport(report, edited)
    const problems = next.themes.find((theme) => theme.id === 'problems')
    assert.equal(problems?.questions.some((item) => item.question === 'What do product teams use to plan work?'), false)
    const kept = problems?.questions.find((item) => item.question === 'What should a team use for issue tracking?')
    assert.equal(kept?.mention, 'not_mentioned')
    assert.deepEqual(kept?.whoInstead, ['Jira', 'Asana'])
    const added = problems?.questions.find((item) => item.question === 'What tools do support teams use for tickets?')
    assert.equal(added?.answer, '')
    assert.equal(added?.mention, undefined)
    assert.equal(added?.framing, 'unbranded')
    const described = next.themes.find((theme) => theme.id === 'described')
    assert.equal(described?.id, 'described')
    assert.equal(described?.framing, 'branded')
    assert.equal(described?.questions[0]?.mention, 'mentioned')
    assert.equal(problems?.framing, 'unbranded')
    const moved = applyOwnedToReport(report, [
      ...edited,
      { question: 'What tools should a team buy for planning?', themeId: 'described' },
    ])
    assert.equal(
      moved.themes.find((theme) => theme.id === 'described')?.questions.every((item) => item.framing === 'branded'),
      true,
    )
    assert.equal(
      moved.themes
        .find((theme) => theme.id === 'problems')
        ?.questions.some((item) => item.question.includes('buy for planning')),
      true,
    )
  })

  it('clears the answer when the question text changes', () => {
    const edited = ownedFromReport(report).map((item) =>
      item.question === 'How do teams describe Linear?'
        ? { question: 'How do buyers describe Linear?', themeId: item.themeId }
        : item,
    )
    const next = applyOwnedToReport(report, edited)
    const row = next.themes.find((theme) => theme.id === 'described')?.questions[0]
    assert.equal(row?.question, 'How do buyers describe Linear?')
    assert.equal(row?.answer, '')
    assert.equal(row?.mention, undefined)
  })

  it('answers the owned wording and keeps mention only when the answer is usable', () => {
    const owned = [
      { question: 'What should a team use for issue tracking?', themeId: 'problems' as const },
      { question: 'How do teams describe Linear?', themeId: 'described' as const },
    ]
    const prompt = ownedAnswerPrompt('linear.app', [{ id: 'problems', title: 'Problems you solve', questions: [owned[0].question] }], null)
    assert.match(prompt, /Do not add questions\. Do not drop questions\. Do not rewrite question text\./)
    assert.equal(/write \d+ questions/.test(prompt), false)
    const themes = mergeOwnedAnswers(
      owned,
      {
        themes: [
          {
            id: 'problems',
            questions: [
              {
                question: 'What tool should I buy?',
                answer: 'Jira shows up for that job. Linear might too.',
                mention: 'mentioned',
                whoInstead: ['Jira'],
              },
            ],
          },
          {
            id: 'described',
            questions: [
              {
                question: 'How do teams describe Linear?',
                answer: 'Linear is a fast issue tracker for software teams.',
                mention: 'mentioned',
                whoInstead: ['Jira'],
              },
            ],
          },
        ],
      },
      { domain: 'linear.app' },
    )
    const problems = themes?.find((theme) => theme.id === 'problems')?.questions[0]
    assert.equal(problems?.question, 'What should a team use for issue tracking?')
    assert.equal(problems?.mention, 'unclear')
    assert.deepEqual(problems?.whoInstead, ['Jira'])
    const described = themes?.find((theme) => theme.id === 'described')?.questions[0]
    assert.equal(described?.mention, 'mentioned')
    assert.deepEqual(described?.whoInstead, [])
    const missed = mergeOwnedAnswers(
      [{ question: 'What should a team use for issue tracking?', themeId: 'problems' }],
      { themes: [{ id: 'problems', questions: [{ question: 'What should a team use for issue tracking?', answer: '' }] }] },
      { domain: 'linear.app' },
    )
    assert.equal(missed?.[0]?.questions[0]?.mention, undefined)
    assert.equal(missed?.[0]?.questions[0]?.answer, '')
  })

  it('stores a short-check edit on the question list and keeps the theme id', () => {
    const stored: StoredResult = {
      labels: {
        questions: LABEL_GENERATED,
        answered: 'Live model',
        whoInstead: LABEL_GENERATED,
        mode: LABEL_UNBRANDED,
      },
      model: 'gpt-4o-mini',
      questionsGenerated: true,
      questions: ['What should a team use for issue tracking?', 'What do product teams use to plan work?'],
      facts: [
        {
          question: 'What should a team use for issue tracking?',
          framing: 'unbranded',
          id: 'problems',
          mention: 'not_mentioned',
          whoInstead: ['Jira'],
        },
      ],
      unbranded: {
        questions: ['What should a team use for issue tracking?', 'What do product teams use to plan work?'],
        questionsGenerated: true,
      },
    }
    const next = applyOwnedToStoredShort(
      stored,
      'unbranded',
      [
        { question: 'What should a team use for issue tracking?', themeId: 'problems' },
        { question: 'Who else should a team use for issue tracking?', themeId: 'alternatives' },
      ],
    )
    assert.equal(next.questionSetOwned, true)
    assert.deepEqual(next.questions, [
      'What should a team use for issue tracking?',
      'Who else should a team use for issue tracking?',
    ])
    assert.equal(next.facts?.[0]?.mention, 'not_mentioned')
    assert.equal(next.facts?.[0]?.id, 'problems')
    assert.equal(next.facts?.[1]?.id, 'alternatives')
    assert.equal(next.facts?.[1]?.mention, undefined)
    assert.equal(next.unbranded?.questions?.[1], 'Who else should a team use for issue tracking?')
  })
})

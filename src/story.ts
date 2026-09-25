/** Story copy. Homepage lines are the bet 7 pass. Land/dig lines stay as shipped. */

export const STORY = {
  landEyebrow: 'Unbranded',
  landTitle: 'Do you show up for what you solve?',
  landHelper: 'Category questions — no brand name required. This is the usual first ask.',
  landBadge: 'Unbranded',
  ask: 'Ask about your brand',
  digLoading: 'Checking what they say when people name you…',
  digEyebrow: 'Branded',
  digTitle: 'What do they say about you?',
  digHelper: 'Questions that name your brand — tone, claims, how you’re described.',
  digBadge: 'Branded',
  digFail: 'Couldn’t generate branded questions — try again.',
  answerLabel: 'Generated · OpenAI',
  answerHelper:
    'Answers below are from our model for these questions — not a live multi-engine scrape.',
  answerMiss: 'Couldn’t get an answer.',
  /** Result-screen honesty. Homepage uses homeProof. */
  proof: 'Every question is labeled Unbranded or Branded. We don’t mix them into one score.',
  documentTitle: 'Grank — See if you show up in AI answers',
  headerBadge: 'SIMPLE AEO · LABELED MODEL CHECKS',
  homeH1: 'See if you show up in AI answers',
  homeSub:
    'Paste a URL. First we check whether you show up for the problems you solve — then you can ask what they say about your brand. No setup.',
  urlPlaceholder: 'https://yourbrand.com',
  cta: 'Check visibility',
  homeLoading: 'Checking how AI might talk about you…',
  exampleLead: 'Or try an example:',
  homeProof:
    'We generate questions and answers with OpenAI and label every block. This is not a live multi-engine scrape — and we never blend branded + unbranded into one score.',
  foilTitle: 'Built for thin teams',
  foilBody:
    '“Are we in AI answers?” shouldn’t need a $499 demo or a prompt lab. Suites sell ops. You need a glance: do you show up for what you solve — and who shows up instead.',
  foilFoot: 'Land on unbranded. Dig into branded when you’re ready.',
} as const

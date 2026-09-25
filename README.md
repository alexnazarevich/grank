# Grank MVP — homepage + URL → aha

**Track A** Vite + React + TS. Deployed: https://grank.pages.dev

## What’s real vs sample

| Signal | Status |
| --- | --- |
| **Unbranded questions** (default) | **Generated · OpenAI** — category / job-to-be-done questions. `GET /api/visibility?domain=&mode=unbranded` (mode defaults to unbranded; POST JSON also works). The brand is known for the read, but the questions do not need its name. |
| **Branded questions** | Same endpoint with `mode=branded`, on demand from **Ask about your brand**. Questions name the brand. Each one includes a short `answers[]` reply from the same `gpt-4o-mini` call (or `{ question, answer }` objects, which the function normalizes). Above the questions: “Answers below are from our model for these questions — not a live multi-engine scrape.” Each reply is badged **Generated · OpenAI**. A missing reply says “Couldn’t get an answer.” No invented praise. A failed branded check says “Couldn’t generate branded questions — try again.” |
| **Answered by you?** | **Live model** — the verdict belongs to the active set only (unbranded or branded). Yes / partial / no, conservative, one-sentence why. Not a multi-engine scan and not a blended score. |
| **Who shows up instead** | **Unbranded only.** 1–3 real alternate brand names from that call. No names → “Couldn’t find alternatives”. Branded responses omit it. |
| Homepage fetch | Small supporting line only (`GET /api/homepage`). It does not set the primary verdict. |

There is no blended visibility percentage. Every question is labeled Unbranded or Branded.

`OPENAI_API_KEY` lives in the Cloudflare Pages env (Production and Preview). It is not a `VITE_*` variable and is never sent to the browser. Missing key → `503` `{ "error": "OPENAI_API_KEY not configured" }`. Model failure → `502` with an honest error (no fake Yes, no invented competitors). If the unbranded call fails, the screen shows labeled sample category questions, **Unavailable** for answered-by-you, and “Couldn’t find alternatives” for who-instead. A branded failure stays on the branded beat and does not reuse the unbranded result.

## Run

```bash
npm install
npm run dev
# or
npm run build && npm run preview
npm test
```

Cloudflare Pages: build `npm run build`, output `dist`. Pages Functions:

- `functions/api/visibility.ts` → `/api/visibility` (`mode=unbranded|branded`; unbranded includes who-instead)
- `functions/api/homepage.ts` → `/api/homepage` (supporting page-content line)

`npm run dev` and `npm run preview` do not run Pages Functions. Question generation then shows an honest unavailable state and sample questions. The homepage supporting line falls back to Jina Reader and AllOrigins only when `/api/homepage` is missing; those proxies fail on production (Jina returns 401).

To smoke the function locally (no key in the repo):

```bash
npx wrangler pages dev dist
# /api/visibility returns 503 until OPENAI_API_KEY is in the shell or .dev.vars (gitignored; do not commit)
```

## 5-minute demo

1. Open homepage → paste URL or try linear.app / notion.so.
2. Land on **Unbranded** — “Do you show up for what you solve?” Each question is badged Unbranded.
3. Point at **Answered by you?** — that read is for the unbranded set. **Who shows up instead** is on this beat only.
4. **Ask about your brand** → branded questions (“What do they say about you?”), badged Branded, each with a model answer labeled **Generated · OpenAI** (or “Couldn’t get an answer”). Who-instead is gone. Switch back with **Unbranded** — the first result stays cached, still a question list with no answer blocks.
5. Close: one screen, one model, two labeled sets. No blended score.

# Grank MVP — homepage + URL → aha

**Track A** Vite + React + TS. Deployed: https://grank.pages.dev

## What’s real vs sample

| Signal | Status |
| --- | --- |
| **Questions people ask** | **Generated · OpenAI** — `gpt-4o-mini` via `GET /api/visibility?domain=` (POST JSON also works). |
| **Answered by you?** | **Live model** — same call. Yes / partial / no from the model, conservative, one-sentence why. Not a multi-engine scan. |
| **Who shows up instead** | **Generated · OpenAI** — same call. 1–3 real alternate brand names. No names → “Couldn’t find alternatives”. |
| Homepage fetch | Small supporting line only (`GET /api/homepage`). It does not set the primary verdict. |

`OPENAI_API_KEY` lives in the Cloudflare Pages env (Production and Preview). It is not a `VITE_*` variable and is never sent to the browser. Missing key → `503` `{ "error": "OPENAI_API_KEY not configured" }`. Model failure → `502` with an honest error (no fake Yes, no invented competitors). If the function fails entirely, the screen shows labeled sample questions, **Unavailable** for answered-by-you, and “Couldn’t find alternatives” for who-instead.

## Run

```bash
npm install
npm run dev
# or
npm run build && npm run preview
npm test
```

Cloudflare Pages: build `npm run build`, output `dist`. Pages Functions:

- `functions/api/visibility.ts` → `/api/visibility` (questions, answered-by-you, who-instead)
- `functions/api/homepage.ts` → `/api/homepage` (supporting page-content line)

`npm run dev` and `npm run preview` do not run Pages Functions. Question generation then shows an honest unavailable state and sample questions. The homepage supporting line falls back to Jina Reader and AllOrigins only when `/api/homepage` is missing; those proxies fail on production (Jina returns 401).

To smoke the function locally (no key in the repo):

```bash
npx wrangler pages dev dist
# /api/visibility returns 503 until OPENAI_API_KEY is in the shell or .dev.vars (gitignored; do not commit)
```

## 5-minute demo

1. Open homepage → paste URL or try linear.app / notion.so.
2. Point at **Questions** — Generated · OpenAI.
3. Point at **Answered by you?** — Live model (gpt-4o-mini), plus the small homepage line if it loaded.
4. Point at **Who shows up instead** — badge **Generated · OpenAI**, or “Couldn’t find alternatives” when there are no names.
5. Close: one screen, one model. Two domains get different who-instead sets.

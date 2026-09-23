# Grank MVP — homepage + URL → aha

**Track A** Vite + React + TS app. One live signal (answered-by-you) plus labeled stubs. No backend, no LLM calls.

## Run

```bash
npm install
npm run dev
# or
npm run build && npm run preview
```

## What’s real vs stubbed

| Real | Stubbed |
| --- | --- |
| Homepage + URL → one-screen aha | Questions people ask |
| **Answered-by-you:** fetch the homepage as text from `https://r.jina.ai/{url}`, fall back to `https://api.allorigins.win/raw?url=`, then score brand/domain mentions in the title and body → **yes** / **partial** / **no**, with the why text on screen | Who shows up instead |
| Example chips (`notion.so`, `linear.app`) run that same live check | No ChatGPT, Perplexity, or other model calls |

Scoring:

- **Yes** — the brand or domain is in the homepage title and in the body.
- **Partial** — it shows up in only one of those.
- **No** — neither the title nor the body names it.

The engines line says this is **not** ChatGPT or Perplexity. The header badge is “answered-by-you live; other blocks stub.” Each block is tagged Live or Stub.

## 5-minute demo script

1. Open the homepage — H1 “See if AI answers with you”, Check visibility, example chips.
2. Click **Try: linear.app** — live Yes / Partial / No plus why text. Questions and who-shows-up-instead stay tagged Stub.
3. Paste any other URL — same homepage read, or the load error if both fetches fail.
4. Point at the header badge, the Live / Stub tags, and the engines line (not ChatGPT or Perplexity).
5. Close: one honest live signal for thin teams — not a multi-engine suite.

## Acceptance (Strategist)

- [x] Homepage story copy kept (H1, Check visibility, example chips)
- [x] Answered-by-you is a live homepage fetch + mention score
- [x] Questions and who-shows-up-instead labeled stubs
- [x] Engines line says this is not ChatGPT or Perplexity
- [x] No Agents / Credits chrome, no Track B auth
- [x] No Supabase, Workers, or multi-engine LLM calls

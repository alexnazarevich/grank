# Grank MVP — homepage + URL → aha

**Track A** Vite + React + TS. Deployed: https://grank.pages.dev

## What’s real vs stubbed

| Signal | Status |
| --- | --- |
| **Answered by you?** | **Live** same-origin page-content check (`GET /api/homepage?domain=`). Yes/partial/no from the homepage title and text. **Not** ChatGPT/Perplexity. |
| Questions people ask | Labeled stub |
| Who shows up instead | Labeled stub |

## Run

```bash
npm install
npm run dev
# or
npm run build && npm run preview
npm test
```

Cloudflare Pages: build `npm run build`, output `dist`. The Pages Function `functions/api/homepage.ts` serves `/api/homepage` (same-origin; no CORS).

`npm run dev` and `npm run preview` do not run Pages Functions. When `/api/homepage` is missing, the client falls back to Jina Reader and AllOrigins. Those proxies fail on production (Jina returns 401). Use the Pages deployment to see the live signal.

## 5-minute demo

1. Open homepage → paste URL or try linear.app / notion.so.  
2. Point at **Answered by you?** — live badge + fetch basis.  
3. Point at stub tags on questions / who-instead.  
4. Close: one real signal, still one screen — no suite chrome.

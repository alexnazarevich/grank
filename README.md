# Grank MVP — homepage + URL → aha

**Track A** Vite + React + TS. Deployed: https://grank.pages.dev

## What’s real vs stubbed

| Signal | Status |
| --- | --- |
| **Answered by you?** | **Live** homepage fetch (Jina Reader, HTML proxy fallback) → yes/partial/no with visible basis. **Not** ChatGPT/Perplexity. |
| Questions people ask | Labeled stub |
| Who shows up instead | Labeled stub |

## Run

```bash
npm install
npm run dev
# or
npm run build && npm run preview
```

Cloudflare Pages: build `npm run build`, output `dist`.

## 5-minute demo

1. Open homepage → paste URL or try linear.app / notion.so.  
2. Point at **Answered by you?** — live badge + fetch basis.  
3. Point at stub tags on questions / who-instead.  
4. Close: one real signal, still one screen — no suite chrome.

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

## Save & re-run

Guest land/dig is unchanged: unbranded category questions first, branded when you ask. No account.

**Save this check** (after the result) sends a Supabase magic link. When you open the link, Grank stores the check and opens **Your checks**. Open one to see the prior land/dig result, including **Generated · OpenAI** and **Unbranded** / **Branded**. The saved blob keeps the unbranded beat and the branded dig when it was loaded. **Run again** calls `/api/visibility` for the active mode and `/api/homepage`, then inserts a new check and trims history to `maxSavedChecksPerUser`.

Button labels and the history title come from `productConfig.copy` (`saveCta`, `runAgainCta`, `historyTitle`). Limits and what gets stored come from the same knobs (`storeQuestions`, `storeAnswers`, `storeWhoInstead`, `storeHomepageSnippet`, `maxSavedChecksPerUser`, `checkRetentionDays`, `freeChecksBeforeSave`, `saveRequiresAuth`). While `paywallEnabled` is false, checks are not quota-blocked and `/api/billing` does not call Stripe. See **Free quota and one paid plan** below.

If the Supabase client vars are missing, the result still loads and Save / History say **Auth not configured**. If the Pages secrets are missing, `/api/checks` returns 503 with the same kind of setup message and `/api/visibility` keeps working.

Apply `supabase/migrations/20260925120000_save_and_rerun.sql` in the Supabase SQL editor before the first save. In Supabase Auth, allow the site origin as a redirect URL (magic links return to `/`).

### Env vars

Privileged values stay on Cloudflare Pages (Production and Preview). Never create `VITE_OPENAI_API_KEY`, `VITE_SUPABASE_SERVICE_ROLE_KEY`, or `VITE_STRIPE_*`.

| Pages secret | Used by |
| --- | --- |
| `OPENAI_API_KEY` | `/api/visibility` |
| `OPENAI_MODEL` | optional; visibility still defaults to `gpt-4o-mini` |
| `SUPABASE_URL` | `/api/checks` (server writes) |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/checks` only. Never ship to the browser. |
| `PRODUCT_CONFIG_JSON` | optional knob blob. Single env aliases (`MAX_SAVED_CHECKS_PER_USER`, `STORE_QUESTIONS`, `PAYWALL_ENABLED`, …) override one field. |
| `STRIPE_SECRET_KEY` | Checkout Session. **(9).** Never a `VITE_*` var. |
| `STRIPE_WEBHOOK_SECRET` | Verify `Stripe-Signature` on `/api/stripe-webhook`. |
| `STRIPE_PRICE_ID` | The one recurring Price (`price_...`). |

| Vite (public) | Used by |
| --- | --- |
| `VITE_SUPABASE_URL` | magic link |
| `VITE_SUPABASE_ANON_KEY` | magic link. Row access is still RLS-scoped; saves go through `/api/checks`. |
| `VITE_PRODUCT_CONFIG_JSON` | optional copy/knob mirror when `/api/product-config` is down |

Server enforcement reads `PRODUCT_CONFIG_JSON` and the env aliases. The UI displays that config; it does not decide the cap or which fields are stored.

### Happy path (needs the env above)

1. Signed out: paste `linear.app` → result with **Generated · OpenAI** and **Unbranded**. No signup before the result.
2. **Save this check** → enter email → open the magic link.
3. **Your checks** lists that domain. Open it → prior questions, model read, and who-instead.
4. **Run again** → fresh `/api/visibility` result, same honesty labels, new history row.

Without those keys locally, step 1 still works and step 2 shows **Auth not configured**.

## Free quota and one paid plan

`paywallEnabled` defaults to **false** (kill switch). Guest land/dig keeps working, and `/api/billing` does not call Stripe.

Turn the wall on for **Production and Preview** without a code change. Set `PRODUCT_CONFIG_JSON`:

```json
{"paywallEnabled": true}
```

`PAYWALL_ENABLED=true` overrides that one field. The same blob sets the quota: `freeQuotaUnit` (`checks`, `saves`, or `both`; default `checks`), `freeQuotaAmount` (default `3`), `freeQuotaWindow` (`lifetime`, `day`, or `month`; default `lifetime`). A profile with `plan = paid` uses `paidQuotaAmount` and `paidMaxSavedChecks` instead of the free caps. One paid tier — not a list of SKUs. `paidPriceCents` is display-only; Stripe charges `STRIPE_PRICE_ID`.

`/api/visibility` checks the quota **before** any OpenAI call. At the limit it returns HTTP 402 `{ "code": "quota_exceeded" }` and does not call the model. The page then shows `copy.upgradeHeadline`, `copy.upgradeBody`, and `copy.upgradeCta`. Upgrade copy stays off the screen until that wall.

Guest checks are counted with a browser id (`x-grank-anon`, stored locally). Signing in attaches those rows to the account. A signed-in check counts against that user.

### Stripe

Set these on Pages **Production and Preview** (test mode is fine). If either secret or the price id is missing, checkout stays disabled and `POST /api/billing` returns a clear configuration error. It does not call Stripe.

| Name | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Create the Checkout Session |
| `STRIPE_WEBHOOK_SECRET` | Verify the webhook |
| `STRIPE_PRICE_ID` | The single recurring price |

Webhook endpoint: `https://grank.pages.dev/api/stripe-webhook`

Subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, and `customer.subscription.deleted`. A paid checkout sets `profiles.plan` to `paid` and stores `stripe_customer_id`. A canceled or unpaid subscription sets the plan back to `free`.

Apply `supabase/migrations/20260926150000_quota_paid.sql` after the save migration. `profiles.plan`, `stripe_customer_id`, and `usage_events` already come from `20260925120000_save_and_rerun.sql`; this file adds the lookup indexes and is safe to re-run.

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
- `functions/api/checks.ts` → `/api/checks` (save and list; service role)
- `functions/api/product-config.ts` → `/api/product-config` (non-secret knobs)
- `functions/api/billing.ts` → `/api/billing` (one Checkout Session when the paywall is on)
- `functions/api/stripe-webhook.ts` → `/api/stripe-webhook` (sets `profiles.plan`)

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

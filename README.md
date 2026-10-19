# Trackora — portfolio tracker

A full-stack tracker for a stock & crypto portfolio spread across several brokers. I built it for myself and use it every day. Redesigned in October 2026; the UI is in English and Czech.

**Live demo:** [zdenekbudicek.github.io/demo/portfolio-tracker](https://zdenekbudicek.github.io/demo/portfolio-tracker/) — runs entirely in the browser with invented prices, trades and company financials.

## What it does

- **Three brokers in one place** — live sync with the Trading 212 API, plus statement import for XTB (`.xlsx`) and Revolut (`.pdf`).
- **Returns against the S&P 500** (time-weighted), dividend income and forecasts, risk metrics.
- **Five display currencies** — the whole portfolio in USD, CZK, EUR, GBP or PLN, with every purchase converted at the exchange rate of its own day, so gains include the currency move. The default currency is saved per user.
- **Company financials** — revenue, profit, cash flow, margins, valuation multiples and capital returned, per year or quarter.
- **Fair-value calculator** — DCF with a sensitivity table, valuation multiples, reverse DCF, Graham number and a dividend model, with adjustable assumptions.
- **Czech tax report** — per-lot FIFO with ČNB exchange rates, the 3-year holding test for securities and crypto-assets and a breakdown against the CZK 100,000 sales limit.
- **Tax estimates for other countries** — the United States, Slovakia, Germany, the United Kingdom and Poland, each with its own rules (wash sales and short/long-term rates, share pooling, the German partial exemption, the Polish annual crypto cost pool …) and a yearly profile per user. The stock page shows the holding-period rule of the user's tax residence.

## How it is built

| Layer | Tech |
|---|---|
| Frontend | TypeScript, React, Vite, TanStack Query, Tailwind CSS, shadcn/ui, Recharts, i18next |
| Database | PostgreSQL on Supabase — row-level security on every table, triggers that keep positions and cash consistent with the transaction ledger, RPC functions for imports and reconciliation |
| Backend | Supabase Edge Functions (Deno) for price refresh, broker sync, snapshots, splits, news, sectors and on-demand fundamentals |
| Scheduling | `pg_cron` inside the database + GitHub Actions workers (`scripts/*.mjs`) for price history and company financials |
| Tests | Vitest (760 tests) |

Some design decisions worth a look:

- **Shared price cache with a provider fallback chain** — each ticker is fetched once for all users, and each provider in the chain only fills in the prices the previous one couldn't return.
- **Resumable broker sync** — a long order history is imported in batches with a cursor, so it stays within the edge-function time limit and the broker's API rate limits.
- **Idempotent statement import** — rows are keyed by content, so uploading the same statement twice does not count trades twice.
- **Company financials on demand** — a newly added company is fetched right away through a GitHub Actions run for just that symbol, with a per-user quota and an atomic reservation in the database; the nightly worker refreshes only after earnings or every 30 days.
- **Tax rules as pure functions** — FIFO, exchange rates and each country's tax engine are plain, tested functions, separate from the UI.
- **Rate-limited data jobs** — every scheduled job pages past PostgREST's 1,000-row cap, the price refresh rotates through tickers within the data provider's per-minute limit, and the broker sync works inside a hard time budget.
- **Encrypted broker API keys** — stored with `pgcrypto`, with the encryption key kept in Supabase Vault.

## Running it locally

Use Node.js 22 or newer. The SheetJS package is pinned to its official distribution tarball as described in the [SheetJS installation guide](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).

```bash
npm ci
cp .env.example .env.local   # fill in your Supabase project URL and publishable key
npm run dev
npm test                     # tests run without a .env file
npm run dev:demo             # the browser-only demo with invented data
```

The database schema lives in `supabase/migrations/`; with the Supabase CLI you can apply it to your own project (`supabase link`, `supabase db push`) and deploy the functions (`supabase functions deploy`).

## Notes

- The project started from a Lovable scaffold. I develop it with AI coding assistants (Claude Code, Codex): I make the design decisions, review every change and own the tests.
- Account numbers and names in the test fixtures are made up.
- This is a public snapshot of my private working repository, without its commit history.

— [Zdeněk Budíček](https://zdenekbudicek.github.io)


## Public snapshot validation

This snapshot (October 2026) passed 760 tests, the TypeScript checks and both production builds (app and demo). `npm audit` currently reports advisories in Tailwind CSS 3 build tooling (`braces`, `postcss-selector-parser`); they affect the development/build toolchain, not the shipped bundle, and fixing them needs a Tailwind 4 migration. Live broker synchronization and a deployment against a new Supabase project were not exercised; those require your own configured backend and credentials. The browser demo uses a separate in-memory data adapter and does not prove the live integrations.

Scheduled data workers are disabled unless the repository variable ENABLE_PORTFOLIO_WORKERS is set to true. Configure the required repository secrets for your own backend before opting in.

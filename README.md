# Portfolio Tracker

A full-stack tracker for a stock & crypto portfolio spread across several brokers. I built it for myself and use it every day.

**Live demo:** [zdenekbudicek.github.io/demo/portfolio-tracker](https://zdenekbudicek.github.io/demo/portfolio-tracker/) — runs entirely in the browser with generated sample data (the UI is in Czech).

## What it does

- **Three brokers in one place** — live sync with the Trading 212 API, plus statement import for XTB (`.xlsx`) and Revolut (`.pdf`).
- **Returns in USD and CZK**, dividend income, Sharpe ratio and maximum drawdown.
- **Czech tax report** — FIFO cost basis per broker account with historical FX rates and the 3-year holding-period exemption tested per lot.

## How it is built

| Layer | Tech |
|---|---|
| Frontend | TypeScript, React, Vite, TanStack Query, Tailwind CSS, shadcn/ui, Recharts |
| Database | PostgreSQL on Supabase — row-level security on every table, triggers that keep positions and cash consistent with the transaction ledger, RPC functions for imports and reconciliation |
| Backend | Supabase Edge Functions (Deno) for price refresh, broker sync, snapshots, splits, news and sectors |
| Scheduling | `pg_cron` inside the database + GitHub Actions workers (`scripts/*.mjs`) |
| Tests | Vitest (~230 unit tests) |

Some design decisions worth a look:

- **Shared price cache with a provider fallback chain** — each ticker is fetched once for all users, and each provider in the chain only fills in the prices the previous one couldn't return.
- **Resumable broker sync** — a long order history is imported in batches with a cursor, so it stays within the edge-function time limit and the broker's API rate limits.
- **Idempotent statement import** — rows are keyed by content, so uploading the same statement twice does not count trades twice.
- **Encrypted broker API keys** — stored with `pgcrypto`, with the encryption key kept in Supabase Vault.

## Running it locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project URL and publishable key
npm run dev
npm test                     # unit tests run without a .env file
```

The database schema lives in `supabase/migrations/`; with the Supabase CLI you can apply it to your own project (`supabase link`, `supabase db push`) and deploy the functions (`supabase functions deploy`).

## Notes

- The project started from a Lovable scaffold. I develop it with AI coding assistants (Claude Code, Codex): I make the design decisions, review every change and own the tests.
- Account numbers and names in the test fixtures are made up.
- This is a public snapshot of my private working repository, without its commit history.

— [Zdeněk Budíček](https://zdenekbudicek.github.io)

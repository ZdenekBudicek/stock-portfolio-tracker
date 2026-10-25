-- Audit B6: a price carried forward from price_history (foreign/UCITS tickers the live providers cannot
-- fetch) is the close of its own day, not a quote retrieved now. `as_of` is that day; null = a live quote.
-- refresh-prices dates such rows by their close and no longer appends them to price_history as today's close.
alter table public.price_cache add column if not exists as_of date;

-- Shared, user-agnostic sector/industry profile per instrument. One row per CANONICAL
-- ticker for the whole app: if ten users hold NBIS we ask the provider once.
-- Same shape and RLS posture as price_cache / ticker_alias.
create table if not exists public.ticker_profiles (
  ticker       text primary key,          -- canonical ticker (after ticker_alias resolution)
  name         text,
  sector_raw   text,                      -- verbatim from the provider ("Technology")
  industry_raw text,                      -- verbatim from the provider ("Software - Infrastructure")
  sector       text,                      -- mapped Czech bucket; NULL = not resolved yet
  asset_type   text not null default 'EQUITY'
    check (asset_type in ('EQUITY', 'ETF', 'CRYPTO')),
  source       text,                      -- 'yahoo' | 'finnhub' | 'static'
  -- Consecutive lookups that returned NOTHING, counted PER PROVIDER. One shared counter
  -- would couple two independent failure modes: the nightly Yahoo worker and the
  -- sync-sectors edge function both back off on their own counter and both give up at 5,
  -- so a single column would let Yahoo's nightly failures — a live risk, the crumb
  -- endpoint is not guaranteed — lengthen the interval at which Finnhub, possibly the
  -- only working path, is allowed to retry, and freeze the ticker after five nights while
  -- the user's chart shows "Ostatní". Neither counter may be written by the other's job.
  -- A lookup that FAILED to reach the provider (429, 5xx, timeout) is not an empty answer
  -- and must not touch either column.
  finnhub_miss_count int not null default 0,
  yahoo_miss_count   int not null default 0,
  fetched_at   timestamptz not null default now()
);

-- No secondary index on purpose. Every consumer reads the whole table with no WHERE and
-- no ORDER BY, then applies the 90-day staleness and backoff rules in JavaScript: the
-- sync-sectors edge function, the nightly worker, and the frontend hook all do this
-- because the table holds one row per instrument anyone has ever held. An index on
-- fetched_at would serve no query and would only add write amplification to the
-- upsert-heavy nightly path. Add one when a SQL-side filter actually exists.

alter table public.ticker_profiles enable row level security;

-- Non-sensitive reference data: any authenticated user may read; only the service role
-- (used by sync-sectors and the nightly worker) writes. Matches ticker_alias, not
-- price_cache — the app is fully gated behind ProtectedRoute, so nothing ever reads this
-- as anon. The grant deliberately omits anon to match the policy: granting the privilege
-- without a matching policy would return an empty result set rather than an error, which
-- reads as "the sync is broken" when debugging.
drop policy if exists "ticker_profiles_read" on public.ticker_profiles;
create policy "ticker_profiles_read" on public.ticker_profiles
  for select to authenticated using (true);

-- No INSERT/UPDATE/DELETE policy: RLS is default-deny, so writes are closed to every role
-- except service_role, which bypasses RLS entirely.
grant select on public.ticker_profiles to authenticated;
grant all    on public.ticker_profiles to service_role;

-- ---------------------------------------------------------------------------------
-- positions.sector becomes a MANUAL OVERRIDE ONLY.
--
-- Until now a trigger stuffed it from the hardcoded guess_sector_for_ticker() map. Those
-- values would masquerade as deliberate user choices and permanently shadow the API, so
-- they get cleared. They are recognisable by being exactly what the map would produce —
-- anything a user typed by hand differs from it and survives.
--
-- Both historical trigger names are dropped. Chronology: 20260501121522:116 created
-- trg_autofill_position_sector (re-created in 20260502095749, 20260602135426 and
-- 20260603141436); 20260601134148:251 added a second name, trg_pos_autofill_sector,
-- running the same function; 20260603141436:178-186 dropped both and re-created only
-- trg_autofill_position_sector, which is what is live today. Dropping both here is the
-- idempotent superset. If either were still attached, this BEFORE UPDATE trigger would
-- refill each row as the UPDATE clears it and the migration would silently do nothing.
--
-- Rollback: re-create the trigger from 20260603141436:186-188 (BEFORE INSERT OR UPDATE,
-- unqualified — that is the one live today; 20260501121522:115-119 has a NARROWER
-- `OF ticker, sector` variant, so restoring from there would not be the status quo), then
-- `update public.positions set sector = public.guess_sector_for_ticker(ticker)
--    where sector is null;`
-- ---------------------------------------------------------------------------------
drop trigger if exists trg_autofill_position_sector on public.positions;
drop trigger if exists trg_pos_autofill_sector      on public.positions;

update public.positions
   set sector = null
 where sector is not distinct from public.guess_sector_for_ticker(ticker);

-- guess_sector_for_ticker() itself stays: it is a harmless pure IMMUTABLE function and the
-- statement above is its only remaining ATTACHED caller. autofill_position_sector() still
-- calls it too, but is now unattached; both are left in place so a rollback only has to
-- re-create the trigger.

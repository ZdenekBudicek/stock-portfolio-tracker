-- Service-side staging. Existing connections start with a full history scan, so an old
-- incomplete deposit import cannot become the new completed watermark.
alter table public.broker_connections add column if not exists cash_sync_state jsonb;

-- Keep the statement id while linking its matching API flow for future id-based deduplication.
alter table public.deposits add column if not exists api_reference text;
create unique index if not exists deposits_user_api_reference_uniq
  on public.deposits(user_id, api_reference) where api_reference is not null;

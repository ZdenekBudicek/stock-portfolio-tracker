-- Record the cash balance alongside the holdings value, per day.
--
-- Nothing ever stored what cash was on a past day, so the chart could only plot the value of
-- the positions. That makes selling a large position look like a crash: the money leaves the
-- holdings and lands in cash, which the chart could not see. Reconstructing the past balance
-- was measured and rejected — with deposits missing from the records it claimed $10 928 of
-- cash in June 2021, when the whole portfolio was worth $5 348.
--
-- So it is recorded from now on instead. NULL means "we did not track it yet" and the chart
-- shows holdings only for those days; from the first recorded day the curve is the whole
-- portfolio and a sale no longer shows up as a loss.
alter table public.daily_snapshots add column if not exists cash_usd numeric;

comment on column public.daily_snapshots.cash_usd is
  'Cash balance in USD on that day. NULL = not tracked yet (days before this column existed).';

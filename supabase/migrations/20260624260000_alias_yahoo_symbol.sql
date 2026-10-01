-- Per-source symbol for the history worker. canonical = symbol our live providers
-- (Finnhub/Twelve Data) use; yahoo_symbol = exchange-qualified symbol for Yahoo,
-- which has the broadest coverage (US + LSE/Xetra/foreign listings).
alter table public.ticker_alias add column if not exists yahoo_symbol text;

-- Seed the legacy broken-format tickers from the original manual import, resolved
-- via their ISIN + OpenFIGI. We keep the app ticker (alias = canonical) so existing
-- transactions/positions stay intact, and only map the correct Yahoo symbol so the
-- worker can fetch their real historical prices.
insert into public.ticker_alias (alias, canonical, isin, yahoo_symbol, source) values
  ('ELF_EQ_US', 'ELF_EQ_US', 'US26856L1035', 'ELF',     'legacy-map'),
  ('TLRY1',     'TLRY1',     'US88688T2096', 'TLRY',    'legacy-map'),
  ('GHVI',      'GHVI',      'US5770961002', 'MTTR',    'legacy-map'),
  ('BRK_B',     'BRK_B',     'US0846707026', 'BRK-B',   'legacy-map'),
  ('BATSl',     'BATSl',     'GB0002875804', 'BATS.L',  'legacy-map'),
  ('PNNl',      'PNNl',      'GB00BNNTLN49', 'PNN.L',   'legacy-map'),
  ('RRl',       'RRl',       'GB00B63H8491', 'RR.L',    'legacy-map'),
  ('IAGl',      'IAGl',      'ES0177542018', 'IAG.L',   'legacy-map'),
  ('VGOVl',     'VGOVl',     'IE00B42WWV65', 'VGOV.L',  'legacy-map'),
  ('VUSDl',     'VUSDl',     'IE00B3XXRP09', 'VUSD.L',  'legacy-map'),
  ('VUSCd',     'VUSCd',     'IE00BDD48R20', 'VUSC.L',  'legacy-map'),
  ('STHSl',     'STHSl',     'IE00BYXVWC37', 'STHS.L',  'legacy-map'),
  ('SEMBl',     'SEMBl',     'IE00B2NPKV68', 'SEMB.L',  'legacy-map'),
  ('SSHYl',     'SSHYl',     'IE00B7N3YW49', 'STHY.L',  'legacy-map'),
  ('DBKd',      'DBKd',      'DE0005140008', 'DBK.DE',  'legacy-map'),
  ('ADSd',      'ADSd',      'DE000A1EWWW0', 'ADS.DE',  'legacy-map'),
  ('LHAd',      'LHAd',      'DE0008232125', 'LHA.DE',  'legacy-map'),
  ('P911d',     'P911d',     'DE000PAG9113', 'P911.DE', 'legacy-map')
on conflict (alias) do update set yahoo_symbol = excluded.yahoo_symbol, isin = excluded.isin;

-- Function to map ticker -> sector (kept in sync with src/lib/sectors.ts)
CREATE OR REPLACE FUNCTION public.guess_sector_for_ticker(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE upper(coalesce(t,''))
    WHEN 'AAPL' THEN 'Technologie'
    WHEN 'MSFT' THEN 'Technologie'
    WHEN 'GOOGL' THEN 'Technologie'
    WHEN 'GOOG' THEN 'Technologie'
    WHEN 'META' THEN 'Technologie'
    WHEN 'NVDA' THEN 'Technologie'
    WHEN 'AMD' THEN 'Technologie'
    WHEN 'INTC' THEN 'Technologie'
    WHEN 'AVGO' THEN 'Technologie'
    WHEN 'QCOM' THEN 'Technologie'
    WHEN 'ORCL' THEN 'Technologie'
    WHEN 'CRM' THEN 'Technologie'
    WHEN 'ADBE' THEN 'Technologie'
    WHEN 'CSCO' THEN 'Technologie'
    WHEN 'IBM' THEN 'Technologie'
    WHEN 'PLTR' THEN 'Technologie'
    WHEN 'SNOW' THEN 'Technologie'
    WHEN 'NOW' THEN 'Technologie'
    WHEN 'SHOP' THEN 'Technologie'
    WHEN 'UBER' THEN 'Technologie'
    WHEN 'ABNB' THEN 'Technologie'
    WHEN 'NFLX' THEN 'Technologie'
    WHEN 'SPOT' THEN 'Technologie'
    WHEN 'ASML' THEN 'Technologie'
    WHEN 'TSM' THEN 'Technologie'
    WHEN 'MU' THEN 'Technologie'
    WHEN 'ARM' THEN 'Technologie'
    WHEN 'SOFI' THEN 'Fintech'
    WHEN 'NU' THEN 'Fintech'
    WHEN 'PYPL' THEN 'Fintech'
    WHEN 'SQ' THEN 'Fintech'
    WHEN 'COIN' THEN 'Fintech'
    WHEN 'HOOD' THEN 'Fintech'
    WHEN 'AFRM' THEN 'Fintech'
    WHEN 'V' THEN 'Fintech'
    WHEN 'MA' THEN 'Fintech'
    WHEN 'AXP' THEN 'Fintech'
    WHEN 'JPM' THEN 'Bankovnictví'
    WHEN 'BAC' THEN 'Bankovnictví'
    WHEN 'WFC' THEN 'Bankovnictví'
    WHEN 'GS' THEN 'Bankovnictví'
    WHEN 'MS' THEN 'Bankovnictví'
    WHEN 'C' THEN 'Bankovnictví'
    WHEN 'BRK.B' THEN 'Bankovnictví'
    WHEN 'AMZN' THEN 'Spotřební zboží'
    WHEN 'WMT' THEN 'Spotřební zboží'
    WHEN 'COST' THEN 'Spotřební zboží'
    WHEN 'TGT' THEN 'Spotřební zboží'
    WHEN 'HD' THEN 'Spotřební zboží'
    WHEN 'NKE' THEN 'Spotřební zboží'
    WHEN 'MCD' THEN 'Spotřební zboží'
    WHEN 'SBUX' THEN 'Spotřební zboží'
    WHEN 'KO' THEN 'Spotřební zboží'
    WHEN 'PEP' THEN 'Spotřební zboží'
    WHEN 'PG' THEN 'Spotřební zboží'
    WHEN 'TSLA' THEN 'Automotive'
    WHEN 'F' THEN 'Automotive'
    WHEN 'GM' THEN 'Automotive'
    WHEN 'RIVN' THEN 'Automotive'
    WHEN 'LCID' THEN 'Automotive'
    WHEN 'NIO' THEN 'Automotive'
    WHEN 'RKLB' THEN 'Letectví & obrana'
    WHEN 'BA' THEN 'Letectví & obrana'
    WHEN 'LMT' THEN 'Letectví & obrana'
    WHEN 'RTX' THEN 'Letectví & obrana'
    WHEN 'NOC' THEN 'Letectví & obrana'
    WHEN 'ASTS' THEN 'Letectví & obrana'
    WHEN 'JNJ' THEN 'Zdravotnictví'
    WHEN 'PFE' THEN 'Zdravotnictví'
    WHEN 'MRK' THEN 'Zdravotnictví'
    WHEN 'LLY' THEN 'Zdravotnictví'
    WHEN 'ABBV' THEN 'Zdravotnictví'
    WHEN 'UNH' THEN 'Zdravotnictví'
    WHEN 'NVO' THEN 'Zdravotnictví'
    WHEN 'XOM' THEN 'Energetika'
    WHEN 'CVX' THEN 'Energetika'
    WHEN 'COP' THEN 'Energetika'
    WHEN 'OXY' THEN 'Energetika'
    WHEN 'SPY' THEN 'ETF'
    WHEN 'VOO' THEN 'ETF'
    WHEN 'QQQ' THEN 'ETF'
    WHEN 'VTI' THEN 'ETF'
    WHEN 'IWM' THEN 'ETF'
    WHEN 'DIA' THEN 'ETF'
    WHEN 'MSTR' THEN 'Krypto'
    WHEN 'MARA' THEN 'Krypto'
    WHEN 'RIOT' THEN 'Krypto'
    WHEN 'CASH' THEN 'Hotovost'
    ELSE NULL
  END;
$$;

-- Trigger: auto-fill sector on insert/update of positions when missing
CREATE OR REPLACE FUNCTION public.autofill_position_sector()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.sector IS NULL OR btrim(NEW.sector) = '' THEN
    NEW.sector := public.guess_sector_for_ticker(NEW.ticker);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autofill_position_sector ON public.positions;
CREATE TRIGGER trg_autofill_position_sector
  BEFORE INSERT OR UPDATE OF ticker, sector ON public.positions
  FOR EACH ROW
  EXECUTE FUNCTION public.autofill_position_sector();

-- Backfill existing positions with NULL/empty sector
UPDATE public.positions
SET sector = public.guess_sector_for_ticker(ticker)
WHERE (sector IS NULL OR btrim(sector) = '')
  AND public.guess_sector_for_ticker(ticker) IS NOT NULL;
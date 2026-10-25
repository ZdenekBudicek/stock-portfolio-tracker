// Pure parser for Finnhub stock-split rows.
// Finnhub /stock/split returns rows like: { symbol, date, fromFactor, toFactor }.
// ratio = toFactor / fromFactor  (e.g. 4-for-1 forward split => 4; 1-for-10 reverse => 0.1)
export function parseFinnhubSplits(ticker: string, rows: { fromFactor?: unknown; toFactor?: unknown; date?: string }[]) {
  return (rows ?? [])
    .filter((r) => Number(r?.fromFactor) > 0 && Number(r?.toFactor) > 0 && r?.date)
    .map((r) => ({
      ticker,
      split_date: r.date,
      ratio: Number(r.toFactor) / Number(r.fromFactor),
      status: "pending",
      source: "finnhub",
    }));
}

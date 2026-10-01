// Pure formatting utilities. All actual data now lives in the database
// and is fetched through React Query hooks (see src/hooks/usePortfolio.ts).

export const formatUsd = (n: number) => {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
};

export const formatCzk = (n: number) => {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `-${formatted} Kč` : `${formatted} Kč`;
};

export const formatPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

// Chart palette (kept here so chart components don't duplicate it)
export const CHART_COLORS = [
  'hsl(217, 91%, 60%)',
  'hsl(142, 72%, 50%)',
  'hsl(38, 92%, 55%)',
  'hsl(280, 65%, 60%)',
  'hsl(190, 80%, 55%)',
  'hsl(340, 75%, 60%)',
  'hsl(50, 90%, 55%)',
  'hsl(160, 60%, 50%)',
  'hsl(20, 80%, 60%)',
  'hsl(260, 60%, 65%)',
];

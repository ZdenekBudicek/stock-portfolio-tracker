import { Treemap, ResponsiveContainer } from "recharts";
import { Grid3X3 } from "lucide-react";
import { useComputedPortfolio } from "@/hooks/usePortfolio";
import { useCurrency } from "@/contexts/CurrencyContext";
import { currentLang } from "@/i18n";
import { wrapSymbol } from "@/lib/displayCurrency";

const colorFor = (pct: number) => {
  const clamped = Math.max(-5, Math.min(5, pct));
  const t = Math.abs(clamped) / 5;
  if (clamped >= 0) {
    // green scale
    const lightness = 35 - t * 15;
    return `hsl(142, 70%, ${lightness}%)`;
  }
  const lightness = 35 - t * 15;
  return `hsl(0, 70%, ${lightness}%)`;
};

const Tile = (props: any) => {
  const { x, y, width, height, name, value, money } = props;
  const pct = typeof props.pct === "number" ? props.pct : 0;
  if (width < 30 || height < 30 || !name) return null;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} style={{ fill: colorFor(pct), stroke: "hsl(var(--background))", strokeWidth: 2 }} />
      <text x={x + width / 2} y={y + height / 2 - 8} textAnchor="middle" fill="white" fontSize={width > 80 ? 16 : 12} fontWeight="bold" fontFamily="ui-monospace">
        {name}
      </text>
      <text x={x + width / 2} y={y + height / 2 + 10} textAnchor="middle" fill="white" fontSize={width > 80 ? 12 : 10} opacity={0.9}>
        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
      </text>
      {width > 100 && height > 70 && typeof value === "number" && (
        <text x={x + width / 2} y={y + height / 2 + 26} textAnchor="middle" fill="white" fontSize={10} opacity={0.75}>
          {money(value)}
        </text>
      )}
    </g>
  );
};

const PortfolioHeatmap = () => {
  const { positions } = useComputedPortfolio();
  const { currency, convert, hidden } = useCurrency();
  const lang = currentLang() === "en" ? "en" : "cs";
  const money = (usd: number) => hidden
    ? wrapSymbol("••••", currency, lang)
    : currency === "USD" ? `$${(usd / 1000).toFixed(1)}k` : wrapSymbol(`${(convert(usd) / 1000).toFixed(currency === "CZK" ? 0 : 1)}k`, currency, lang);
  const data = positions
    .filter((p) => p.ticker !== "CASH" && p.value > 0)
    .map((p) => ({ name: p.ticker, value: p.value, pct: p.dailyChangePct }));

  return (
    <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-bold flex items-center gap-2">
          <Grid3X3 className="w-5 h-5 text-primary" /> Heatmapa portfolia
        </h2>
        <p className="text-[10px] text-muted-foreground">Velikost = hodnota · Barva = denní změna</p>
      </div>
      <div className="h-72">
        <ResponsiveContainer>
          <Treemap data={data} dataKey="value" content={<Tile money={money} />} />

        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default PortfolioHeatmap;

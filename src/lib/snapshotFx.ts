import type { LocalFx } from "./displayCurrency";
import type { DisplaySnapshot, RawSnapshot } from "./portfolioTypes";

export function toDisplaySnapshots(rows: readonly RawSnapshot[], fx: LocalFx): DisplaySnapshot[] {
  return rows.map((s) => {
    if (s.fxBasis !== "raw-czk") throw new Error("Expected raw-czk snapshot");
    const k = fx.code === "CZK" ? 1 : fx.perCzkAt(s.snapshot_date);
    return { ...s, fxBasis: "display", displayCurrency: fx.code,
      value_czk: s.value_czk * k, profit_czk: s.profit_czk * k,
      fx_rate: fx.code === "CZK" ? s.fx_rate : s.fx_rate != null ? s.fx_rate * k : null };
  });
}

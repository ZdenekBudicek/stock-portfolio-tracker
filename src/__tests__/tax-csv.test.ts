import { describe, it, expect } from "vitest";
import { toCsv, salesCsvRows } from "@/lib/taxCsv";
import { runFifo, type FifoTx } from "@/lib/fifo";
import { buildSalesReport } from "@/lib/czTax";

const tx = (o: Partial<FifoTx>): FifoTx => ({
  id: Math.random().toString(36), ticker: "AAPL", side: "BUY", shares: 1, price_usd: 100, fee_usd: 0,
  executed_at: "2025-01-02T15:00:00Z", broker: "Revolut", broker_account: "R1", ...o,
});

describe("tax CSV for a Czech Excel", () => {
  it("starts with a UTF-8 BOM and uses semicolons, decimal commas and CRLF", () => {
    const csv = toCsv([["Příjem CZK", "Zisk"], ["1234,50", 'a;"b"']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe('﻿Příjem CZK;Zisk\r\n1234,50;"a;""b"""\r\n');
  });

  it("lists proceeds, acquisition date and the rates used for every lot", () => {
    const r = runFifo([
      tx({ shares: 2, price_usd: 100, fee_usd: 1, executed_at: "2021-03-01T15:00:00Z" }),
      tx({ side: "SELL", shares: 2, price_usd: 150.5, executed_at: "2024-06-03T15:00:00Z" }),
    ]);
    const rows = salesCsvRows(buildSalesReport(r.disposals, 2024));
    const head = rows[0];
    const line = rows[1];
    const col = (name: string) => line[head.indexOf(name)];
    expect(col("Datum prodeje")).toBe("3.6.2024");
    expect(col("Datum nabytí")).toBe("1.3.2021");
    expect(col("Příjem USD")).toBe("301,00");
    expect(col("Náklady USD (vč. poplatku za nákup)")).toBe("201,00");
    expect(col("Kurz nákup – den")).toBe("1.3.2021");
    expect(col("Kurz prodej – den")).toBe("3.6.2024");
    expect(col("Kurz prodej")).toMatch(/^\d{2},\d{3}$/);
    expect(col("Status")).toBe("Osvobozeno (časový test)");
  });
});

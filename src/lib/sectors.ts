// Centrální mapování tickerů na sektory.
// Použito ve frontendu (SectorAllocation) i v DB triggeru (přes seed migrations).
// Při přidání nové pozice se sektor automaticky doplní podle této mapy.

export const TICKER_SECTORS: Record<string, string> = {
  // Technology
  AAPL: "Technologie",
  MSFT: "Technologie",
  GOOGL: "Technologie",
  GOOG: "Technologie",
  META: "Technologie",
  NVDA: "Technologie",
  AMD: "Technologie",
  INTC: "Technologie",
  AVGO: "Technologie",
  QCOM: "Technologie",
  ORCL: "Technologie",
  CRM: "Technologie",
  ADBE: "Technologie",
  CSCO: "Technologie",
  IBM: "Technologie",
  PLTR: "Technologie",
  SNOW: "Technologie",
  NOW: "Technologie",
  SHOP: "Technologie",
  UBER: "Technologie",
  ABNB: "Technologie",
  NFLX: "Technologie",
  SPOT: "Technologie",
  ASML: "Technologie",
  TSM: "Technologie",
  MU: "Technologie",
  ARM: "Technologie",

  // Fintech / Finance
  SOFI: "Fintech",
  NU: "Fintech",
  PYPL: "Fintech",
  SQ: "Fintech",
  COIN: "Fintech",
  HOOD: "Fintech",
  AFRM: "Fintech",
  V: "Fintech",
  MA: "Fintech",
  AXP: "Fintech",

  // Banks & Insurance
  JPM: "Bankovnictví",
  BAC: "Bankovnictví",
  WFC: "Bankovnictví",
  GS: "Bankovnictví",
  MS: "Bankovnictví",
  C: "Bankovnictví",
  BRK_B: "Bankovnictví",
  "BRK.B": "Bankovnictví",

  // Consumer / Retail
  AMZN: "Spotřební zboží",
  WMT: "Spotřební zboží",
  COST: "Spotřební zboží",
  TGT: "Spotřební zboží",
  HD: "Spotřební zboží",
  NKE: "Spotřební zboží",
  MCD: "Spotřební zboží",
  SBUX: "Spotřební zboží",
  KO: "Spotřební zboží",
  PEP: "Spotřební zboží",
  PG: "Spotřební zboží",

  // Automotive / EV
  TSLA: "Automotive",
  F: "Automotive",
  GM: "Automotive",
  RIVN: "Automotive",
  LCID: "Automotive",
  NIO: "Automotive",

  // Aerospace & Defense
  RKLB: "Letectví & obrana",
  BA: "Letectví & obrana",
  LMT: "Letectví & obrana",
  RTX: "Letectví & obrana",
  NOC: "Letectví & obrana",
  ASTS: "Letectví & obrana",

  // Healthcare / Pharma
  JNJ: "Zdravotnictví",
  PFE: "Zdravotnictví",
  MRK: "Zdravotnictví",
  LLY: "Zdravotnictví",
  ABBV: "Zdravotnictví",
  UNH: "Zdravotnictví",
  NVO: "Zdravotnictví",

  // Energy
  XOM: "Energetika",
  CVX: "Energetika",
  COP: "Energetika",
  OXY: "Energetika",

  // ETF / Index
  SPY: "ETF",
  VOO: "ETF",
  QQQ: "ETF",
  VTI: "ETF",
  IWM: "ETF",
  DIA: "ETF",

  // Crypto-related
  MSTR: "Krypto",
  MARA: "Krypto",
  RIOT: "Krypto",

  // Cash
  CASH: "Hotovost",
};

export function sectorForTicker(ticker: string, fallback = "Ostatní"): string {
  if (!ticker) return fallback;
  const key = ticker.toUpperCase().trim();
  return TICKER_SECTORS[key] || fallback;
}

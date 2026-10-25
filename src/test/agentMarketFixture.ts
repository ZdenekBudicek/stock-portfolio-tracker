import type { InstrumentRegistry } from '../../supabase/functions/agent/_lib/trackora-lib.js';

export const marketNow = Date.parse('2026-10-23T12:00:00Z');
export const marketContext = () => ({ signal: new AbortController().signal, deadline: marketNow + 45000 });
export const marketRegistry: InstrumentRegistry = {
  positions: [{ ticker: 'RKLB', name: 'Rocket Lab', type: 'Stock', shares: 1 } as InstrumentRegistry['positions'][number]],
  aliases: [], profiles: [],
};
export const analystRaw = {
  quoteSummary: { result: [{
    financialData: { targetMeanPrice: { raw: 150 }, targetLowPrice: { raw: 120 }, targetHighPrice: { raw: 180 },
      financialCurrency: 'USD', recommendationKey: 'buy' },
    price: { currency: 'USD' },
    recommendationTrend: { trend: [{ period: '0m', strongBuy: 2, buy: 7, hold: 3, sell: 0, strongSell: 0 }] },
    upgradeDowngradeHistory: { history: [{ epochGradeDate: 1792670400, firm: 'Synthetic Research', fromGrade: 'Hold', toGrade: 'Buy' }] },
  }], error: null },
};

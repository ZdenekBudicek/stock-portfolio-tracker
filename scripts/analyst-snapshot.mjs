/** @typedef {import('../supabase/functions/agent/core/marketTypes.ts').AnalystView} AnalystView */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const target = value => { const n = number(object(value).raw ?? value); return n !== null && n > 0 ? n : null; };
const count = value => { const n = number(value); return n !== null && Number.isInteger(n) && n >= 0 ? n : null; };
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;

/** @param {unknown} raw @param {string} ticker @returns {AnalystView & { currencyBasis?: 'trading' }} */
export function parseAnalystSnapshot(raw, ticker) {
  const summary = object(object(raw).quoteSummary);
  if (summary.error || !Array.isArray(summary.result)) throw new Error('Analyst snapshot unavailable');
  const result = object(summary.result[0]);
  const financial = object(result.financialData);
  const trends = object(result.recommendationTrend).trend;
  const trend = object(Array.isArray(trends) ? trends.find(t => t.period === '0m') : null);
  const changes = object(result.upgradeDowngradeHistory).history;
  // Ocenění v2: consensus estimates of the current and next fiscal year (earningsTrend), in the statements' currency.
  const trendRows = Array.isArray(object(result.earningsTrend).trend) ? object(result.earningsTrend).trend : [];
  const rawNumber = value => number(object(value).raw ?? value);
  const estimates = [['0y', 'current'], ['+1y', 'next']].flatMap(([key, period]) => {
    const row = object(trendRows.find(t => object(t).period === key));
    const eps = object(row.earningsEstimate), revenue = object(row.revenueEstimate);
    const estimate = { period, endDate: text(row.endDate), eps: rawNumber(eps.avg), revenue: rawNumber(revenue.avg), epsGrowth: rawNumber(row.growth ?? eps.growth),
      revenueGrowth: rawNumber(revenue.growth), analysts: count(rawNumber(eps.numberOfAnalysts) ?? rawNumber(revenue.numberOfAnalysts)) };
    return estimate.eps === null && estimate.revenue === null ? [] : [estimate];
  });
  const financialCurrency = text(financial.financialCurrency);
  // financialCurrency is the currency of the financial STATEMENTS, not of the price targets: for an ADR
  // (TSM: statements TWD, listing and targets USD) they differ, and nothing in financialData names the
  // targets' currency. Targets are quoted like the share price, so their currency is the trading currency
  // of the `price` module; without it the targets keep an unknown currency (never compared with a price).
  const currency = text(object(result.price).currency);
  const view = {
    ticker, consensus: text(financial.recommendationKey),
    counts: { strongBuy: count(trend.strongBuy), buy: count(trend.buy), hold: count(trend.hold), sell: count(trend.sell), strongSell: count(trend.strongSell) },
    targetMean: target(financial.targetMeanPrice), targetLow: target(financial.targetLowPrice), targetHigh: target(financial.targetHighPrice),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    // Marks `currency` as the trading currency; the agent ignores the currency of rows without it.
    ...(currency && /^[A-Z]{3}$/.test(currency) ? { currencyBasis: 'trading' } : {}),
    changes: (Array.isArray(changes) ? changes : []).flatMap(row => {
      const epoch = number(row.epochGradeDate), firm = text(row.firm);
      if (!epoch || !firm || !Number.isFinite(new Date(epoch * 1000).getTime())) return [];
      return [{ date: new Date(epoch * 1000).toISOString().slice(0, 10), firm, from: text(row.fromGrade), to: text(row.toGrade) }];
    }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20),
    ...(estimates.length ? { estimates, estimatesCurrency: financialCurrency && /^[A-Z]{3}$/.test(financialCurrency) ? financialCurrency : null } : {}),
  };
  if (view.targetMean === null && view.targetLow === null && view.targetHigh === null && Object.values(view.counts).every(n => n === null)) throw new Error('Analyst snapshot empty');
  return view;
}

/** @param {{fetched_at:string|null,last_attempt_at:string|null,status:string}|null} row @param {number} now @returns {boolean} */
export function analystsDue(row, now) {
  if (!row) return true;
  const fetched = Date.parse(row.fetched_at ?? ''), attempted = Date.parse(row.last_attempt_at ?? '');
  if (row.status !== 'ok' && Number.isFinite(attempted) && now - attempted >= 0 && now - attempted < 3600000) return false;
  // No coverage (OTC, delisted, empty consensus): asked again after a week, not every night.
  if (row.status === 'unavailable' && Number.isFinite(attempted) && now - attempted >= 0 && now - attempted < 7 * 86400000) return false;
  return !Number.isFinite(fetched) || now < fetched || now - fetched >= 86400000;
}

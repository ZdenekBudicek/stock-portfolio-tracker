import { selectAccount, selectedAccount } from './accountChoices.ts';
import { quotableHeadline, safeUrl } from './guards.ts';
import type { NewsItem } from './marketTypes.ts';
import type { Lang } from './protocol.ts';
import { tradingDaysBack } from './moveExplanation.ts';
import { isTodayMoveQuestion, requestedText } from './router.ts';
import { ensureWithinLimits } from './tools/common.ts';
import type { Fact, Intent, Route, ToolCtx, ToolResult } from './types.ts';

// `notes` are server sentences shown after the facts (today's headlines); they carry no numbers.
export type IntentEvidence = { facts: Fact[]; missing: boolean; limits: string[]; notes?: string[] };
export type IntentPlan = { calls: { name: string; args: unknown }[]; clarification?: string };
const CHOOSE: Record<Lang, string> = {
  cs: 'Pro který účet chceš výpočet? Napiš znovu otázku a přesný název účtu i brokera:',
  sk: 'Pre ktorý účet chceš výpočet? Napíš znova otázku a presný názov účtu aj brokera:',
  en: 'Which account should the calculation use? Repeat the question with the exact account and broker names:',
};
const INPUTS: Record<Lang, string> = {
  cs: 'Pro simulaci napiš jeden ticker, počet kusů a cenu za kus v USD. Bez těchto údajů prodej nespočítám.',
  sk: 'Pre simuláciu napíš jeden ticker, počet kusov a cenu za kus v USD. Bez týchto údajov predaj nespočítam.',
  en: 'For the simulation, give one ticker, the number of shares and the price per share in USD. These inputs are needed to calculate the sale.',
};
export const MISSING: Record<Lang, string> = {
  cs: 'Některé požadované údaje nejsou dostupné. Chybějící hodnoty nelze považovat za nulu.',
  sk: 'Niektoré požadované údaje nie sú dostupné. Chýbajúce hodnoty nemožno považovať za nulu.',
  en: 'Some required figures are unavailable. Missing values cannot be treated as zero.',
};

/** Required tools run before the writer, with arguments read from the question, never invented by it. */
export async function planIntent(route: Route, question: string, ctx: ToolCtx): Promise<IntentPlan> {
  const ticker = route.tickers.length === 1 ? route.tickers[0] : undefined;
  let scope: { broker: string; account: string } | undefined;
  if (['transactions', 'realized', 'lots'].includes(route.intent ?? '') && /úč(?:et|t\p{L}*)|accounts?/iu.test(question)
    && !/(?:všech|všetkých)\s+účt|all\s+(?:my\s+)?accounts/iu.test(question)) {
    const { data } = await ctx.loadSnapshot();
    const unique = new Map(data.transactions.filter(t => ctx.lib.isRealTradeTx(t)).map(t => {
      const broker = ctx.lib.brokerOf(t), account = t.broker_account ?? '';
      return [JSON.stringify([broker, account]), { broker, account }];
    }));
    const choices = [...unique.values()].map((c, i) => ({ ...c, id: `choice_${i + 1}` }));
    const ref = selectAccount(ctx, ticker ?? 'all', choices, question);
    if (!ref) return { calls: [], clarification: choices.length
      ? `${CHOOSE[route.lang]}\n${choices.map(c => `• ${c.broker} / ${c.account || '—'}`).join('\n')}` : MISSING[route.lang] };
    const chosen = selectedAccount(ctx, ticker ?? 'all', ref);
    scope = { broker: chosen.broker, account: chosen.account };
  }
  const filters = (route.tickers.length ? route.tickers.map(ticker => ({ ticker })) : [{}]).map(filter => ({ ...filter, ...(scope ? { scope } : {}) }));
  switch (route.intent) {
    case 'dividends': return { calls: [{ name: 'get_dividends', args: /forecast|projected|next|příšt|budouc|budúc|odhad|predik/iu.test(question)
      ? { mode: 'forecast' } : { mode: 'received', ...route.period } }] };
    case 'holdings': return { calls: [{ name: 'get_portfolio_summary', args: {} }, { name: 'get_holdings', args: ticker ? { ticker } : {} }] };
    case 'movers': return { calls: [{ name: 'get_holdings', args: { dayChange: true } }] };
    case 'summary': return { calls: [{ name: 'get_portfolio_summary', args: {} }] };
    case 'quote': {
      const calls: IntentPlan['calls'] = route.tickers.slice(0, 2).map(ticker => ({ name: 'get_quote', args: { ticker } }));
      // "Co se dnes děje s X?": today's quote plus the last five trading days, briefly.
      if (ticker && isTodayMoveQuestion(question)) calls.push({ name: 'get_price_history', args: { ticker, period: { from: tradingDaysBack(ctx.today, 5), to: ctx.today } } });
      return { calls };
    }
    case 'tax': return { calls: [{ name: 'get_tax_report', args: { year: Number(route.period.from.slice(0, 4)) } },
      { name: 'get_realized_pnl', args: { ...route.period, currency: ctx.preferences.localCurrency } }] };
    case 'performance': return { calls: [{ name: 'get_performance', args: { ...route.period, ...(/\bSPX\b|S&P\s*500/iu.test(question) ? { benchmark: 'SPX' } : {}) } }] };
    case 'allocation': return { calls: [{ name: 'get_allocation', args: {} }] };
    case 'transactions': return { calls: filters.map(filter => ({ name: 'get_transactions', args: { ...route.period, ...filter } })) };
    case 'realized': return { calls: filters.map(filter => ({ name: 'get_realized_pnl', args: { ...route.period, ...filter, currency: ctx.preferences.localCurrency } })) };
    case 'lots': return { calls: filters.map(filter => ({ name: 'get_tax_lots', args: filter })) };
    case 'simulation': case 'account_clarification': {
      if (!ticker) return { calls: [], clarification: INPUTS[route.lang] };
      const loaded = await ctx.loadSnapshot();
      ensureWithinLimits(ctx, loaded.data);
      const accounts = ctx.lib.resolveSaleAccount(ticker, loaded.data.transactions.filter(t => ctx.lib.isRealTradeTx(t)));
      let accountChoice: string | undefined;
      if (accounts.status === 'clarify' || /úč(?:et|t\p{L}*)|account/iu.test(question)) {
        const holders = accounts.status === 'clarify' ? accounts.choices : [accounts];
        if (!holders.length) return { calls: [], clarification: MISSING[route.lang] };
        const choices = holders.map((c, i) => ({ broker: c.broker, account: c.account, id: `choice_${i + 1}` }));
        accountChoice = selectAccount(ctx, ticker, choices, question);
        if (!accountChoice) return { calls: [], clarification: `${CHOOSE[route.lang]}\n${choices.map(c => `• ${c.broker} / ${c.account || '—'}`).join('\n')}` };
      }
      const text = requestedText(question);
      const quantities = [...text.matchAll(/(?<![\d.,+-])(\d+(?:[.,]\d+)?)\s*(?:kus\p{L}*|akci\p{L}*|shares?|units?)(?![\p{L}])/giu)];
      const prices = [...text.matchAll(/(?:za|at|for)\s+(\d+(?:[.,]\d+)?)\s*USD\b/giu)];
      const quantity = quantities[0], price = prices[0];
      // Unsupported alternatives or extra assumptions require clarification, not a silent default.
      const extra = /\d\s*(?:nebo|alebo|or|až|to|–|-)\s*\d|poplat\p{L}*|fees?|\d{4}-\d{2}-\d{2}|zítra|zajtra|tomorrow|příští|budúci|next|kurz|exchange rate/iu.test(text);
      if (quantities.length !== 1 || prices.length !== 1 || extra) return { calls: [], clarification: extra ? {
        cs: 'Tady umím jednoduchou simulaci k dnešku s nulovým poplatkem a aktuálním kurzem. Pro jiný den, poplatek, kurz nebo více variant použij simulátor v daňovém přehledu Trackory.',
        sk: 'Tu viem jednoduchú simuláciu k dnešku s nulovým poplatkom a aktuálnym kurzom. Pre iný deň, poplatok, kurz alebo viac variantov použi simulátor v daňovom prehľade Trackory.',
        en: 'Here I can simulate a sale today with zero fees and the current exchange rate. For a different date, fee, rate or multiple alternatives, use the simulator in Trackora’s tax overview.',
      }[route.lang] : INPUTS[route.lang] };
      const shares = Number(quantity[1].replace(',', '.')), priceUsd = Number(price[1].replace(',', '.'));
      if (!(shares > 0 && priceUsd > 0)) return { calls: [], clarification: INPUTS[route.lang] };
      return { calls: [{ name: 'simulate_sale', args: { ticker, shares, priceUsd, ...(accountChoice ? { accountChoice } : {}) } }] };
    }
    default: return { calls: [] };
  }
}

// The top two movers' news also carries article text: the news analyst may explain them (Běh 23).
export const TOP_MOVERS = 3, MOVER_NEWS_DAYS = 7, HEADLINES_PER_MOVER = 2, MOVERS_ANALYZED = 2;
/** Today's biggest movers of a `get_holdings {dayChange}` result: largest absolute value change first. */
export function topMovers(result: ToolResult<unknown> | undefined): string[] {
  if (!result?.ok) return [];
  return result.facts.filter(f => /^holding:[^:]+:day_change$/.test(f.metric ?? f.id) && typeof f.value === 'number' && !!f.ticker)
    .sort((a, b) => Math.abs(b.value as number) - Math.abs(a.value as number)).map(f => f.ticker!).slice(0, TOP_MOVERS);
}
/** Calls that depend on the mandatory results: headlines for today's top movers. */
export function followUpCalls(route: Route, results: ToolResult<unknown>[], ctx: ToolCtx): { name: string; args: unknown }[] {
  if (route.intent !== 'movers') return [];
  const from = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - MOVER_NEWS_DAYS * 86_400_000).toISOString().slice(0, 10);
  return topMovers(results[0]).map((ticker, i) => ({ name: 'get_stock_news', args: { ticker, period: { from, to: ctx.today }, ...(i < MOVERS_ANALYZED ? { articles: true } : {}) } }));
}

const HEADLINES: Record<Lang, { about: (t: string, titles: string) => string; linked: (t: string) => string; unquoted: (t: string) => string; none: string;
  context: string }> = {
  cs: { about: (t, titles) => `Titulky k ${t}: ${titles}.`, linked: t => `K ${t} jsou nedávné titulky v odkazech.`,
    unquoted: t => `K ${t} jsou nedávné titulky, jejich znění tu necituji.`,
    none: 'K těmto pozicím jsem nenašel žádné titulky z posledních dní.', context: 'Titulky jsou jen kontext a nedokazují, proč se ceny pohnuly.' },
  sk: { about: (t, titles) => `Titulky k ${t}: ${titles}.`, linked: t => `K ${t} sú nedávne titulky v odkazoch.`,
    unquoted: t => `K ${t} sú nedávne titulky, ich znenie tu necitujem.`,
    none: 'K týmto pozíciám som nenašiel žiadne titulky z posledných dní.', context: 'Titulky sú len kontext a nedokazujú, prečo sa ceny pohli.' },
  en: { about: (t, titles) => `Headlines on ${t}: ${titles}.`, linked: t => `Recent ${t} headlines are linked.`,
    unquoted: t => `There are recent ${t} headlines; I do not quote their wording here.`,
    none: 'I found no headlines on these positions from the last few days.', context: 'Headlines are context only and do not prove why prices moved.' },
};
const QUOTES: Record<Lang, [string, string]> = { cs: ['„', '“'], sk: ['„', '“'], en: ['“', '”'] };
/** Up to two headlines per mover, quoted only when the title states no figure, link or technical text; always marked as context. */
function headlineNotes(route: Route, results: ToolResult<unknown>[], movers: string[]): string[] {
  const words = HEADLINES[route.lang], [open, close] = QUOTES[route.lang];
  const lines: string[] = [];
  let any = false;
  for (const ticker of movers) {
    const news = results.find(r => r.ok && r.facts.some(f => (f.metric ?? f.id) === `news:${ticker}:count`));
    const items = news?.ok ? ((news.data as { items?: NewsItem[] }).items ?? []) : [];
    if (!items.length) continue;
    any = true;
    const titles = items.map(item => quotableHeadline(item.title)).filter((t): t is string => !!t).slice(0, HEADLINES_PER_MOVER);
    // "Linked" only when a link will really be shown (an allowed publisher URL from the tool).
    lines.push(titles.length ? words.about(ticker, titles.map(t => `${open}${t}${close}`).join('; '))
      : items.some(item => safeUrl(item.url)) ? words.linked(ticker) : words.unquoted(ticker));
  }
  return movers.length ? [...lines, any ? words.context : words.none] : [];
}

/** Exact fact identities bind completeness to the mandatory result's period, scope and assumptions. */
export function intentEvidence(route: Route, results: ToolResult<unknown>[]): IntentEvidence {
  if (route.intent === 'movers') return moversEvidence(route, results);
  const facts = results.flatMap(r => r.ok ? r.facts : []);
  const patterns: Partial<Record<Intent, RegExp>> = {
    dividends: /^dividends:(received|forecast_annual|next_pay_date)$/,
    holdings: /^portfolio:(total_value|holding_count)$|^holding:[^:]+:(shares|value)$/,
    transactions: /^transactions:[^:]+:(count|buy_count|sell_count|buy_usd|sell_usd|bought_shares|sold_shares)$/,
    realized: /^realized:[^:]+:(net|gains|losses|proceeds)$/,
    lots: /^lots:/, simulation: /^sale:/, account_clarification: /^sale:/,
    performance: /^performance:(portfolio_return|annual_return|profit|benchmark_return|benchmark_annual_return)$/,
    allocation: /^allocation:/,
    summary: /^portfolio:(total_value|cash|total_profit|unrealized_profit)$/,
    quote: /^quote:[^:]+:(price|previous_close|change_pct)$|^history:(?!SPX:)[^:]+:change_pct$/,
    tax: results[0]?.ok ? /^tax:/ : /^realized:[^:]+:(net|gains|losses|proceeds|dividends)$/,
  };
  const required = facts.filter(f => patterns[route.intent!]?.test(f.metric ?? f.id));
  const expected = results.map((r, index) => {
    if (!r.ok) return [];
    switch (route.intent) {
      case 'dividends': return [(r.data as { forecast: unknown }).forecast ? 'dividends:forecast_annual' : 'dividends:received'];
      case 'holdings': return index === 0 ? ['portfolio:total_value', 'portfolio:holding_count'] : [];
      case 'tax': return index === 0 ? [`tax:${route.period.from.slice(0, 4)}:estimated_tax`] : [];
      case 'performance': return ['performance:portfolio_return', 'performance:profit'];
      case 'allocation': return ['allocation:invested'];
      case 'summary': return ['portfolio:total_value'];
      case 'quote': return index < Math.min(2, route.tickers.length) ? [`quote:${(r.data as { ticker: string }).ticker}:price`] : [];
      case 'transactions': {
        const prefix = `transactions:${route.tickers[index] ?? 'all'}`;
        return ['count', 'buy_count', 'sell_count', 'buy_usd', 'sell_usd', 'bought_shares', 'sold_shares'].map(key => `${prefix}:${key}`);
      }
      case 'realized': return Array.from({ length: Number(route.period.to.slice(0, 4)) - Number(route.period.from.slice(0, 4)) + 1 }, (_, i) =>
        ['net', 'gains', 'losses', 'proceeds'].map(key => `realized:${Number(route.period.from.slice(0, 4)) + i}:${key}`)).flat();
      case 'simulation': case 'account_clarification': {
        const prefix = `sale:${route.tickers[0]}`;
        const outputs = (r.data as { jurisdiction?: string }).jurisdiction === 'CZ'
          ? ['gain', 'proceeds', 'taxable_gain', 'extra_tax', 'missing_shares', 'sale_fx'] : ['tax_delta', 'estimated_tax_after'];
        return ['shares', 'price', 'fee', 'date', ...outputs].map(key => `${prefix}:${key}`);
      }
      case 'lots': {
        const data = r.data as { lots: unknown[]; residence: string };
        return [`lots:${route.tickers[index] ?? 'all'}:count`, ...data.lots.flatMap((_, i) =>
          ['shares', 'acquired', ...(data.residence === 'CZ' ? ['exempt_date', 'exempt'] : [])].map(key => `lots:lot_${i + 1}:${key}`))];
      }
      default: return [];
    }
  });
  const missing = results.some(r => !r.ok) || required.some(f => f.value === null) || required.length === 0
    || expected.some((keys, i) => {
      const result = results[i];
      return !result.ok || keys.some(key => !result.facts.some(f => (f.metric ?? f.id) === key));
    });
  const limits: string[] = [];
  if (missing) limits.push(MISSING[route.lang]);
  if (route.intent === 'simulation' || route.intent === 'account_clarification') limits.push({
    cs: 'Jde o hypotetický prodej, nikoli uskutečněný obchod. Datum, poplatek a kurz označené jako předpoklad jsou odhady.',
    sk: 'Ide o hypotetický predaj, nie uskutočnený obchod. Dátum, poplatok a kurz označené ako predpoklad sú odhady.',
    en: 'This is a hypothetical sale. Date, fee and exchange rate marked as assumptions are estimates.',
  }[route.lang]);
  if (route.intent === 'lots') {
    if (results.some(r => r.ok && (r.data as { residence?: string }).residence !== 'CZ')) limits.push({
      cs: 'Pro tuto daňovou rezidenci nemám doložené datum osvobození podle časového testu.',
      sk: 'Pre túto daňovú rezidenciu nemám doložený dátum oslobodenia podľa časového testu.',
      en: 'No time-test exemption date is established for this tax residence.',
    }[route.lang]);
    if (results.some(r => r.ok && r.meta.omittedRows > 0)) limits.push({
      cs: 'Zobrazený seznam lotů je zkrácený; další najdeš v daňovém přehledu Trackory.',
      sk: 'Zobrazený zoznam lotov je skrátený; ďalšie nájdeš v daňovom prehľade Trackory.',
      en: 'The displayed lot list is truncated; see the remaining lots in Trackora’s tax overview.',
    }[route.lang]);
  }
  return { facts: required.filter(f => f.value !== null), missing, limits };
}

/** Today's change of the portfolio and of its top movers (largest absolute value change first), plus their headlines. */
function moversEvidence(route: Route, results: ToolResult<unknown>[]): IntentEvidence {
  const holdings = results[0];
  if (!holdings?.ok) return { facts: [], missing: true, limits: [MISSING[route.lang]] };
  const count = holdings.facts.find(f => (f.metric ?? f.id) === 'portfolio:holding_count');
  // An empty account holds nothing: that is the answer, not missing evidence.
  if (count?.value === 0) return { facts: [count], missing: false, limits: [] };
  const movers = topMovers(holdings);
  const keys = ['portfolio:day_change', 'portfolio:day_change_pct', ...movers.flatMap(t => [`holding:${t}:day_change_pct`, `holding:${t}:day_change`])];
  const facts = keys.map(key => holdings.facts.find(f => (f.metric ?? f.id) === key && f.value !== null)).filter((f): f is Fact => !!f);
  const missing = !movers.length || facts.length !== keys.length;
  return { facts, missing, limits: missing ? [MISSING[route.lang]] : [], notes: headlineNotes(route, results, movers) };
}

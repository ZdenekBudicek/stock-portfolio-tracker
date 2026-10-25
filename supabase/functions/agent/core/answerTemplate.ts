import { hasUnverifiedTicker, runsOf } from './context.ts';
import type { StoredAnswer } from './dataTypes.ts';
import { displayDecimals, expandDraft, isFactSelection, PERCENT_RATIO, validateAnswer } from './grounding.ts';
import type { IntentEvidence } from './intentContract.ts';
import { bestPassage, EXTRACT_MAX } from './articleText.ts';
import { quotableHeadline, safeSourceLinks } from './guards.ts';
import type { NewsItem } from './marketTypes.ts';
import type { MoveEvidence, MoveNews } from './moveExplanation.ts';
import type { NewsAnalysis } from './newsAnalyst.ts';
import type { Lang, Link } from './protocol.ts';
import { calculate } from './tools/calculate.ts';
import type { AnalysisEvidence, AnswerBlock, AnswerBlockKind, AnswerDraft, Confidence, Fact, Intent, NumericClaim, ReferencedClaim, Route, ToolCtx,
  Verdict } from './types.ts';

// The only place where answer text is assembled: numbers, units, currencies, tickers, labels and
// sources come from facts, in the question's language. Model drafts and the verified template both
// render here; neither ever shows a fact ID, a tool or field name, or raw data.

type T3 = Record<Lang, string>;
const LOCALE: Record<Lang, string> = { cs: 'cs-CZ', sk: 'sk-SK', en: 'en-US' };

/* ----------------------------- words ----------------------------- */

const W = {
  heading: {
    analysts: { cs: 'Analytici', sk: 'Analytici', en: 'Analysts' }, valuation: { cs: 'Ocenění', sk: 'Ocenenie', en: 'Valuation' },
    context: { cs: 'Kontext', sk: 'Kontext', en: 'Context' }, risks: { cs: 'Rizika', sk: 'Riziká', en: 'Risks' },
    verdict: { cs: 'Můj názor', sk: 'Môj názor', en: 'My view' }, summary: { cs: 'Shrnutí', sk: 'Zhrnutie', en: 'Summary' },
  } as Record<Exclude<AnswerBlockKind, 'facts'>, T3>,
  verdict: {
    attractive: { cs: 'spíš atraktivní', sk: 'skôr atraktívna', en: 'rather attractive' },
    fair: { cs: 'zhruba férová, bez výrazné slevy', sk: 'zhruba férová, bez výraznej zľavy', en: 'about fair, no real discount' },
    expensive: { cs: 'spíš drahá', sk: 'skôr drahá', en: 'rather expensive' },
    insufficient: { cs: 'nedostatek dat', sk: 'nedostatok údajov', en: 'insufficient data' },
  } as Record<Verdict, T3>,
  confidence: { low: { cs: 'nízká', sk: 'nízka', en: 'low' }, medium: { cs: 'střední', sk: 'stredná', en: 'medium' },
    high: { cs: 'vysoká', sk: 'vysoká', en: 'high' } } as Record<Confidence, T3>,
  conclusion: { cs: 'Cena vůči ocenění', sk: 'Cena voči oceneniu', en: 'Price vs valuation' }, confidenceLabel: { cs: 'Jistota', sk: 'Istota', en: 'Confidence' },
  wouldChange: { cs: 'Co by závěr změnilo', sk: 'Čo by záver zmenilo', en: 'What would change it' },
  general: { cs: 'Jde o obecné vysvětlení, ne o investiční doporučení.', sk: 'Ide o všeobecné vysvetlenie, nie o investičné odporúčanie.',
    en: 'This is a general explanation, not investment advice.' },
  decision: { cs: 'Je to můj názor z dostupných dat, ne investiční doporučení – rozhodnutí je na tobě.',
    sk: 'Je to môj názor z dostupných údajov, nie investičné odporúčanie – rozhodnutie je na tebe.',
    en: 'This is my view from the available data, not investment advice – the decision is yours.' },
  sources: { cs: 'Zdroje', sk: 'Zdroje', en: 'Sources' }, limits: { cs: 'Omezení', sk: 'Obmedzenia', en: 'Limitations' },
  fetched: { cs: 'staženo', sk: 'stiahnuté', en: 'retrieved' },
  yes: { cs: 'ano', sk: 'áno', en: 'yes' }, no: { cs: 'ne', sk: 'nie', en: 'no' },
};

const SOURCE_NAMES: [RegExp, T3][] = [
  [/^price_cache$/, { cs: 'uložené kurzy', sk: 'uložené kurzy', en: 'stored prices' }],
  [/^price_history$|^valuation_series/, { cs: 'Trackora – historie cen', sk: 'Trackora – história cien', en: 'Trackora – price history' }],
  [/^(portfolio_model|allocation_model|realized_model|tax_model|transactions|lots|performance)/, { cs: 'Trackora – výpočet portfolia', sk: 'Trackora – výpočet portfólia', en: 'Trackora – portfolio calculation' }],
  [/^analyst_opinion/, { cs: 'názor analytiků', sk: 'názor analytikov', en: 'analyst opinion' }],
  [/^fair_value_model/, { cs: 'Trackora – model férové hodnoty', sk: 'Trackora – model férovej hodnoty', en: 'Trackora – fair value model' }],
  [/^scenario_model$/, { cs: 'Trackora – modelové scénáře', sk: 'Trackora – modelové scenáre', en: 'Trackora – model scenarios' }],
  [/^calculation:analyst_target$/, { cs: 'Trackora – výpočet z cílové ceny analytiků', sk: 'Trackora – výpočet z cieľovej ceny analytikov', en: 'Trackora – from the analyst target' }],
  [/^company_fundamentals$/, { cs: 'výkazy společnosti', sk: 'výkazy spoločnosti', en: 'company filings' }],
  [/^earnings_calendar$/, { cs: 'kalendář výsledků', sk: 'kalendár výsledkov', en: 'earnings calendar' }],
  [/^(stock_news|Finnhub news)$/, { cs: 'zprávy', sk: 'správy', en: 'news' }],
  [/^assumption$/, { cs: 'předpoklad modelu', sk: 'predpoklad modelu', en: 'model assumption' }],
  [/^user$/, { cs: 'tvoje zadání', sk: 'tvoje zadanie', en: 'your input' }],
  [/^calculate$/, { cs: 'Trackora', sk: 'Trackora', en: 'Trackora' }],
  [/^daily_snapshots$/, { cs: 'Trackora – uložený snímek', sk: 'Trackora – uložený snímok', en: 'Trackora – stored snapshot' }],
  [/^benchmark_history$/, { cs: 'index S&P 500', sk: 'index S&P 500', en: 'S&P 500 index' }],
  [/^(Finnhub|Twelve Data|CoinGecko|Binance)$/, { cs: '', sk: '', en: '' }],
];
function sourceName(source: string, lang: Lang): string {
  const found = SOURCE_NAMES.find(([re]) => re.test(source));
  if (!found) return 'Trackora';
  return found[1][lang] || source;
}

const MULTIPLE: Record<string, string> = { pe: 'P/E', ps: 'P/S', pfcf: 'P/FCF', evEbitda: 'EV/EBITDA' };
type Label = (lang: Lang, t: string, extra: string) => string;
const L = (cs: string, sk: string, en: string): Label => (lang, t, extra) => ({ cs, sk, en }[lang]).replace('{t}', t).replace('{m}', extra).replace(/\s+/g, ' ').trim();
// Labels by the server-made fact key; the model cannot relabel a price as a profit.
const LABELS: [RegExp, Label][] = [
  [/^portfolio:total_value$/, L('hodnota portfolia', 'hodnota portfólia', 'portfolio value')],
  [/^portfolio:holding_count$/, L('počet držených pozic', 'počet držaných pozícií', 'number of positions held')],
  [/^portfolio:total_profit$/, L('celkový zisk či ztráta', 'celkový zisk či strata', 'total profit or loss')],
  [/^portfolio:unrealized_profit$/, L('nerealizovaný zisk či ztráta', 'nerealizovaný zisk či strata', 'unrealized profit or loss')],
  [/^portfolio:cash$/, L('hotovost', 'hotovosť', 'cash')],
  [/^portfolio:net_deposits$/, L('čisté vklady', 'čisté vklady', 'net deposits')],
  [/^portfolio:usd_czk$/, L('kurz USD/CZK', 'kurz USD/CZK', 'USD/CZK rate')],
  [/^portfolio:usd_local$/, L('kurz USD k místní měně', 'kurz USD k miestnej mene', 'USD to local currency rate')],
  [/^holding:[^:]+:value$/, L('hodnota pozice {t}', 'hodnota pozície {t}', '{t} position value')],
  [/^holding:[^:]+:shares$/, L('počet kusů {t}', 'počet kusov {t}', '{t} units held')],
  [/^holding:[^:]+:profit$/, L('zisk či ztráta pozice {t}', 'zisk či strata pozície {t}', '{t} position profit or loss')],
  [/^holding:[^:]+:day_change$/, L('dnešní změna hodnoty {t}', 'dnešná zmena hodnoty {t}', '{t} value change today')],
  [/^holding:[^:]+:day_change_pct$/, L('dnešní změna {t}', 'dnešná zmena {t}', '{t} change today')],
  [/^portfolio:day_change$/, L('dnešní změna hodnoty portfolia', 'dnešná zmena hodnoty portfólia', 'portfolio value change today')],
  [/^portfolio:day_change_pct$/, L('dnešní změna portfolia', 'dnešná zmena portfólia', 'portfolio change today')],
  [/^holding:[^:]+:allocation$/, L('podíl {t} v portfoliu', 'podiel {t} v portfóliu', '{t} share of the portfolio')],
  [/^quote:[^:]+:price$/, L('cena {t}', 'cena {t}', '{t} price')],
  [/^quote:[^:]+:previous_close$/, L('předchozí zavírací cena {t}', 'predchádzajúca záverečná cena {t}', '{t} previous close')],
  [/^quote:[^:]+:change_pct$/, L('denní změna {t}', 'denná zmena {t}', '{t} daily change')],
  [/^analysts:[^:]+:target_mean$/, L('průměrná cílová cena analytiků pro {t}', 'priemerná cieľová cena analytikov pre {t}', 'analysts\' mean target for {t}')],
  [/^analysts:[^:]+:target_low$/, L('nejnižší cílová cena analytiků', 'najnižšia cieľová cena analytikov', 'lowest analyst target')],
  [/^analysts:[^:]+:target_high$/, L('nejvyšší cílová cena analytiků', 'najvyššia cieľová cena analytikov', 'highest analyst target')],
  [/^analysts:[^:]+:(strong_buy|buy|hold|sell|strong_sell)$/, L('doporučení analytiků', 'odporúčania analytikov', 'analyst recommendations')],
  [/^analysts:[^:]+:consensus$/, L('konsenzus analytiků', 'konsenzus analytikov', 'analyst consensus')],
  [/^fair_value:[^:]+:value$/, L('férová hodnota {t} (model Trackory)', 'férová hodnota {t} (model Trackory)', '{t} fair value (Trackora model)')],
  [/^fair_value:[^:]+:sensitivity_(low|high)$/, L('rozpětí citlivosti férové hodnoty', 'rozpätie citlivosti férovej hodnoty', 'fair value sensitivity range')],
  [/^fair_value:[^:]+:margin_of_safety$/, L('bezpečnostní polštář', 'bezpečnostný vankúš', 'margin of safety')],
  [/^fair_value:[^:]+:potential$/, L('potenciál k férové hodnotě', 'potenciál k férovej hodnote', 'potential to fair value')],
  [/^fair_value:[^:]+:implied_growth$/, L('růst, se kterým počítá cena', 'rast, s ktorým počíta cena', 'growth implied by the price')],
  [/^fair_value:[^:]+:method:/, L('férová hodnota jednou z metod', 'férová hodnota jednou z metód', 'fair value by one method')],
  [/^fair_value:[^:]+:assumption:/, L('předpoklad modelu', 'predpoklad modelu', 'model assumption')],
  [/^valuation:[^:]+:current:/, L('aktuální {m}', 'aktuálne {m}', 'current {m}')],
  [/^valuation:[^:]+:median_5y:/, L('pětiletý medián {m}', 'päťročný medián {m}', 'five-year median {m}')],
  [/^valuation:[^:]+:percentile:/, L('postavení {m} v pětileté historii', 'postavenie {m} v päťročnej histórii', '{m} position in its five-year history')],
  [/^history:SPX:change_pct$/, L('změna indexu S&P 500', 'zmena indexu S&P 500', 'S&P 500 change')],
  [/^history:[^:]+:last_close$/, L('poslední zavírací cena {t}', 'posledná záverečná cena {t}', '{t} last close')],
  [/^history:[^:]+:change_pct$/, L('změna ceny {t} za období', 'zmena ceny {t} za obdobie', '{t} price change over the period')],
  [/^history:[^:]+:first_close$/, L('první zavírací cena {t} v období', 'prvá záverečná cena {t} v období', '{t} first close in the period')],
  [/^history:[^:]+:max_drawdown_pct$/, L('největší propad {t} od maxima v období', 'najväčší prepad {t} od maxima v období', '{t} largest drop from a high in the period')],
  [/^history:[^:]+:volatility_60d$/, L('denní volatilita {t}', 'denná volatilita {t}', '{t} daily volatility')],
  [/^earnings:[^:]+:next_date$/, L('příští výsledky {t}', 'najbližšie výsledky {t}', 'next {t} earnings')],
  [/^earnings:/, L('výsledky hospodaření {t}', 'hospodárske výsledky {t}', '{t} earnings')],
  [/^fundamentals:/, L('údaj z výkazů {t}', 'údaj z výkazov {t}', '{t} filing figure')],
  [/^realized:[^:]+:net$/, L('realizovaný výsledek {t}', 'realizovaný výsledok {t}', '{t} realized result')],
  [/^realized:[^:]+:gains$/, L('realizované zisky {t}', 'realizované zisky {t}', '{t} realized gains')],
  [/^realized:[^:]+:losses$/, L('realizované ztráty {t}', 'realizované straty {t}', '{t} realized losses')],
  [/^realized:[^:]+:proceeds$/, L('příjmy z prodejů {t}', 'príjmy z predajov {t}', '{t} sale proceeds')],
  [/^realized:[^:]+:dividends$/, L('dividendy {t}', 'dividendy {t}', '{t} dividends')],
  [/^tax:[^:]+:estimated_tax$/, L('odhad daně', 'odhad dane', 'estimated tax')],
  [/^tax:[^:]+:under_limit$/, L('příjmy pod limitem', 'príjmy pod limitom', 'proceeds under the limit')],
  [/^tax:[^:]+:(tax_base|taxable_base)$/, L('základ daně', 'základ dane', 'tax base')],
  [/^tax:[^:]+:proceeds$/, L('příjmy z prodejů', 'príjmy z predajov', 'sale proceeds')],
  [/^tax:[^:]+:limit_base$/, L('příjmy započtené do limitu', 'príjmy započítané do limitu', 'proceeds counted toward the limit')],
  [/^tax:/, L('daňový údaj', 'daňový údaj', 'tax figure')],
  [/^sale:[^:]+:gain$/, L('zisk či ztráta z prodeje {t}', 'zisk či strata z predaja {t}', '{t} sale profit or loss')],
  [/^sale:[^:]+:(tax_delta|extra_tax)$/, L('dodatečná daň při prodeji {t}', 'dodatočná daň pri predaji {t}', 'additional tax on selling {t}')],
  [/^sale:[^:]+:estimated_tax_after$/, L('celkový odhad daně po prodeji {t}', 'celkový odhad dane po predaji {t}', 'total estimated tax after selling {t}')],
  [/^sale:[^:]+:proceeds$/, L('příjem z prodeje {t}', 'príjem z predaja {t}', '{t} sale proceeds')],
  [/^sale:[^:]+:shares$/, L('prodávané kusy {t}', 'predávané kusy {t}', '{t} shares to sell')],
  [/^sale:[^:]+:price$/, L('prodejní cena za kus {t}', 'predajná cena za kus {t}', '{t} sale price per share')],
  [/^sale:[^:]+:fee$/, L('poplatek za prodej {t}', 'poplatok za predaj {t}', '{t} sale fee')],
  [/^sale:[^:]+:date$/, L('datum prodeje {t}', 'dátum predaja {t}', '{t} sale date')],
  [/^sale:[^:]+:(sale_fx|assumed_local_fx)$/, L('kurz při prodeji {t}', 'kurz pri predaji {t}', '{t} sale exchange rate')],
  [/^sale:[^:]+:taxable_gain$/, L('zdanitelný zisk z prodeje {t}', 'zdaniteľný zisk z predaja {t}', '{t} taxable sale gain')],
  [/^sale:[^:]+:missing_shares$/, L('chybějící kusy k prodeji {t}', 'chýbajúce kusy na predaj {t}', '{t} shares missing for the sale')],
  [/^sale:/, L('údaj simulace prodeje {t}', 'údaj simulácie predaja {t}', '{t} sale simulation figure')],
  [/^dividends:gross$/, L('hrubé dividendy', 'hrubé dividendy', 'gross dividends')],
  [/^dividends:net$/, L('čisté dividendy', 'čisté dividendy', 'net dividends')],
  [/^dividends:withheld$/, L('sražená daň z dividend', 'zrazená daň z dividend', 'dividend tax withheld')],
  [/^dividends:forecast_annual$/, L('roční odhad dividend', 'ročný odhad dividend', 'annual dividend estimate')],
  [/^dividends:received$/, L('přijaté dividendy', 'prijaté dividendy', 'dividends received')],
  [/^dividends:count$/, L('počet výplat dividend', 'počet výplat dividend', 'number of dividend payments')],
  [/^dividends:next_pay_date$/, L('příští výplata dividendy', 'najbližšia výplata dividendy', 'next dividend payment')],
  [/^dividends:/, L('dividendy', 'dividendy', 'dividends')],
  [/^performance:portfolio_return$/, L('výnos portfolia', 'výnos portfólia', 'portfolio return')],
  [/^performance:benchmark_(annual_)?return$/, L('výnos indexu S&P 500', 'výnos indexu S&P 500', 'S&P 500 return')],
  [/^performance:annual_return$/, L('roční výnos portfolia', 'ročný výnos portfólia', 'annual portfolio return')],
  [/^performance:profit$/, L('zisk či ztráta za období', 'zisk či strata za obdobie', 'profit or loss for the period')],
  [/^performance:[^:]+:price_change$/, L('změna ceny {t}', 'zmena ceny {t}', '{t} price change')],
  [/^allocation:hhi$/, L('koncentrace portfolia', 'koncentrácia portfólia', 'portfolio concentration')],
  [/^allocation:invested$/, L('investovaná částka', 'investovaná suma', 'invested amount')],
  [/^allocation:/, L('podíl v portfoliu', 'podiel v portfóliu', 'portfolio share')],
  [/^transactions:[^:]+:count$/, L('počet obchodů {t}', 'počet obchodov {t}', 'number of {t} trades')],
  [/^transactions:[^:]+:buy_count$/, L('počet nákupů {t}', 'počet nákupov {t}', 'number of {t} buys')],
  [/^transactions:[^:]+:sell_count$/, L('počet prodejů {t}', 'počet predajov {t}', 'number of {t} sells')],
  [/^transactions:[^:]+:buy_usd$/, L('nakoupeno za {t}', 'nakúpené za {t}', '{t} bought for')],
  [/^transactions:[^:]+:sell_usd$/, L('prodáno za {t}', 'predané za {t}', '{t} sold for')],
  [/^transactions:[^:]+:bought_shares$/, L('nakoupené kusy {t}', 'nakúpené kusy {t}', '{t} units bought')],
  [/^transactions:[^:]+:sold_shares$/, L('prodané kusy {t}', 'predané kusy {t}', '{t} units sold')],
  [/^transactions:[^:]+:fees_usd$/, L('poplatky', 'poplatky', 'fees')],
  [/^transactions:/, L('souhrn obchodů', 'súhrn obchodov', 'trade summary')],
  [/^lots:lot_\d+:shares$/, L('kusy v lotu {t}', 'kusy v lote {t}', '{t} lot shares')],
  [/^lots:lot_\d+:acquired$/, L('nákup lotu {t}', 'nákup lotu {t}', '{t} lot acquired')],
  [/^lots:lot_\d+:exempt_date$/, L('osvobození od {t}', 'oslobodenie od {t}', '{t} exempt from')],
  [/^lots:lot_\d+:exempt$/, L('časový test splněn {t}', 'časový test splnený {t}', '{t} time test met')],
  [/^lots:[^:]+:count$/, L('počet nákupních lotů {t}', 'počet nákupných lotov {t}', '{t} purchase lot count')],
  [/^lots:/, L('kusy v nákupních lotech {t}', 'kusy v nákupných lotoch {t}', '{t} purchase lot shares')],
  [/^watchlist:[^:]+:target$/, L('tvoje cílová cena {t}', 'tvoja cieľová cena {t}', 'your target price for {t}')],
  [/^news:/, L('nedávné titulky', 'nedávne titulky', 'recent headlines')],
  [/^calc:/, L('výpočet Trackory', 'výpočet Trackory', 'Trackora calculation')],
];
export function factLabel(fact: Fact, lang: Lang): string {
  const key = fact.id.split('#')[0];
  const allocation = /^allocation:(sector|asset_type|currency):([\p{L}\p{N}_-]+)$/u.exec(key);
  if (allocation) {
    const group = { sector: L('sektor', 'sektor', 'sector'), asset_type: L('druh aktiv', 'druh aktív', 'asset type'),
      currency: L('měna kotace', 'mena kotácie', 'quote currency') }[allocation[1]]!;
    return `${L('podíl', 'podiel', 'allocation')(lang, '', '')} – ${group(lang, '', '')} ${allocation[2].replace(/[_-]/g, ' ')}`;
  }
  const multiple = MULTIPLE[key.split(':').pop() ?? ''] ?? '';
  const label = LABELS.find(([re]) => re.test(key))?.[1] ?? L('údaj Trackory', 'údaj Trackory', 'Trackora figure');
  const lot = /^lots:lot_(\d+):/.exec(key);
  return `${label(lang, fact.ticker ?? '', multiple)}${lot ? ` (lot ${lot[1]})` : ''}`;
}

/* ----------------------------- formatting ----------------------------- */

const TEXT_VALUES: Record<string, T3> = {
  strong_buy: { cs: 'silný nákup', sk: 'silný nákup', en: 'strong buy' }, buy: { cs: 'nákup', sk: 'nákup', en: 'buy' },
  hold: { cs: 'držet', sk: 'držať', en: 'hold' }, sell: { cs: 'prodej', sk: 'predaj', en: 'sell' },
  strong_sell: { cs: 'silný prodej', sk: 'silný predaj', en: 'strong sell' }, underperform: { cs: 'slabší výkon', sk: 'slabší výkon', en: 'underperform' },
  outperform: { cs: 'nadprůměrný výkon', sk: 'nadpriemerný výkon', en: 'outperform' },
};
function money(value: number, currency: string | undefined, decimals: number, lang: Lang): string {
  const number = new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (!currency) return number.format(value);
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency, currencyDisplay: currency === 'CZK' && lang === 'cs' ? 'symbol' : 'code',
      minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  } catch {
    // Not an ISO currency (e.g. USDT): the code is still shown, never dropped.
    return `${number.format(value)} ${currency}`;
  }
}
function dateText(value: string, lang: Lang, withTime: boolean): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return '';
  const timed = withTime && !/^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', ...(timed ? { timeStyle: 'short' } : {}),
    timeZone: timed ? 'Europe/Prague' : 'UTC' }).format(date);
}
/** A fact as people read it, with the renderer's own decimals; null for a value that cannot be shown. */
export function formatFact(fact: Fact, lang: Lang): string | null {
  const v = fact.value;
  if (v === null) return null;
  const d = displayDecimals(fact);
  const number = (x: number, decimals: number) => new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(x);
  switch (fact.unit) {
    case 'money': {
      if (typeof v !== 'number') return null;
      // A market capitalisation reads in billions ("120 mld. USD"), not as a twelve-digit amount.
      if (/:market_cap$/.test(fact.id) && Math.abs(v) >= 1e9) return `${number(v / 1e9, 1)} ${({ cs: 'mld.', sk: 'mld.', en: 'bn' })[lang]} ${fact.currency ?? ''}`.trim();
      return money(v, fact.currency, d, lang);
    }
    case 'shares': case 'count': return typeof v === 'number' ? number(v, d) : null;
    case 'percent': return typeof v === 'number' ? new Intl.NumberFormat(LOCALE[lang], { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }).format(v / 100) : null;
    case 'ratio': {
      if (typeof v !== 'number') return null;
      return PERCENT_RATIO.test(fact.id)
        ? new Intl.NumberFormat(LOCALE[lang], { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v) : number(v, d);
    }
    case 'date': return typeof v === 'string' ? dateText(v, lang, false) || null : null;
    case 'boolean': return typeof v === 'boolean' ? (v ? W.yes : W.no)[lang] : null;
    case 'text': {
      if (typeof v !== 'string') return null;
      const known = TEXT_VALUES[v.trim().toLowerCase().replace(/[\s-]+/g, '_')];
      return known ? known[lang] : /^[\p{L} .'-]{1,40}$/u.test(v) && !v.includes('_') ? v : null;
    }
  }
}

/* ----------------------------- rendering ----------------------------- */

/**
 * One entry per source, with its distinct times (at most three): "Trackora – výpočet portfolia
 * (23. 10. 2026 14:00); uložené kurzy (staženo 23. 10. 2026 13:50)". Which fact came from where is
 * already in the answer's own labels, so the line stays short.
 */
function sourcesLine(facts: Fact[], lang: Lang): string {
  const groups = new Map<string, string[]>();
  for (const fact of facts) {
    const name = sourceName(fact.source, lang);
    const when = dateText(fact.as_of, lang, true);
    // A stored price is dated by its retrieval, said once per entry.
    const key = `${name}\u0000${fact.source === 'price_cache' ? `${W.fetched[lang]} ` : ''}`;
    const times = groups.get(key) ?? (groups.size < 6 ? [] : null);
    if (!times) continue;
    if (when && !times.includes(when) && times.length < 3) times.push(when);
    groups.set(key, times);
  }
  const entries = [...groups].map(([key, times]) => {
    const [name, prefix] = key.split('\u0000');
    return `${name}${times.length ? ` (${prefix}${times.join(', ')})` : ''}`;
  });
  return entries.length ? `${W.sources[lang]}: ${entries.join('; ')}.` : '';
}

/**
 * Renders a validated draft; numbers, currencies and tickers come from the facts, never from the draft text.
 * A fact selection (model or server) is phrased as short sentences by the server (Běh 21d); prose blocks of the
 * analysis template have their slots filled in place.
 */
export function renderVerifiedAnswer(draft: AnswerDraft, facts: ReadonlyMap<string, Fact>,
  extras: { limits?: string[]; links?: Link[]; labels?: Record<string, string>; serverTemplate?: boolean; today?: string; notes?: string[];
    explain?: boolean; quietQuality?: boolean } = {}): StoredAnswer {
  const lang = draft.lang, used: Fact[] = [], parts: string[] = [];
  for (const block of draft.blocks) {
    // A validated general explanation (prose with slots, no conclusion) is the only model prose that renders.
    const explained = extras.explain && !draft.verdict && (block.kind === 'context' || block.kind === 'facts');
    if (!extras.serverTemplate && !explained && (!isFactSelection(block.text) || block.kind !== 'facts' || draft.verdict)) {
      throw new Error('Render of unbound prose or conclusion');
    }
    const slotFact = (id: string) => {
      const claim = block.claims[id] as NumericClaim | ReferencedClaim | undefined;
      const fact = claim ? facts.get(claim.factId) : undefined;
      if (!fact) throw new Error('Render of an unvalidated draft');
      used.push(fact);
      return fact;
    };
    const text = block.kind === 'facts' && isFactSelection(block.text)
      ? phraseFacts([...block.text.matchAll(/\{\{([A-Za-z0-9_]{1,24})\}\}/g)].map(m => slotFact(m[1])), lang, extras.today)
      : block.text.replace(/\{\{([A-Za-z0-9_]{1,24})\}\}/g, (_m, id: string, offset: number, whole: string) => {
        const fact = slotFact(id);
        // A figure in a model's own explanation carries its server label, so the prose cannot give it another meaning.
        // The opinion says its own period in words ("za poslední rok") and shows large amounts compactly (150 mil. USD).
        const opinion = block.kind === 'verdict';
        const notes = [...(explained ? [factLabel(fact, lang)] : []), ...factNotes(fact, lang, !opinion, extras.quietQuality).map(n => n.inline)];
        // Inside the sentence's own parentheses the qualification is joined, never nested: "(100,0 %; 19. 6. – …)".
        const inParens = whole.slice(offset + _m.length).startsWith(')');
        const shown = opinion && fact.unit === 'money' && typeof fact.value === 'number' && Math.abs(fact.value) >= 1e6 && fact.currency
          ? `${new Intl.NumberFormat(LOCALE[lang], { notation: 'compact', maximumFractionDigits: 1 }).format(fact.value)} ${fact.currency}` : formatFact(fact, lang) ?? '';
        return `${shown}${notes.length ? inParens ? `; ${notes.join('; ')}` : ` (${notes.join('; ')})` : ''}`;
      }).trim();
    for (const id of block.sourceIds) { const f = facts.get(id); if (f) used.push(f); }
    const lines = [block.kind === 'facts' || explained ? '' : W.heading[block.kind][lang], text];
    if (block.kind === 'verdict' && draft.verdict) {
      lines.push(`${W.conclusion[lang]}: ${W.verdict[draft.verdict][lang]}.${draft.confidence ? ` ${W.confidenceLabel[lang]}: ${W.confidence[draft.confidence][lang]}.` : ''}`);
      if (draft.wouldChange?.trim()) lines.push(`${W.wouldChange[lang]}: ${draft.wouldChange.trim().replace(/\.?$/, '.')}`);
      lines.push(W.decision[lang]);
    }
    parts.push(lines.filter(Boolean).join('\n'));
  }
  if (draft.verdict && !draft.blocks.some(b => b.kind === 'verdict')) parts.push(W.decision[lang]);
  if (extras.notes?.length) parts.push(extras.notes.join(' '));
  if (extras.explain) parts.push(W.general[lang]);
  if (extras.limits?.length) parts.push(`${W.limits[lang]}: ${extras.limits.join(' ')}`);
  const sources = sourcesLine(used, lang);
  if (sources) parts.push(sources);
  let text = parts.join('\n\n').replace(/\n\n• /g, '\n• ');
  for (const [token, label] of Object.entries(extras.labels ?? {})) text = text.split(token).join(label);
  return { text, links: extras.links ?? [], trace: [], lang, outcome: 'ok', verified: true };
}

/* ----------------------------- qualifications ----------------------------- */

// Every claim keeps its qualifications (Běh 14). Inline they follow the number; when all numbers of one topic share
// one, it is said once for the topic as a sentence.
type Note = { key: string; inline: string; sentence: string };
const NOTES: Record<'scope_unknown' | 'selected' | 'currency' | 'incomplete' | 'stale', { inline: T3; sentence: T3 }> = {
  scope_unknown: { inline: { cs: 'rozsah není znám', sk: 'rozsah nie je známy', en: 'scope is unknown' },
    sentence: { cs: 'Rozsah účtů není znám.', sk: 'Rozsah účtov nie je známy.', en: 'The account scope is unknown.' } },
  selected: { inline: { cs: 'vybraný účet', sk: 'vybraný účet', en: 'selected account' },
    sentence: { cs: 'Počítáno jen pro vybraný účet.', sk: 'Počítané len pre vybraný účet.', en: 'Calculated for the selected account only.' } },
  currency: { inline: { cs: 'měna není známá', sk: 'mena nie je známa', en: 'currency is unknown' },
    sentence: { cs: 'Měna není známá.', sk: 'Mena nie je známa.', en: 'The currency is unknown.' } },
  incomplete: { inline: { cs: 'neúplné podklady', sk: 'neúplné podklady', en: 'incomplete evidence' },
    sentence: { cs: 'Podklady jsou neúplné.', sk: 'Podklady sú neúplné.', en: 'The evidence is incomplete.' } },
  stale: { inline: { cs: 'údaj není čerstvý', sk: 'údaj nie je čerstvý', en: 'not fresh' },
    sentence: { cs: 'Část údajů není čerstvá.', sk: 'Časť údajov nie je čerstvá.', en: 'Some data are not fresh.' } },
};
const MARKET_METRIC = /^(?:quote|analysts|fair_value|valuation|fundamentals|news|earnings|scenario|research|peers|metrics):/;
const periodText = (period: { from: string; to: string }, lang: Lang) => `${dateText(period.from, lang, false)} – ${dateText(period.to, lang, false)}`;
function factNotes(fact: Fact, lang: Lang, withPeriod: boolean, quietQuality = false): Note[] {
  const notes: Note[] = [];
  if (withPeriod && fact.period) { const text = periodText(fact.period, lang); notes.push({ key: 'period', inline: text, sentence: text }); }
  const add = (key: keyof typeof NOTES) => notes.push({ key, inline: NOTES[key].inline[lang], sentence: NOTES[key].sentence[lang] });
  if (fact.scope === 'unknown') add('scope_unknown');
  else if (fact.scope && fact.scope !== 'all') add('selected');
  if (fact.unit === 'money' && !fact.currency) add('currency');
  // Freshness and the completeness of market data (prices, analysts, valuations, statements, news) are the assistant's
  // own concern: they lower its confidence instead of repeating "not fresh" after every number. Incomplete figures of
  // the user's own ledger (portfolio, tax, dividends) are still said, they change what the number means.
  if (!quietQuality && fact.quality?.state !== 'complete' && !MARKET_METRIC.test(fact.metric ?? fact.id)) add('incomplete');
  return notes;
}

/* ----------------------------- natural sentences (Běh 21d) ----------------------------- */

// Facts are grouped by topic (trades, realized result, tax, dividends, price, portfolio, ...) and phrased as short
// sentences with tykání. Every number is formatFact of its own fact; the meaning word stands in front of it, a counted
// noun right after it ("2 kusy"). The period is said once per topic; a zero may be said in words ("nic jsi
// nenakoupil"), never a non-zero value. Anything without a phrase keeps its server label.

const NOUNS: Record<'unit' | 'trade' | 'buy' | 'sale' | 'payment' | 'position' | 'lot', Record<Lang, string[]>> = {
  unit: { cs: ['kus', 'kusy', 'kusů', 'kusu'], sk: ['kus', 'kusy', 'kusov', 'kusa'], en: ['unit', 'units'] },
  trade: { cs: ['obchod', 'obchody', 'obchodů'], sk: ['obchod', 'obchody', 'obchodov'], en: ['trade', 'trades'] },
  buy: { cs: ['nákup', 'nákupy', 'nákupů'], sk: ['nákup', 'nákupy', 'nákupov'], en: ['buy', 'buys'] },
  sale: { cs: ['prodej', 'prodeje', 'prodejů'], sk: ['predaj', 'predaje', 'predajov'], en: ['sale', 'sales'] },
  payment: { cs: ['výplata', 'výplaty', 'výplat'], sk: ['výplata', 'výplaty', 'výplat'], en: ['payment', 'payments'] },
  position: { cs: ['pozici', 'pozice', 'pozic'], sk: ['pozíciu', 'pozície', 'pozícií'], en: ['position', 'positions'] },
  lot: { cs: ['lot', 'loty', 'lotů'], sk: ['lot', 'loty', 'lotov'], en: ['lot', 'lots'] },
};
function noun(word: keyof typeof NOUNS, fact: Fact, lang: Lang): string {
  const forms = NOUNS[word][lang], n = Math.abs(typeof fact.value === 'number' ? fact.value : 0);
  if (lang === 'en') return n === 1 ? forms[0] : forms[1];
  if (!Number.isInteger(n)) return forms[3] ?? forms[1];
  return n === 1 ? forms[0] : n >= 2 && n <= 4 ? forms[1] : forms[2];
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = (lang: Lang, t: T3) => t[lang];
/** "a, b a c" / "a, b and c". */
function list(items: string[], lang: Lang): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'a'} ${items[items.length - 1]}`;
}
const num = (f: Fact | undefined): number | null => f && typeof f.value === 'number' ? f.value : null;

/** "Letos (1. 1. 2026 – 23. 10. 2026)", "V roce 2025", "Od … do …"; null without a period. */
function periodOpener(period: Fact['period'], lang: Lang, today?: string): string | null {
  if (!period) return null;
  const year = period.from.slice(0, 4);
  if (period.from === `${year}-01-01` && today && period.to === today && today.startsWith(year)) {
    return `${pick(lang, { cs: 'Letos', sk: 'Tento rok', en: 'This year' })} (${periodText(period, lang)})`;
  }
  if (period.from === `${year}-01-01` && period.to === `${year}-12-31`) return `${pick(lang, { cs: 'V roce', sk: 'V roku', en: 'In' })} ${year}`;
  return `${pick(lang, { cs: 'Od', sk: 'Od', en: 'From' })} ${dateText(period.from, lang, false)} ${pick(lang, { cs: 'do', sk: 'do', en: 'to' })} ${dateText(period.to, lang, false)}`;
}

type Topic = { kind: string; ticker?: string; facts: Map<string, Fact> };
// v: the value with its own (not topic-wide) qualifications; q: those qualifications alone, for a value said in words.
type Say = { lang: Lang; today?: string; v: (f: Fact, abs?: boolean) => string; q: (f: Fact) => string; used: Set<Fact> };
const TOPICS: [string, RegExp][] = [
  ['tx', /^transactions:([^:]+):(count|buy_count|sell_count|buy_usd|sell_usd|bought_shares|sold_shares|fees_usd)$/],
  ['realized', /^realized:([^:]+):(net|gains|losses|proceeds|dividends)$/],
  ['tax', /^tax:(\d{4}):(estimated_tax|tax_base|taxable_base|proceeds|limit_base|under_limit)$/],
  ['dividends', /^dividends:()(received|count|gross|net|withheld|forecast_annual|next_pay_date)$/],
  ['quote', /^quote:([^:]+):(price|previous_close|change_pct)$/],
  ['pricemove', /^history:([^:]+):(change_pct)$/],
  ['portfolio', /^portfolio:()(total_value|cash|total_profit|unrealized_profit|holding_count|net_deposits|usd_czk|usd_local)$/],
  ['holding', /^holding:([^:]+):(shares|value|profit|allocation)$/],
  ['movers', /^(?:portfolio|holding:([^:]+)):(day_change|day_change_pct)$/],
  ['performance', /^performance:()(portfolio_return|annual_return|profit|benchmark_return|benchmark_annual_return)$/],
  ['allocation', /^allocation:()((?:sector|asset_type|currency):.+|hhi|invested)$/],
  ['lots', /^lots:([^:]+):(.+)$/],
  ['sale', /^sale:([^:]+):(.+)$/],
];

/** One topic's sentences; facts it phrases are added to `say.used`, the rest keep their label. */
const PHRASES: Record<string, (t: Topic, say: Say) => string[]> = {
  tx(t, { lang, today, v, used }) {
    const f = (k: string) => t.facts.get(k);
    const [c, bc, sc, bu, su, bs, ss, fee] = ['count', 'buy_count', 'sell_count', 'buy_usd', 'sell_usd', 'bought_shares', 'sold_shares', 'fees_usd'].map(f);
    const present = [c, bc, sc, bu, su, bs, ss].filter((x): x is Fact => !!x);
    if (!present.length || present.some(x => num(x) === null)) return [];
    const opener = periodOpener(present[0].period, lang, today) ?? pick(lang, { cs: 'Celkem', sk: 'Celkovo', en: 'Overall' });
    const lead = lang === 'en' ? `${opener}, you` : `${opener} ${lang === 'cs' ? 'jsi' : 'si'}`;
    const T = t.ticker === 'all' ? undefined : t.ticker;
    const out: string[] = [];
    if (present.every(x => x.value === 0)) {
      present.forEach(x => used.add(x));
      const prep = lang === 'cs' ? /^[sSzZšŠžŽ]/.test(T ?? '') ? 'se' : 's' : /^[sSzZšŠžŽ]/.test(T ?? '') ? 'so' : 's';
      out.push(lang === 'en' ? `${lead} made no trades${T ? ` in ${T}` : ''}.` : `${lead} ${pick(lang, { cs: 'neudělal žádný obchod', sk: 'neurobil žiadny obchod', en: '' })}${T ? ` ${prep} ${T}` : ''}.`);
    } else {
      const sides = ([['buy', bs, bu, bc], ['sell', ss, su, sc]] as const).filter(([, ...xs]) => xs.some(Boolean));
      let tickerSaid = !T;
      const clauses = sides.map(([side, units, amount, count]) => {
        const zero = [units, amount, count].filter((x): x is Fact => !!x).every(x => x.value === 0);
        if (zero) {
          [units, amount, count].forEach(x => x && used.add(x));
          const where = !tickerSaid && lang !== 'en' ? `${pick(lang, { cs: 'u', sk: 'pri', en: '' })} ${T} ` : '';
          const what = !tickerSaid && lang === 'en' ? `any ${T}` : 'anything';
          tickerSaid = true;
          return side === 'buy' ? `${where}${pick(lang, { cs: 'nic nenakoupil', sk: 'nič nenakúpil', en: `did not buy ${what}` })}`
            : `${where}${pick(lang, { cs: 'nic neprodal', sk: 'nič nepredal', en: `did not sell ${what}` })}`;
        }
        let clause = side === 'buy' ? pick(lang, { cs: 'nakoupil', sk: 'nakúpil', en: 'bought' }) : pick(lang, { cs: 'prodal', sk: 'predal', en: 'sold' });
        if (units) {
          used.add(units);
          clause += ` ${v(units)} ${noun('unit', units, lang)}${tickerSaid ? '' : lang === 'en' ? ` of ${T}` : ` ${T}`}`;
          tickerSaid = true;
        }
        if (amount) { used.add(amount); clause += ` ${pick(lang, { cs: 'za', sk: 'za', en: 'for' })} ${v(amount)}`; }
        return clause;
      });
      // Trade counts: the total, split by side only when both sides traded; a side count equal to the total is that total.
      const tail: string[] = [];
      const bothSides = num(bc)! > 0 && num(sc)! > 0;
      if (c) {
        used.add(c);
        tail.push(lang === 'en' ? `${v(c)} ${noun('trade', c, lang)} in total` : `${pick(lang, { cs: 'celkem', sk: 'spolu', en: '' })} ${v(c)} ${noun('trade', c, lang)}`);
      }
      const split = [[bc, 'buy'], [sc, 'sale']] as const;
      const shown = split.filter(([x]) => x && !used.has(x) && (bothSides || !c || x.value !== c.value)).map(([x, word]) => { used.add(x!); return `${v(x!)} ${noun(word, x!, lang)}`; });
      split.forEach(([x]) => x && used.add(x));
      let counts = tail.join('');
      if (shown.length) {
        counts += c ? `${lang === 'en' ? ': ' : `, ${pick(lang, { cs: 'z toho', sk: 'z toho', en: '' })} `}${list(shown, lang)}`
          : lang === 'en' ? `${list(shown, lang)} in total` : `${pick(lang, { cs: 'celkem', sk: 'spolu', en: '' })} ${list(shown, lang)}`;
      }
      out.push(`${lead} ${list(clauses, lang)}${counts ? `, ${counts}` : ''}.`);
    }
    if (fee && num(fee) !== null) {
      used.add(fee);
      if (fee.value !== 0) out.push(pick(lang, { cs: `Poplatky byly ${v(fee)}.`, sk: `Poplatky boli ${v(fee)}.`, en: `Fees were ${v(fee)}.` }));
    }
    return out;
  },

  realized(t, { lang, today, v, used }) {
    const [net, gains, losses, proceeds, dividends] = ['net', 'gains', 'losses', 'proceeds', 'dividends'].map(k => t.facts.get(k));
    const all = [net, gains, losses, proceeds, dividends].filter((x): x is Fact => !!x);
    if (!all.length || all.some(x => num(x) === null)) return [];
    const opener = periodOpener(all[0].period, lang, today) ?? pick(lang, { cs: 'Celkem', sk: 'Celkovo', en: 'Overall' });
    const T = all.find(x => x.ticker)?.ticker;
    const on = T ? pick(lang, { cs: ` na ${T}`, sk: ` na ${T}`, en: ` on ${T}` }) : '';
    const out: string[] = [];
    const quiet = [gains, losses].every(x => !x || x.value === 0);
    if (net) {
      used.add(net);
      const n = num(net)!;
      const lead = lang === 'en' ? `${opener}, you` : `${opener} ${lang === 'cs' ? 'jsi' : 'si'}${on}`;
      out.push(n > 0 ? pick(lang, { cs: `${lead} realizoval zisk ${v(net)}.`, sk: `${lead} realizoval zisk ${v(net)}.`, en: `${lead} realized a gain of ${v(net)}${on}.` })
        : n < 0 ? pick(lang, { cs: `${lead} realizoval ztrátu ${v(net, true)}.`, sk: `${lead} realizoval stratu ${v(net, true)}.`, en: `${lead} realized a loss of ${v(net, true)}${on}.` })
        : quiet ? pick(lang, { cs: `${lead} nerealizoval žádný zisk ani ztrátu, výsledek je ${v(net)}.`, sk: `${lead} nerealizoval žiadny zisk ani stratu, výsledok je ${v(net)}.`,
          en: `${lead} realized no gain or loss${on}; the result is ${v(net)}.` })
        : pick(lang, { cs: `${lead} realizoval nulový výsledek ${v(net)}.`, sk: `${lead} realizoval nulový výsledok ${v(net)}.`, en: `${lead} realized a net result of ${v(net)}${on}.` }));
    }
    const parts: string[] = [];
    if (proceeds) {
      used.add(proceeds);
      parts.push(proceeds.value === 0 ? pick(lang, { cs: 'žádné tržby z prodejů jsi neměl', sk: 'žiadne tržby z predajov si nemal', en: 'you had no sale proceeds' })
        : pick(lang, { cs: `tržby z prodejů byly ${v(proceeds)}`, sk: `tržby z predajov boli ${v(proceeds)}`, en: `sale proceeds were ${v(proceeds)}` }));
    }
    if (!(net && quiet && net.value === 0)) {
      const g = num(gains), l = num(losses);
      if (losses && l === 0) {
        used.add(losses);
        // With no losses the gains are the result itself, already said.
        if (gains && (!net || g !== num(net))) { used.add(gains); parts.push(pick(lang, { cs: `zisky byly ${v(gains)}`, sk: `zisky boli ${v(gains)}`, en: `gains were ${v(gains)}` })); }
        else if (gains) used.add(gains);
        parts.push(pick(lang, { cs: 'žádné ztráty jsi neměl', sk: 'žiadne straty si nemal', en: 'you had no losses' }));
      } else if (losses) {
        used.add(losses);
        if (gains && g !== 0) { used.add(gains); parts.push(pick(lang, { cs: `zisky byly ${v(gains)} a ztráty ${v(losses, true)}`, sk: `zisky boli ${v(gains)} a straty ${v(losses, true)}`, en: `gains were ${v(gains)} and losses ${v(losses, true)}` })); }
        else { if (gains) used.add(gains); parts.push(pick(lang, { cs: `žádné zisky, jen ztráty ${v(losses, true)}`, sk: `žiadne zisky, len straty ${v(losses, true)}`, en: `you had no gains, only losses of ${v(losses, true)}` })); }
      } else if (gains) {
        used.add(gains);
        parts.push(pick(lang, { cs: `zisky byly ${v(gains)}`, sk: `zisky boli ${v(gains)}`, en: `gains were ${v(gains)}` }));
      }
    } else {
      [gains, losses].forEach(x => x && used.add(x));
    }
    if (dividends) {
      used.add(dividends);
      parts.push(dividends.value === 0 ? pick(lang, { cs: 'žádné dividendy jsi nedostal', sk: 'žiadne dividendy si nedostal', en: 'you received no dividends' })
        : pick(lang, { cs: `dividendy byly ${v(dividends)}`, sk: `dividendy boli ${v(dividends)}`, en: `dividends were ${v(dividends)}` }));
    }
    if (parts.length) {
      // "Nemal si žiadne tržby…" reads better than a sentence opening with "žiadne".
      const first = parts[0].replace(/^(žádné tržby z prodejů) jsi neměl$/, 'neměl jsi $1').replace(/^(žiadne tržby z predajov) si nemal$/, 'nemal si $1');
      out.push(`${cap(net ? first : `${lang === 'en' ? `${opener}, ` : `${opener} `}${first}`)}${parts.length > 1 ? `${parts.length > 2 ? ', ' : ` ${lang === 'en' ? 'and' : 'a'} `}${list(parts.slice(1), lang)}` : ''}.`);
    }
    return out;
  },

  tax(t, { lang, v, q, used }) {
    const year = t.ticker;
    const [tax, base, proceeds, limit, under] = ['estimated_tax', 'tax_base', 'proceeds', 'limit_base', 'under_limit']
      .map(k => t.facts.get(k) ?? (k === 'tax_base' ? t.facts.get('taxable_base') : undefined));
    const out: string[] = [];
    if (tax && num(tax) !== null) {
      used.add(tax);
      let s = pick(lang, { cs: `Odhad daně za rok ${year} je ${v(tax)}`, sk: `Odhad dane za rok ${year} je ${v(tax)}`, en: `Your estimated tax for ${year} is ${v(tax)}` });
      if (base && num(base) !== null) { used.add(base); s += pick(lang, { cs: `, základ daně je ${v(base)}`, sk: `, základ dane je ${v(base)}`, en: `, with a tax base of ${v(base)}` }); }
      out.push(`${s}.`);
    } else if (base && num(base) !== null) {
      used.add(base);
      out.push(pick(lang, { cs: `Základ daně za rok ${year} je ${v(base)}.`, sk: `Základ dane za rok ${year} je ${v(base)}.`, en: `Your tax base for ${year} is ${v(base)}.` }));
    }
    const p = proceeds && num(proceeds) !== null ? proceeds : undefined, lb = limit && num(limit) !== null ? limit : undefined;
    const u = under && typeof under.value === 'boolean' ? under : undefined;
    let s = '';
    if (p && lb && formatFact(p, lang) === formatFact(lb, lang)) {
      used.add(p); used.add(lb);
      s = pick(lang, { cs: `Příjmy z prodejů, které se počítají do limitu pro osvobození, jsou ${v(p)}`, sk: `Príjmy z predajov, ktoré sa počítajú do limitu na oslobodenie, sú ${v(p)}`,
        en: `Sale proceeds counted toward the exemption limit are ${v(p)}` });
    } else {
      const bits: string[] = [];
      if (p) { used.add(p); bits.push(pick(lang, { cs: `Příjmy z prodejů jsou ${v(p)}`, sk: `Príjmy z predajov sú ${v(p)}`, en: `Sale proceeds are ${v(p)}` })); }
      if (lb) { used.add(lb); bits.push(pick(lang, { cs: `do limitu pro osvobození se počítá ${v(lb)}`, sk: `do limitu na oslobodenie sa počíta ${v(lb)}`, en: `proceeds counted toward the exemption limit are ${v(lb)}` })); }
      s = cap(bits.join(lang === 'en' ? '; ' : ', '));
    }
    if (u) {
      used.add(u);
      s = s ? `${s}${pick(lang, u.value ? { cs: ', takže jsi pod limitem', sk: ', takže si pod limitom', en: ', so you are under the limit' }
        : { cs: ', takže pod limitem nejsi', sk: ', takže pod limitom nie si', en: ', so you are not under the limit' })}`
        : pick(lang, u.value ? { cs: 'Příjmy z prodejů jsou pod limitem pro osvobození', sk: 'Príjmy z predajov sú pod limitom na oslobodenie', en: 'Sale proceeds are under the exemption limit' }
          : { cs: 'Příjmy z prodejů nejsou pod limitem pro osvobození', sk: 'Príjmy z predajov nie sú pod limitom na oslobodenie', en: 'Sale proceeds are not under the exemption limit' });
      s += q(u);
    }
    if (s) out.push(`${s}.`);
    return out;
  },

  dividends(t, { lang, today, v, used }) {
    const [received, count, gross, net, withheld, forecast, next] = ['received', 'count', 'gross', 'net', 'withheld', 'forecast_annual', 'next_pay_date'].map(k => t.facts.get(k));
    const out: string[] = [];
    if (received && num(received) !== null) {
      used.add(received);
      const opener = periodOpener(received.period, lang, today);
      const lead = opener ? lang === 'en' ? `${opener}, you` : `${opener} ti` : lang === 'en' ? 'You' : 'Ti';
      if (received.value === 0) {
        if (count && count.value === 0) used.add(count);
        out.push(pick(lang, { cs: `${lead} nepřišly žádné dividendy.`, sk: `${lead} neprišli žiadne dividendy.`, en: `${lead} received no dividends.` }));
      } else {
        let s = pick(lang, { cs: `${lead} přišly dividendy ${v(received)}`, sk: `${lead} prišli dividendy ${v(received)}`, en: `${lead} received dividends of ${v(received)}` });
        if (count && num(count) !== null) {
          used.add(count);
          s += lang === 'en' ? `, ${v(count)} ${noun('payment', count, lang)} in total` : `, ${pick(lang, { cs: 'celkem', sk: 'spolu', en: '' })} ${v(count)} ${noun('payment', count, lang)}`;
        }
        out.push(`${s}.`);
      }
    }
    const split = ([[gross, { cs: 'hrubé dividendy byly', sk: 'hrubé dividendy boli', en: 'gross dividends were' }], [withheld, { cs: 'sražená daň', sk: 'zrazená daň', en: 'tax withheld' }],
      [net, { cs: 'čisté dividendy', sk: 'čisté dividendy', en: 'net dividends' }]] as [Fact | undefined, T3][]).filter(([f]) => f && num(f) !== null);
    if (split.length) { split.forEach(([f]) => used.add(f!)); out.push(`${cap(list(split.map(([f, w]) => `${w[lang]} ${v(f!)}`), lang))}.`); }
    if (forecast && num(forecast) !== null) { used.add(forecast); out.push(pick(lang, { cs: `Roční odhad dividend je ${v(forecast)}.`, sk: `Ročný odhad dividend je ${v(forecast)}.`, en: `The annual dividend estimate is ${v(forecast)}.` })); }
    if (next && formatFact(next, lang)) { used.add(next); out.push(pick(lang, { cs: `Příští výplata dividendy bude ${v(next)}.`, sk: `Najbližšia výplata dividendy bude ${v(next)}.`, en: `The next dividend payment is on ${v(next)}.` })); }
    return out;
  },

  quote(t, { lang, v, used }) {
    const [price, prev, change] = ['price', 'previous_close', 'change_pct'].map(k => t.facts.get(k)).map(f => f && num(f) !== null ? f : undefined);
    const parts: string[] = [];
    if (price) { used.add(price); parts.push(pick(lang, { cs: `cena ${t.ticker} je ${v(price)}`, sk: `cena ${t.ticker} je ${v(price)}`, en: `the ${t.ticker} price is ${v(price)}` })); }
    if (prev) { used.add(prev); parts.push(pick(lang, { cs: `předchozí zavírací cena${price ? '' : ` ${t.ticker}`} byla ${v(prev)}`, sk: `predchádzajúca záverečná cena${price ? '' : ` ${t.ticker}`} bola ${v(prev)}`, en: `the previous${price ? '' : ` ${t.ticker}`} close was ${v(prev)}` })); }
    if (change) { used.add(change); parts.push(pick(lang, { cs: `dnešní změna${parts.length ? '' : ` ${t.ticker}`} je ${v(change)}`, sk: `dnešná zmena${parts.length ? '' : ` ${t.ticker}`} je ${v(change)}`, en: `today's${parts.length ? '' : ` ${t.ticker}`} change is ${v(change)}` })); }
    return parts.length ? [`${cap(list(parts, lang))}.`] : [];
  },

  pricemove(t, { lang, today, v, used }) {
    // "Od 16. 10. 2026 do 22. 10. 2026 se cena SYNA změnila o +4,2 %." — the last days next to today's quote.
    const f = t.facts.get('change_pct');
    if (!f || num(f) === null) return [];
    used.add(f);
    const opener = periodOpener(f.period, lang, today) ?? pick(lang, { cs: 'Za sledované období', sk: 'Za sledované obdobie', en: 'Over the period' });
    const change = `${num(f)! > 0 ? '+' : ''}${v(f)}`;
    return [t.ticker === 'SPX' ? pick(lang, { cs: `${opener} se index S&P 500 změnil o ${change}.`, sk: `${opener} sa index S&P 500 zmenil o ${change}.`,
      en: `${opener}, the S&P 500 changed by ${change}.` })
      : pick(lang, { cs: `${opener} se cena ${t.ticker} změnila o ${change}.`, sk: `${opener} sa cena ${t.ticker} zmenila o ${change}.`,
        en: `${opener}, the ${t.ticker} price changed by ${change}.` })];
  },

  portfolio(t, { lang, v, used }) {
    const [total, cash, profit, unrealized, count, deposits, usdCzk, usdLocal] = ['total_value', 'cash', 'total_profit', 'unrealized_profit', 'holding_count', 'net_deposits', 'usd_czk', 'usd_local']
      .map(k => t.facts.get(k)).map(f => f && num(f) !== null ? f : undefined);
    const out: string[] = [];
    let totalSaid = false;
    if (count && count.value === 0 && count.quality?.state === 'complete') {
      used.add(count);
      let s = S.empty[lang].replace(/\.$/, '');
      if (total) { used.add(total); totalSaid = true; s += pick(lang, { cs: `, hodnota portfolia je ${v(total)}`, sk: `, hodnota portfólia je ${v(total)}`, en: `, so your portfolio is worth ${v(total)}` }); }
      out.push(`${s}.`);
    } else if (count) {
      used.add(count);
      out.push(pick(lang, { cs: `Držíš ${v(count)} ${noun('position', count, lang)}.`, sk: `Držíš ${v(count)} ${noun('position', count, lang)}.`, en: `You hold ${v(count)} ${noun('position', count, lang)}.` }));
    }
    if (total && !totalSaid) {
      used.add(total);
      let s = pick(lang, { cs: `Tvoje portfolio má hodnotu ${v(total)}`, sk: `Tvoje portfólio má hodnotu ${v(total)}`, en: `Your portfolio is worth ${v(total)}` });
      if (cash) { used.add(cash); s += pick(lang, { cs: `, z toho hotovost ${v(cash)}`, sk: `, z toho hotovosť ${v(cash)}`, en: `, of which cash is ${v(cash)}` }); }
      out.push(`${s}.`);
    } else if (cash) {
      used.add(cash);
      out.push(pick(lang, { cs: `Hotovost máš ${v(cash)}.`, sk: `Hotovosť máš ${v(cash)}.`, en: `Your cash is ${v(cash)}.` }));
    }
    const gainOrLoss = (f: Fact, kind: 'total' | 'unrealized') => {
      const loss = num(f)! < 0;
      return pick(lang, kind === 'total'
        ? loss ? { cs: `celková ztráta je ${v(f, true)}`, sk: `celková strata je ${v(f, true)}`, en: `your total loss is ${v(f, true)}` }
          : { cs: `celkový zisk je ${v(f)}`, sk: `celkový zisk je ${v(f)}`, en: `your total profit is ${v(f)}` }
        : loss ? { cs: `nerealizovaná ztráta ${v(f, true)}`, sk: `nerealizovaná strata ${v(f, true)}`, en: `an unrealized loss of ${v(f, true)}` }
          : { cs: `nerealizovaný zisk ${v(f)}`, sk: `nerealizovaný zisk ${v(f)}`, en: `an unrealized profit of ${v(f)}` });
    };
    if (profit) {
      used.add(profit);
      let s = gainOrLoss(profit, 'total');
      if (unrealized) {
        used.add(unrealized);
        const same = (num(profit)! < 0) === (num(unrealized)! < 0);
        s += lang === 'en' ? same ? `, of which ${v(unrealized, num(unrealized)! < 0)} is unrealized` : `, with ${gainOrLoss(unrealized, 'unrealized')}`
          : `${same ? `, ${pick(lang, { cs: 'z toho', sk: 'z toho', en: '' })}` : ` ${pick(lang, { cs: 'a', sk: 'a', en: '' })}`} ${gainOrLoss(unrealized, 'unrealized')}`;
      }
      out.push(`${cap(s)}.`);
    } else if (unrealized) {
      used.add(unrealized);
      out.push(lang === 'en' ? `You have ${gainOrLoss(unrealized, 'unrealized')}.` : `${cap(gainOrLoss(unrealized, 'unrealized').replace(/ (?=[-−\d])/, pick(lang, { cs: ' je ', sk: ' je ', en: ' ' })))}.`);
    }
    if (deposits) { used.add(deposits); out.push(pick(lang, { cs: `Čisté vklady jsou ${v(deposits)}.`, sk: `Čisté vklady sú ${v(deposits)}.`, en: `Net deposits are ${v(deposits)}.` })); }
    if (usdCzk) { used.add(usdCzk); out.push(pick(lang, { cs: `Kurz USD/CZK je ${v(usdCzk)}.`, sk: `Kurz USD/CZK je ${v(usdCzk)}.`, en: `The USD/CZK exchange rate is ${v(usdCzk)}.` })); }
    if (usdLocal) {
      used.add(usdLocal);
      // The local-currency rate is the same rate for a CZK user; say it once.
      if (!usdCzk || formatFact(usdCzk, lang) !== formatFact(usdLocal, lang)) {
        out.push(pick(lang, { cs: `Kurz USD k místní měně je ${v(usdLocal)}.`, sk: `Kurz USD k miestnej mene je ${v(usdLocal)}.`, en: `The USD exchange rate to your local currency is ${v(usdLocal)}.` }));
      }
    }
    return out;
  },

  holding(t, { lang, v, used }) {
    // All positions in one sentence ("Držíš 10 kusů SYNA v hodnotě … a 5 kusů SYNB …"); cash is cash, not units.
    const tickers = [...new Set([...t.facts.keys()].map(k => k.split(':')[0]))];
    const clauses: string[] = [], out: string[] = [];
    for (const ticker of tickers) {
      const [shares, value, profit, allocation] = ['shares', 'value', 'profit', 'allocation'].map(k => t.facts.get(`${ticker}:${k}`))
        .map(f => f && num(f) !== null ? f : undefined);
      if (ticker === 'CASH') {
        if (!value) continue;
        [shares, value].forEach(f => f && used.add(f));
        out.push(pick(lang, { cs: `Hotovost má hodnotu ${v(value)}.`, sk: `Hotovosť má hodnotu ${v(value)}.`, en: `Your cash is worth ${v(value)}.` }));
        continue;
      }
      if (!shares) continue;
      used.add(shares);
      let c = pick(lang, { cs: `${v(shares)} ${noun('unit', shares, lang)} ${ticker}`, sk: `${v(shares)} ${noun('unit', shares, lang)} ${ticker}`,
        en: `${v(shares)} ${noun('unit', shares, lang)} of ${ticker}` });
      if (value) { used.add(value); c += pick(lang, { cs: ` v hodnotě ${v(value)}`, sk: ` v hodnote ${v(value)}`, en: ` worth ${v(value)}` }); }
      if (profit) {
        used.add(profit);
        c += num(profit)! < 0 ? pick(lang, { cs: ` se ztrátou ${v(profit, true)}`, sk: ` so stratou ${v(profit, true)}`, en: ` with a loss of ${v(profit, true)}` })
          : pick(lang, { cs: ` se ziskem ${v(profit)}`, sk: ` so ziskom ${v(profit)}`, en: ` with a profit of ${v(profit)}` });
      }
      if (allocation) { used.add(allocation); c += pick(lang, { cs: ` – podíl ${v(allocation)}`, sk: ` – podiel ${v(allocation)}`, en: ` – a share of ${v(allocation)}` }); }
      clauses.push(c);
    }
    return [...(clauses.length ? [`${pick(lang, { cs: 'Držíš', sk: 'Držíš', en: 'You hold' })} ${list(clauses, lang)}.`] : []), ...out];
  },

  movers(t, { lang, q, used }) {
    // "Dnes se hodnota tvého portfolia změnila o +25,01 USD (+0,8 %)." then one line per mover, largest absolute change first.
    const signed = (f: Fact) => `${num(f)! > 0 ? '+' : ''}${formatFact(f, lang) ?? ''}`;
    const out: string[] = [];
    const total = t.facts.get(':day_change'), totalPct = t.facts.get(':day_change_pct');
    if (total && num(total) !== null) {
      used.add(total);
      let s = `${pick(lang, { cs: 'Dnes se hodnota tvého portfolia změnila o', sk: 'Dnes sa hodnota tvojho portfólia zmenila o', en: 'Today your portfolio value changed by' })} ${signed(total)}${q(total)}`;
      if (totalPct && num(totalPct) !== null) { used.add(totalPct); s += ` (${signed(totalPct)}${q(totalPct).replace(/^ \((.*)\)$/, '; $1')})`; }
      out.push(`${s}.`);
    }
    const rows = [...new Set([...t.facts.keys()].map(k => k.split(':')[0]).filter(Boolean))]
      .map(ticker => ({ ticker, change: t.facts.get(`${ticker}:day_change`), pct: t.facts.get(`${ticker}:day_change_pct`) }))
      .filter(r => r.change && num(r.change) !== null && r.pct && num(r.pct) !== null)
      .sort((a, b) => Math.abs(num(b.change!)!) - Math.abs(num(a.change!)!));
    if (rows.length) {
      const lines = rows.map(({ ticker, change, pct }) => {
        used.add(change!); used.add(pct!);
        const notes = [...new Set([q(pct!), q(change!)].filter(Boolean))].join('');
        return `• ${ticker}: ${pick(lang, { cs: 'změna', sk: 'zmena', en: 'change' })} ${signed(pct!)} (${signed(change!)})${notes}.`;
      });
      out.push(`${pick(lang, { cs: 'Největší dnešní změny:', sk: 'Najväčšie dnešné zmeny:', en: 'Today\'s biggest moves:' })}\n${lines.join('\n')}`);
    }
    return out;
  },

  performance(t, { lang, today, v, used }) {
    const [ret, annual, profit, bench, benchAnnual] = ['portfolio_return', 'annual_return', 'profit', 'benchmark_return', 'benchmark_annual_return']
      .map(k => t.facts.get(k)).map(f => f && num(f) !== null ? f : undefined);
    const out: string[] = [];
    const opener = periodOpener((ret ?? profit)?.period, lang, today);
    if (ret || profit) {
      const lead = opener ? lang === 'en' ? `${opener}, ` : `${opener} ` : '';
      let s = '';
      if (ret) { used.add(ret); s = pick(lang, { cs: `${lead}má tvoje portfolio výnos ${v(ret)}`, sk: `${lead}má tvoje portfólio výnos ${v(ret)}`, en: `${lead}your portfolio returned ${v(ret)}` }); }
      if (profit) {
        used.add(profit);
        const loss = num(profit)! < 0;
        s += ret ? pick(lang, loss ? { cs: ` a ztrátu ${v(profit, true)}`, sk: ` a stratu ${v(profit, true)}`, en: ` with a loss of ${v(profit, true)}` }
          : { cs: ` a zisk ${v(profit)}`, sk: ` a zisk ${v(profit)}`, en: ` with a profit of ${v(profit)}` })
          : pick(lang, loss ? { cs: `${lead}máš ztrátu ${v(profit, true)}`, sk: `${lead}máš stratu ${v(profit, true)}`, en: `${lead}you have a loss of ${v(profit, true)}` }
            : { cs: `${lead}máš zisk ${v(profit)}`, sk: `${lead}máš zisk ${v(profit)}`, en: `${lead}you have a profit of ${v(profit)}` });
      }
      out.push(`${cap(s)}.`);
    }
    if (annual) { used.add(annual); out.push(pick(lang, { cs: `V přepočtu na rok je výnos ${v(annual)}.`, sk: `V prepočte na rok je výnos ${v(annual)}.`, en: `Annualized, the return is ${v(annual)}.` })); }
    if (bench) {
      used.add(bench);
      let s = pick(lang, { cs: `Index S&P 500 měl za stejné období výnos ${v(bench)}`, sk: `Index S&P 500 mal za rovnaké obdobie výnos ${v(bench)}`, en: `The S&P 500 returned ${v(bench)} over the same period` });
      if (benchAnnual) { used.add(benchAnnual); s += pick(lang, { cs: `, v přepočtu na rok ${v(benchAnnual)}`, sk: `, v prepočte na rok ${v(benchAnnual)}`, en: `, ${v(benchAnnual)} annualized` }); }
      out.push(`${s}.`);
    }
    return out;
  },

  allocation(t, { lang, v, used }) {
    const out: string[] = [];
    const DIMENSIONS: [string, T3][] = [['sector', { cs: 'sektorů', sk: 'sektorov', en: 'sector' }], ['asset_type', { cs: 'druhu aktiv', sk: 'druhu aktív', en: 'asset type' }],
      ['currency', { cs: 'měny kotace', sk: 'meny kotácie', en: 'quote currency' }]];
    for (const [dimension, name] of DIMENSIONS) {
      const items = [...t.facts].filter(([k, f]) => k.startsWith(`${dimension}:`) && num(f) !== null && /^[\p{L}\p{N}_-]+$/u.test(k.slice(dimension.length + 1)));
      if (!items.length) continue;
      items.forEach(([, f]) => used.add(f));
      out.push(`${pick(lang, { cs: 'Podíl podle', sk: 'Podiel podľa', en: 'Allocation by' })} ${name[lang]}: ${items.map(([k, f]) => `${k.slice(dimension.length + 1).replace(/[_-]/g, ' ')} ${v(f)}`).join(', ')}.`);
    }
    const hhi = t.facts.get('hhi'), invested = t.facts.get('invested');
    if (hhi && num(hhi) !== null) { used.add(hhi); out.push(pick(lang, { cs: `Koncentrace portfolia je ${v(hhi)}.`, sk: `Koncentrácia portfólia je ${v(hhi)}.`, en: `Portfolio concentration is ${v(hhi)}.` })); }
    if (invested && num(invested) !== null) { used.add(invested); out.push(pick(lang, { cs: `Investovaná částka je ${v(invested)}.`, sk: `Investovaná suma je ${v(invested)}.`, en: `The invested amount is ${v(invested)}.` })); }
    return out;
  },

  lots(t, { lang, v, used }) {
    const out: string[] = [];
    const count = t.facts.get('count'), shares = t.facts.get('shares');
    if (count && num(count) !== null) {
      used.add(count);
      let s = pick(lang, { cs: `Máš ${v(count)} ${noun('lot', count, lang)}`, sk: `Máš ${v(count)} ${noun('lot', count, lang)}`, en: `You have ${v(count)} ${noun('lot', count, lang)}` });
      if (shares && num(shares) !== null) {
        used.add(shares);
        s += lang === 'en' ? ` with ${v(shares)} ${noun('unit', shares, lang)} in total` : `, ${pick(lang, { cs: 'celkem', sk: 'spolu', en: '' })} ${v(shares)} ${noun('unit', shares, lang)}`;
      }
      out.push(`${s}.`);
    }
    return out;
  },

  sale(t, { lang, v, used }) {
    const g = (k: string) => { const f = t.facts.get(k); return f && formatFact(f, lang) !== null ? f : undefined; };
    const [shares, price, fee, date, fx, proceeds, gain, taxable, extra, after, missing] =
      ['shares', 'price', 'fee', 'date', 'sale_fx', 'proceeds', 'gain', 'taxable_gain', 'extra_tax', 'estimated_tax_after', 'missing_shares'].map(g);
    const fxRate = fx ?? g('assumed_local_fx'), extraTax = extra ?? g('tax_delta');
    if (!shares) return [];
    const out: string[] = [];
    const T = t.ticker;
    used.add(shares);
    let s = pick(lang, { cs: `Kdybys${date ? ` ${v(date)}` : ''} prodal ${v(shares)} ${noun('unit', shares, lang)} ${T}`,
      sk: `Keby si${date ? ` ${v(date)}` : ''} predal ${v(shares)} ${noun('unit', shares, lang)} ${T}`,
      en: `If you sold ${v(shares)} ${noun('unit', shares, lang)} of ${T}${date ? ` on ${v(date)}` : ''}` });
    if (date) used.add(date);
    if (price) { used.add(price); s += pick(lang, { cs: ` za cenu ${v(price)} za kus`, sk: ` za cenu ${v(price)} za kus`, en: ` at a price of ${v(price)} per unit` }); }
    if (fee) { used.add(fee); s += pick(lang, { cs: ` s poplatkem ${v(fee)}`, sk: ` s poplatkom ${v(fee)}`, en: ` with a fee of ${v(fee)}` }); }
    if (proceeds) { used.add(proceeds); s += pick(lang, { cs: `, příjem z prodeje by byl ${v(proceeds)}`, sk: `, príjem z predaja by bol ${v(proceeds)}`, en: `, the sale proceeds would be ${v(proceeds)}` }); }
    if (fxRate) { used.add(fxRate); s += pick(lang, { cs: ` při kurzu ${v(fxRate)}`, sk: ` pri kurze ${v(fxRate)}`, en: ` at an exchange rate of ${v(fxRate)}` }); }
    out.push(`${s}.`);
    const parts: string[] = [];
    if (gain) {
      used.add(gain);
      parts.push(num(gain)! < 0 ? pick(lang, { cs: `ztráta z prodeje by byla ${v(gain, true)}`, sk: `strata z predaja by bola ${v(gain, true)}`, en: `the loss on the sale would be ${v(gain, true)}` })
        : pick(lang, { cs: `zisk z prodeje by byl ${v(gain)}`, sk: `zisk z predaja by bol ${v(gain)}`, en: `the gain on the sale would be ${v(gain)}` }));
    }
    if (taxable) { used.add(taxable); parts.push(pick(lang, { cs: `zdanitelný zisk ${v(taxable)}`, sk: `zdaniteľný zisk ${v(taxable)}`, en: `the taxable gain ${v(taxable)}` })); }
    if (extraTax) { used.add(extraTax); parts.push(pick(lang, { cs: `daň navíc ${v(extraTax)}`, sk: `daň navyše ${v(extraTax)}`, en: `the extra tax ${v(extraTax)}` })); }
    if (parts.length) out.push(`${cap(list(parts, lang))}.`);
    if (after) { used.add(after); out.push(pick(lang, { cs: `Celkový odhad daně po prodeji by byl ${v(after)}.`, sk: `Celkový odhad dane po predaji by bol ${v(after)}.`, en: `The total estimated tax after the sale would be ${v(after)}.` })); }
    if (missing && num(missing) !== null) {
      used.add(missing);
      if (missing.value !== 0) out.push(pick(lang, { cs: `K takovému prodeji ti chybí ${v(missing)} ${noun('unit', missing, lang)}.`, sk: `Na taký predaj ti chýba ${v(missing)} ${noun('unit', missing, lang)}.`,
        en: `You are ${v(missing)} ${noun('unit', missing, lang)} short for this sale.` }));
    }
    return out;
  },
};

/** One lot per line: "• SYNA (lot 1): 4 kusy, nakoupeno 1. 3. 2024, osvobození od 2. 3. 2027, časový test zatím nesplněn." */
function lotLines(facts: Fact[], lang: Lang, v: Say['v'], q: Say['q'], used: Set<Fact>): string[] {
  const lots = new Map<string, Map<string, Fact>>();
  for (const f of facts) {
    const m = /^lots:lot_(\d+):(shares|acquired|exempt_date|exempt)$/.exec((f.metric ?? f.id).split('#')[0]);
    if (m) (lots.get(m[1]) ?? lots.set(m[1], new Map()).get(m[1])!).set(m[2], f);
  }
  return [...lots].flatMap(([n, l]) => {
    const shares = l.get('shares');
    if (!shares || num(shares) === null) return [];
    const bits = [`${v(shares)} ${noun('unit', shares, lang)}`];
    used.add(shares);
    const acquired = l.get('acquired'), exemptDate = l.get('exempt_date'), exempt = l.get('exempt');
    if (acquired && formatFact(acquired, lang)) { used.add(acquired); bits.push(`${pick(lang, { cs: 'nakoupeno', sk: 'nakúpené', en: 'bought' })} ${v(acquired)}`); }
    if (exemptDate && formatFact(exemptDate, lang)) { used.add(exemptDate); bits.push(`${pick(lang, { cs: 'osvobození od', sk: 'oslobodenie od', en: 'exempt from' })} ${v(exemptDate)}`); }
    if (exempt && typeof exempt.value === 'boolean') {
      used.add(exempt);
      bits.push(`${pick(lang, exempt.value ? { cs: 'časový test splněn', sk: 'časový test splnený', en: 'time test met' }
        : { cs: 'časový test zatím nesplněn', sk: 'časový test zatiaľ nesplnený', en: 'time test not met yet' })}${q(exempt)}`);
    }
    return [`• ${shares.ticker ?? ''} (lot ${n}): ${bits.join(', ')}.`.replace(/^• \s+/, '• ')];
  });
}

/** Short sentences for a fact selection, in the order of the topics' first facts. */
export function phraseFacts(facts: readonly Fact[], lang: Lang, today?: string): string {
  // The same datum from two results (e.g. the holding count of summary and holdings) is said once.
  const unique: Fact[] = [];
  const keyOf = (f: Fact) => (f.metric ?? f.id).split('#')[0];
  for (const f of facts) {
    if (!unique.some(u => u === f || (keyOf(u) === keyOf(f) && u.value === f.value && JSON.stringify(u.period ?? null) === JSON.stringify(f.period ?? null)
      && u.scope === f.scope && u.quality?.state === f.quality?.state))) unique.push(f);
  }
  const topics = new Map<string, Topic>();
  for (const f of unique) {
    const key = keyOf(f);
    const found = TOPICS.map(([kind, re]) => [kind, re.exec(key)] as const).find(([, m]) => m);
    const kind = found?.[0] ?? 'label', group = found?.[1]?.[1] ?? '';
    // Realized results are per year and ticker; all lots form one list; the rest is per ticker/year of the key.
    const ticker = kind === 'realized' ? f.ticker : kind === 'lots' && /^lot_\d+$/.test(group) ? 'lot' : group || undefined;
    const perPosition = kind === 'holding' || kind === 'movers';
    const id = kind === 'label' ? 'label' : `${kind}|${perPosition ? '' : group}|${perPosition ? '' : ticker ?? ''}|${JSON.stringify(f.period ?? null)}|${f.scope ?? ''}`
      .replace(/^lots\|lot_\d+\|/, 'lots|lot|');
    const topic = topics.get(id) ?? topics.set(id, { kind, ticker, facts: new Map() }).get(id)!;
    // Positions share one topic, keyed by ticker.
    const suffix = perPosition ? `${group}:${found![1]![2]}` : found?.[1]?.[2] ?? key;
    topic.facts.set(topic.facts.has(suffix) ? `${suffix}#${topic.facts.size}` : suffix, f);
  }
  const lines: string[] = [];
  for (const topic of topics.values()) {
    const all = [...topic.facts.values()];
    // A qualification shared by every number of a topic is said once, after its sentences.
    const shared = all.length > 1 ? factNotes(all[0], lang, false).filter(n => all.every(f => factNotes(f, lang, false).some(m => m.key === n.key))) : [];
    const used = new Set<Fact>();
    const q = (f: Fact) => {
      const own = factNotes(f, lang, false).filter(n => !shared.some(s => s.key === n.key)).map(n => n.inline);
      return own.length ? ` (${own.join('; ')})` : '';
    };
    const v = (f: Fact, abs = false) => `${formatFact(abs && typeof f.value === 'number' ? { ...f, value: Math.abs(f.value) } : f, lang) ?? ''}${q(f)}`;
    const lotList = topic.kind === 'lots' && topic.ticker === 'lot';
    const sentences = lotList ? [] : PHRASES[topic.kind]?.(topic, { lang, today, v, q, used }) ?? [];
    const lotText = lotList ? lotLines(all, lang, v, q, used) : [];
    // Without any phrased fact the shared qualification stays with each labelled value.
    const rest = all.filter(f => !used.has(f)).map(f => {
      const notes = factNotes(f, lang, true).filter(n => !used.size || !shared.some(s => s.key === n.key)).map(n => n.inline);
      return `${cap(factLabel(f, lang))}: ${formatFact(f, lang) ?? ''}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
    });
    const notes = used.size ? shared.map(n => n.sentence) : [];
    lines.push(lotText.length ? [[...sentences, ...rest].join(' '), ...lotText, notes.join(' ')].filter(Boolean).join('\n')
      : [...sentences, ...rest, ...notes].join(' '));
  }
  return lines.filter(Boolean).join('\n');
}

/* ----------------------------- verdict policy ----------------------------- */

const RANK: readonly Confidence[] = ['low', 'medium', 'high'];
const lower = (a: Confidence, b: Confidence) => RANK[Math.min(RANK.indexOf(a), RANK.indexOf(b))];
export type AnalysisPolicy = { verdict: Verdict; maxConfidence: Confidence; confidence: Confidence; basis: 'fair_value' | 'analysts' | 'none';
  ratio: Fact | null; deviation: Fact | null; missing: ('price' | 'valuation' | 'analysts')[]; conflict: boolean; stale: boolean; relativeOnly: boolean; incomplete: boolean };

/** The newest fact registered under a key in this request (`key` or `key#n`). */
export function factByKey(ctx: ToolCtx, key: string): Fact | undefined {
  let found: Fact | undefined;
  for (const [id, fact] of ctx.facts) if (id === key || id.startsWith(`${key}#`)) found = fact;
  return found;
}
const numeric = (f: Fact | undefined): f is Fact & { value: number } => !!f && typeof f.value === 'number' && Number.isFinite(f.value);

/** The same calculation is recorded once per request. */
export function calcOnce(ctx: ToolCtx, op: 'divide' | 'percentChange', inputs: Fact[]): Fact | null {
  const ids = inputs.map(f => f.id);
  const existing = ctx.calculations.find(r => r.op === op && r.inputs.length === ids.length && r.inputs.every((f, i) => f.id === ids[i]));
  if (existing) return existing.result;
  const result = calculate({ op, inputs: ids }, ctx);
  return result.ok ? result.data.result : null;
}

/**
 * Deterministic buy-analysis verdict: fair value / price > 1.15 rather attractive, < 0.85 rather
 * expensive, otherwise fairly valued — a labelled valuation assumption, not a promised return.
 * Without a fair value only a conditional low-confidence view from the analysts' target; without a
 * usable price or valuation, insufficient data.
 */
export function analysisPolicy(ctx: ToolCtx, evidence: AnalysisEvidence): AnalysisPolicy {
  const t = evidence.ticker;
  const price = evidence.quote.ok ? evidence.quote.facts.find(f => f.metric === `quote:${t}:price`) : undefined;
  const fair = evidence.fairValue.ok ? evidence.fairValue.facts.find(f => f.metric === `fair_value:${t}:value`) : undefined;
  const target = evidence.analysts.ok ? evidence.analysts.facts.find(f => f.metric === `analysts:${t}:target_mean`) : undefined;
  const missing: AnalysisPolicy['missing'] = [];
  if (!numeric(price) || !price.currency || price.value <= 0) missing.push('price');
  if (!numeric(fair) || !fair.currency || fair.currency !== price?.currency) missing.push('valuation');
  if (!numeric(target) || !target.currency || target.currency !== price?.currency) missing.push('analysts');
  const results = Object.values(evidence).filter((r): r is AnalysisEvidence['quote'] => typeof r === 'object');
  const stale = results.some(r => r.ok && r.meta.freshness !== 'fresh');
  const incomplete = results.some(r => !r.ok || !r.meta.complete)
    || [price, fair, target].some(f => f && f.quality?.state !== 'complete');
  const fv = evidence.fairValue.ok ? evidence.fairValue.data as { relativeOnly?: boolean; usableCount?: number } : null;
  const relativeOnly = !!fv?.relativeOnly;
  const verdictOf = (ratio: number): Verdict => ratio > 1.15 ? 'attractive' : ratio < 0.85 ? 'expensive' : 'fair';
  const none: AnalysisPolicy = { verdict: 'insufficient', maxConfidence: 'low', confidence: 'low', basis: 'none', ratio: null, deviation: null, missing, conflict: false, stale, relativeOnly, incomplete };
  if (!numeric(price) || missing.includes('price')) return none;
  if (numeric(fair) && fair.currency === price.currency) {
    const ratio = calcOnce(ctx, 'divide', [fair, price]), deviation = calcOnce(ctx, 'percentChange', [price, fair]);
    if (!numeric(ratio ?? undefined)) return none;
    const verdict = verdictOf(ratio!.value as number);
    const upside = numeric(target) && target.currency === price.currency ? target.value / price.value : null;
    const conflict = upside !== null && ((verdict === 'attractive' && upside < 0.95) || (verdict === 'expensive' && upside > 1.05));
    const supported = upside !== null && (verdict === 'attractive' ? upside > 1.05 : verdict === 'expensive' ? upside < 0.95 : upside >= 0.95 && upside <= 1.05);
    let max: Confidence = 'high';
    if (!supported || (fv?.usableCount ?? 3) < 3) max = 'medium';
    if (conflict || stale || relativeOnly || incomplete) max = 'low';
    return { verdict, maxConfidence: max, confidence: lower(max, 'medium'), basis: 'fair_value', ratio, deviation, missing, conflict, stale, relativeOnly, incomplete };
  }
  if (numeric(target) && target.currency === price.currency) {
    const ratio = calcOnce(ctx, 'divide', [target, price]), deviation = calcOnce(ctx, 'percentChange', [price, target]);
    if (!numeric(ratio ?? undefined)) return none;
    return { verdict: verdictOf(ratio!.value as number), maxConfidence: 'low', confidence: 'low', basis: 'analysts', ratio, deviation, missing, conflict: false, stale, relativeOnly, incomplete };
  }
  return none;
}

/* ----------------------------- opinion (buy questions) ----------------------------- */

// The assistant's own view from the data it has: a clear stance on the price (buy more, wait, not at this valuation),
// what the business numbers say, timing and concentration. Every figure is a fact; the stance is a labelled opinion.
const O = {
  attractive: { cs: 'Za tuhle cenu mi to z dat vychází jako rozumná příležitost k přikoupení: férová hodnota modelu je o {{u}} nad cenou.',
    sk: 'Za túto cenu mi to z údajov vychádza ako rozumná príležitosť na prikúpenie: férová hodnota modelu je o {{u}} nad cenou.',
    en: 'At this price the data point to a reasonable chance to buy more: the model\'s fair value is {{u}} above the price.' },
  attractiveWeak: { cs: 'Cena vypadá vůči modelu levně (férová hodnota o {{u}} výš), ale byznys zatím nevydělává, takže bych přikupoval jen opatrně a po menších částech.',
    sk: 'Cena vyzerá voči modelu lacno (férová hodnota o {{u}} vyššie), ale biznis zatiaľ nezarába, takže by som prikupoval len opatrne a po menších častiach.',
    en: 'The price looks cheap against the model (fair value {{u}} higher), but the business does not make money yet, so I would only add carefully in small steps.' },
  fair: { cs: 'Za současnou cenu to podle mě není výhodný nákup ani přepálená cena – je zhruba férová. Ve velkém bych nepřikupoval; dává smysl počkat na lepší cenu nebo přikupovat po menších částech.',
    sk: 'Za súčasnú cenu to podľa mňa nie je výhodný nákup ani prepálená cena – je zhruba férová. Vo veľkom by som neprikupoval; dáva zmysel počkať na lepšiu cenu alebo prikupovať po menších častiach.',
    en: 'At the current price this is neither a bargain nor overpriced – it is about fair. I would not add a lot; waiting for a better price or adding in small steps makes sense.' },
  expensive: { cs: 'Na současné valuaci bych nepřikupoval: cena je o {{o}} nad férovou hodnotou modelu. Lepší je počkat na nižší cenu nebo na výsledky, které ocenění obhájí.',
    sk: 'Pri súčasnej valuácii by som neprikupoval: cena je o {{o}} nad férovou hodnotou modelu. Lepšie je počkať na nižšiu cenu alebo na výsledky, ktoré ocenenie obhája.',
    en: 'I would not buy more at the current valuation: the price is {{o}} above the model\'s fair value. Better to wait for a lower price or for results that justify it.' },
  analystsOnly: { cs: 'Vlastní ocenění teď nemám, takže se opírám jen o analytiky (průměrný cíl {{t}} při ceně {{p}}) – na jistý názor to nestačí.',
    sk: 'Vlastné ocenenie teraz nemám, takže sa opieram len o analytikov (priemerný cieľ {{t}} pri cene {{p}}) – na istý názor to nestačí.',
    en: 'I have no valuation of my own right now, so I lean on the analysts only (mean target {{t}} at a price of {{p}}) – not enough for a firm view.' },
  none: { cs: 'Bez spolehlivého ocenění si netroufám říct, jestli je cena dobrá.', sk: 'Bez spoľahlivého ocenenia si netrúfam povedať, či je cena dobrá.',
    en: 'Without a reliable valuation I will not say whether the price is good.' },
  businessStrong: { cs: 'Byznys vypadá zdravě: v posledním vykázaném roce je ziskový ({{ni}}) a vydělává hotovost (volný cash flow {{fcf}}).',
    sk: 'Biznis vyzerá zdravo: v poslednom vykázanom roku je ziskový ({{ni}}) a zarába hotovosť (voľný cash flow {{fcf}}).',
    en: 'The business looks healthy: profitable in the latest reported year ({{ni}}) and generating cash (free cash flow {{fcf}}).' },
  businessWeak: { cs: 'Byznys mi z čísel zatím nedává přesvědčivý smysl: v posledním vykázaném roce je ve ztrátě ({{ni}}) a pálí hotovost (volný cash flow {{fcf}}), takže stojí hlavně na očekávání budoucího růstu.',
    sk: 'Biznis mi z čísel zatiaľ nedáva presvedčivý zmysel: v poslednom vykázanom roku je v strate ({{ni}}) a páli hotovosť (voľný cash flow {{fcf}}), takže stojí hlavne na očakávaní budúceho rastu.',
    en: 'The business does not make a convincing case in the numbers yet: a loss in the latest reported year ({{ni}}) and cash burn (free cash flow {{fcf}}), so it rests mainly on hopes of future growth.' },
  runwayShort: { cs: 'Při tomhle tempu jí hotovost ({{c}}) nevystačí na dlouho, takže hrozí další ředění akcionářů.',
    sk: 'Pri tomto tempe jej hotovosť ({{c}}) nevystačí nadlho, takže hrozí ďalšie riedenie akcionárov.',
    en: 'At this pace its cash ({{c}}) will not last long, so further dilution of shareholders is likely.' },
  lossCashPositive: { cs: 'Účetně je v posledním vykázaném roce ve ztrátě ({{ni}}), ale hotovost už vydělává (volný cash flow {{fcf}}).',
    sk: 'Účtovne je v poslednom vykázanom roku v strate ({{ni}}), ale hotovosť už zarába (voľný cash flow {{fcf}}).',
    en: 'It reported a loss in the latest reported year ({{ni}}), but it already generates cash (free cash flow {{fcf}}).' },
  profitCashNegative: { cs: 'Účetně je ziskový ({{ni}}), ale hotovost zatím pálí (volný cash flow {{fcf}}) – vydělané peníze spolykají investice.',
    sk: 'Účtovne je ziskový ({{ni}}), ale hotovosť zatiaľ páli (voľný cash flow {{fcf}}) – zarobené peniaze zhltnú investície.',
    en: 'It is profitable on paper ({{ni}}) but still burns cash (free cash flow {{fcf}}) – investment swallows the earnings.' },
  fragile: { cs: 'Teď bych nepřikupoval: firma pálí hotovost a ta jí při tomhle tempu dlouho nevydrží, takže hrozí ředění, které může jakoukoli slevu v ceně smazat.',
    sk: 'Teraz by som neprikupoval: firma páli hotovosť a tá jej pri tomto tempe dlho nevydrží, takže hrozí riedenie, ktoré môže akúkoľvek zľavu v cene zmazať.',
    en: 'I would not buy more now: the company burns cash that will not last long at this pace, so dilution could wipe out any discount in the price.' },
  earningsSoon: { cs: 'Výsledky {{e}} můžou cenu výrazně pohnout – s větším nákupem bych počkal až po nich.',
    sk: 'Výsledky {{e}} môžu cenu výrazne pohnúť – s väčším nákupom by som počkal až po nich.',
    en: 'The results on {{e}} can move the price a lot – I would wait with a bigger purchase until after them.' },
  heavy: { cs: 'Pozice už je velká část tvého portfolia, takže bych další nákup zvažoval hlavně z pohledu rizika.',
    sk: 'Pozícia už je veľká časť tvojho portfólia, takže by som ďalší nákup zvažoval hlavne z pohľadu rizika.',
    en: 'The position is already a large part of your portfolio, so I would weigh another purchase mainly on risk.' },
  analystsHigher: { cs: 'Analytici jsou optimističtější (průměrný cíl {{a}}), já se ale držím ocenění z čísel firmy.',
    sk: 'Analytici sú optimistickejší (priemerný cieľ {{a}}), ja sa však držím ocenenia z čísel firmy.',
    en: 'The analysts are more optimistic (mean target {{a}}), but I stay with the valuation from the company\'s numbers.' },
  analystsBelowPrice: { cs: 'Potvrzují to i analytici: jejich průměrný cíl {{a}} je pod aktuální cenou.',
    sk: 'Potvrdzujú to aj analytici: ich priemerný cieľ {{a}} je pod aktuálnou cenou.',
    en: 'The analysts agree: their mean target of {{a}} is below the current price.' },
  analystsLower: { cs: 'Analytici jsou opatrnější (průměrný cíl {{a}}), to je důvod k větší opatrnosti.',
    sk: 'Analytici sú opatrnejší (priemerný cieľ {{a}}), to je dôvod na väčšiu opatrnosť.',
    en: 'The analysts are more cautious (mean target {{a}}), a reason for more care.' },
} satisfies Record<string, T3>;

type Business = 'strong' | 'weak' | 'loss_cash_positive' | 'profit_cash_negative' | 'unknown';
type BusinessView = { kind: Business; ni?: Fact; flow?: Fact; operating: boolean; cash?: Fact; shortRunway: boolean };
const amount = (fact: Fact | undefined) => (fact && typeof fact.value === 'number' ? fact.value : null);
const ending = (fact: Fact | undefined) => fact?.period?.to ?? fact?.as_of ?? '';
/**
 * What the latest reported statements say about the business. Free cash flow when reported, else operating cash flow
 * under its own name; the newest cash balance of either kind; statements older than 18 months say nothing about "now".
 */
function businessOf(f: (key: string) => Fact | undefined, today: string): BusinessView {
  const ni = f('fundamentals:{t}:annual:netIncome');
  const free = f('fundamentals:{t}:annual:freeCashFlow'), flow = free ?? f('fundamentals:{t}:annual:operatingCashFlow');
  const cash = [f('fundamentals:{t}:quarterly:cash'), f('fundamentals:{t}:annual:cash')].filter(c => amount(c) !== null && c?.currency === flow?.currency)
    .sort((a, b) => ending(b).localeCompare(ending(a)))[0];
  const n = amount(ni), c = amount(flow), k = amount(cash), operating = !free && !!flow;
  const unknown: BusinessView = { kind: 'unknown', operating, shortRunway: false };
  if (n === null || c === null || ni?.currency !== flow?.currency || !ending(ni) || daysBetween(ending(ni), today) > 550) return unknown;
  const shortRunway = c < 0 && k !== null && k < Math.abs(c) * 2;
  const view = { ni, flow, operating, cash, shortRunway };
  if (n > 0 && c > 0) return { kind: 'strong', ...view };
  if (n < 0 && c < 0) return { kind: 'weak', ...view };
  if (n < 0 && c > 0) return { kind: 'loss_cash_positive', ...view };
  if (n > 0 && c < 0) return { kind: 'profit_cash_negative', ...view };
  return unknown;
}
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
/** The sentence with "operating cash flow" in place of "free cash flow" when free cash flow is not reported. */
const flowWording = (sentence: T3, operating: boolean): T3 => !operating ? sentence : {
  cs: sentence.cs.replace('volný cash flow', 'provozní cash flow'), sk: sentence.sk.replace('voľný cash flow', 'prevádzkový cash flow'),
  en: sentence.en.replace('free cash flow', 'operating cash flow') };

/** The opinion sentences of a buy answer, in order: stance (price and business together), the business, timing, concentration, analysts. */
function opinionOf(ctx: ToolCtx, policy: AnalysisPolicy, f: (key: string) => Fact | undefined): [T3, Record<string, Fact | undefined>][] {
  const out: [T3, Record<string, Fact | undefined>][] = [];
  const price = f('quote:{t}:price'), fair = f('fair_value:{t}:value'), target = f('analysts:{t}:target_mean');
  const business = businessOf(f, ctx.today);
  // Burning cash that will not last decides the view whatever the model price says: dilution can erase any "discount".
  const fragile = (business.kind === 'weak' || business.kind === 'profit_cash_negative') && business.shortRunway;
  if (policy.basis === 'fair_value' && numeric(fair) && numeric(price)) {
    if (policy.verdict === 'expensive') out.push([O.expensive, { o: calcOnce(ctx, 'percentChange', [fair, price]) ?? undefined }]);
    else if (fragile) out.push([O.fragile, {}]);
    else if (policy.verdict === 'attractive') {
      out.push([business.kind === 'weak' ? O.attractiveWeak : O.attractive, { u: calcOnce(ctx, 'percentChange', [price, fair]) ?? undefined }]);
    } else out.push([O.fair, {}]);
  } else if (policy.basis === 'analysts') out.push([fragile ? O.fragile : O.analystsOnly, fragile ? {} : { t: target, p: price }]);
  else out.push([fragile ? O.fragile : O.none, {}]);
  const flow = { ni: business.ni, fcf: business.flow };
  if (business.kind === 'strong') out.push([flowWording(O.businessStrong, business.operating), flow]);
  if (business.kind === 'weak') out.push([flowWording(O.businessWeak, business.operating), flow]);
  if (business.kind === 'loss_cash_positive') out.push([flowWording(O.lossCashPositive, business.operating), flow]);
  if (business.kind === 'profit_cash_negative') out.push([flowWording(O.profitCashNegative, business.operating), flow]);
  if (business.shortRunway) out.push([O.runwayShort, { c: business.cash }]);
  const earnings = f('earnings:{t}:next_date');
  if (typeof earnings?.value === 'string') {
    const days = daysBetween(ctx.today, earnings.value);
    if (days >= 0 && days <= 21) out.push([O.earningsSoon, { e: earnings }]);
  }
  const weight = f('holding:{t}:allocation');
  if (typeof weight?.value === 'number' && weight.value >= 15) out.push([O.heavy, {}]);
  if (policy.basis === 'fair_value' && numeric(target) && numeric(price) && target.currency === price.currency) {
    const upside = target.value / price.value;
    if (policy.verdict !== 'attractive' && upside > 1.25) out.push([O.analystsHigher, { a: target }]);
    if (policy.verdict === 'attractive' && upside < 0.95) out.push([O.analystsLower, { a: target }]);
    if (policy.verdict === 'expensive' && upside < 1) out.push([O.analystsBelowPrice, { a: target }]);
  }
  return out;
}

/* ----------------------------- template ----------------------------- */

const S = {
  analystsTarget: { cs: 'Průměrná cílová cena analytiků je {{a}}.', sk: 'Priemerná cieľová cena analytikov je {{a}}.', en: 'The analysts\' mean price target is {{a}}.' },
  analystsRange: { cs: 'Nejvyšší cíl je {{h}}.', sk: 'Najvyšší cieľ je {{h}}.', en: 'The highest target is {{h}}.' },
  analystsLow: { cs: 'Nejnižší cíl je {{l}}.', sk: 'Najnižší cieľ je {{l}}.', en: 'The lowest target is {{l}}.' },
  analystsConsensus: { cs: 'Konsenzus: {{c}}.', sk: 'Konsenzus: {{c}}.', en: 'Consensus: {{c}}.' },
  analystsOpinion: { cs: 'Jde o názor analytiků, ne o fakt o budoucnosti.', sk: 'Ide o názor analytikov, nie o fakt o budúcnosti.', en: 'This is the analysts\' opinion, not a fact about the future.' },
  analystsMissing: { cs: 'Údaje analytiků teď nejsou k dispozici.', sk: 'Údaje analytikov teraz nie sú k dispozícii.', en: 'Analyst data are not available right now.' },
  fair: { cs: 'Model Trackory odhaduje férovou hodnotu na {{f}} při ceně {{p}}.', sk: 'Model Trackory odhaduje férovú hodnotu na {{f}} pri cene {{p}}.', en: 'The Trackora model estimates a fair value of {{f}} at a price of {{p}}.' },
  ratio: { cs: 'Poměr férové hodnoty k ceně je {{r}}, odchylka ceny od férové hodnoty {{d}}.', sk: 'Pomer férovej hodnoty k cene je {{r}}, odchýlka ceny od férovej hodnoty {{d}}.', en: 'Fair value to price is {{r}}; the gap from price to fair value is {{d}}.' },
  sensitivity: { cs: 'Při jiných předpokladech diskontu a růstu vychází od {{lo}} do {{hi}}.', sk: 'Pri iných predpokladoch diskontu a rastu vychádza od {{lo}} do {{hi}}.', en: 'Other discount and growth assumptions give {{lo}} to {{hi}}.' },
  multiple: { cs: 'Aktuální P/E je {{m}} proti pětiletému mediánu {{md}}.', sk: 'Aktuálne P/E je {{m}} oproti päťročnému mediánu {{md}}.', en: 'The current P/E is {{m}} against its multi-year median of {{md}}.' },
  relativeOnly: { cs: 'Ocenění stojí jen na srovnání násobků, ne na peněžních tocích.', sk: 'Ocenenie stojí len na porovnaní násobkov, nie na peňažných tokoch.', en: 'The valuation rests on multiples only, not on cash flows.' },
  valuationMissing: { cs: 'Ocenění modelem Trackory teď není k dispozici.', sk: 'Ocenenie modelom Trackory teraz nie je k dispozícii.', en: 'The Trackora valuation is not available right now.' },
  priceOnly: { cs: 'Aktuální cena je {{p}}.', sk: 'Aktuálna cena je {{p}}.', en: 'The current price is {{p}}.' },
  earnings: { cs: 'Příští výsledky hospodaření jsou ohlášeny na {{e}}.', sk: 'Najbližšie hospodárske výsledky sú ohlásené na {{e}}.', en: 'The next earnings report is scheduled for {{e}}.' },
  news: { cs: 'Nedávné titulky jsou v odkazech; jsou jen kontext a nedokazují, proč se cena pohnula.', sk: 'Nedávne titulky sú v odkazoch; sú len kontext a nedokazujú, prečo sa cena pohla.', en: 'Recent headlines are linked; they are context only and do not prove why the price moved.' },
  newsUnlinked: { cs: 'Nedávné titulky jsou jen kontext a nedokazují, proč se cena pohnula.', sk: 'Nedávne titulky sú len kontext a nedokazujú, prečo sa cena pohla.', en: 'Recent headlines are context only and do not prove why the price moved.' },
  newsMissing: { cs: 'Nedávné zprávy nejsou k dispozici.', sk: 'Nedávne správy nie sú k dispozícii.', en: 'No recent news is available.' },
  newsEmpty: { cs: 'V prohledaném období nejsou žádné titulky zpráv.', sk: 'V prehľadanom období nie sú žiadne titulky správ.', en: 'No headlines were found in the checked period.' },
  dayChange: { cs: 'Dnešní změna ceny je {{c}}.', sk: 'Dnešná zmena ceny je {{c}}.', en: 'Today\'s price change is {{c}}.' },
  concentration: { cs: 'Pozice už tvoří {{w}} tvého portfolia, další nákup zvýší koncentraci.', sk: 'Pozícia už tvorí {{w}} tvojho portfólia, ďalší nákup zvýši koncentráciu.', en: 'The position is already {{w}} of your portfolio; buying more raises concentration.' },
  notHeld: { cs: 'Tuto akcii zatím nedržíš.', sk: 'Túto akciu zatiaľ nedržíš.', en: 'You do not hold this stock yet.' },
  holdingUnknown: { cs: 'Velikost tvé pozice není spolehlivě známá; dopad nákupu na koncentraci nelze určit.', sk: 'Veľkosť tvojej pozície nie je spoľahlivo známa; dopad nákupu na koncentráciu nemožno určiť.', en: 'Your position size is unknown; the concentration impact of a purchase is not available.' },
  empty: { cs: 'Zatím nic nedržíš.', sk: 'Zatiaľ nič nedržíš.', en: 'You do not hold anything yet.' },
  // The percentile's own period follows it; "five-year" would contradict a shorter stored history.
  highPercentile: { cs: 'P/E je vysoko ve své historii – percentil {{pp}}.', sk: 'P/E je vysoko vo svojej histórii – percentil {{pp}}.', en: 'P/E is high within its history – percentile {{pp}}.' },
  modelRisk: { cs: 'Férová hodnota stojí na předpokladech, které se nemusí naplnit.', sk: 'Férová hodnota stojí na predpokladoch, ktoré sa nemusia naplniť.', en: 'The fair value rests on assumptions that may not hold.' },
  conflict: { cs: 'Ocenění a názor analytiků si odporují, proto je jistota nízká.', sk: 'Ocenenie a názor analytikov si odporujú, preto je istota nízka.', en: 'The valuation and the analysts disagree, so confidence is low.' },
  change: {
    attractive: { cs: 'Výrazně slabší výsledky, opatrnější předpoklady růstu nebo prudký růst ceny.', sk: 'Výrazne slabšie výsledky, opatrnejšie predpoklady rastu alebo prudký rast ceny.', en: 'Clearly weaker results, more cautious growth assumptions or a sharp price rise.' },
    fair: { cs: 'Výrazný pohyb ceny nebo nové výsledky, které posunou férovou hodnotu.', sk: 'Výrazný pohyb ceny alebo nové výsledky, ktoré posunú férovú hodnotu.', en: 'A large price move or new results that shift the fair value.' },
    expensive: { cs: 'Pokles ceny nebo výrazně lepší výsledky.', sk: 'Pokles ceny alebo výrazne lepšie výsledky.', en: 'A lower price or clearly better results.' },
    insufficient: { cs: 'Doplnění chybějících údajů.', sk: 'Doplnenie chýbajúcich údajov.', en: 'The missing data becoming available.' },
  } as Record<Verdict, T3>,
  noData: { cs: 'Teď se mi nepodařilo načíst data k odpovědi. Zkus to prosím za chvíli znovu, případně otázku upřesni.',
    sk: 'Teraz sa mi nepodarilo načítať údaje na odpoveď. Skús to prosím o chvíľu znova, prípadne otázku upresni.',
    en: 'I could not load the data for an answer right now. Please try again in a moment or make the question more specific.' },
  intro: { cs: 'Z ověřených dat Trackory:', sk: 'Z overených údajov Trackory:', en: 'Verified Trackora evidence:' },
};
/** True for the "could not load the data" answer: nothing verified to say (Běh 26 answers a named instrument instead). */
export const isNoDataText = (text: string) => Object.values(S.noData).includes(text);

const WARNING_TEXT: [RegExp, T3][] = [
  [/^missing_fx/, { cs: 'Chybí část směnných kurzů; daňový výsledek je neúplný.', sk: 'Chýba časť výmenných kurzov; daňový výsledok je neúplný.', en: 'Some exchange rates are missing; the tax result is incomplete.' }],
  [/^(unmatched_sells|unresolved_asset_kind|tax:)/, { cs: 'Daňové podklady mají nevyřešené položky; výsledek není konečný.', sk: 'Daňové podklady majú nevyriešené položky; výsledok nie je konečný.', en: 'Tax evidence has unresolved items; the result is not final.' }],
  [/^estimate_not_tax_advice$/, { cs: 'Daň je odhad podle dostupných podkladů.', sk: 'Daň je odhad podľa dostupných podkladov.', en: 'Tax is an estimate based on the available evidence.' }],
  [/^(quote_missing:|quote_currency_unsupported:[^:]+:)/, { cs: 'U některé pozice chybí aktuální cena, je oceněna nákupní cenou.', sk: 'Pri niektorej pozícii chýba aktuálna cena, je ocenená nákupnou cenou.', en: 'A position has no current price and is valued at cost.' }],
  [/^usdczk_from_snapshot$/, { cs: 'Kurz USD/CZK je z posledního uloženého snímku portfolia.', sk: 'Kurz USD/CZK je z posledného uloženého snímku portfólia.', en: 'The USD/CZK rate comes from the last stored portfolio snapshot.' }],
  [/^forecast_is_estimate$/, { cs: 'Výhled dividend je odhad.', sk: 'Výhľad dividend je odhad.', en: 'The dividend outlook is an estimate.' }],
  [/^withholding_assumed$/, { cs: 'Srážková daň je u části dividend odhadnutá.', sk: 'Zrážková daň je pri časti dividend odhadnutá.', en: 'Withholding tax is estimated for some dividends.' }],
  [/^day_change_missing:/, { cs: 'U některé pozice chybí dnešní změna ceny, celková dnešní změna je neúplná.', sk: 'Pri niektorej pozícii chýba dnešná zmena ceny, celková dnešná zmena je neúplná.', en: 'A position has no change for today, so the total change today is incomplete.' }],
  [/^(position_history_missing:|history_missing)/, { cs: 'U části pozic chybí historie cen.', sk: 'Pri časti pozícií chýba história cien.', en: 'Price history is missing for some positions.' }],
  [/^ticker_unverified$/, { cs: 'Symbol jsem teď nemohl ověřit u zdroje dat, beru ho tak, jak je napsaný.',
    sk: 'Symbol som teraz nemohol overiť u zdroja dát, beriem ho tak, ako je napísaný.', en: 'I could not verify the symbol with a data source right now, so I used it as written.' }],
];
function limitsOf(warnings: Iterable<string>, lang: Lang): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    const text = WARNING_TEXT.find(([re]) => re.test(w))?.[1][lang];
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

type Builder = { blocks: AnswerBlock[]; add(kind: AnswerBlockKind, sentences: [T3, Record<string, Fact | undefined>][], ticker?: string): void };
function builder(lang: Lang): Builder {
  const blocks: AnswerBlock[] = [];
  let n = 0;
  return { blocks, add(kind, sentences, ticker) {
    const claims: AnswerBlock['claims'] = {};
    const texts: string[] = [];
    for (const [sentence, slots] of sentences) {
      // A sentence is used only when every fact it needs is present and showable.
      if (Object.values(slots).some(f => !f || f.value === null)) continue;
      let text = sentence[lang];
      for (const [slot, fact] of Object.entries(slots)) {
        const id = `s${++n}`;
        text = text.replace(`{{${slot}}}`, `{{${id}}}`);
        const f = fact!;
        claims[id] = typeof f.value === 'number'
          ? { factId: f.id, value: f.value, unit: f.unit, ...(f.currency ? { currency: f.currency } : {}), ...(f.ticker ? { ticker: f.ticker } : {}),
            ...(f.period ? { period: f.period } : {}), decimals: displayDecimals(f), meaning: f.source === 'assumption' || f.source === 'user' ? 'assumption' : 'value' }
          : { factId: f.id, value: f.value as string | boolean, unit: f.unit as 'date' | 'text' | 'boolean', ...(f.ticker ? { ticker: f.ticker } : {}),
            ...(f.period ? { period: f.period } : {}) };
        Object.assign(claims[id], { metric: f.metric, scope: f.scope, quality: f.quality });
      }
      texts.push(text);
    }
    if (texts.length) blocks.push({ kind, ...(ticker ? { ticker } : {}), text: texts.join(' '), claims, sourceIds: [] });
  } };
}

function newsItemsOf(ctx: ToolCtx, evidence?: AnalysisEvidence): NewsItem[] {
  const results = evidence ? [evidence.news] : runsOf(ctx).filter(r => r.name === 'get_stock_news' || r.name === 'get_market_news').map(r => r.result);
  return results.flatMap(r => r.ok ? ((r.data as { items?: NewsItem[] }).items ?? []) : []);
}
function warningsOf(ctx: ToolCtx, evidence?: AnalysisEvidence): string[] {
  const results = evidence ? Object.values(evidence).filter((r): r is AnalysisEvidence['quote'] => typeof r === 'object') : runsOf(ctx).map(r => r.result);
  return [...results.flatMap(r => r.ok ? r.meta.warnings : []), ...(hasUnverifiedTicker(ctx) ? ['ticker_unverified'] : [])];
}

function taxLimits(ctx: ToolCtx, lang: Lang): string[] {
  return runsOf(ctx).some(r => r.result.ok === false && r.result.error.reason === 'unsupported_residence') ? [{
    cs: 'Trackora nemá daňový model pro tvoji daňovou rezidenci. Může ti ukázat neutrální přehled realizovaných zisků a ztrát, příjmů z prodejů a dividend, bez výpočtu daně a osvobození.',
    sk: 'Trackora nemá daňový model pre tvoju daňovú rezidenciu. Môže ti ukázať neutrálny prehľad realizovaných ziskov a strát, príjmov z predajov a dividend, bez výpočtu dane a oslobodenia.',
    en: 'Trackora has no tax model for your tax residence. It can show a neutral view of realized gains and losses, sale proceeds and dividends, without calculating tax or exemptions.',
  }[lang]] : [];
}

/** Model selections carry the same mandatory qualifications as the fallback. */
export function renderSelectedFacts(ctx: ToolCtx, draft: AnswerDraft, links: Link[], contract?: IntentEvidence, explain = false): StoredAnswer {
  const answer = renderVerifiedAnswer(draft, ctx.facts, { links, today: ctx.today, explain, ...(contract?.notes?.length ? { notes: contract.notes } : {}),
    limits: [...taxLimits(ctx, draft.lang), ...limitsOf(warningsOf(ctx), draft.lang), ...(contract?.limits ?? [])] });
  return withEmptyState(ctx, draft.lang, answer);
}

/** A complete empty portfolio is said first, once, even when the selection did not include the holding count. */
function withEmptyState(ctx: ToolCtx, lang: Lang, answer: StoredAnswer): StoredAnswer {
  const count = factByKey(ctx, 'portfolio:holding_count');
  if (count?.value === 0 && count.quality?.state === 'complete' && !answer.text.includes(S.empty[lang].replace(/\.$/, ''))) {
    answer.text = `${S.empty[lang]}\n\n${answer.text}`;
  }
  return answer;
}

const PRIORITY: Record<Route['group'], RegExp[]> = {
  portfolio: [/^portfolio:total_value$/, /^portfolio:total_profit$/, /^portfolio:unrealized_profit$/, /^portfolio:cash$/, /^performance:/, /^holding:[^:]+:value$/, /^dividends:/, /^allocation:/],
  dane: [/^tax:/, /^realized:/, /^sale:/, /^dividends:/, /^lots:/],
  trh: [/^quote:[^:]+:price$/, /^quote:/, /^history:/, /^analysts:[^:]+:target/, /^earnings:[^:]+:next_date$/],
  valuace: [/^fair_value:[^:]+:value$/, /^quote:[^:]+:price$/, /^valuation:[^:]+:current:/, /^valuation:/],
  obecne: [/^portfolio:/, /^holding:/, /^quote:/],
  mimo_temu: [],
};
// What a keyword intent asks about comes first (buy questions use the analysis template).
const INTENT_PRIORITY: Record<Exclude<Intent, 'buy'>, RegExp[]> = {
  realized: [/^realized:/], simulation: [/^sale:/], account_clarification: [/^sale:/], lots: [/^lots:/],
  transactions: [/^transactions:[^:]+:count$/, /^transactions:[^:]+:buy_usd$/, /^transactions:[^:]+:sell_usd$/, /^transactions:[^:]+:(bought|sold)_shares$/,
    /^transactions:[^:]+:fees_usd$/],
  tax: PRIORITY.dane,
  dividends: [/^dividends:received$/, /^dividends:count$/, /^dividends:(gross|net|withheld)$/, /^dividends:/],
  quote: PRIORITY.trh,
  performance: [/^performance:/], allocation: [/^allocation:/], holdings: PRIORITY.portfolio, summary: PRIORITY.portfolio,
  movers: [/^portfolio:day_change/, /^holding:[^:]+:day_change/],
  move_explanation: [/^history:[^:]+:change_pct$/, /^history:[^:]+:(first_close|last_close|max_drawdown_pct)$/, /^quote:[^:]+:(price|change_pct)$/],
};

/** A verified answer built only from facts of this request: the fallback after a failed model, quota or timeout. */
export function buildVerifiedTemplate(ctx: ToolCtx, route: Route, evidence?: AnalysisEvidence, contract?: IntentEvidence): StoredAnswer {
  const lang = route.lang, b = builder(lang);
  if (contract) {
    if (!contract.facts.length) return { text: [...taxLimits(ctx, lang), ...contract.limits].join(' ') || S.noData[lang], links: [], trace: [], lang, outcome: 'fallback', verified: true };
    // Keep every required datum, including each displayed lot. Chunking is only a draft shape limit.
    const blocks = [];
    for (let start = 0; start < contract.facts.length; start += 80) {
      const facts = contract.facts.slice(start, start + 80);
      blocks.push({ kind: 'facts', text: facts.map((_, i) => `{{v${i}}}`).join('\n'),
        claims: Object.fromEntries(facts.map((fact, i) => [`v${i}`, { factId: fact.id }])), sourceIds: [] });
    }
    const checked = validateAnswer(expandDraft({ lang, blocks }, ctx.facts), ctx.facts, ctx.calculations,
      { lang, requiredFactIds: contract.facts.map(f => f.id) });
    if (!checked.ok) throw new Error('Invalid intent template');
    // Headlines loaded by the intent (today's movers) are linked from tool URLs only.
    return renderSelectedFacts(ctx, checked.draft, safeSourceLinks(newsItemsOf(ctx)), contract);
  }
  if (evidence) {
    const t = evidence.ticker;
    const evidenceFacts = Object.values(evidence).flatMap(r => typeof r === 'object' && r.ok ? r.facts : []);
    const f = (key: string) => evidenceFacts.find(fact => fact.metric === key.replace('{t}', t));
    const policy = analysisPolicy(ctx, evidence);
    if (evidence.analysts.ok && f('analysts:{t}:target_mean')?.value != null) {
      b.add('analysts', [[S.analystsTarget, { a: f('analysts:{t}:target_mean') }], [S.analystsRange, { h: f('analysts:{t}:target_high') }],
        [S.analystsLow, { l: f('analysts:{t}:target_low') }], [S.analystsConsensus, { c: f('analysts:{t}:consensus') }], [S.analystsOpinion, {}]], t);
    } else if (evidence.analysts.ok) {
      b.add('analysts', [[S.analystsConsensus, { c: f('analysts:{t}:consensus') }], [S.analystsOpinion, {}]], t);
    }
    if (!b.blocks.some(x => x.kind === 'analysts')) b.add('analysts', [[S.analystsMissing, {}]]);
    const fair = f('fair_value:{t}:value');
    if (fair?.value != null && policy.basis === 'fair_value') {
      b.add('valuation', [[S.fair, { f: fair, p: f('quote:{t}:price') }], [S.ratio, { r: policy.ratio ?? undefined, d: policy.deviation ?? undefined }],
        [S.sensitivity, { lo: f('fair_value:{t}:sensitivity_low'), hi: f('fair_value:{t}:sensitivity_high') }],
        [S.multiple, { m: f('valuation:{t}:current:pe'), md: f('valuation:{t}:median_5y:pe') }], ...(policy.relativeOnly ? [[S.relativeOnly, {}] as [T3, Record<string, Fact>]] : [])], t);
    } else {
      b.add('valuation', [[S.valuationMissing, {}], [S.priceOnly, { p: f('quote:{t}:price') }]], t);
    }
    const links = safeSourceLinks(newsItemsOf(ctx, evidence));
    const newsCount = f('news:{t}:count');
    b.add('context', [[S.dayChange, { c: f('quote:{t}:change_pct') }], [S.earnings, { e: f('earnings:{t}:next_date') }],
      [typeof newsCount?.value === 'number' && newsCount.value > 0 ? (links.length ? S.news : S.newsUnlinked)
        : newsCount?.value === 0 && evidence.news.ok && evidence.news.meta.complete ? S.newsEmpty : S.newsMissing, {}]], t);
    const weight = evidence.holdings.ok && evidence.allocation.ok ? f('holding:{t}:allocation') : undefined, percentile = f('valuation:{t}:percentile:pe');
    const notHeld = evidence.holdings.ok && evidence.holdings.meta.complete && evidence.holdings.meta.omittedRows === 0
      && (evidence.holdings.data as { totalRows?: number }).totalRows === 0;
    b.add('risks', [[weight?.value != null && (weight.value as number) > 0 ? S.concentration : notHeld ? S.notHeld : S.holdingUnknown,
      weight?.value != null && (weight.value as number) > 0 ? { w: weight } : {}],
      ...(typeof percentile?.value === 'number' && percentile.value >= 0.8 ? [[S.highPercentile, { pp: percentile }] as [T3, Record<string, Fact>]] : []),
      ...(policy.basis === 'fair_value' ? [[S.modelRisk, {}] as [T3, Record<string, Fact>]] : []),
      ...(policy.conflict ? [[S.conflict, {}] as [T3, Record<string, Fact>]] : [])], t);
    // Stale or incomplete evidence is not repeated in the text: it already lowers the confidence shown with the view.
    b.add('verdict', opinionOf(ctx, policy, f), t);
    const draft: AnswerDraft = { lang, blocks: b.blocks, verdict: policy.verdict, confidence: policy.confidence, wouldChange: S.change[policy.verdict][lang] };
    // A buy answer is market evidence and calculations from it: its quality is in the confidence, never after each number.
    return renderChecked(ctx, draft, { links, limits: limitsOf(warningsOf(ctx, evidence), lang), quietQuality: true }, policy);
  }
  const facts = [...ctx.facts.values()].filter(fact => fact.value !== null && fact.source !== 'assumption' && fact.ticker !== 'CASH' && formatFact(fact, lang) !== null);
  const chosen: Fact[] = [];
  for (const re of (route.intent && route.intent !== 'buy' ? INTENT_PRIORITY[route.intent] : PRIORITY[route.group]) ?? []) for (const fact of facts) if (re.test(fact.id.split('#')[0]) && !chosen.includes(fact) && chosen.length < 8) chosen.push(fact);
  if (!chosen.length) return { text: taxLimits(ctx, lang).join(' ') || S.noData[lang], links: [], trace: [], lang, outcome: 'fallback', verified: true };
  // The same fact selection a model would make; the renderer phrases it (and its labels) after validation.
  const selection = expandDraft({ lang, blocks: [{ kind: 'facts', text: chosen.map((_, i) => `{{v${i}}}`).join(' '),
    claims: Object.fromEntries(chosen.map((fact, i) => [`v${i}`, { factId: fact.id }])), sourceIds: [] }] }, ctx.facts) as AnswerDraft;
  return withEmptyState(ctx, lang, renderChecked(ctx, selection, { links: safeSourceLinks(newsItemsOf(ctx)), limits: [...taxLimits(ctx, lang), ...limitsOf(warningsOf(ctx), lang)] }));
}

/** Validate the whole server answer, including the analysis contract; never silently drop a required block. */
function renderChecked(ctx: ToolCtx, draft: AnswerDraft, extras: { links: Link[]; limits: string[]; labels?: Record<string, string>; quietQuality?: boolean }, analysis?: AnalysisPolicy): StoredAnswer {
  const check = validateAnswer(draft, ctx.facts, ctx.calculations, { serverTemplate: true, analysis });
  if (check.ok === false) throw new Error(`Invalid server answer: ${check.reasons.join(',')}`);
  return { ...renderVerifiedAnswer(check.draft, ctx.facts, { ...extras, serverTemplate: true, today: ctx.today }), outcome: 'fallback' };
}

/* ----------------------------- move explanation (Běh 22, articles in Běh 23) ----------------------------- */

const MW = {
  happened: { cs: 'Co se stalo', sk: 'Čo sa stalo', en: 'What happened' },
  reasons: { cs: 'Proč se to pravděpodobně děje', sk: 'Prečo sa to pravdepodobne deje', en: 'Why it is likely happening' },
  press: { cs: 'Co píšou zprávy', sk: 'Čo píšu správy', en: 'What the news says' },
  // "How is SPCX doing?" (Běh 26): the same answer, read as an assessment of the company.
  company: { cs: 'Jak si firma vede podle zpráv', sk: 'Ako sa firme darí podľa správ', en: 'How the company is doing, per the news' },
  companyLikely: { cs: 'Jde o shrnutí zpráv a pohledů v nich, ne o doporučení koupit nebo prodat.', sk: 'Ide o zhrnutie správ a pohľadov v nich, nie o odporúčanie kúpiť alebo predať.',
    en: 'This summarises the news and the views in it; it is not a recommendation to buy or sell.' },
  watch: { cs: 'Na co se dívat', sk: 'Na čo sa pozerať', en: 'What to watch' },
  likely: { cs: 'Jde o pravděpodobné důvody podle zpráv, ne o prokázané příčiny.', sk: 'Ide o pravdepodobné dôvody podľa správ, nie o preukázané príčiny.',
    en: 'These are likely drivers based on the news, not proven causes.' },
  thin: { cs: 'Zpráv z tohoto období je málo, vysvětlení je proto nejisté.', sk: 'Správ z tohto obdobia je málo, vysvetlenie je preto neisté.',
    en: 'There is little news from this period, so the explanation is uncertain.' },
  extracts: { cs: 'Výňatky jsou z článků; jde o kontext, ne o prokázané příčiny pohybu.', sk: 'Výňatky sú z článkov; ide o kontext, nie o preukázané príčiny pohybu.',
    en: 'Extracts are from the articles; they are context, not proven causes of the move.' },
  titlesOnly: { cs: 'K tomuto období jsem našel jen titulky bez textu článků, takže důvody pohybu neumím rozebrat.',
    sk: 'K tomuto obdobiu som našiel len titulky bez textu článkov, takže dôvody pohybu neviem rozobrať.',
    en: 'For this period I found only headlines without article text, so I cannot analyse the reasons for the move.' },
  unlinked: { cs: 'Zprávy z tohoto období nemají odkaz od ověřeného vydavatele, proto je tu neuvádím; důvody pohybu tak neumím doložit.',
    sk: 'Správy z tohto obdobia nemajú odkaz od overeného vydavateľa, preto ich tu neuvádzam; dôvody pohybu tak neviem doložiť.',
    en: 'The news from this period has no link from a verified publisher, so it is not listed and the reasons for the move cannot be backed up.' },
  noHistory: { cs: 'Historii ceny za toto období teď nemám, takže pohyb neumím spočítat.', sk: 'Históriu ceny za toto obdobie teraz nemám, takže pohyb neviem spočítať.',
    en: 'The price history for this period is not available right now, so the move cannot be calculated.' },
  watchGeneric: { cs: 'Sleduj, jestli se pohyb přenese i na podobné firmy a jestli přijdou nové zprávy přímo o firmě.',
    sk: 'Sleduj, či sa pohyb prenesie aj na podobné firmy a či prídu nové správy priamo o firme.',
    en: 'Watch whether peers follow and whether new company-specific news comes out.' },
  source: { cs: ['Zdroj', 'Zdroje'], sk: ['Zdroj', 'Zdroje'], en: ['Source', 'Sources'] } as Record<Lang, [string, string]>,
};
const MOVE_QUOTES: Record<Lang, [string, string]> = { cs: ['„', '“'], sk: ['„', '“'], en: ['“', '”'] };
// Fallback groups of article extracts: the first cluster whose words appear in the title or extract.
const CLUSTERS: [RegExp, T3][] = [
  [/(?<![\p{L}])(?:short[- ]?sell\p{L}*|short report|convertible|notes|debt|borrow\p{L}*|dilut\p{L}*|financ\p{L}*|offering|bonds?)(?![\p{L}])/iu,
    { cs: 'Shortaři a financování', sk: 'Shortisti a financovanie', en: 'Short sellers and financing' }],
  [/(?<![\p{L}])(?:downgrad\p{L}*|upgrad\p{L}*|price targets?|analysts?|ratings?)(?![\p{L}])/iu, { cs: 'Analytici', sk: 'Analytici', en: 'Analysts' }],
  [/(?<![\p{L}])(?:capex|spending|hyperscalers?|data[- ]?cent\p{L}*|sectors?|neoclouds?|gpu cloud|peers|rivals|sell-?off|industry)(?![\p{L}])/iu,
    { cs: 'Sektor a výdaje na AI', sk: 'Sektor a výdavky na AI', en: 'Sector and AI spending' }],
];
const COMPANY_NEWS: T3 = { cs: 'Zprávy o firmě', sk: 'Správy o firme', en: 'Company news' };
const PEER_NEWS: T3 = { cs: 'Zprávy o podobných firmách', sk: 'Správy o podobných firmách', en: 'Peer news' };

const plainProse = (text: string) => text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

/**
 * The text without who published it: "podle Reuters", "(podle Yahoo Finance)", a page id ("n4") and the like. The
 * analyst must still attribute every figure (the validator checks it against the cited page); the answer shows the
 * claim, not the outlet (owner's call, 2026-10-24). Analyst firms ("cíl 3 000 USD od Bernsteina") are not outlets and stay.
 */
export function withoutAttribution(text: string, publishers: readonly string[]): string {
  const names = [...new Set(publishers.map(p => p.trim()).filter(p => p.length >= 2))].sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const outlet = String.raw`(?:<?\s*n\d{1,2}\s*>?${names.length ? `|${names.join('|')}` : ''})`;
  const lead = String.raw`(?:[Pp]odle|[Pp]odľa|[Aa]ccording to|[Vv]e? zprávě|[Ii]n a report by)`;
  const list = String.raw`${outlet}(?:\s*(?:\([^)]*\)))?(?:\s*(?:,|a|and)\s*${outlet}(?:\s*(?:\([^)]*\)))?)*`;
  return text
    .replace(/\s*\((?:[Pp]odle|[Pp]odľa|[Aa]ccording to|[Zz]droj\p{L}*|[Ss]ources?)[^)]*\)/gu, '')
    .replace(new RegExp(String.raw`(^|[.!?]\s+)${lead}\s+${list}\s*,?\s*(\p{L})`, 'gu'), (_, start: string, first: string) => `${start}${first.toUpperCase()}`)
    .replace(new RegExp(String.raw`,?\s*${lead}\s+${list}(?=\s*[.,;:!?)]|\s*$)`, 'gu'), '')
    .replace(new RegExp(String.raw`,?\s*${lead}\s+${list}\s+`, 'gu'), ' ')
    // "Barron's píše, že …", "CNBC uvádí …" open a sentence; "…, jak píše Reuters" closes one.
    .replace(new RegExp(String.raw`(^|[.!?]\s+)${list}\s+(?:píše|píšou|uvádí|uvádějí|informuje|tvrdí|upozorňuje|reports?|writes?|says?)\s*,?\s*(?:že|that)\s+(\p{L})`, 'gu'),
      (_, start: string, first: string) => `${start}${first.toUpperCase()}`)
    // "Barron's píše o shortařovi" keeps its sentence with a neutral subject: "Tisk píše o shortařovi".
    .replace(new RegExp(String.raw`(^|[.!?]\s+)${list}\s+(píše|uvádí|informuje|upozorňuje|reports?|writes?)\b`, 'gu'),
      (_, start: string, verb: string) => `${start}${/^[a-z]+$/.test(verb) && /^(?:reports?|writes?)$/.test(verb) ? 'The press' : 'Tisk'} ${verb}`)
    .replace(new RegExp(String.raw`,?\s*(?:jak\s+)?(?:píše|uvádí|informuje|tvrdí|as\s+\S+\s+reports?)\s+${list}`, 'gu'), '')
    .replace(new RegExp(String.raw`\s*\(\s*${outlet}(?:\s*,[^)]*)?\s*\)`, 'gu'), '')
    .replace(/<?\s*\bn\d{1,2}\b\s*>?/g, '')
    .replace(/\s+([.,;:!?])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** Accepted analyst themes as bullets: bold short title, the explanation (sources verified, not shown). */
export function renderNewsThemes(analysis: NewsAnalysis, articles: readonly MoveNews[], lang: Lang, prefixTicker = false): string[] {
  const byKey = new Map(articles.map(a => [a.key, a]));
  const outlets = articles.map(a => a.publisher);
  return analysis.themes.map(t => {
    const cited = t.sources.map(k => byKey.get(k)).filter((a): a is MoveNews => !!a);
    const label = `${prefixTicker && cited[0] ? `${cited[0].ticker} – ` : ''}${withoutAttribution(plainProse(t.title), outlets)}`;
    return `• **${label}:** ${withoutAttribution(plainProse(t.explanation), outlets)}`;
  });
}

/**
 * Any other investing question answered from searched pages (Běh 27): the direct answer, the supporting points with their
 * sources and what to follow (Běh 32: no closing note); links of the cited pages first.
 */
export function renderWebAnswer(ctx: ToolCtx, news: readonly MoveNews[], analysis: NewsAnalysis, lang: Lang): StoredAnswer {
  const byKey = new Map(news.map(n => [n.key, n]));
  const cited = [...new Set(analysis.themes.flatMap(t => t.sources))].map(k => byKey.get(k)).filter((x): x is MoveNews => !!x);
  const used = cited.map(n => ctx.facts.get(n.factId)).filter((f): f is Fact => !!f);
  const T: Record<string, T3> = {
    answer: { cs: 'Odpověď', sk: 'Odpoveď', en: 'Answer' }, details: { cs: 'Podrobnosti ze zdrojů', sk: 'Podrobnosti zo zdrojov', en: 'From the sources' },
    watch: { cs: 'Co sledovat', sk: 'Čo sledovať', en: 'What to follow' },
  };
  const parts = [`**${T.answer[lang]}:** ${plainProse(analysis.summary)}`, [T.details[lang], ...renderNewsThemes(analysis, news, lang)].join('\n')];
  if (analysis.watch.length) parts.push([T.watch[lang], ...analysis.watch.map(w => plainProse(w)).map(w => `• ${w[0].toUpperCase()}${w.slice(1)}`)].join('\n'));
  const sources = sourcesLine(used, lang);
  if (sources) parts.push(sources);
  const links = safeSourceLinks([...cited, ...news.filter(n => !cited.includes(n))].map(n => ({ title: n.title, summary: null, publisher: n.publisher, url: n.url,
    published: n.date, lang: 'original' as const })));
  return { text: parts.join('\n\n'), links, trace: [], lang, outcome: 'ok', verified: true };
}

/** Today's top movers explained (movers intent): one block of attributed themes, marked as likely drivers. */
export function renderMoverThemes(analysis: NewsAnalysis, articles: readonly MoveNews[], lang: Lang): string {
  const heading: T3 = { cs: 'Proč se tyhle akcie pravděpodobně hýbou:', sk: 'Prečo sa tieto akcie pravdepodobne hýbu:', en: 'Why these are likely moving:' };
  return [heading[lang], ...renderNewsThemes(analysis, articles, lang, true), MW.likely[lang]].join('\n');
}

/**
 * The analyst fallback: each verified article as „**Publisher, date:** “a verbatim extract”“ (≤ 320 characters of its
 * most relevant sentences, figures only inside the quote), grouped by theme words; peers' articles in their own group.
 * Articles without any text are left out — a title alone is never the content.
 */
export function renderNewsExtracts(articles: readonly MoveNews[], keywords: readonly string[], lang: Lang, ticker: string): string[] {
  const [open, close] = MOVE_QUOTES[lang];
  const groups = new Map<string, string[]>();
  const order = [...CLUSTERS.map(c => c[1][lang]), COMPANY_NEWS[lang], PEER_NEWS[lang]];
  for (const a of articles) {
    const extract = neutralizeExtract(bestPassage(a.excerpt || a.summary, keywords, EXTRACT_MAX));
    if (!extract) continue;
    const head = [quotableHeadline(a.publisher) ?? '', a.date ? dateText(a.date, lang, false) : ''].filter(Boolean).join(', ');
    const group = a.ticker !== ticker ? PEER_NEWS[lang] : CLUSTERS.find(([re]) => re.test(`${a.title} ${extract}`))?.[1][lang] ?? COMPANY_NEWS[lang];
    const line = `• **${head}${a.ticker !== ticker ? ` (${a.ticker})` : ''}:** ${open}${extract}${close}`;
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  return order.filter(g => groups.has(g)).map(g => `${g}:\n${groups.get(g)!.join('\n')}`);
}
// An extract is already clean text; this only guarantees it cannot break the quotation or the markup around it.
const neutralizeExtract = (text: string) => text.replace(/["„“”«»*]/g, '\'').replace(/[<>{}[\]`]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The answer to "what is going on with X over the last days": a one-line summary first; what happened (every figure is
 * formatFact of a fact of this request — period change, first and last close, drawdown, S&P 500, peers, today's quote);
 * why it is likely happening (the analyst's themes with their sources) or, without an analysis, what the articles say
 * (attributed extracts); what to watch (earnings, rating changes, the analyst's points). Links only from tool URLs.
 */
// Outlook answers (Běh 27).
const OW = {
  summary: (t: string): T3 => ({ cs: `Výhled ${t} podle analytiků, ocenění a zpráv.`, sk: `Výhľad ${t} podľa analytikov, ocenenia a správ.`,
    en: `The ${t} outlook from analysts, valuation and the news.` }),
  business: { cs: 'O firmě', sk: 'O firme', en: 'About the company' },
  financials: { cs: 'Finanční zdraví', sk: 'Finančné zdravie', en: 'Financial health' },
  moat: { cs: 'Konkurenční výhoda', sk: 'Konkurenčná výhoda', en: 'Competitive edge' },
  management: { cs: 'Vedení a vlastníci', sk: 'Vedenie a vlastníci', en: 'Management and owners' },
  dividends: { cs: 'Dividendy a odkupy akcií', sk: 'Dividendy a spätné odkupy', en: 'Dividends and buybacks' },
  catalysts: { cs: 'Co může pohnout cenou', sk: 'Čo môže pohnúť cenou', en: 'Upcoming catalysts' },
  priceMove: { cs: 'Proč se cena hýbe', sk: 'Prečo sa cena hýbe', en: 'Why the price is moving' },
  industry: { cs: 'Výhled odvětví', sk: 'Výhľad odvetvia', en: 'Industry outlook' },
  strengths: { cs: 'Silné stránky', sk: 'Silné stránky', en: 'Strengths' },
  risks: { cs: 'Slabiny a rizika', sk: 'Slabiny a riziká', en: 'Weaknesses and risks' },
  analysts: { cs: 'Co čekají analytici', sk: 'Čo čakajú analytici', en: 'What analysts expect' },
  valuation: { cs: 'Ocenění dnes', sk: 'Ocenenie dnes', en: 'Valuation today' },
  scenarios: { cs: 'Kde může být cena za 3 roky (modelové scénáře)', sk: 'Kde môže byť cena o 3 roky (modelové scenáre)',
    en: 'Where the price could be in 3 years (model scenarios)' },
  scenariosIn: (y: number): T3 => ({ cs: `Kde může být cena za ${y} ${y === 1 ? 'rok' : y < 5 ? 'roky' : 'let'} (modelové scénáře)`,
    sk: `Kde môže byť cena o ${y} ${y === 1 ? 'rok' : y < 5 ? 'roky' : 'rokov'} (modelové scenáre)`, en: `Where the price could be in ${y} year${y === 1 ? '' : 's'} (model scenarios)` }),
  view: { cs: 'Jak to vidím', sk: 'Ako to vidím', en: 'How I see it' },
  viewNote: { cs: 'Je to úvaha nad zprávami a čísly výše, ne investiční doporučení.', sk: 'Je to úvaha nad správami a číslami vyššie, nie investičné odporúčanie.',
    en: 'This is a reading of the news and figures above, not investment advice.' },
  price: { cs: 'Vývoj ceny', sk: 'Vývoj ceny', en: 'Price trend' },
  noAnalysis: { cs: 'Rozbor článků se teď nepodařilo připravit (AI je chvíli vytížená). Níže jsou ověřená čísla; zkus otázku za pár minut znovu.',
    sk: 'Rozbor článkov sa teraz nepodarilo pripraviť (AI je chvíľu vyťažená). Nižšie sú overené čísla; skús otázku o pár minút znova.',
    en: 'The article analysis could not be prepared right now (the AI is busy). The verified figures follow; try again in a few minutes.' },
};
export function renderMoveAnswer(ctx: ToolCtx, ev: MoveEvidence, analysis: NewsAnalysis | null): StoredAnswer {
  const lang = ev.lang, T = ev.ticker, used: Fact[] = [];
  const show = (f: Fact, signed = false) => {
    if (!used.includes(f)) used.push(f);
    const notes = factNotes(f, lang, false).map(n => n.inline);
    return `${signed && num(f)! > 0 ? '+' : ''}${formatFact(f, lang) ?? ''}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  };
  const say = (t: T3) => t[lang];
  const crypto = ev.peerBasis === 'crypto';
  const noun = say(crypto ? { cs: 'ostatní kryptoměny', sk: 'ostatné kryptomeny', en: 'other major coins' } : { cs: 'podobné firmy', sk: 'podobné firmy', en: 'peers' });
  const down = (num(ev.change ?? undefined) ?? 0) < 0;

  // What happened: the period move against the S&P 500 and the peers.
  const happened: string[] = [];
  if (ev.change && num(ev.change) !== null) {
    const opener = periodOpener(ev.change.period, lang, ctx.today) ?? '';
    const range = ev.first && ev.last ? lang === 'en' ? ` (from ${show(ev.first)} to ${show(ev.last)})` : ` (z ${show(ev.first)} na ${show(ev.last)})` : '';
    const change = show(ev.change, true);
    happened.push(say({ cs: `${opener} se cena ${T} změnila o ${change}${range}.`, sk: `${opener} sa cena ${T} zmenila o ${change}${range}.`,
      en: `${opener}, the ${T} price changed by ${change}${range}.` }));
    const dd = num(ev.drawdown);
    if (ev.drawdown && dd !== null && dd <= -1 && Math.abs(dd - num(ev.change)!) >= 0.05) {
      const drop = show(ev.drawdown);
      happened.push(say({ cs: `Největší propad od maxima v tomto období byl ${drop}.`, sk: `Najväčší prepad od maxima v tomto období bol ${drop}.`,
        en: `The largest drop from a high within the period was ${drop}.` }));
    }
  } else happened.push(say(MW.noHistory));
  if (ev.spx && num(ev.spx) !== null) {
    const spx = show(ev.spx, true);
    happened.push(say({ cs: `Index S&P 500 se za stejné období změnil o ${spx}.`, sk: `Index S&P 500 sa za rovnaké obdobie zmenil o ${spx}.`,
      en: `The S&P 500 changed by ${spx} over the same period.` }));
  }
  const withData = ev.peers.filter(p => p.change && num(p.change) !== null), without = ev.peers.filter(p => !p.change || num(p.change) === null);
  if (withData.length) {
    const heading = say(crypto ? { cs: 'Další velké kryptoměny za stejné období:', sk: 'Ďalšie veľké kryptomeny za rovnaké obdobie:', en: 'Other major coins over the same period:' }
      : { cs: 'Podobné firmy za stejné období:', sk: 'Podobné firmy za rovnaké obdobie:', en: 'Peers over the same period:' });
    const samePeriod = (f: Fact) => !ev.change?.period || JSON.stringify(f.period ?? null) === JSON.stringify(ev.change.period);
    happened.push(`${heading}\n${withData.map(p => `• ${p.ticker}: ${say({ cs: 'změna', sk: 'zmena', en: 'change' })} ${show(p.change!, true)}${samePeriod(p.change!) || !p.change!.period ? '' : ` (${periodText(p.change!.period, lang)})`}`).join('\n')}`);
  }
  if (without.length) {
    const names = list(without.map(p => p.ticker), lang);
    happened.push(say({ cs: `Pro ${names} teď nemám historii cen.`, sk: `Pre ${names} teraz nemám históriu cien.`, en: `No price history is available for ${names} right now.` }));
  }
  const fell = say(down ? { cs: 'klesaly', sk: 'klesali', en: 'fell' } : { cs: 'rostly', sk: 'rástli', en: 'rose' });
  const scope: Partial<Record<MoveEvidence['scope'], T3>> = {
    mixed: { cs: `${cap(noun)} ${fell} taky, ${T} ale výrazně víc – roli hraje celý sektor i zprávy přímo o firmě.`,
      sk: `${cap(noun)} tiež ${fell}, ${T} však výrazne viac – úlohu hrá celý sektor aj správy priamo o firme.`,
      en: `${cap(noun)} ${fell} too, but ${T} ${fell} much more – both the sector and company news seem to matter.` },
    sector: { cs: `Podobně se pohybovaly i ${noun} – vypadá to spíš na pohyb celého sektoru.`, sk: `Podobne sa pohybovali aj ${noun} – vyzerá to skôr na pohyb celého sektora.`,
      en: `${cap(noun)} moved the same way – this looks more like a sector-wide move.` },
    stock: withData.length ? { cs: `Trh ani ${noun} se takhle nepohybovaly – pohyb je spíš specifický pro ${T}.`, sk: `Trh ani ${noun} sa takto nepohybovali – pohyb je skôr špecifický pre ${T}.`,
      en: `Neither the market nor ${noun} moved like this – the move looks specific to ${T}.` }
      : { cs: `Trh se takhle nepohyboval – pohyb je spíš specifický pro ${T}.`, sk: `Trh sa takto nepohyboval – pohyb je skôr špecifický pre ${T}.`,
        en: `The market did not move like this – the move looks specific to ${T}.` },
    market: { cs: `Cena ${T} se pohybovala zhruba s trhem.`, sk: `Cena ${T} sa pohybovala zhruba s trhom.`, en: `${T} moved roughly with the market.` },
    flat: { cs: `Za tohle období se cena ${T} výrazně nepohnula.`, sk: `Za toto obdobie sa cena ${T} výrazne nepohla.`, en: `The ${T} price did not move much over this period.` },
  };
  if (scope[ev.scope]) happened.push(say(scope[ev.scope]!));
  if (ev.price && num(ev.price) !== null) {
    const price = show(ev.price), today = ev.dayChange && num(ev.dayChange) !== null ? show(ev.dayChange, true) : null;
    happened.push(say({ cs: `Aktuální cena ${T} je ${price}${today ? `, dnešní změna ${today}` : ''}.`, sk: `Aktuálna cena ${T} je ${price}${today ? `, dnešná zmena ${today}` : ''}.`,
      en: `The current ${T} price is ${price}${today ? `, today's change ${today}` : ''}.` }));
  }

  // Why it is likely happening: the analyst's themes, else attributed extracts; honest when there is nothing to read.
  const byKey = new Map(ev.news.map(n => [n.key, n]));
  const newsFacts = (items: readonly MoveNews[]) => items.forEach(n => { const f = ctx.facts.get(n.factId); if (f && !used.includes(f)) used.push(f); });
  const cited = analysis ? [...new Set(analysis.themes.flatMap(t => t.sources))].map(k => byKey.get(k)).filter((x): x is MoveNews => !!x) : [];
  const order = [...cited, ...ev.news.filter(n => !cited.includes(n))];
  const links = safeSourceLinks(order.map(n => ({ title: n.title, summary: null, publisher: n.publisher, url: n.url, published: n.date, lang: 'original' as const })));
  const noNews: Record<MoveEvidence['scope'], T3> = {
    sector: { cs: 'Podle čísel to vypadá spíš na pohyb celého sektoru.', sk: 'Podľa čísel to vyzerá skôr na pohyb celého sektora.', en: 'By the numbers, this looks more like a sector-wide move.' },
    mixed: { cs: `Podle čísel se pohnul celý sektor, ${T} ale výrazně víc.`, sk: `Podľa čísel sa pohol celý sektor, ${T} však výrazne viac.`,
      en: `By the numbers, the whole sector moved, but ${T} moved much more.` },
    market: { cs: `Podle čísel se ${T} pohybovala zhruba s trhem.`, sk: `Podľa čísel sa ${T} pohybovala zhruba s trhom.`, en: `By the numbers, ${T} moved roughly with the market.` },
    stock: { cs: 'Podle čísel jde spíš o pohyb samotné firmy, zprávy ho ale nevysvětlují.', sk: 'Podľa čísel ide skôr o pohyb samotnej firmy, správy ho však nevysvetľujú.',
      en: 'By the numbers, the move looks company-specific, but the news does not explain it.' },
    flat: { cs: 'Podle čísel je pohyb malý.', sk: 'Podľa čísel je pohyb malý.', en: 'By the numbers, the move is small.' },
    unknown: { cs: 'Podle čísel teď pohyb nemám s čím porovnat.', sk: 'Podľa čísel teraz pohyb nemám s čím porovnať.', en: 'There is nothing to compare the move with right now.' },
  };
  let reasons: string;
  if (analysis) {
    newsFacts(cited);
    const company = ev.focus === 'company';
    reasons = [say(company ? MW.company : MW.reasons), ...renderNewsThemes(analysis, ev.news, lang),
      `${say(company ? MW.companyLikely : MW.likely)}${ev.news.length < 2 && !company ? ` ${say(MW.thin)}` : ''}`].join('\n');
  } else if (ev.news.length) {
    const groups = renderNewsExtracts(ev.news, ev.keywords, lang, T);
    if (groups.length) newsFacts(ev.news);
    reasons = groups.length ? [say(MW.press), ...groups, say(MW.extracts)].join('\n') : say(MW.titlesOnly);
  } else if (ev.unverified) {
    reasons = say(MW.unlinked);
  } else {
    reasons = `${say({ cs: 'K tomuto období jsem nenašel zprávy, které by pohyb vysvětlovaly.', sk: 'K tomuto obdobiu som nenašiel správy, ktoré by pohyb vysvetľovali.',
      en: 'I found no news from this period that would explain the move.' })} ${say(noNews[ev.scope])}`;
  }

  // What to watch: earnings and rating changes from the data, then the analyst's (or a generic) points.
  const watch: string[] = [];
  for (const date of ev.earningsInPeriod) {
    const d = dateText(date, lang, false);
    watch.push(say({ cs: `• Výsledky hospodaření zveřejnila ${d}.`, sk: `• Hospodárske výsledky zverejnila ${d}.`, en: `• It reported earnings on ${d}.` }));
  }
  if (ev.nextEarnings && formatFact(ev.nextEarnings, lang)) {
    const next = show(ev.nextEarnings);
    watch.push(say({ cs: `• Příští výsledky hospodaření: ${next}.`, sk: `• Najbližšie hospodárske výsledky: ${next}.`, en: `• Next earnings: ${next}.` }));
  }
  for (const c of ev.analystChanges) {
    const firm = quotableHeadline(c.firm), from = c.from ? quotableHeadline(c.from) : null, to = c.to ? quotableHeadline(c.to) : null, d = dateText(c.date, lang, false);
    if (!firm || !to || !d) continue;
    // An outlook lists rating changes with the analysts; here only for a price move.
    if (ev.focus === 'outlook') continue;
    watch.push(from && from.toLowerCase() === to.toLowerCase() ? say({ cs: `• ${firm} ${d} potvrdila doporučení ${to}.`, sk: `• ${firm} ${d} potvrdila odporúčanie ${to}.`,
      en: `• ${firm} reiterated ${to} on ${d}.` })
      : from ? say({ cs: `• ${firm} ${d} změnila doporučení z ${from} na ${to}.`, sk: `• ${firm} ${d} zmenila odporúčanie z ${from} na ${to}.`,
      en: `• ${firm} changed its rating from ${from} to ${to} on ${d}.` })
      : say({ cs: `• ${firm} ${d} vydala doporučení ${to}.`, sk: `• ${firm} ${d} vydala odporúčanie ${to}.`, en: `• ${firm} rated it ${to} on ${d}.` }));
  }
  if (analysis?.watch.length) watch.push(...analysis.watch.map(w => withoutAttribution(plainProse(w), ev.news.map(a => a.publisher))).filter(Boolean)
    .map(w => `• ${w[0].toUpperCase()}${w.slice(1)}`));
  else watch.push(`• ${say(MW.watchGeneric)}`);

  const summaries: Record<MoveEvidence['scope'], T3> = {
    mixed: { cs: `Cena ${T} za tohle období ${down ? 'klesla' : 'vzrostla'} víc než trh i ${noun} – vliv má nálada v celém sektoru i zprávy přímo o firmě.`,
      sk: `Cena ${T} za toto obdobie ${down ? 'klesla' : 'vzrástla'} viac než trh aj ${noun} – vplyv má nálada v celom sektore aj správy priamo o firme.`,
      en: `${T} ${down ? 'fell' : 'rose'} more than the market and its ${noun} over this period – sector mood and company news both play a part.` },
    sector: { cs: `Cena ${T} se pohybovala hlavně s ostatními v sektoru – jde spíš o pohyb celého sektoru.`,
      sk: `Cena ${T} sa pohybovala hlavne s ostatnými v sektore – ide skôr o pohyb celého sektora.`, en: `${T} mostly moved with its sector – a sector-wide move rather than a company one.` },
    stock: { cs: `Pohyb ceny ${T} je spíš specifický pro firmu – trh se tak nepohyboval.`, sk: `Pohyb ceny ${T} je skôr špecifický pre firmu – trh sa tak nepohyboval.`,
      en: `The ${T} move looks company-specific – the market did not move like this.` },
    market: { cs: `Cena ${T} se pohybovala zhruba s trhem.`, sk: `Cena ${T} sa pohybovala zhruba s trhom.`, en: `${T} moved roughly with the market.` },
    flat: { cs: `Cena ${T} se za tohle období výrazně nepohnula.`, sk: `Cena ${T} sa za toto obdobie výrazne nepohla.`, en: `The ${T} price did not move much over this period.` },
    unknown: { cs: `Pohyb ceny ${T} teď nemám s čím porovnat.`, sk: `Pohyb ceny ${T} teraz nemám s čím porovnať.`, en: `There is nothing to compare the ${T} move with right now.` },
  };
  // The analyst's summary when it gave a usable one; else the server's reading of the numbers, or — without numbers —
  // the analysis' main themes by their titles.
  const themeLead: T3 = { cs: 'Hlavní témata ze zpráv', sk: 'Hlavné témy zo správ', en: 'Main themes in the news' };
  const summary = analysis?.summary ? plainProse(analysis.summary)
    : analysis?.themes.length && ev.scope === 'unknown' ? `${say(themeLead)}: ${analysis.themes.slice(0, 2).map(t => plainProse(t.title)).join('; ')}.`
      : say(summaries[ev.scope]);

  // "Where will META be in three years?" (Běh 27): strengths and risks from the articles, analysts, today's valuation,
  // three model scenarios and the analyst's reasoned view; every figure is a fact, the view is words only.
  if (ev.focus === 'outlook') {
    const o = ev.outlook;
    const lines = (heading: T3, items: string[]) => items.length ? `${say(heading)}\n${items.join('\n')}` : '';
    const outlets = ev.news.map(a => a.publisher);
    const asks = ev.asks ?? { scenarios: true, business: true, analysts: true, risks: true, full: true, years: 3, aspects: [] };
    // Ocenění v3 (owner, 2026-10-24): the story first — what the company does, what drives growth, what could stop it —
    // then every price exactly once in one section, then the verdict. Each section is final when sent (streamed by key).
    const scenarioFirst = !asks.full && (asks.scenarios || asks.aspects.some(a => a === 'valuation' || a === 'analysts'));
    const RANK: Record<string, number> = { summary: 0, business: 10, growth: 20, risks: 30, financials: 40, management: 41, dividends: 42, price: 43,
      valuation: scenarioFirst ? 5 : 50, view: 60, watch: 70, limits: 80, sources: 90 };
    // A specific question leads with what it asks (Běh 31), in the order asked; risks follow the specific ones.
    if (!asks.full) {
      const SECTION_OF: Record<string, string> = { business: 'business', financials: 'financials', management: 'management', dividends: 'dividends', price_trend: 'price',
        risks: 'risks', moat: 'growth', industry: 'growth', catalysts: 'growth', valuation: 'valuation', scenarios: 'valuation', analysts: 'valuation' };
      const ranked = [...asks.aspects.filter(a => a !== 'risks'), ...asks.aspects.filter(a => a === 'risks')].map(a => SECTION_OF[a]).filter(Boolean);
      [...new Set(ranked)].forEach((key, i) => { RANK[key] = 1 + i; });
    }
    const out: { key: string; order: number; text: string }[] = [];
    const add = (key: string, text: string) => { if (text) out.push({ key, order: RANK[key], text }); };
    const themesOf = (...kinds: NonNullable<NewsAnalysis['themes'][number]['kind']>[]) => analysis
      ? renderNewsThemes({ ...analysis, themes: analysis.themes.filter(t => kinds.includes(t.kind!)) }, ev.news, lang) : [];

    // The valuation section: today's price, the P/E against its history, analysts, the model, the scenarios — each once.
    const value: string[] = [];
    if (ev.price && num(ev.price) !== null) {
      const since = ev.change && num(ev.change) !== null && ev.change.period?.from ? dateText(ev.change.period.from, lang, false) : '';
      const moved = since ? say({ cs: `, od ${since} ${show(ev.change!, true)}`, sk: `, od ${since} ${show(ev.change!, true)}`, en: `, ${show(ev.change!, true)} since ${since}` }) : '';
      value.push(say({ cs: `Akcie dnes stojí ${show(ev.price)}${moved}.`, sk: `Akcia dnes stojí ${show(ev.price)}${moved}.`, en: `The share trades at ${show(ev.price)}${moved}.` }));
    }
    if (o?.peNow) {
      const median = o.peMedian ? say({ cs: ` (pětiletý medián ${show(o.peMedian)})`, sk: ` (päťročný medián ${show(o.peMedian)})`, en: ` (5-year median ${show(o.peMedian)})` }) : '';
      const p = num(o.pePercentile ?? undefined);
      const vsHistory = p === null ? '' : say(p <= 0.3 ? { cs: ', tedy levně vůči vlastní historii', sk: ', teda lacno voči vlastnej histórii', en: ', cheap against its own history' }
        : p >= 0.7 ? { cs: ', tedy draze vůči vlastní historii', sk: ', teda draho voči vlastnej histórii', en: ', expensive against its own history' }
          : { cs: ', zhruba průměrně vůči vlastní historii', sk: ', zhruba priemerne voči vlastnej histórii', en: ', about average against its own history' });
      value.push(say({ cs: `P/E je ${show(o.peNow)}${median}${vsHistory}.`, sk: `P/E je ${show(o.peNow)}${median}${vsHistory}.`, en: `The P/E is ${show(o.peNow)}${median}${vsHistory}.` }));
    }
    const n = (k: string) => (o?.counts ?? []).filter(f => (f.metric ?? f.id).endsWith(`:${k}`)).reduce((sum, f) => sum + (num(f) ?? 0), 0);
    const buys = n('strong_buy') + n('buy'), holds = n('hold'), sells = n('sell') + n('strong_sell'), total = buys + holds + sells;
    if (total) used.push(...(o?.counts ?? []));
    const split = total ? say({ cs: `${buys} z ${total} doporučuje koupit, ${holds} držet, ${sells} prodat`, sk: `${buys} z ${total} odporúča kúpiť, ${holds} držať, ${sells} predať`,
      en: `${buys} of ${total} rate it buy, ${holds} hold, ${sells} sell` }) : '';
    if (o?.targetMean) {
      const range = o.targetLow && o.targetHigh ? ` (${show(o.targetLow)} – ${show(o.targetHigh)})` : '';
      const vs = o.targetPotential ? say({ cs: `, tedy ${show(o.targetPotential, true)}`, sk: `, teda ${show(o.targetPotential, true)}`, en: `, ${show(o.targetPotential, true)}` }) : '';
      value.push(say({ cs: `Analytici: ${split ? `${split}; ` : ''}průměrný cíl na 12 měsíců je ${show(o.targetMean)}${range}${vs}.`,
        sk: `Analytici: ${split ? `${split}; ` : ''}priemerný cieľ na 12 mesiacov je ${show(o.targetMean)}${range}${vs}.`,
        en: `Analysts: ${split ? `${split}; ` : ''}the mean 12-month target is ${show(o.targetMean)}${range}${vs}.` }));
    } else if (split) value.push(say({ cs: `Analytici: ${split}.`, sk: `Analytici: ${split}.`, en: `Analysts: ${split}.` }));
    // The latest rating change only (the rest is noise for an outlook).
    const latest = ev.analystChanges[0];
    if (latest) {
      const firm = quotableHeadline(latest.firm), to = latest.to ? quotableHeadline(latest.to) : null, from = latest.from ? quotableHeadline(latest.from) : null, d = dateText(latest.date, lang, false);
      if (firm && to && d) value.push(say(from && from.toLowerCase() === to.toLowerCase()
        ? { cs: `Naposledy ${firm} ${d} potvrdila doporučení ${to}.`, sk: `Naposledy ${firm} ${d} potvrdila odporúčanie ${to}.`, en: `Most recently ${firm} reiterated ${to} on ${d}.` }
        : from ? { cs: `Naposledy ${firm} ${d} změnila doporučení z ${from} na ${to}.`, sk: `Naposledy ${firm} ${d} zmenila odporúčanie z ${from} na ${to}.`, en: `Most recently ${firm} moved from ${from} to ${to} on ${d}.` }
          : { cs: `Naposledy ${firm} ${d} dala doporučení ${to}.`, sk: `Naposledy ${firm} ${d} dala odporúčanie ${to}.`, en: `Most recently ${firm} rated it ${to} on ${d}.` }));
    }
    if (o?.fair) {
      const gap = o.fairPotential ? say({ cs: ` (${show(o.fairPotential, true)})`, sk: ` (${show(o.fairPotential, true)})`, en: ` (${show(o.fairPotential, true)})` }) : '';
      const check = o.analystCheck?.value;
      const vs = typeof check === 'string' ? say(({
        inline: { cs: ', blízko průměrného cíle analytiků', sk: ', blízko priemerného cieľa analytikov', en: ', close to the mean analyst target' },
        below: { cs: ', opatrněji než analytici', sk: ', opatrnejšie než analytici', en: ', more cautious than analysts' },
        above: { cs: ', optimističtěji než analytici', sk: ', optimistickejšie než analytici', en: ', more optimistic than analysts' },
        outside: { cs: ' – mimo celé rozpětí cílů analytiků, takže ho ber s rezervou', sk: ' – mimo celé rozpätie cieľov analytikov, takže ho ber s rezervou', en: ' – outside the whole analyst range, so treat it with caution' },
      } as Record<string, T3>)[check] ?? { cs: '', sk: '', en: '' }) : '';
      value.push(say({ cs: `Model férové hodnoty Trackory vychází na ${show(o.fair)}${gap}${vs}.`, sk: `Model férovej hodnoty Trackory vychádza na ${show(o.fair)}${gap}${vs}.`,
        en: `The Trackora fair value model gives ${show(o.fair)}${gap}${vs}.` }));
      if (o.companyType?.value === 'cyclical') value.push(say({ cs: 'Firma je cyklická, proto model počítá s průměrnou marží za celý cyklus a s nízkým P/E, ne se ziskem z vrcholu.',
        sk: 'Firma je cyklická, preto model počíta s priemernou maržou za celý cyklus a s nízkym P/E, nie so ziskom z vrcholu.',
        en: 'The company is cyclical, so the model uses the margin over the whole cycle and a low P/E, not peak profit.' }));
    }
    if (o?.implied) value.push(say(o.fairModel?.value === 'revenue'
      ? { cs: `Dnešní cena počítá s růstem tržeb zhruba ${show(o.implied)} ročně v prvních dvou letech.`, sk: `Dnešná cena počíta s rastom tržieb zhruba ${show(o.implied)} ročne v prvých dvoch rokoch.`,
        en: `Today's price assumes revenue growth of about ${show(o.implied)} a year for two years.` }
      : { cs: `Dnešní cena počítá s růstem volného cash flow zhruba ${show(o.implied)} ročně.`, sk: `Dnešná cena počíta s rastom voľného cash flow zhruba ${show(o.implied)} ročne.`,
        en: `Today's price assumes free cash flow growth of about ${show(o.implied)} a year.` }));
    // Provider figures when Trackora has no fair value of its own (any listed company, Běh 27).
    if (!o?.fair) {
      if (o?.marketCap) value.push(say({ cs: `Tržní hodnota firmy je ${show(o.marketCap)}.`, sk: `Trhová hodnota firmy je ${show(o.marketCap)}.`, en: `The market capitalisation is ${show(o.marketCap)}.` }));
      if (o?.psNow) value.push(say({ cs: `P/S (cena vůči tržbám) je ${show(o.psNow)}.`, sk: `P/S (cena voči tržbám) je ${show(o.psNow)}.`, en: `The P/S (price to sales) is ${show(o.psNow)}.` }));
      if (o?.revenueGrowth) value.push(say({ cs: `Tržby za poslední rok meziročně: ${show(o.revenueGrowth, true)}.`, sk: `Tržby za posledný rok medziročne: ${show(o.revenueGrowth, true)}.`,
        en: `Revenue over the last year, year on year: ${show(o.revenueGrowth, true)}.` }));
    }
    // The scenarios, in the same section: one line on the method, three prices, one caveat.
    const Y = o?.years ?? 3;
    const scen: string[] = [];
    if (o?.scenarios.length) {
      const sales = o.basis === 'sales' || (o.basis === 'model' && o.modelBasis === 'sales');
      const cyclical = o.companyType?.value === 'cyclical';
      // One line on the method actually used for these prices.
      const method: T3 = sales ? { cs: 'Firma zatím nemá zisk, scénáře proto vycházejí z tržeb a z P/S, které se zmenšuje s tím, jak zpomaluje růst:',
        sk: 'Firma zatiaľ nemá zisk, scenáre preto vychádzajú z tržieb a z P/S, ktoré sa zmenšuje s tým, ako spomaľuje rast:', en: 'No profit yet, so the scenarios work from sales and a P/S that shrinks as growth slows:' }
        : cyclical ? { cs: 'Základní scénář bere zisk podle analytiků a nižší P/E, pesimistický počítá s otočením cyklu, optimistický s delším vrcholem:',
          sk: 'Základný scenár berie zisk podľa analytikov a nižšie P/E, pesimistický počíta s otočením cyklu, optimistický s dlhším vrcholom:', en: 'Base: analysts\' earnings at a lower P/E; bear: the cycle turns; bull: a longer peak:' }
          : o.basis !== 'model' ? { cs: 'Scénáře vycházejí ze zisku na akcii za poslední rok, jeho růstu a P/E:', sk: 'Scenáre vychádzajú zo zisku na akciu za posledný rok, jeho rastu a P/E:',
            en: 'The scenarios grow last year\'s earnings per share and apply a P/E:' }
            : o.fairModel?.value === 'revenue' ? { cs: 'Scénáře vycházejí z tržeb a marže podle analytiků a z P/E odpovídajícího růstu, který firmě ještě zbývá:',
              sk: 'Scenáre vychádzajú z tržieb a marže podľa analytikov a z P/E zodpovedajúceho rastu, ktorý firme ešte zostáva:', en: 'The scenarios use analysts\' revenue and margin and a P/E matching the growth still ahead:' }
              : { cs: 'Scénáře vycházejí z tržeb, marže podle analytiků (jinak obvyklé marže firmy) a P/E z historie firmy:',
                sk: 'Scenáre vychádzajú z tržieb, marže podľa analytikov (inak obvyklej marže firmy) a P/E z histórie firmy:', en: 'The scenarios use revenue, the analysts\' (else the usual) margin and the company\'s historical P/E:' };
      scen.push(say(method));
      const name: Record<string, T3> = { bear: { cs: 'Pesimistický', sk: 'Pesimistický', en: 'Bear' }, base: { cs: 'Základní', sk: 'Základný', en: 'Base' },
        bull: { cs: 'Optimistický', sk: 'Optimistický', en: 'Bull' } };
      for (const s of o.scenarios) {
        const annual = s.annual ? say({ cs: `, ročně ${show(s.annual, true)}`, sk: `, ročne ${show(s.annual, true)}`, en: `, ${show(s.annual, true)} a year` }) : '';
        const margin = s.margin ? say({ cs: `, marže ${show(s.margin)}`, sk: `, marža ${show(s.margin)}`, en: `, margin ${show(s.margin)}` }) : '';
        const growth = o.basis === 'model' || sales ? say({ cs: `tržby ${show(s.growth, true)} ročně`, sk: `tržby ${show(s.growth, true)} ročne`, en: `revenue ${show(s.growth, true)} a year` })
          : say({ cs: `zisk ${show(s.growth, true)} ročně`, sk: `zisk ${show(s.growth, true)} ročne`, en: `EPS ${show(s.growth, true)} a year` });
        scen.push(`• **${say(name[s.kind])}:** ${show(s.price)}${annual} ${say({ cs: `(${growth}${margin}, ${sales ? 'P/S' : 'P/E'} ${show(s.pe)})`,
          sk: `(${growth}${margin}, ${sales ? 'P/S' : 'P/E'} ${show(s.pe)})`, en: `(${growth}${margin}, ${sales ? 'P/S' : 'P/E'} ${show(s.pe)})` })}`);
      }
      scen.push(say({ cs: 'Jsou to modelové scénáře, ne předpověď ani doporučení.', sk: 'Sú to modelové scenáre, nie predpoveď ani odporúčanie.', en: 'These are model scenarios, not a forecast or advice.' }));
    } else if (asks.scenarios) {
      scen.push(say(o?.missing === 'loss' ? { cs: `${T} je teď ve ztrátě a nemá dost dat pro scénáře ceny.`, sk: `${T} je teraz v strate a nemá dosť dát pre scenáre ceny.`,
        en: `${T} is loss-making without enough data for price scenarios.` }
        : { cs: `K ${T} teď nemám účetní výkazy, scénáře ceny proto neumím spočítat.`, sk: `K ${T} teraz nemám účtovné výkazy, scenáre ceny preto neviem spočítať.`,
          en: `There are no financial statements for ${T} right now, so price scenarios cannot be calculated.` }));
    }
    const valuationHeading: T3 = { cs: `Ocenění a kde může být cena za ${Y} ${Y === 1 ? 'rok' : Y < 5 ? 'roky' : 'let'}`,
      sk: `Ocenenie a kde môže byť cena o ${Y} ${Y === 1 ? 'rok' : Y < 5 ? 'roky' : 'rokov'}`, en: `Valuation and where the price could be in ${Y} year${Y === 1 ? '' : 's'}` };
    if (!value.length && !scen.length) value.push(say({ cs: 'Údaje k ocenění firmy teď nemám.', sk: 'Údaje k oceneniu firmy teraz nemám.', en: 'Valuation data is not available right now.' }));
    add('valuation', [say(valuationHeading), ...value, ...(scen.length ? [`\n${scen.join('\n')}`] : [])].join('\n').replace(/\n\n/g, '\n'));

    // The story: the analyst's summary, what the company does, what drives growth, what could stop it.
    const factSummary = (): string => {
      const bits: string[] = [];
      if (o?.targetPotential) bits.push(say({ cs: `analytici v průměru čekají ${show(o.targetPotential, true)} proti dnešní ceně`, sk: `analytici v priemere čakajú ${show(o.targetPotential, true)} oproti dnešnej cene`,
        en: `analysts on average expect ${show(o.targetPotential, true)} from today's price` }));
      if (o?.companyType?.value === 'cyclical') bits.push(say({ cs: 'jde o cyklickou firmu blízko vrcholu cyklu', sk: 'ide o cyklickú firmu blízko vrcholu cyklu', en: 'it is a cyclical company near the top of its cycle' }));
      return bits.length ? `${T}: ${bits.join('; ')}.` : say(OW.summary(T));
    };
    add('summary', `**${W.heading.summary[lang]}:** ${analysis?.summary ? withoutAttribution(plainProse(analysis.summary), outlets) : factSummary()}`);
    if (analysis) {
      newsFacts(cited);
      if (asks.business) add('business', lines(OW.business, themesOf('business').length ? themesOf('business')
        : [say({ cs: `Popis podnikání ${T} se teď z dostupných článků nepodařilo spolehlivě ověřit.`, sk: `Opis podnikania ${T} sa teraz z dostupných článkov nepodarilo spoľahlivo overiť.`,
          en: `What ${T} does could not be verified from the available articles right now.` })]));
      add('growth', lines({ cs: 'Co může táhnout růst', sk: 'Čo môže ťahať rast', en: 'What could drive growth' }, themesOf('strength', 'industry', 'catalysts', 'moat')));
      add('risks', lines(OW.risks, themesOf('risk')));
      add('financials', lines(OW.financials, themesOf('financials')));
      add('management', lines(OW.management, themesOf('management')));
      add('dividends', lines(OW.dividends, themesOf('dividends')));
      add('price', lines(OW.priceMove, themesOf('price_trend')));
    } else add('business', say(OW.noAnalysis));

    if (analysis?.outlook) add('view', `${say(OW.view)}\n${withoutAttribution(plainProse(analysis.outlook), outlets)}\n${say(OW.viewNote)}`);
    else if (asks.full || asks.scenarios) {
      // No view from the analyst: the server's reading of the verified facts, in words only.
      const words: string[] = [];
      const t = num(o?.targetPotential ?? undefined), fp = num(o?.fairPotential ?? undefined);
      if (t !== null) words.push(say(t > 0.1 ? { cs: 'Analytici čekají další růst ceny.', sk: 'Analytici čakajú ďalší rast ceny.', en: 'Analysts expect the price to rise further.' }
        : t < -0.05 ? { cs: 'Analytici vidí cenu spíš níž než dnes.', sk: 'Analytici vidia cenu skôr nižšie než dnes.', en: 'Analysts see the price lower than today.' }
          : { cs: 'Analytici vidí cenu zhruba na dnešní úrovni.', sk: 'Analytici vidia cenu zhruba na dnešnej úrovni.', en: 'Analysts see the price near today\'s level.' }));
      if (fp !== null) words.push(say(fp > 0.15 ? { cs: 'Vlastní model Trackory vychází nad dnešní cenou.', sk: 'Vlastný model Trackory vychádza nad dnešnou cenou.', en: 'Trackora\'s own model comes out above today\'s price.' }
        : fp < -0.15 ? { cs: 'Vlastní model Trackory vychází pod dnešní cenou, valuace je tedy náročná.', sk: 'Vlastný model Trackory vychádza pod dnešnou cenou, valuácia je teda náročná.', en: 'Trackora\'s own model comes out below today\'s price: the valuation is demanding.' }
          : { cs: 'Vlastní model Trackory vychází zhruba na dnešní ceně.', sk: 'Vlastný model Trackory vychádza zhruba na dnešnej cene.', en: 'Trackora\'s own model comes out near today\'s price.' }));
      if (o?.companyType?.value === 'cyclical') words.push(say({ cs: 'Hlavní riziko je otočení cyklu: zisky cyklických firem z vrcholu rychle klesají.',
        sk: 'Hlavné riziko je otočenie cyklu: zisky cyklických firiem z vrcholu rýchlo klesajú.', en: 'The main risk is the cycle turning: cyclical profits fall fast from a peak.' }));
      if (words.length) add('view', `${say(OW.view)}\n${words.join(' ')}\n${say(OW.viewNote)}`);
    }
    // What comes next: the next report date and the analyst's points; past reports and repeats of the date are left out.
    const reported = say({ cs: '• Výsledky hospodaření zveřejnila', sk: '• Hospodárske výsledky zverejnila', en: '• It reported earnings' });
    const nextKnown = !!ev.nextEarnings;
    const specific = watch.filter(w => w !== `• ${say(MW.watchGeneric)}` && !w.startsWith(reported)
      && !(nextKnown && /výsledk|earnings|hospodársk/i.test(w) && !/\d/.test(w)));
    if (specific.length) add('watch', `${say(MW.watch)}\n${specific.join('\n')}`);
    const limits = limitsOf(ev.warnings.filter(w => !/^history_missing/.test(w)), lang);
    if (limits.length) add('limits', `${W.limits[lang]}: ${limits.join(' ')}`);
    const sources = sourcesLine(used, lang);
    if (sources) add('sources', sources);
    const ordered = [...out].sort((a, b) => a.order - b.order);
    return { text: ordered.map(s => s.text).join('\n\n'), links, trace: [], lang, outcome: analysis ? 'ok' : 'fallback', verified: true, sections: ordered };
  }

  const parts = [`**${W.heading.summary[lang]}:** ${summary}`, `${say(MW.happened)}\n${happened.join('\n')}`, reasons, `${say(MW.watch)}\n${watch.join('\n')}`];
  const limits = limitsOf(ev.warnings.filter(w => !/^history_missing/.test(w)), lang);
  if (limits.length) parts.push(`${W.limits[lang]}: ${limits.join(' ')}`);
  const sources = sourcesLine(used, lang);
  if (sources) parts.push(sources);
  return { text: parts.join('\n\n'), links, trace: [], lang, outcome: analysis ? 'ok' : 'fallback', verified: true };
}

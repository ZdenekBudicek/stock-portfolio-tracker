import type { Lang } from './protocol.ts';
import type { AnswerBlock, AnswerBlockKind, AnswerDraft, CalculationRecord, ClaimMeaning, Confidence, Fact, NumericClaim, ReferencedClaim,
  Verdict } from './types.ts';

// A model draft reaches the user only through here: every number and date is a slot bound to a
// fact of this request, including metric, scope and quality. Model blocks select slots only;
// prose and critical conclusions are composed by the server, never inferred from a free sentence.

const LANGS: readonly Lang[] = ['cs', 'sk', 'en'];
const KINDS: readonly AnswerBlockKind[] = ['facts', 'analysts', 'valuation', 'context', 'risks', 'verdict', 'summary'];
const VERDICTS: readonly Verdict[] = ['attractive', 'fair', 'expensive', 'insufficient'];
const CONFIDENCE: readonly Confidence[] = ['low', 'medium', 'high'];
const MEANINGS: readonly ClaimMeaning[] = ['value', 'gain', 'loss', 'change', 'assumption'];
const NUMERIC_UNITS = new Set<Fact['unit']>(['money', 'shares', 'percent', 'ratio', 'count']);
export const ANALYSIS_ORDER: readonly AnswerBlockKind[] = ['analysts', 'valuation', 'context', 'risks', 'verdict'];
const SLOT = /\{\{([A-Za-z0-9_]{1,24})\}\}/g;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const samePeriod = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Ratios shown to people as percentages; their raw value is a fraction.
// Portfolio and benchmark returns are fractions too ("výnos 5,0 %", not "výnos 0,05").
export const PERCENT_RATIO = /:(margin_of_safety|potential|implied_growth|percentile:[A-Za-z]+|volatility_60d|assumption:(growth|discount|terminalGrowth|epsGrowth|dividendGrowth|margin|revenueGrowth|targetMargin|dilution)|portfolio_return|annual_return|benchmark_return|benchmark_annual_return)$/;

/** Decimals the renderer shows for a fact: enough that nothing non-zero is shown as zero. */
export function displayDecimals(fact: Pick<Fact, 'id' | 'unit' | 'value'>): number {
  const v = typeof fact.value === 'number' ? Math.abs(fact.value) : 0;
  const significant = (min: number) => v === 0 ? min : Math.min(8, Math.max(min, 1 - Math.floor(Math.log10(v)) + 1));
  switch (fact.unit) {
    case 'money': return v >= 100_000 || (v >= 1000 && Number.isInteger(v)) ? 0 : v >= 1 ? 2 : significant(2);
    case 'shares': {
      for (let d = 0; d <= 8; d++) if (Math.abs(Number(v.toFixed(d)) - v) <= 1e-12 * Math.max(1, v)) return d;
      return 8;
    }
    case 'percent': return v !== 0 && v < 0.1 ? significant(1) : 1;
    case 'ratio': return PERCENT_RATIO.test(fact.id) ? 3 : v !== 0 && v < 0.01 ? significant(2) : 2;
    default: return 0;
  }
}

/* ----------------------------- localized numbers and dates ----------------------------- */

const CURRENCIES: [RegExp, string][] = [[/^(kč|czk|korun\p{L}*)$/iu, 'CZK'], [/^(usd|us\$|\$|dolar\p{L}*|dollars?)$/iu, 'USD'],
  [/^(eur|€|eur\p{L}*)$/iu, 'EUR'], [/^(gbp|£)$/iu, 'GBP'], [/^(pln|zł)$/iu, 'PLN']];
const currencyOf = (token: string) => CURRENCIES.find(([re]) => re.test(token))?.[1] ?? null;

/** "1 234,56 Kč", "1,234.56 CZK", "-3,35 USD", "$1,234" → value, stated decimals and currency; ambiguous input → null. */
export function parseLocalizedNumber(text: string): { value: number; decimals: number; currency: string | null } | null {
  const t = text.replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\u2212/g, '-').trim();
  const m = /^([^\d\s+-]*)\s*([+-])?\s*([^\d\s+-]*)\s*(\d[\d ,.]*\d|\d)\s*(%|[^\d\s]*)$/u.exec(t);
  if (!m) return null;
  const [, pre1, sign, pre2, digits, post] = m;
  const prefix = (pre1 || pre2 || '').trim(), suffix = post.trim();
  let currency: string | null = null;
  for (const token of [prefix, suffix].filter(Boolean)) {
    if (token === '%') continue;
    const c = currencyOf(token);
    if (!c || (currency && currency !== c)) return null;
    currency = c;
  }
  const compact = digits.replace(/ (?=\d{3}(\D|$))/g, '');
  if (/ /.test(compact)) return null;
  const commas = (compact.match(/,/g) ?? []).length, dots = (compact.match(/\./g) ?? []).length;
  let integer = compact, fraction = '';
  if (commas && dots) {
    const decimalSep = compact.lastIndexOf(',') > compact.lastIndexOf('.') ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    const [i, f = ''] = compact.split(decimalSep);
    if (f.includes(thousandSep) || i.split(thousandSep).slice(1).some(g => g.length !== 3)) return null;
    integer = i.split(thousandSep).join(''); fraction = f;
  } else if (commas || dots) {
    const sep = commas ? ',' : '.', parts = compact.split(sep);
    if (parts.length > 2) {
      if (parts.slice(1).some(g => g.length !== 3)) return null;
      integer = parts.join('');
    } else {
      // "1,234" or "1.234" alone is thousands in one locale and decimals in another: not provable,
      // unless spaces already group the thousands ("1 234,567").
      if (parts[1].length === 3 && !(sep === ',' && digits.includes(' '))) return null;
      integer = parts[0]; fraction = parts[1];
    }
  }
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction)) return null;
  const value = Number(`${sign === '-' ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`);
  return Number.isFinite(value) ? { value, decimals: fraction.length, currency } : null;
}

/** True when a number written in text states this fact: same sign and currency, within half a unit of its last decimal. */
export function groundNumber(text: string, fact: Fact): boolean {
  const parsed = parseLocalizedNumber(text);
  if (!parsed || typeof fact.value !== 'number' || !NUMERIC_UNITS.has(fact.unit)) return false;
  if (parsed.currency && parsed.currency !== (fact.currency ?? null)) return false;
  if (Math.sign(parsed.value) !== Math.sign(fact.value)) return false;
  return Math.abs(parsed.value - fact.value) <= 0.5 * 10 ** -parsed.decimals + 1e-9 * Math.abs(fact.value);
}

const calendar = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** "23 . 10. 2024", "23. 10. 2024", "2024-10-23", "10/23/2024" → ISO date; impossible dates → null. */
export function parseLocalizedDate(text: string): string | null {
  const t = text.replace(/[\u00a0\u202f]/g, ' ').trim();
  let m = /^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})$/.exec(t);
  if (m) return calendar(+m[3], +m[2], +m[1]);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return calendar(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? calendar(+m[3], +m[1], +m[2]) : null;
}

/* ----------------------------- text checks ----------------------------- */

const NUMBER_WORDS: Record<Lang, string[]> = {
  cs: ['dva', 'dvě', 'dvou', 'tři', 'tří', 'čtyři', 'čtyř', 'pět', 'šest', 'sedm', 'osm', 'devět', 'deset', 'jedenáct', 'dvanáct', 'třináct',
    'čtrnáct', 'patnáct', 'šestnáct', 'sedmnáct', 'osmnáct', 'devatenáct', 'dvacet', 'třicet', 'čtyřicet', 'padesát', 'šedesát', 'sedmdesát',
    'osmdesát', 'devadesát', 'sto', 'tisíc', 'tisíce', 'milion', 'miliony', 'milionů', 'miliarda', 'miliardy', 'miliard', 'procent', 'procenta',
    'procento', 'polovina', 'polovinu', 'čtvrtina', 'čtvrtinu', 'dvojnásobek', 'trojnásobek'],
  sk: ['dva', 'dve', 'dvoch', 'tri', 'troch', 'štyri', 'päť', 'šesť', 'sedem', 'osem', 'deväť', 'desať', 'jedenásť', 'dvanásť', 'trinásť',
    'štrnásť', 'pätnásť', 'šestnásť', 'sedemnásť', 'osemnásť', 'devätnásť', 'dvadsať', 'tridsať', 'štyridsať', 'päťdesiat', 'šesťdesiat',
    'sedemdesiat', 'osemdesiat', 'deväťdesiat', 'sto', 'tisíc', 'milión', 'milióny', 'miliónov', 'miliarda', 'miliardy', 'miliárd', 'percent',
    'percento', 'percentá', 'polovica', 'polovicu', 'štvrtina', 'dvojnásobok'],
  // "ten" is left out: in Czech it is a pronoun, and every language's list is applied to every answer.
  en: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
    'thousand', 'million', 'millions', 'billion', 'billions', 'trillion', 'percent', 'percentage', 'dozen', 'double', 'triple', 'twice'],
};
// Upper-case words that are not instrument tickers.
export const NOT_TICKERS = new Set(['USD', 'CZK', 'EUR', 'GBP', 'PLN', 'ETF', 'EPS', 'DCF', 'EBITDA', 'EV', 'PE', 'PS', 'FCF', 'HHI', 'CEO', 'CFO',
  'AI', 'USA', 'EU', 'ČNB', 'CNB', 'SEC', 'IPO', 'GDP', 'OK', 'IT', 'S&P', 'NASDAQ', 'NYSE', 'DPH', 'ČR', 'SR', 'UK', 'US', 'FIFO']);
const CURRENCY_NEAR_SLOT = /\{\{\w+\}\}\s*(kč|czk|usd|eur|gbp|pln|us\$|\$|€|£|zł|dolar\p{L}*|korun\p{L}*|eur\p{L}*)(?![\p{L}])|(kč|czk|usd|eur|gbp|pln|\$|€|£)\s*\{\{/iu;
const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])`, 'iu');
// A number word in any supported language counts, whatever the answer's language.
const NUMBER_WORD_PATTERNS = [...new Set(Object.values(NUMBER_WORDS).flat())].map(word);

/** Problems of free text around slots; an empty list means the text states nothing unverified. */
export function textProblems(text: string, _lang: Lang): string[] {
  const problems: string[] = [];
  // "S&P 500" is the index's name, not a figure.
  const bare = text.replace(SLOT, ' ').replace(/S&P\s?500/g, 'S&P');
  if (/<|>/.test(bare)) problems.push('html');
  if (/[{}[\]]/.test(bare)) problems.push('json');
  if (/!\[|\]\(/.test(text)) problems.push('markdown');
  if (/\b(?:https?|javascript|data|ftp):|\bwww\.|\b[a-z0-9-]+\.(?:com|cz|sk|org|net|io|example)\b/i.test(bare)) problems.push('url');
  if (/\b[a-z][A-Za-z_]*:[A-Za-z0-9_.#-]+/.test(bare) || /\bget_[a-z_]+|\bcalculate\b|\bsimulate_sale\b/.test(bare)
    || /\b[A-Za-z]+_[A-Za-z0-9_]+\b/.test(bare) || /\b(as_of|factId|claimId|sourceIds|toolCalls?|json)\b/i.test(bare)) problems.push('technical');
  if (/\d/.test(bare) || /%|‰/.test(bare)) problems.push('unslotted_number');
  if (NUMBER_WORD_PATTERNS.some(re => re.test(bare))) problems.push('number_word');
  if (CURRENCY_NEAR_SLOT.test(text)) problems.push('currency_text');
  return problems;
}

/* ----------------------------- claims ----------------------------- */

// Keys whose value can be a gain or a loss; a price, target or holding value never can.
const SIGNED_KEY = /(profit|gain|:net$|realized|pnl|tax_delta|change|return|potential|price_change|^calc:)/;

function claimProblems(id: string, claim: unknown, fact: Fact | undefined, calcs: readonly CalculationRecord[], facts: ReadonlyMap<string, Fact>): string[] {
  if (!record(claim) || typeof claim.factId !== 'string') return [`claim_invalid:${id}`];
  if (!fact) return [`unknown_fact:${id}`];
  if (fact.source === 'calculate') {
    const rec = calcs.find(r => r.id === fact.id);
    if (!rec || rec.result.id !== fact.id || rec.result.value !== fact.value || rec.inputs.some(input => facts.get(input.id) !== input)) {
      return [`calculation_unverified:${id}`];
    }
  }
  if (fact.value === null) return [`null_fact:${id}`];
  const problems: string[] = [];
  if (claim.metric !== fact.metric) problems.push(`metric:${id}`);
  if (claim.scope !== fact.scope) problems.push(`scope:${id}`);
  if (!samePeriod(claim.quality, fact.quality)) problems.push(`quality:${id}`);
  if (claim.unit !== fact.unit) problems.push(`unit:${id}`);
  if ((claim.ticker ?? null) !== (fact.ticker ?? null)) problems.push(`ticker:${id}`);
  if (!samePeriod(claim.period, fact.period)) problems.push(`period:${id}`);
  if (NUMERIC_UNITS.has(fact.unit)) {
    const value = claim.value, decimals = claim.decimals, meaning = claim.meaning as ClaimMeaning;
    if ((claim.currency ?? null) !== (fact.currency ?? null)) problems.push(`currency:${id}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof fact.value !== 'number') return [...problems, `value:${id}`];
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 10) return [...problems, `decimals:${id}`];
    if (Math.sign(value) !== Math.sign(fact.value)) problems.push(`sign:${id}`);
    if (Math.abs(value - fact.value) > 0.5 * 10 ** -decimals + 1e-12 * Math.abs(fact.value)) problems.push(`value:${id}`);
    if (fact.value !== 0 && Number(fact.value.toFixed(decimals)) === 0) problems.push(`rounds_to_zero:${id}`);
    if (!MEANINGS.includes(meaning)) problems.push(`meaning:${id}`);
    const assumed = fact.source === 'assumption' || fact.source === 'user';
    if (assumed !== (meaning === 'assumption')) problems.push(`meaning:${id}`);
    if ((meaning === 'gain' || meaning === 'loss') && !SIGNED_KEY.test(fact.id)) problems.push(`meaning:${id}`);
    if (meaning === 'gain' && !(fact.value > 0)) problems.push(`meaning:${id}`);
    if (meaning === 'loss' && !(fact.value < 0)) problems.push(`meaning:${id}`);
  } else if (claim.value !== fact.value) problems.push(`value:${id}`);
  return problems;
}

/** Tickers named in a sentence must be the ticker of every slot in that sentence. */
function tickerProblems(text: string, claims: Record<string, unknown>, facts: ReadonlyMap<string, Fact>): string[] {
  const problems: string[] = [];
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    const slots = [...sentence.matchAll(SLOT)].map(m => m[1]);
    if (!slots.length) continue;
    const named = (sentence.replace(SLOT, ' ').match(/(?<![\p{L}\p{N}])[A-Z][A-Z0-9.]{1,9}(?![\p{L}\p{N}])/gu) ?? []).filter(t => !NOT_TICKERS.has(t));
    for (const slot of slots) {
      const claim = claims[slot];
      const ticker = record(claim) && typeof claim.factId === 'string' ? facts.get(claim.factId)?.ticker : undefined;
      if (ticker && named.some(t => t !== ticker)) problems.push(`ticker_text:${slot}`);
    }
  }
  return problems;
}

// `explain`: a general investing question. The model's own sentences are allowed, but every check of free text stays —
// no digits, percentages, number words, links or technical names outside {{slots}} bound to facts — and no conclusion.
// `custom`: an intent with its own writer contract (move_explanation) validates the whole draft itself.
export type ValidationResult = { ok: true; draft: AnswerDraft } | { ok: false; reasons: string[] };
export type ValidateOptions = { lang?: Lang; analysis?: { verdict: Verdict; maxConfidence: Confidence }; serverTemplate?: boolean;
  requiredFactIds?: string[]; evidenceMissing?: boolean; explain?: boolean; custom?: (draft: unknown) => ValidationResult };
const EXPLAIN_KINDS: readonly AnswerBlockKind[] = ['facts', 'context'];

export const isFactSelection = (text: string) => text.replace(SLOT, '').trim() === '';

export function validateAnswer(draft: unknown, facts: ReadonlyMap<string, Fact>, calculations: readonly CalculationRecord[],
  options: ValidateOptions = {}): ValidationResult {
  if (options.custom) return options.custom(draft);
  if (!record(draft)) return { ok: false, reasons: ['not_object'] };
  const reasons: string[] = [];
  const selected = new Set<string>();
  const lang = draft.lang as Lang;
  if (!LANGS.includes(lang)) return { ok: false, reasons: ['lang'] };
  if (options.lang && lang !== options.lang) reasons.push('lang');
  if (!Array.isArray(draft.blocks) || draft.blocks.length < 1 || draft.blocks.length > 9) return { ok: false, reasons: [...reasons, 'blocks'] };
  draft.blocks.forEach((raw, b) => {
    if (!record(raw) || !KINDS.includes(raw.kind as AnswerBlockKind) || typeof raw.text !== 'string' || raw.text.length > 1500
      || !record(raw.claims) || !Array.isArray(raw.sourceIds) || (raw.ticker !== undefined && typeof raw.ticker !== 'string')) {
      reasons.push(`block_invalid:${b}`);
      return;
    }
    const claims = raw.claims as Record<string, unknown>;
    if (options.explain && !EXPLAIN_KINDS.includes(raw.kind as AnswerBlockKind)) reasons.push(`block_invalid:${b}`);
    if (!options.serverTemplate && !options.explain && !isFactSelection(raw.text)) reasons.push(`unbound_prose:${b}`);
    reasons.push(...textProblems(raw.text, lang).map(p => `${p}:${b}`));
    const used = new Set([...raw.text.matchAll(SLOT)].map(m => m[1]));
    if (options.explain ? !raw.text.replace(SLOT, '').trim() && used.size === 0
      : !options.serverTemplate && !options.analysis && (raw.kind !== 'facts' || used.size === 0)) reasons.push(`empty_selection:${b}`);
    for (const slot of used) if (!(slot in claims)) reasons.push(`missing_claim:${b}`);
    for (const [id, claim] of Object.entries(claims)) {
      if (!used.has(id)) { reasons.push(`unused_claim:${b}`); continue; }
      const fact = record(claim) && typeof claim.factId === 'string' ? facts.get(claim.factId) : undefined;
      if (fact) selected.add(fact.id);
      reasons.push(...claimProblems(id, claim, fact, calculations, facts));
      if (raw.ticker && fact?.ticker && fact.ticker !== raw.ticker) reasons.push(`ticker_block:${id}`);
    }
    reasons.push(...tickerProblems(raw.text, claims, facts));
    for (const source of raw.sourceIds) if (typeof source !== 'string' || !facts.has(source)) reasons.push(`unknown_source:${b}`);
  });
  if (options.evidenceMissing || options.requiredFactIds?.some(id => !selected.has(id))) reasons.push('intent_incomplete');
  if (options.explain && (draft.verdict !== undefined || draft.confidence !== undefined || draft.wouldChange !== undefined)) reasons.push('unbound_conclusion');
  if (draft.verdict !== undefined && !VERDICTS.includes(draft.verdict as Verdict)) reasons.push('verdict');
  if (draft.confidence !== undefined && !CONFIDENCE.includes(draft.confidence as Confidence)) reasons.push('confidence');
  if (draft.wouldChange !== undefined) {
    if (!options.serverTemplate && draft.wouldChange !== 'evidence') reasons.push('unbound_conclusion');
    if (typeof draft.wouldChange !== 'string' || draft.wouldChange.length > 300) reasons.push('would_change');
    else reasons.push(...textProblems(draft.wouldChange, lang).map(p => `${p}:would_change`));
  }
  if (options.analysis) {
    const kinds = (draft.blocks as Record<string, unknown>[]).map(b => b?.kind);
    let at = 0;
    for (const kind of kinds) if (kind === ANALYSIS_ORDER[at]) at++;
    if (at < ANALYSIS_ORDER.length || kinds.filter(k => k !== 'facts').length !== ANALYSIS_ORDER.length) reasons.push('analysis_structure');
    if (draft.verdict !== options.analysis.verdict) reasons.push('analysis_verdict');
    const confidence = CONFIDENCE.indexOf(draft.confidence as Confidence);
    if (confidence < 0 || confidence > CONFIDENCE.indexOf(options.analysis.maxConfidence)) reasons.push('analysis_confidence');
    if (typeof draft.wouldChange !== 'string' || !draft.wouldChange.trim()) reasons.push('analysis_would_change');
  }
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, draft: JSON.parse(JSON.stringify(draft)) as AnswerDraft };
}

/**
 * Completes compact claims (`{factId, meaning}`) from their facts: the model names which fact it
 * cites and what it means, the server fills value, unit, currency, ticker and period. Fields the
 * model did state are kept, so a misstated value still fails validation.
 */
export function expandDraft(draft: unknown, facts: ReadonlyMap<string, Fact>): unknown {
  if (!record(draft) || !Array.isArray(draft.blocks)) return draft;
  return { ...draft, blocks: draft.blocks.map(block => {
    if (!record(block)) return block;
    if ('factIds' in block) {
      // A compact selection must not silently discard conflicting prose or claim metadata.
      if (Object.keys(block).some(k => !['kind', 'factIds'].includes(k)) || !Array.isArray(block.factIds)
        || block.factIds.length > 40 || block.factIds.some(id => typeof id !== 'string')) return { kind: block.kind };
      block = { kind: block.kind, text: block.factIds.map((_, i) => `{{s${i}}}`).join(' '),
        claims: Object.fromEntries(block.factIds.map((id, i) => [`s${i}`, { factId: id }])) };
    }
    const claims = record(block.claims) ? block.claims : {};
    return { ...block, sourceIds: Array.isArray(block.sourceIds) ? block.sourceIds : [], claims: Object.fromEntries(Object.entries(claims).map(([id, claim]) => {
      const fact = record(claim) && typeof claim.factId === 'string' ? facts.get(claim.factId) : undefined;
      if (!fact || !record(claim)) return [id, claim];
      const assumed = fact.source === 'assumption' || fact.source === 'user';
      const base: Record<string, unknown> = { factId: fact.id, value: fact.value, unit: fact.unit,
        ...(fact.metric ? { metric: fact.metric } : {}), ...(fact.scope ? { scope: fact.scope } : {}), ...(fact.quality ? { quality: fact.quality } : {}),
        ...(fact.currency ? { currency: fact.currency } : {}), ...(fact.ticker ? { ticker: fact.ticker } : {}), ...(fact.period ? { period: fact.period } : {}),
        ...(NUMERIC_UNITS.has(fact.unit) ? { decimals: displayDecimals(fact), meaning: assumed ? 'assumption' : 'value' } : {}) };
      return [id, { ...base, ...Object.fromEntries(Object.entries(claim).filter(([, v]) => v !== undefined && v !== null)) }];
    })) };
  }) };
}

export type { NumericClaim, ReferencedClaim, AnswerBlock };

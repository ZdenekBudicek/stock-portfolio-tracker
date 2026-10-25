import { memo } from './context.ts';
import { RETRIEVAL_TIME_NOTE } from './marketTypes.ts';
import type { LlmMessage } from './llm.ts';
import type { ToolCtx, ToolErrorCode } from './types.ts';

const ERROR_TEXT: Record<ToolErrorCode, string> = {
  invalid: 'Invalid arguments.', clarify: 'Ask the user to clarify the selection in Trackora.',
  unsupported: 'This calculation is not supported for the supplied inputs.',
  unavailable: 'The data source is unavailable.', timeout: 'The data source did not answer in time.',
};
export const modelError = (code: ToolErrorCode) => ERROR_TEXT[code] ?? ERROR_TEXT.unavailable;

// Only authored categories cross the boundary; suffixes and unknown free text stay local.
const WARNING_CODES = new Set(['missing_fx', 'unmatched_sells', 'unresolved_asset_kind', 'estimate_not_tax_advice',
  'quote_missing', 'quote_currency', 'quote_time_unknown', 'quote_stale', 'usdczk_from_snapshot', 'usdczk_stale',
  'fact_undated', 'fact_not_finite', 'currency_unknown', 'benchmark', 'volatility_returns', 'analyst_opinion',
  'untrusted_external_text', 'non_trade_rows_excluded', 'return_quality', 'position_history_missing', 'forecast_is_estimate',
  'withholding_assumed', 'projections_excluded', 'sector_comparison_unavailable', 'history_points', 'account_only_holder',
  'shares_exceed_account', 'tax', 'last_stored_close', 'fx_cache_only', 'fx_missing', 'refresh_failed', 'targets_unavailable',
  'projection_rows_trimmed', 'projection_data_omitted', 'projection_facts_omitted', 'additional_warning']);
export function modelWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.map(w => w === RETRIEVAL_TIME_NOTE ? w : WARNING_CODES.has(w.split(':')[0]) ? w.split(':')[0] : 'additional_warning'))];
}

/** Request-local redaction before either model sees conversation text or a tool-call echo. */
export function modelMessages(ctx: ToolCtx): Promise<(messages: LlmMessage[]) => LlmMessage[]> {
  return memo(ctx, 'model_privacy', async () => {
    const { data } = await ctx.loadSnapshot();
    const identifiers = new Set<string>();
    for (const row of [...data.transactions, ...data.dividends, ...data.deposits]) {
      if (row.broker_account) identifiers.add(row.broker_account);
      if (row.broker) identifiers.add(row.broker);
    }
    const values = [...new Set([...identifiers].flatMap(id => [id, JSON.stringify(id).slice(1, -1)]))].sort((a, b) => b.length - a.length);
    const redact = (text: string) => values.reduce((value, id) => value.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[private]'), text);
    return messages => messages.map(m => ({ ...m, content: m.content === null ? null : redact(m.content),
      ...(m.toolCalls ? { toolCalls: m.toolCalls.map(c => ({ ...c, arguments: redact(c.arguments) })) } : {}) }));
  });
}

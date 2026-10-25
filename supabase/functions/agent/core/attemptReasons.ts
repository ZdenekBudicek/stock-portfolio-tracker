/** Audit codes only: never store a provider message, rejected draft, value or identifier. */
export const REJECTION_CODES = new Set(['invalid', 'not_object', 'lang', 'blocks', 'block_invalid', 'unbound_prose', 'empty_selection', 'missing_claim',
  'unused_claim', 'unknown_source', 'intent_incomplete', 'verdict', 'confidence', 'unbound_conclusion', 'would_change',
  'analysis_structure', 'analysis_verdict', 'analysis_confidence', 'analysis_would_change', 'html', 'json', 'markdown', 'url',
  'technical', 'unslotted_number', 'number_word', 'currency_text', 'claim_invalid', 'unknown_fact', 'calculation_unverified',
  'null_fact', 'metric', 'scope', 'quality', 'unit', 'ticker', 'period', 'currency', 'value', 'decimals', 'sign', 'rounds_to_zero',
  'meaning', 'ticker_block', 'ticker_text', 'truncated', 'finish_reason', 'route_schema', 'tool_call_format', 'tool_not_allowed',
  'http', 'http_400', 'http_401', 'http_403', 'http_404', 'http_413', 'http_422', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504', 'http_other',
  'invalid_request_error', 'tool_use_failed', 'invalid_api_key', 'model_not_found', 'rate_limit_exceeded', 'server_error', 'provider_error',
  'json_validate_failed', 'param_response_format', 'param_messages', 'param_tool_choice', 'param_tools', 'param_max_completion_tokens',
  'param_max_tokens', 'param_reasoning_effort', 'param_include_reasoning', 'param_stop', 'param_temperature',
  'schema', 'response_size', 'timeout', 'empty', 'provider', 'budget', 'policy', 'config', 'network', 'quota', 'cancelled',
  'input_bound_exceeded', 'usage_exceeded',
  // News analyst (Běh 23).
  'summary', 'themes', 'theme_invalid', 'watch', 'sentences', 'unbacked_number', 'unattributed_number', 'injection',
  // Details of the analyst shape codes (Běh 24 observability).
  'wrong_publisher', 'outlook', 'unbacked_name', 'unbacked_event',
  'summary_missing', 'summary_empty', 'summary_type', 'summary_long', 'themes_none', 'themes_missing', 'themes_few', 'themes_many', 'sentences_few', 'sentences_many', 'watch_shape', 'watch_long', 'at_summary', 'at_watch', 'at_theme']);

export const sanitizeReasons = (reasons: readonly string[]) => [...new Set(reasons.map(r => {
  const code = r.split(':')[0];
  return REJECTION_CODES.has(code) ? code : 'invalid';
}))].slice(0, 10);

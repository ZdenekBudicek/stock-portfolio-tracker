export type Lang = 'cs' | 'sk' | 'en';
export type Link = { url: string; title: string };
export type ViewPreferences = {
  displayCurrency: 'USD' | 'CZK' | 'EUR' | 'GBP' | 'PLN';
  localCurrency: 'CZK' | 'EUR' | 'GBP' | 'PLN';
  tax: { fxMethod: 'cnb-daily' | 'gfr-annual'; limitIncludesExempt: boolean };
};
export type ChatRequest = { requestId: string; threadId?: string; question: string; lang?: Lang; preferences?: ViewPreferences };
export type ChatMessage = { id: string; requestId: string; seq: number; role: 'user' | 'assistant'; content: string; lang: Lang; createdAt: string;
  /** An answer's stored links: the allowlist its inline links need after a reload (audit A8). */
  links?: Link[] };
export type TraceItem = { label: string; state: 'running' | 'ok' | 'unavailable'; source?: string; asOf?: string };
export type AgentEvent =
  | { type: 'meta'; requestId: string; threadId: string; remainingToday: number | null }
  | { type: 'status'; text: string }
  | { type: 'trace'; items: TraceItem[] }
  /** A part of the coming answer, final as sent (Ocenění v3: the valuation while the analyst still writes); `order`
   * places it in the reading order. The `answer` that follows is the whole verified text and replaces the parts. */
  | { type: 'section'; key: string; order: number; text: string }
  | { type: 'answer'; text: string; links: Link[]; verified: true }
  | { type: 'error'; code: 'auth' | 'quota' | 'timeout' | 'failed' | 'conflict' | 'invalid'; text: string; retryAt?: string }
  | { type: 'done'; requestId: string; persisted: boolean; outcome: 'ok' | 'fallback' | 'quota' | 'timeout' | 'error' | 'cancelled' };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseChatRequest(value: unknown): ChatRequest {
  if (!record(value) || typeof value.requestId !== 'string' || !uuid.test(value.requestId)
    || (value.threadId !== undefined && (typeof value.threadId !== 'string' || !uuid.test(value.threadId)))
    || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 2000
    || (value.lang !== undefined && !['cs', 'sk', 'en'].includes(String(value.lang)))) {
    throw new Error('Invalid chat request');
  }
  if (value.preferences !== undefined) {
    const p = value.preferences;
    if (!record(p) || !['USD', 'CZK', 'EUR', 'GBP', 'PLN'].includes(String(p.displayCurrency))
      || !['CZK', 'EUR', 'GBP', 'PLN'].includes(String(p.localCurrency)) || !record(p.tax)
      || !['cnb-daily', 'gfr-annual'].includes(String(p.tax.fxMethod)) || typeof p.tax.limitIncludesExempt !== 'boolean') {
      throw new Error('Invalid preferences');
    }
  }
  // Whitelist fields: a client-supplied owner never reaches the chat service.
  return { requestId: value.requestId, question: value.question, threadId: value.threadId as string | undefined,
    lang: value.lang as Lang | undefined, preferences: value.preferences as ViewPreferences | undefined };
}

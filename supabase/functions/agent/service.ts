import { answerQuestion, type ChatOutcome } from './core/agent.ts';
import { type RequestBudget, stageBudget } from './core/budget.ts';
import type { AgentLib } from './core/calculations.ts';
import { createToolContext, runsOf } from './core/context.ts';
import type { ReadContext, Reservation, RunMetrics, StoredAnswer } from './core/dataTypes.ts';
import { createTokenBudget, type LlmDeps } from './core/llm.ts';
import type { AgentDb, MarketSource, PortfolioRepo } from './core/ports.ts';
import { type AgentEvent, type ChatMessage, type ChatRequest, type Lang, parseChatRequest, type ViewPreferences } from './core/protocol.ts';
import { executeTool, exportToolSchemas } from './core/registry.ts';
import { detectLang } from './core/router.ts';
import type { CalculationRecord, Fact, ToolCtx } from './core/types.ts';
import { agentPath, readBody } from './handler.ts';
import type { VerifiedUser } from './live/auth.ts';

// The chat service of one verified user: reserve the request (quota, thread, replay) before any
// model, answer, store the verified result, and only then send the final answer and `done`.
// Created per request after authentication, so no client, cache or JWT is shared between users.

type T3 = Record<Lang, string>;
const TEXT = {
  busy: { cs: 'Ještě se připravuje tvoje předchozí odpověď. Počkej prosím chvíli a zkus to znovu.',
    sk: 'Ešte sa pripravuje tvoja predchádzajúca odpoveď. Počkaj prosím chvíľu a skús to znova.',
    en: 'Your previous answer is still being prepared. Please wait a moment and try again.' },
  conflict: { cs: 'Tento dotaz už byl odeslán s jiným obsahem, nebo vlákno už neexistuje. Polož prosím nový dotaz.',
    sk: 'Táto otázka už bola odoslaná s iným obsahom alebo vlákno už neexistuje. Polož prosím novú otázku.',
    en: 'This request was already sent with different content, or the conversation no longer exists. Please ask a new question.' },
  quota: { cs: 'Dnešních 20 dotazů je vyčerpáno. Další bude možné položit zítra.', sk: 'Dnešných 20 otázok je vyčerpaných. Ďalšie bude možné položiť zajtra.',
    en: 'Today\'s 20 questions are used up. You can ask again tomorrow.' },
  // The shared daily cap of the free models (every account together), not this user's own 20.
  shared: { cs: 'Dnešní kapacita bezplatných modelů je vyčerpaná pro všechny uživatele. Zkus to prosím zítra.',
    sk: 'Dnešná kapacita bezplatných modelov je vyčerpaná pre všetkých používateľov. Skús to prosím zajtra.',
    en: 'Today\'s free model capacity is used up for everyone. Please try again tomorrow.' },
  invalid: { cs: 'Dotaz nemá platné nastavení. Obnov prosím stránku.', sk: 'Otázka nemá platné nastavenia. Obnov prosím stránku.',
    en: 'The question has invalid settings. Please reload the page.' },
  storage: { cs: 'Historie teď není dostupná, dotaz se proto nespustil. Zkus to prosím za chvíli.',
    sk: 'História teraz nie je dostupná, otázka sa preto nespustila. Skús to prosím o chvíľu.',
    en: 'History is unavailable right now, so the question was not started. Please try again shortly.' },
  notSaved: { cs: 'Odpověď se nepodařilo uložit do historie; po obnovení stránky ji neuvidíš.',
    sk: 'Odpoveď sa nepodarilo uložiť do histórie; po obnovení stránky ju neuvidíš.',
    en: 'The answer could not be saved to your history; it will not be there after a reload.' },
} satisfies Record<string, T3>;

export const DEFAULT_PREFERENCES: ViewPreferences = { displayCurrency: 'USD', localCurrency: 'CZK', tax: { fxMethod: 'cnb-daily', limitIncludesExempt: true } };

/** Local evaluation evidence of one chat run; exists only in the loopback test runner, never in production. */
export type EvalAudit = { metrics: RunMetrics; facts: Fact[]; calculations: CalculationRecord[]; toolsUsed: string[]; snapshotId: string };

export type ServiceDeps = { db: AgentDb; repo: PortfolioRepo; market: MarketSource; lib: AgentLib; llm: LlmDeps;
  /** Today's date in Prague (the quota day); tests pin it to the fixture date. */
  today?: () => string; now?: () => number; audit?: (requestId: string, audit: EvalAudit) => void };

export const pragueToday = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(ms));

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function fingerprintOf(input: ChatRequest, lang: Lang): Promise<string> {
  const canonical = JSON.stringify([input.question, lang, input.threadId ?? null, input.preferences ?? null]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}
const executionToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** Turns a producer that emits events into an async stream; the producer's own failure ends the stream with it. */
async function* pump(work: (emit: (event: AgentEvent) => void) => Promise<void>): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null, finished = false, failure: unknown = null;
  const running = work(event => { queue.push(event); wake?.(); })
    .catch(error => { failure = error ?? new Error('Service failed'); })
    .finally(() => { finished = true; wake?.(); });
  while (!finished || queue.length) {
    if (queue.length) { yield queue.shift()!; continue; }
    await new Promise<void>(resolve => { wake = resolve; });
    wake = null;
  }
  await running;
  if (failure) throw failure;
}

/** What is stored for a finished run: the verified answer, or the human error text as a terminal message. */
function storedOf(result: ChatOutcome, lang: Lang): StoredAnswer {
  // The streamed sections are a delivery detail: the stored answer is its verified text (no second copy).
  if (result.answer) { const { sections: _sections, ...answer } = result.answer; return { ...answer, lang }; }
  const outcome = result.outcome === 'timeout' ? 'timeout' : 'error';
  return { text: result.error?.text ?? TEXT.storage[lang], links: [], trace: [], lang, outcome, verified: true };
}

function replayEvents(requestId: string, reservation: Extract<Reservation, { kind: 'replay' }>): AgentEvent[] {
  const a = reservation.answer;
  return [
    { type: 'meta', requestId, threadId: reservation.threadId, remainingToday: reservation.remainingToday },
    a.outcome === 'ok' || a.outcome === 'fallback'
      ? { type: 'answer', text: a.text, links: a.links, verified: true }
      : { type: 'error', code: a.outcome === 'timeout' ? 'timeout' : 'failed', text: a.text },
    { type: 'done', requestId, persisted: true, outcome: a.outcome },
  ];
}

export function createChatService(deps: ServiceDeps): (input: ChatRequest, user: VerifiedUser, budget: RequestBudget) => AsyncIterable<AgentEvent> {
  const now = deps.now ?? Date.now;
  return (raw, _user, budget) => pump(async emit => {
    const started = now();
    const uiLang: Lang = raw?.lang === 'sk' || raw?.lang === 'en' ? raw.lang : 'cs';
    let input: ChatRequest;
    // Context and preferences are checked against the schema again here; residence and tax profile come from the server.
    try { input = parseChatRequest(raw); } catch {
      emit({ type: 'error', code: 'invalid', text: TEXT.invalid[uiLang] });
      emit({ type: 'done', requestId: String(raw?.requestId ?? ''), persisted: false, outcome: 'error' });
      return;
    }
    const { requestId } = input;
    // The stored language of the request: the question's own, else the UI's.
    const lang: Lang = detectLang(input.question) ?? input.lang ?? 'cs';
    const read: ReadContext = { signal: budget.signal, deadline: stageBudget(budget).deadline };
    const token = executionToken();
    let reservation: Reservation;
    try {
      reservation = await deps.db.begin({ requestId, ...(input.threadId ? { threadId: input.threadId } : {}), question: input.question, lang,
        fingerprint: await fingerprintOf(input, lang), executionToken: token }, read);
    } catch {
      if (budget.signal.aborted) { emit({ type: 'done', requestId, persisted: false, outcome: 'cancelled' }); return; }
      emit({ type: 'error', code: 'failed', text: TEXT.storage[lang] });
      emit({ type: 'done', requestId, persisted: false, outcome: 'error' });
      return;
    }
    if (reservation.kind === 'replay') { replayEvents(requestId, reservation).forEach(emit); return; }
    if (reservation.kind !== 'accepted') {
      const quota = reservation.kind === 'quota';
      emit({ type: 'error', code: quota ? 'quota' : 'conflict', text: TEXT[quota && reservation.scope === 'shared' ? 'shared' : reservation.kind][lang], ...(reservation.retryAt ? { retryAt: reservation.retryAt } : {}) });
      emit({ type: 'done', requestId, persisted: false, outcome: quota ? 'quota' : 'error' });
      return;
    }
    emit({ type: 'meta', requestId, threadId: reservation.threadId, remainingToday: reservation.remainingToday });

    // Stored history of the thread (the agent gives the model only the last four messages).
    let history: ChatMessage[] = [];
    if (input.threadId) {
      try { history = (await deps.db.loadThread(input.threadId, read))?.messages.filter(m => m.requestId !== requestId) ?? []; }
      catch { if (budget.signal.aborted) { emit({ type: 'done', requestId, persisted: false, outcome: 'cancelled' }); return; } }
    }
    const ctx: ToolCtx = createToolContext({ repo: deps.repo, market: deps.market, lib: deps.lib, budget, today: (deps.today ?? pragueToday)(),
      lang: input.lang ?? lang, preferences: input.preferences ?? DEFAULT_PREFERENCES });
    let firstEventAt: number | null = null;
    const result = await answerQuestion({ request: input, history }, { ctx, llm: { ...deps.llm, tokens: createTokenBudget() } }, event => {
      firstEventAt ??= now();
      emit(event);
    });
    if (result.outcome === 'cancelled') { emit({ type: 'done', requestId, persisted: false, outcome: 'cancelled' }); return; }
    const stored = storedOf(result, lang);
    const metrics: RunMetrics = { ...result.metrics, outcome: stored.outcome, wallMs: Math.round(now() - started),
      ttftMs: firstEventAt === null ? null : Math.round(firstEventAt - started) };
    const runs = runsOf(ctx), firstOk = runs.find(r => r.result.ok)?.result;
    deps.audit?.(requestId, { metrics, facts: [...ctx.facts.values()], calculations: [...ctx.calculations],
      toolsUsed: runs.map(r => r.name).filter((n, i, all) => all.indexOf(n) === i),
      snapshotId: firstOk?.ok ? firstOk.meta.snapshotId : '' });
    let persisted = false;
    // Stored before the final answer reaches the client; the last 3 s of the budget belong to this.
    try {
      await deps.db.complete({ requestId, executionToken: token, answer: stored, metrics }, { signal: budget.signal, deadline: budget.deadline });
      persisted = true;
    } catch {
      if (budget.signal.aborted) { emit({ type: 'done', requestId, persisted: false, outcome: 'cancelled' }); return; }
      emit({ type: 'status', text: TEXT.notSaved[lang] });
    }
    // The final trace ("how I got there"), including fallback tools that ran without progress events.
    if (stored.trace.length) emit({ type: 'trace', items: stored.trace });
    if (result.answer) emit({ type: 'answer', text: stored.text, links: stored.links, verified: true });
    else emit({ type: 'error', code: result.error?.code ?? 'failed', text: stored.text, ...(result.error?.retryAt ? { retryAt: result.error.retryAt } : {}) });
    emit({ type: 'done', requestId, persisted, outcome: result.outcome });
  });
}

/* ----------------------------- other routes ----------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export type ToolRequest = { requestId: string; args: unknown };

export type RouteDeps = {
  db: AgentDb;
  /**
   * Direct tool calls (AGENT_DIRECT_TOOLS_ENABLED): null in production (404). `reserve` makes every
   * call take one request of the same daily quota under its request ID; the loopback fixture runner omits it.
   */
  directTools: null | { context: (budget: RequestBudget) => Omit<ToolCtx, 'facts' | 'calculations' | 'loadSnapshot'>; reserve?: boolean };
  /** Loopback eval runner only: audit of a finished chat request. */
  evalAudit?: (requestId: string) => EvalAudit | null;
};

/** `GET /agent/tools`, `POST /agent/tools/:name`, own thread history and the local eval audit; null = 404. */
export function createAgentRoutes(deps: RouteDeps): (req: Request, user: VerifiedUser, budget: RequestBudget) => Promise<Response | null> {
  return async (req, _user, budget) => {
    const path = agentPath(req.url);
    if (!path) return null;
    const read: ReadContext = { signal: budget.signal, deadline: budget.deadline };
    const parts = path.split('/').slice(2);
    if (parts[0] === 'tools' && parts.length === 1 && req.method === 'GET') {
      return json(200, { tools: exportToolSchemas().map(({ name, description, group, inputSchema, outputSchema }) => ({ name, description, group, inputSchema, outputSchema })) });
    }
    if (parts[0] === 'tools' && parts.length === 2 && req.method === 'POST') {
      if (!deps.directTools || !exportToolSchemas().some(t => t.name === parts[1])) return null;
      let body: unknown;
      try { body = await readBody(req, budget.signal); } catch { return json(400, { text: 'Invalid body' }); }
      const request = body as Partial<ToolRequest> | null;
      if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || !UUID.test(request.requestId) || !('args' in request)) {
        return json(400, { text: 'Invalid tool request' });
      }
      const token = executionToken();
      if (deps.directTools.reserve) {
        const reservation = await deps.db.begin({ requestId: request.requestId, question: `Tool ${parts[1]}`, lang: 'en',
          fingerprint: await fingerprintOf({ requestId: request.requestId, question: `${parts[1]} ${JSON.stringify(request.args)}` }, 'en'), executionToken: token }, read);
        if (reservation.kind === 'quota') return json(429, { text: 'Daily limit reached', ...(reservation.retryAt ? { retryAt: reservation.retryAt } : {}) });
        if (reservation.kind !== 'accepted') return json(409, { text: 'Request ID already used' });
      }
      const ctx = createToolContext(deps.directTools.context(budget));
      const result = await executeTool(parts[1], request.args, ctx);
      if (deps.directTools.reserve) {
        await deps.db.complete({ requestId: request.requestId, executionToken: token, answer: { text: 'Tool run.', links: [], trace: [], lang: 'en', outcome: 'ok', verified: true },
          metrics: { model: null, routerModel: null, tokensIn: 0, tokensOut: 0, maxCallTokens: 0, toolCalls: 1, toolsUsed: [parts[1]], wallMs: 0, ttftMs: null,
            outcome: 'ok', groundingOk: true, calculationVersion: result.ok ? result.meta.calculationVersion : 'n/a', errorCode: result.ok ? null : (result as Extract<typeof result, { ok: false }>).error.code } }, read);
      }
      return json(200, result);
    }
    if (parts[0] === 'threads' && parts.length === 1 && req.method === 'GET') return json(200, { threads: await deps.db.listThreads(read) });
    if (parts[0] === 'threads' && parts.length === 2) {
      if (!UUID.test(parts[1])) return req.method === 'GET' || req.method === 'DELETE' ? json(404, { text: 'Not found' }) : null;
      if (req.method === 'GET') {
        const history = await deps.db.loadThread(parts[1], read);
        return history ? json(200, history) : json(404, { text: 'Not found' });
      }
      if (req.method === 'DELETE') return await deps.db.deleteThread(parts[1], read) ? new Response(null, { status: 204 }) : json(404, { text: 'Not found' });
    }
    if (deps.evalAudit && parts[0] === 'eval' && parts[1] === 'runs' && parts.length === 3 && req.method === 'GET') {
      const audit = deps.evalAudit(parts[2]);
      return audit ? json(200, audit) : json(404, { text: 'Not found' });
    }
    return null;
  };
}

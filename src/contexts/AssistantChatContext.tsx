// State of the assistant chat for the signed-in user: the open thread, its messages, the running
// request and the saved thread list. It sits inside Auth/Currency and above LanguageProvider, so a
// language switch remounts the panel but keeps the conversation. Everything is keyed by user: an
// identity change aborts the request and clears what the previous user saw, and a late chunk of an
// old request (user, request, generation) is dropped. Privacy mode cancels and hides it all.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, ChatRequest, Link, TraceItem, ViewPreferences } from '../../supabase/functions/agent/core/protocol.ts';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { readTaxPrefs } from '@/hooks/useTaxPrefs';
import { currentLang } from '@/i18n';
import { abortableEvents, AssistantHttpError, assistantConfig, createAssistantTransport, type AssistantTransport, type Thread } from '@/lib/assistantTransport';
import { SseError } from '@/lib/sse';

/** `live`: arrived in this session, so the chat writes it out paragraph by paragraph instead of showing it at once. */
export type UiMessage = ChatMessage & { links?: Link[]; trace?: TraceItem[]; unsaved?: boolean; live?: boolean };
export type ChatError = { code: string; text: string; retryAt?: string };
export type AssistantChat = {
  messages: UiMessage[]; threads: Thread[]; threadId: string | null; pending: boolean; status: string | null; trace: TraceItem[];
  remainingToday: number | null; error: ChatError | null;
  send(question: string): Promise<void>; retry(): Promise<void>; selectThread(id: string): Promise<void>; newThread(): void;
  deleteThread(id: string): Promise<void>; setTaxViewOverride(value: ViewPreferences['tax'] | null): void;
  /** The unsent question; cleared with everything else on a user switch. */
  draft: string; setDraft(value: string): void;
  /** True while privacy mode hides the conversation. */
  hidden: boolean;
  /** Whether the chat panel is open; every entry point (top bar, launcher, ask bar, Ctrl/Cmd+K) shares it. */
  open: boolean; setOpen(open: boolean): void;
  /** Opens the panel and sends the question at once. In privacy mode it only opens the panel (which shows the
   * privacy notice) and keeps the question nowhere; while an answer is running the question waits as the draft. */
  ask(question: string): Promise<void>;
};

/** The client gives the server 45 s plus a margin; then it stops waiting (the server limit is not extended). */
export const STILL_WORKING_MS = 10_000, CLIENT_TIMEOUT_MS = 50_000;

type State = Pick<AssistantChat, 'messages' | 'threads' | 'threadId' | 'pending' | 'status' | 'trace' | 'remainingToday' | 'error' | 'draft'>;
const EMPTY: State = { messages: [], threads: [], threadId: null, pending: false, status: null, trace: [], remainingToday: null, error: null, draft: '' };

const AssistantChatContext = createContext<AssistantChat | null>(null);
export const useAssistantChatContext = () => useContext(AssistantChatContext);

type Active = { key: string; controller: AbortController; clear: () => void };

export function AssistantChatProvider({ children, transport: given }: { children: ReactNode; transport?: AssistantTransport }) {
  const { t } = useTranslation();
  const transport = useMemo(() => given ?? createAssistantTransport(assistantConfig().mode), [given]);
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { currency, local, hidden } = useCurrency();
  const [state, setState] = useState<State>(EMPTY);
  const [open, setOpen] = useState(false);
  const active = useRef<Active | null>(null);
  const reads = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const owner = useRef<string | null>(userId);
  const [stateOwner, setStateOwner] = useState(userId);
  const lastRequest = useRef<ChatRequest | null>(null);
  // The request whose failure the server stored (a terminal error/timeout): retrying its ID would only replay it.
  const settledFailure = useRef<string | null>(null);
  const cache = useRef(new Map<string, UiMessage[]>());
  const taxOverride = useRef<ViewPreferences['tax'] | null>(null);
  const view = useRef({ currency, local, hidden, userId, threadId: state.threadId, t });
  view.current = { currency, local, hidden, userId, threadId: stateOwner === userId ? state.threadId : null, t };

  /** Cancels the running request and anything still in flight for an older view. */
  const stop = useCallback(() => {
    generation.current++;
    active.current?.clear();
    active.current?.controller.abort();
    active.current = null;
  }, []);

  const cancelReads = useCallback(() => {
    for (const controller of reads.current) controller.abort();
    reads.current.clear();
  }, []);
  useEffect(() => () => { stop(); cancelReads(); }, [stop, cancelReads]);

  const loadThreads = useCallback(async () => {
    const gen = generation.current, uid = view.current.userId;
    if (!uid || view.current.hidden) return;
    const controller = new AbortController();
    reads.current.add(controller);
    try {
      const threads = await transport.threads(controller.signal);
      if (!controller.signal.aborted && view.current.userId === uid && !view.current.hidden && gen === generation.current) setState(s => ({ ...s, threads }));
    } catch { /* the list is optional; the chat still works */ }
    finally { reads.current.delete(controller); }
  }, [transport]);

  // A different identity (sign-out, A→B) sees nothing of the previous one.
  useEffect(() => {
    if (owner.current !== userId) {
      stop();
      cancelReads();
      cache.current.clear();
      lastRequest.current = null;
      taxOverride.current = null;
      setState(EMPTY);
      setOpen(false);
      setStateOwner(userId);
      owner.current = userId;
    }
    void loadThreads();
  }, [userId, stop, cancelReads, loadThreads]);

  // Privacy mode: cancel, and keep no text in state that could reach the DOM; reload own history after.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (hidden === wasHidden.current) return;
    wasHidden.current = hidden;
    if (hidden) {
      stop();
      cancelReads();
      cache.current.clear();
      setState(s => ({ ...EMPTY, threadId: s.threadId, remainingToday: s.remainingToday }));
      return;
    }
    void loadThreads();
    const id = view.current.threadId;
    if (id) void selectRef.current(id);
  }, [hidden, stop, cancelReads, loadThreads]);

  const preferences = (): ViewPreferences => ({
    displayCurrency: view.current.currency as ViewPreferences['displayCurrency'],
    localCurrency: view.current.local as ViewPreferences['localCurrency'],
    tax: taxOverride.current ?? readTaxPrefs(),
  });

  const run = useCallback(async (request: ChatRequest) => {
    const uid = view.current.userId;
    if (!uid) return;
    stop();
    const gen = generation.current;
    const key = `${uid}:${request.requestId}:${gen}`;
    const controller = new AbortController();
    const live = () => active.current?.key === key && view.current.userId === uid && !view.current.hidden;
    const tr = view.current.t;
    let slow: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const resetSlow = () => {
      clearTimeout(slow);
      slow = setTimeout(() => { if (live()) setState(s => ({ ...s, status: tr('assistant.status.still') })); }, STILL_WORKING_MS);
    };
    const hard = setTimeout(() => {
      if (!live()) return;
      timedOut = true;
      active.current?.clear();
      active.current = null;
      setState(s => ({ ...s, pending: false, status: null, error: { code: 'timeout', text: tr('assistant.errors.timeout') },
        messages: s.messages.map(m => m.requestId === request.requestId && m.role === 'assistant' ? { ...m, unsaved: true } : m) }));
      controller.abort(new DOMException('Client timeout', 'TimeoutError'));
    }, CLIENT_TIMEOUT_MS);
    active.current = { key, controller, clear: () => { clearTimeout(slow); clearTimeout(hard); } };
    // Shown at once, before any server event (auth may be slow).
    setState(s => ({ ...s, pending: true, status: tr('assistant.status.sending'), trace: [], error: null }));
    resetSlow();
    let trace: TraceItem[] = [];
    let threadId: string | null = request.threadId ?? null;
    let finished = false;
    let failure: ChatError | null = null;
    try {
      for await (const event of abortableEvents(transport.stream(request, controller.signal), controller.signal)) {
        if (!live()) return;
        resetSlow();
        if (event.type === 'meta') {
          threadId = event.threadId;
          setState(s => ({ ...s, threadId: event.threadId, remainingToday: event.remainingToday ?? s.remainingToday,
            threads: s.threads.some(x => x.id === event.threadId) ? s.threads
              : [{ id: event.threadId, title: request.question.slice(0, 120), updatedAt: new Date().toISOString() }, ...s.threads] }));
        } else if (event.type === 'status') {
          setState(s => ({ ...s, status: event.text }));
        } else if (event.type === 'trace') {
          trace = [...trace.filter(item => !event.items.some(n => n.label === item.label)), ...event.items];
          const snapshot = trace;
          setState(s => ({ ...s, trace: snapshot }));
        } else if (event.type === 'section') {
          // A part finished early (the valuation) is not shown ahead of the text above it: the answer is written
          // from its top once complete, so nothing is ever inserted into text the user is reading.
        } else if (event.type === 'answer') {
          const message: UiMessage = { id: `local-${request.requestId}-a`, requestId: request.requestId, seq: Number.MAX_SAFE_INTEGER, role: 'assistant',
            content: event.text, lang: request.lang ?? 'cs', createdAt: new Date().toISOString(), links: event.links, trace, live: true };
          setState(s => ({ ...s, messages: [...s.messages.filter(m => m.id !== message.id), message] }));
        } else if (event.type === 'error') {
          failure = { code: event.code, text: event.text, ...(event.retryAt ? { retryAt: event.retryAt } : {}) };
        } else if (event.type === 'done') {
          finished = true;
          if (event.persisted && (event.outcome === 'error' || event.outcome === 'timeout')) settledFailure.current = request.requestId;
          if (!event.persisted && event.outcome !== 'cancelled') {
            setState(s => ({ ...s, messages: s.messages.map(m => m.requestId === request.requestId && m.role === 'assistant' ? { ...m, unsaved: true } : m) }));
          }
          break;
        }
      }
      if (!finished && live()) failure = { code: 'stream', text: tr('assistant.errors.stream') };
    } catch (error) {
      if (!live()) return;
      if (timedOut) failure = { code: 'timeout', text: tr('assistant.errors.timeout') };
      else if (error instanceof AssistantHttpError) {
        const code = error.status === 401 || error.status === 403 ? 'auth' : error.status === 429 ? 'quota' : error.status === 503 ? 'unavailable' : 'server';
        failure = { code, text: tr(`assistant.errors.${code}`), ...(error.retryAt ? { retryAt: error.retryAt } : {}) };
      } else if (error instanceof SseError) failure = { code: 'stream', text: tr('assistant.errors.stream') };
      else failure = { code: 'offline', text: tr('assistant.errors.offline') };
    } finally {
      if (active.current?.key === key) {
        active.current.clear();
        active.current = null;
        const done = failure;
        setState(s => {
          const next = { ...s, pending: false, status: null, error: done };
          if (threadId && view.current.userId === uid) cache.current.set(`${uid}:${threadId}`, next.messages);
          return next;
        });
      }
    }
  }, [stop, transport]);

  const send = useCallback(async (raw: string) => {
    const question = raw.trim();
    if (!question || view.current.hidden || !view.current.userId || owner.current !== view.current.userId || active.current) return;
    const request: ChatRequest = { requestId: crypto.randomUUID(), question, lang: currentLang(), preferences: preferences(),
      ...(view.current.threadId ? { threadId: view.current.threadId } : {}) };
    lastRequest.current = request;
    const message: UiMessage = { id: `local-${request.requestId}-q`, requestId: request.requestId, seq: Number.MAX_SAFE_INTEGER, role: 'user',
      content: question, lang: request.lang ?? 'cs', createdAt: new Date().toISOString() };
    setState(s => ({ ...s, draft: '', error: null, messages: [...s.messages, message] }));
    await run(request);
  }, [run]);

  /**
   * The same request again (same ID): the server replays a finished answer or reports it still running.
   * A failure the server already stored is asked again under a new ID (a new question of the daily 20).
   */
  const retry = useCallback(async () => {
    if (!lastRequest.current || active.current || view.current.hidden || owner.current !== view.current.userId) return;
    // The new ID stays in the conversation the failed question opened (its `meta` gave the thread), not a new one.
    if (settledFailure.current === lastRequest.current.requestId) {
      const threadId = lastRequest.current.threadId ?? view.current.threadId ?? undefined;
      lastRequest.current = { ...lastRequest.current, requestId: crypto.randomUUID(), ...(threadId ? { threadId } : {}) };
    }
    await run(lastRequest.current);
  }, [run]);

  const selectThread = useCallback(async (id: string) => {
    const uid = view.current.userId;
    if (!uid || view.current.hidden) return;
    stop();
    const gen = generation.current;
    lastRequest.current = null;
    const cached = cache.current.get(`${uid}:${id}`);
    setState(s => ({ ...s, threadId: id, messages: cached ?? [], trace: [], error: null, pending: false, status: null }));
    if (cached) return;
    const controller = new AbortController();
    reads.current.add(controller);
    try {
      const history = await transport.history(id, controller.signal);
      if (controller.signal.aborted || gen !== generation.current || view.current.userId !== uid || view.current.hidden) return;
      cache.current.set(`${uid}:${id}`, history.messages);
      setState(s => ({ ...s, messages: history.messages }));
    } catch {
      if (!controller.signal.aborted && gen === generation.current && view.current.userId === uid && !view.current.hidden) setState(s => ({ ...s, error: { code: 'history', text: view.current.t('assistant.errors.history') } }));
    } finally { reads.current.delete(controller); }
  }, [stop, transport]);
  const selectRef = useRef(selectThread);
  selectRef.current = selectThread;

  const newThread = useCallback(() => {
    stop();
    lastRequest.current = null;
    setState(s => ({ ...s, threadId: null, messages: [], trace: [], error: null, pending: false, status: null }));
  }, [stop]);

  const deleteThread = useCallback(async (id: string) => {
    const uid = view.current.userId;
    if (!uid || view.current.hidden) return;
    const gen = generation.current, controller = new AbortController();
    reads.current.add(controller);
    const live = () => !controller.signal.aborted && gen === generation.current && view.current.userId === uid && !view.current.hidden;
    try { await transport.remove(id, controller.signal); } catch {
      if (live()) setState(s => ({ ...s, error: { code: 'history', text: view.current.t('assistant.errors.history') } }));
      return;
    } finally { reads.current.delete(controller); }
    if (!live()) return;
    cache.current.delete(`${uid}:${id}`);
    if (view.current.threadId === id) newThread();
    setState(s => ({ ...s, threads: s.threads.filter(x => x.id !== id) }));
  }, [newThread, transport]);

  const ask = useCallback(async (raw: string) => {
    setOpen(true);
    const question = raw.trim();
    if (!question || view.current.hidden) return;
    if (active.current) { setState(s => ({ ...s, draft: question })); return; }
    await send(question);
  }, [send]);

  const setTaxViewOverride = useCallback((value: ViewPreferences['tax'] | null) => { taxOverride.current = value; }, []);
  const setDraft = useCallback((draft: string) => setState(s => ({ ...s, draft })), []);

  // Nothing of the conversation leaves this provider while privacy mode is on.
  const visible: State = stateOwner !== userId ? EMPTY : hidden ? { ...EMPTY, threadId: state.threadId, remainingToday: state.remainingToday } : state;
  const value: AssistantChat = { ...visible, hidden, send, retry, selectThread, newThread, deleteThread, setTaxViewOverride, setDraft, open, setOpen, ask };
  return <AssistantChatContext.Provider value={value}>{children}</AssistantChatContext.Provider>;
}

/** Taxes page: its current (possibly one-look) settings apply to the next question; leaving the page forgets them. */
export function useAssistantTaxOverride(settings: ViewPreferences['tax']) {
  const chat = useAssistantChatContext();
  const set = chat?.setTaxViewOverride;
  const { fxMethod, limitIncludesExempt } = settings;
  useEffect(() => { set?.({ fxMethod, limitIncludesExempt }); }, [set, fxMethod, limitIncludesExempt]);
  useEffect(() => () => set?.(null), [set]);
}

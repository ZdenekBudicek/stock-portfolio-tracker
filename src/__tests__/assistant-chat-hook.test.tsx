import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';
import i18n from '@/i18n';
import LanguageProvider from '@/i18n/LanguageProvider';

// Identity, currency and privacy come from the app's contexts; here they are switchable fakes.
const auth = vi.hoisted(() => ({ user: { id: 'user-a' } as { id: string } | null }));
const money = vi.hoisted(() => ({ currency: 'USD', local: 'CZK', hidden: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, session: null, loading: false, signOut: async () => {} }) }));
vi.mock('@/contexts/CurrencyContext', () => ({ useCurrency: () => money }));
vi.mock('@/integrations/supabase/client', () => { throw new Error('tests never reach the family Supabase client'); });

const { AssistantChatProvider, useAssistantTaxOverride } = await import('@/contexts/AssistantChatContext');
const { useAssistantChat } = await import('@/hooks/useAssistantChat');
const { AssistantPanel } = await import('@/components/assistant/AssistantPanel');
const { AssistantSlot } = await import('@/components/assistant/AssistantButton');
const { AssistantHttpError } = await import('@/lib/assistantTransport');
import type { AssistantTransport } from '@/lib/assistantTransport';

/** A transport whose streams the test drives event by event. */
function scripted() {
  const requests: ChatRequest[] = [];
  const signals: AbortSignal[] = [];
  const streams: { push(e: AgentEvent): void; fail(e: unknown): void; end(): void }[] = [];
  const history = vi.fn(async (id: string) => ({ thread: { id, title: 'Uložené vlákno', updatedAt: '2026-10-23' }, messages: [
    { id: 'm1', requestId: 'r1', seq: 1, role: 'user' as const, content: 'Uložená otázka', lang: 'cs' as const, createdAt: '2026-10-23' },
    { id: 'm2', requestId: 'r1', seq: 2, role: 'assistant' as const, content: 'Uložená odpověď', lang: 'cs' as const, createdAt: '2026-10-23' }] }));
  const transport: AssistantTransport = {
    stream(input, signal) {
      requests.push(input); signals.push(signal);
      const queue: (AgentEvent | { error: unknown } | null)[] = [];
      let wake: (() => void) | null = null;
      streams.push({ push: e => { queue.push(e); wake?.(); }, fail: error => { queue.push({ error }); wake?.(); }, end: () => { queue.push(null); wake?.(); } });
      return (async function* () {
        while (true) {
          if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          if (!queue.length) {
            await new Promise<void>(resolve => { wake = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
            continue;
          }
          const next = queue.shift()!;
          if (next === null) return;
          if ('error' in next) throw next.error;
          yield next;
        }
      })();
    },
    threads: vi.fn(async () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Uložené vlákno', updatedAt: '2026-10-23' }]),
    history,
    remove: vi.fn(async () => {}),
  };
  return { transport, requests, signals, streams, history };
}

const wrapperFor = (transport: AssistantTransport) => ({ children }: { children: ReactNode }) => (
  <AssistantChatProvider transport={transport}>{children}</AssistantChatProvider>
);
const meta = (requestId: string): AgentEvent => ({ type: 'meta', requestId, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', remainingToday: 18 });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { auth.user = { id: 'user-a' }; Object.assign(money, { currency: 'USD', local: 'CZK', hidden: false }); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); void i18n.changeLanguage('cs'); });

describe('useAssistantChat', () => {
  it('masks every field on the first render after A→B, before effects run', async () => {
    const s = scripted();
    const seen: ReturnType<typeof useAssistantChat>[] = [];
    const { result, rerender } = renderHook(() => { const chat = useAssistantChat(); seen.push(chat); return chat; }, { wrapper: wrapperFor(s.transport) });
    await flush();
    act(() => { result.current.setDraft('private draft'); void result.current.send('private question'); });
    await flush();
    act(() => s.streams[0].push(meta(s.requests[0].requestId)));
    await flush();
    seen.length = 0;
    auth.user = { id: 'user-b' };
    rerender();
    expect(seen[0]).toMatchObject({ messages: [], threads: [], draft: '', trace: [], threadId: null,
      pending: false, status: null, error: null, remainingToday: null });
  });

  it('unmount aborts streams and list/history reads and clears the timers', async () => {
    vi.useFakeTimers();
    const s = scripted(), reads: AbortSignal[] = [];
    s.transport.threads = async signal => { reads.push(signal); return new Promise(() => {}); };
    s.transport.history = async (_id, signal) => { reads.push(signal); return new Promise(() => {}); };
    const { result, unmount } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    act(() => { void result.current.selectThread('thread'); void result.current.send('question'); });
    await flush();
    unmount();
    expect(s.signals[0].aborted).toBe(true);
    expect(reads.length).toBe(2);
    expect(reads.every(s => s.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at 50 s even when the iterator ignores abort, permits retry and drops its late answer', async () => {
    vi.useFakeTimers();
    const s = scripted();
    let release!: () => void;
    s.transport.stream = async function* () {
      await new Promise<void>(resolve => { release = resolve; });
      yield { type: 'answer', text: 'late secret', links: [], verified: true };
    };
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    act(() => { void result.current.send('question'); });
    await act(async () => { vi.advanceTimersByTime(50_000); });
    expect(result.current.pending).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.error?.code).toBe('timeout');
    const late = release;
    act(() => { void result.current.retry(); });
    expect(result.current.pending).toBe(true);
    await act(async () => { late(); });
    expect(result.current.messages.some(m => m.content === 'late secret')).toBe(false);
    expect(result.current.pending).toBe(true);
  });

  it('retries a failure the server stored under a new ID, and an unconfirmed one under the same ID (replay)', async () => {
    const s = scripted();
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    act(() => { void result.current.send('question'); });
    const first = s.requests[0].requestId;
    await act(async () => {
      s.streams[0].push(meta(first));
      s.streams[0].push({ type: 'error', code: 'failed', text: 'Odpověď se nepodařila.' });
      s.streams[0].push({ type: 'done', requestId: first, persisted: true, outcome: 'error' });
    });
    expect(result.current.pending).toBe(false);
    act(() => { void result.current.retry(); });
    const second = s.requests[1].requestId;
    expect(second).not.toBe(first);
    expect(s.requests[1].question).toBe('question');
    // The first question opened a thread (meta); the retry asks in it instead of opening another.
    expect(s.requests[0].threadId).toBeUndefined();
    expect(s.requests[1].threadId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    // The stream breaks before `done`: the server may still have the answer, so the same ID asks for its replay.
    await act(async () => { s.streams[1].fail(new TypeError('network')); });
    act(() => { void result.current.retry(); });
    expect(s.requests[2].requestId).toBe(second);
  });

  it('shows a local status at once, "still working" after 10 s of silence, and aborts with a retry at 50 s', async () => {
    vi.useFakeTimers();
    const s = scripted();
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    await flush();
    act(() => { void result.current.send('Kolik jsem letos nakoupil?'); });
    expect(result.current.pending).toBe(true);
    expect(result.current.status).toBeTruthy();
    const local = result.current.status;
    await flush();
    act(() => s.streams[0].push(meta(s.requests[0].requestId)));
    await flush();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(result.current.status).not.toBe(local);
    expect(result.current.status).toMatch(/pořád|still/i);
    await act(async () => { vi.advanceTimersByTime(40_000); });
    await flush();
    expect(s.signals[0].aborted).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.error?.code).toBe('timeout');
    act(() => { void result.current.retry(); });
    await flush();
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1].requestId).toBe(s.requests[0].requestId);
    expect(s.requests[1].question).toBe(s.requests[0].question);
    expect(result.current.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('streams an answer into the thread and ends on done; EOF without done is an explicit error', async () => {
    const s = scripted();
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    await flush();
    await act(async () => {
      const sent = result.current.send('Kolik jsem letos nakoupil?');
      await Promise.resolve();
      const id = s.requests[0].requestId;
      s.streams[0].push(meta(id));
      s.streams[0].push({ type: 'trace', items: [{ label: 'Obchody', state: 'ok' }] });
      s.streams[0].push({ type: 'answer', text: 'Letos jsi nakoupil za 1 000 USD.', links: [], verified: true });
      s.streams[0].push({ type: 'done', requestId: id, persisted: true, outcome: 'ok' });
      await sent;
    });
    expect(result.current.threadId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(result.current.remainingToday).toBe(18);
    expect(result.current.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(result.current.pending).toBe(false);
    await act(async () => {
      const sent = result.current.send('A dividendy?');
      await Promise.resolve();
      expect(s.requests[1].threadId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      s.streams[1].push(meta(s.requests[1].requestId));
      s.streams[1].end();
      await sent;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.error?.code).toBe('stream');
  });

  it('never shows a section sent early ahead of the text above it: the answer is written from its top', async () => {
    const s = scripted();
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    await flush();
    let sent!: Promise<void>, id = '';
    await act(async () => {
      sent = result.current.send('Analýza DELL a cena za 2 roky?');
      await Promise.resolve();
      id = s.requests[0].requestId;
      s.streams[0].push(meta(id));
      s.streams[0].push({ type: 'section', key: 'valuation', order: 50, text: 'Ocenění a kde může být cena za 2 roky' });
      await flush();
    });
    expect(result.current.messages.filter(m => m.role === 'assistant')).toHaveLength(0);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      s.streams[0].push({ type: 'answer', text: '**Shrnutí:** firma roste.\n\nOcenění a kde může být cena za 2 roky', links: [], verified: true });
      s.streams[0].push({ type: 'done', requestId: id, persisted: true, outcome: 'ok' });
      await sent;
    });
    const answers = result.current.messages.filter(m => m.role === 'assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ live: true, content: '**Shrnutí:** firma roste.\n\nOcenění a kde může být cena za 2 roky' });
  });

  it.each([
    [401, 'auth', /přihlas/i], [429, 'quota', /limit|vyčerp/i], [500, 'server', /nepodařil|chyb/i], [503, 'unavailable', /dostupn|vypnut/i],
  ] as const)('maps HTTP %i before the stream to its own human message', async (status, code, text) => {
    const s = scripted();
    const { result } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    await flush();
    await act(async () => {
      const sent = result.current.send('Kolik?');
      await Promise.resolve();
      s.streams[0].fail(new AssistantHttpError(status, status === 429 ? '2026-10-24T22:00:00Z' : undefined));
      await sent;
    });
    expect(result.current.error).toMatchObject({ code });
    expect(result.current.error?.text).toMatch(text);
    if (status === 429) expect(result.current.error?.retryAt).toBe('2026-10-24T22:00:00Z');
  });

  it('a user switch mid-stream aborts, clears history, trace, draft and thread, and drops the late chunk of the old user', async () => {
    const s = scripted();
    const { result, rerender } = renderHook(() => useAssistantChat(), { wrapper: wrapperFor(s.transport) });
    await flush();
    act(() => { void result.current.send('Tajná otázka A'); });
    await flush();
    act(() => { s.streams[0].push(meta(s.requests[0].requestId)); s.streams[0].push({ type: 'trace', items: [{ label: 'Pozice', state: 'ok' }] }); });
    await flush();
    act(() => result.current.setDraft('rozepsané A'));
    auth.user = { id: 'user-b' };
    rerender();
    await flush();
    expect(s.signals[0].aborted).toBe(true);
    act(() => s.streams[0].push({ type: 'answer', text: 'Pozdní odpověď A', links: [], verified: true }));
    await flush();
    expect(result.current.messages).toEqual([]);
    expect(result.current.trace).toEqual([]);
    expect(result.current.threadId).toBeNull();
    expect(result.current.draft).toBe('');
    expect(result.current.pending).toBe(false);
    auth.user = null;
    rerender();
    await flush();
    expect(result.current.messages).toEqual([]);
  });

  it('sends the shown currency and the Taxes override with the next request, and forgets the override when Taxes unmounts', async () => {
    localStorage.setItem('trackora.taxPrefs', JSON.stringify({ fxMethod: 'cnb-daily', limitIncludesExempt: true }));
    money.currency = 'EUR'; money.local = 'EUR';
    const s = scripted();
    const Taxes = ({ fx, incl }: { fx: 'gfr-annual' | 'cnb-daily'; incl: boolean }) => { useAssistantTaxOverride({ fxMethod: fx, limitIncludesExempt: incl }); return null; };
    // Outside the provider (assistant off) the Taxes page hook does nothing.
    render(<Taxes fx="gfr-annual" incl={false} />).unmount();
    // The override hook needs the same provider: render both inside one tree.
    const Probe = () => { const chat = useAssistantChat(); probe.current = chat; return null; };
    const probe: { current: ReturnType<typeof useAssistantChat> | null } = { current: null };
    const tree = render(<AssistantChatProvider transport={s.transport}><Probe /><Taxes fx="gfr-annual" incl={false} /></AssistantChatProvider>);
    await flush();
    await act(async () => { void probe.current!.send('Jaká je moje daň?'); await Promise.resolve(); });
    expect(s.requests.at(-1)!.preferences).toEqual({ displayCurrency: 'EUR', localCurrency: 'EUR', tax: { fxMethod: 'gfr-annual', limitIncludesExempt: false } });
    act(() => { s.streams.at(-1)!.push({ type: 'done', requestId: s.requests.at(-1)!.requestId, persisted: true, outcome: 'ok' }); });
    await flush();
    tree.rerender(<AssistantChatProvider transport={s.transport}><Probe /></AssistantChatProvider>);
    await act(async () => { void probe.current!.send('A teď?'); await Promise.resolve(); });
    expect(s.requests.at(-1)!.preferences?.tax).toEqual({ fxMethod: 'cnb-daily', limitIncludesExempt: true });
  });

  it('a language switch remounts the UI but keeps the history; a Slovak question does not change the UI language', async () => {
    const s = scripted();
    const seen: number[] = [];
    let mounts = 0;
    const Consumer = () => {
      const chat = useAssistantChat();
      seen.push(chat.messages.length);
      probe.current = chat;
      return <div data-testid="count">{chat.messages.length}</div>;
    };
    const probe: { current: ReturnType<typeof useAssistantChat> | null } = { current: null };
    const Counted = () => { mounts++; return <Consumer />; };
    const MountCounter = () => <Counted />;
    render(<AssistantChatProvider transport={s.transport}><LanguageProvider><MountCounter /></LanguageProvider></AssistantChatProvider>);
    await flush();
    await act(async () => {
      const sent = probe.current!.send('Koľko som tento rok nakúpil?');
      await Promise.resolve();
      const id = s.requests[0].requestId;
      s.streams[0].push(meta(id));
      s.streams[0].push({ type: 'answer', text: 'Tento rok ste nakúpili za 1 000 USD.', links: [], verified: true });
      s.streams[0].push({ type: 'done', requestId: id, persisted: true, outcome: 'ok' });
      await sent;
    });
    expect(i18n.language).toBe('cs');
    expect(screen.getByTestId('count').textContent).toBe('2');
    const before = mounts;
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(mounts).toBeGreaterThan(before);
    expect(screen.getByTestId('count').textContent).toBe('2');
  });
});

describe('privacy mode and mounting', () => {
  it('hides the whole conversation, thread titles and trace from the DOM, disables the composer and cancels the stream', async () => {
    const s = scripted();
    const view = render(<AssistantChatProvider transport={s.transport}><AssistantPanel open onOpenChange={() => {}} /></AssistantChatProvider>);
    await flush();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Tajná otázka o NVDA' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    act(() => { s.streams[0].push(meta(s.requests[0].requestId)); s.streams[0].push({ type: 'trace', items: [{ label: 'Tajný krok', state: 'ok' }] });
      s.streams[0].push({ type: 'status', text: 'Tajný stav' }); });
    await flush();
    expect(document.body.textContent).toContain('Tajná otázka o NVDA');
    money.hidden = true;
    view.rerender(<AssistantChatProvider transport={s.transport}><AssistantPanel open onOpenChange={() => {}} /></AssistantChatProvider>);
    await flush();
    act(() => s.streams[0].push({ type: 'answer', text: 'Tajná odpověď', links: [], verified: true }));
    await flush();
    const html = document.body.innerHTML;
    for (const secret of ['Tajná otázka', 'Tajný krok', 'Tajný stav', 'Tajná odpověď', 'Uložené vlákno']) expect(html).not.toContain(secret);
    expect(s.signals[0].aborted).toBe(true);
    expect(screen.getByRole('textbox')).toBeDisabled();
    money.hidden = false;
    view.rerender(<AssistantChatProvider transport={s.transport}><AssistantPanel open onOpenChange={() => {}} /></AssistantChatProvider>);
    await flush();
    expect(document.body.innerHTML).not.toContain('Tajná odpověď');
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('shows four suggested questions on an empty thread and sends one on click', async () => {
    const s = scripted();
    render(<AssistantChatProvider transport={s.transport}><AssistantPanel open onOpenChange={() => {}} /></AssistantChatProvider>);
    await flush();
    const suggestions = screen.getAllByTestId('assistant-suggestion');
    expect(suggestions).toHaveLength(4);
    fireEvent.click(suggestions[0]);
    await flush();
    expect(s.requests[0].question).toBe(suggestions[0].textContent);
  });

  it('mounts nothing without the provider (VITE_ASSISTANT_ENABLED off) and the button with it', async () => {
    const off = render(<AssistantSlot />);
    expect(off.container.innerHTML).toBe('');
    off.unmount();
    const s = scripted();
    render(<AssistantChatProvider transport={s.transport}><AssistantSlot /></AssistantChatProvider>);
    expect(screen.getByRole('button', { name: /asistent|assistant/i })).toBeInTheDocument();
  });
});

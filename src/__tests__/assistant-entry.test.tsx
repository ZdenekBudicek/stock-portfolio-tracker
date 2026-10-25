// Entry points of the assistant: ask() from the chat context, the Overview ask bar, the floating
// launcher, the stock-detail action and the Ctrl/Cmd+K shortcut. All of them respect privacy mode
// and mount nothing without the provider (VITE_ASSISTANT_ENABLED off).
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';
import i18n from '@/i18n';

const auth = vi.hoisted(() => ({ user: { id: 'user-a' } as { id: string } | null }));
const money = vi.hoisted(() => ({ currency: 'USD', local: 'CZK', hidden: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user, session: null, loading: false, signOut: async () => {} }) }));
vi.mock('@/contexts/CurrencyContext', () => ({ useCurrency: () => money }));
vi.mock('@/integrations/supabase/client', () => { throw new Error('tests never reach the family Supabase client'); });

const { AssistantChatProvider } = await import('@/contexts/AssistantChatContext');
const { useAssistantChat } = await import('@/hooks/useAssistantChat');
const { AssistantSlot } = await import('@/components/assistant/AssistantButton');
const { AssistantAskBar, assistantBuyTicker } = await import('@/components/assistant/AssistantAskBar');
const { AssistantLauncher, LAUNCHER_SEEN_KEY } = await import('@/components/assistant/AssistantLauncher');
const { AssistantStockAsk } = await import('@/components/assistant/AssistantStockAsk');
import type { AssistantTransport } from '@/lib/assistantTransport';

/** A transport that records requests and answers each with meta → answer → done. */
function recording() {
  const requests: ChatRequest[] = [];
  const transport: AssistantTransport = {
    stream(input) {
      requests.push(input);
      return (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'meta', requestId: input.requestId, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', remainingToday: 19 };
        yield { type: 'answer', text: 'Odpověď', links: [], verified: true };
        yield { type: 'done', requestId: input.requestId, outcome: 'ok', persisted: true } as AgentEvent;
      })();
    },
    threads: vi.fn(async () => []),
    history: vi.fn(async (id: string) => ({ thread: { id, title: 't', updatedAt: '2026-10-23' }, messages: [] })),
    remove: vi.fn(async () => {}),
  };
  return { transport, requests };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const withChat = (transport: AssistantTransport, children: ReactNode) => (
  <AssistantChatProvider transport={transport}>{children}<AssistantSlot /></AssistantChatProvider>
);

beforeEach(() => { auth.user = { id: 'user-a' }; Object.assign(money, { currency: 'USD', local: 'CZK', hidden: false }); localStorage.clear(); void i18n.changeLanguage('cs'); });
afterEach(() => { vi.restoreAllMocks(); void i18n.changeLanguage('cs'); });

function AskProbe({ question }: { question: string }) {
  const chat = useAssistantChat();
  return <button type="button" onClick={() => void chat.ask(question)}>probe</button>;
}

describe('ask()', () => {
  it('opens the panel and sends the question at once', async () => {
    const s = recording();
    render(withChat(s.transport, <AskProbe question="Co je ETF?" />));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('probe'));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(s.requests.map(r => r.question)).toEqual(['Co je ETF?']);
  });

  it('in privacy mode only opens the panel: nothing is sent and the question never reaches the DOM', async () => {
    money.hidden = true;
    const s = recording();
    render(withChat(s.transport, <AskProbe question="Tajná otázka o NVDA" />));
    fireEvent.click(screen.getByText('probe'));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(s.requests).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('Tajná otázka');
  });
});

describe('Overview ask bar', () => {
  it('sends the typed question and opens the panel', async () => {
    const s = recording();
    render(withChat(s.transport, <AssistantAskBar buyTicker="AAPL" />));
    const input = screen.getByRole('textbox', { name: /zeptej se|dotaz/i });
    fireEvent.change(input, { target: { value: 'Kolik mám dividend?' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    expect(s.requests.map(r => r.question)).toEqual(['Kolik mám dividend?']);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('offers four chips, the buy chip with the given ticker, and sends a chip on click', async () => {
    const s = recording();
    render(withChat(s.transport, <AssistantAskBar buyTicker="AAPL" />));
    const chips = screen.getAllByTestId('assistant-ask-chip');
    expect(chips).toHaveLength(4);
    expect(chips.map(c => c.textContent)).toContain('Vyplatí se teď koupit AAPL?');
    fireEvent.click(chips[0]);
    await flush();
    expect(s.requests[0].question).toBe(chips[0].textContent);
  });

  it('in privacy mode disables the input and does not reveal the largest holding', () => {
    money.hidden = true;
    const s = recording();
    render(withChat(s.transport, <AssistantAskBar buyTicker="AAPL" />));
    expect(screen.getByRole('textbox', { name: /zeptej se|dotaz/i })).toBeDisabled();
    expect(document.body.innerHTML).not.toContain('AAPL');
    expect(screen.getAllByTestId('assistant-ask-chip').map(c => c.textContent)).toContain('Vyplatí se teď koupit NVDA?');
  });

  it('picks the largest holding for the buy chip, NVDA otherwise', () => {
    expect(assistantBuyTicker([{ ticker: 'CASH', value: 9e9 }, { ticker: 'MSFT', value: 10 }, { ticker: 'AAPL', value: 30 }])).toBe('AAPL');
    expect(assistantBuyTicker([])).toBe('NVDA');
    expect(assistantBuyTicker([{ ticker: 'CASH', value: 5 }])).toBe('NVDA');
  });

  it('is in English with the English UI', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    render(withChat(recording().transport, <AssistantAskBar buyTicker={null} />));
    expect(screen.getByText('Ask anything about your portfolio')).toBeInTheDocument();
  });
});

describe('floating launcher', () => {
  it('opens the panel and hides itself while the panel is open', async () => {
    const s = recording();
    render(withChat(s.transport, <AssistantLauncher />));
    const launcher = screen.getByRole('button', { name: /zeptej se ai/i });
    fireEvent.click(launcher);
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-launcher')).toBeNull();
  });

  it('pulses once for a new user and remembers it', () => {
    const first = render(withChat(recording().transport, <AssistantLauncher />));
    expect(screen.getByTestId('assistant-launcher').dataset.pulse).toBe('true');
    expect(localStorage.getItem(LAUNCHER_SEEN_KEY)).toBe('1');
    first.unmount();
    render(withChat(recording().transport, <AssistantLauncher />));
    expect(screen.getByTestId('assistant-launcher').dataset.pulse).toBe('false');
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(withChat(recording().transport, <AssistantLauncher />));
    expect(screen.getByTestId('assistant-launcher')).toBeInTheDocument();
  });
});

describe('stock detail action', () => {
  it('sends a ticker question and opens the panel', async () => {
    const s = recording();
    render(withChat(s.transport, <AssistantStockAsk ticker="TSLA" />));
    expect(screen.getByRole('button', { name: /zeptej se ai na TSLA/i })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Proč se TSLA dnes hýbe?'));
    await flush();
    expect(s.requests.map(r => r.question)).toEqual(['Proč se TSLA dnes hýbe?']);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Ctrl/Cmd+K', () => {
  it('opens the panel, also with Cmd', async () => {
    const s = recording();
    const view = render(withChat(s.transport, <div />));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.unmount();
    render(withChat(recording().transport, <div />));
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is ignored while typing in a field and without the modifier', async () => {
    render(withChat(recording().transport, <input aria-label="jiné pole" />));
    const field = screen.getByLabelText('jiné pole');
    field.focus();
    fireEvent.keyDown(field, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('assistant switched off', () => {
  it('renders none of the entry points without the provider', () => {
    const view = render(<><AssistantAskBar buyTicker="AAPL" /><AssistantLauncher /><AssistantStockAsk ticker="TSLA" /><AssistantSlot /></>);
    expect(view.container.innerHTML).toBe('');
  });
});

// Overview entry point: a prominent "ask anything" card with an input and suggestion chips. Submitting
// or clicking a chip opens the panel and sends at once. In privacy mode the input is disabled and the
// buy chip never names a holding (it falls back to NVDA), so nothing about the portfolio reaches the DOM.
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Sparkles } from 'lucide-react';
import { useOptionalAssistantChat } from '@/hooks/useAssistantChat';
import { assistantConfig } from '@/lib/assistantTransport';
import { demoQuestions } from '@/demo/questions';

// The public demo: the prepared questions as chips and a note instead of the input (the chat is switched off).
const DEMO = assistantConfig().mode === 'demo';

export const FALLBACK_BUY_TICKER = 'NVDA';
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The largest holding (by value, cash excluded) for the "is it worth buying" chip; NVDA otherwise. */
export function assistantBuyTicker(holdings: readonly { ticker: string; value: number; type?: string | null }[]): string {
  let best: { ticker: string; value: number } | null = null;
  for (const h of holdings) {
    if (h.ticker === 'CASH' || h.type === 'Cash' || !(h.value > 0)) continue;
    if (!best || h.value > best.value) best = h;
  }
  return best?.ticker ?? FALLBACK_BUY_TICKER;
}

export function AssistantAskBar({ buyTicker }: { buyTicker: string | null }) {
  const { t, i18n } = useTranslation();
  const chat = useOptionalAssistantChat();
  const [text, setText] = useState('');
  const hidden = chat?.hidden ?? false;
  useEffect(() => { if (hidden) setText(''); }, [hidden]);
  if (!chat) return null;

  const ticker = hidden || !buyTicker ? FALLBACK_BUY_TICKER : buyTicker;
  const chips = DEMO ? demoQuestions(i18n.language?.startsWith('en') ? 'en' : 'cs') : [
    t('assistant.entry.chips.today'),
    t('assistant.entry.chips.tax'),
    t('assistant.entry.chips.buy', { ticker }),
    t('assistant.entry.chips.etf'),
  ];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (hidden) { chat.setOpen(true); return; }
    const question = text.trim();
    if (!question) return;
    setText('');
    void chat.ask(question);
  };

  return (
    <section aria-labelledby="assistant-ask-title" className="ai-card-border relative overflow-hidden rounded-3xl p-4 sm:p-5 shadow-[0_18px_60px_-30px_hsl(var(--primary)/0.7)]">
      <div className="flex items-center gap-3">
        <span aria-hidden className="ai-gradient ai-glow grid h-9 w-9 sm:h-10 sm:w-10 shrink-0 place-items-center rounded-xl sm:rounded-2xl">
          <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-background" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id="assistant-ask-title" className="text-[15px] leading-snug sm:text-lg font-semibold tracking-tight">{t('assistant.entry.title')}</h2>
            <span className="hidden sm:inline rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{DEMO ? t('assistant.demo.badge') : t('assistant.beta')}</span>
          </div>
          <p className="hidden sm:block text-xs text-muted-foreground">{hidden ? t('assistant.entry.hiddenHint') : DEMO ? t('assistant.demo.entrySubtitle') : t('assistant.entry.subtitle')}</p>
        </div>
        <kbd className="hidden lg:inline-flex shrink-0 items-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={t('assistant.entry.shortcutHint')}>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
      </div>

      {DEMO ? (
        <p role="note" data-testid="assistant-demo-disabled" className="mt-3 sm:mt-4 rounded-2xl border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {t('assistant.demo.disabled')}
        </p>
      ) : (
      <form onSubmit={submit} className="mt-3 sm:mt-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.045] p-1.5 pl-3.5 sm:pl-4 transition-colors focus-within:border-primary/50 focus-within:bg-white/[0.06]">
        <input type="text" value={text} onChange={e => setText(e.target.value)} disabled={hidden} maxLength={2000}
          aria-label={t('assistant.entry.inputLabel')} placeholder={hidden ? t('assistant.entry.hiddenHint') : t('assistant.entry.placeholder')} enterKeyHint="send"
          className="min-w-0 flex-1 bg-transparent py-2 text-[14px] sm:text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed" />
        <button type="submit" disabled={!hidden && !text.trim()} aria-label={t('assistant.entry.submit')}
          className="ai-gradient grid h-9 w-9 sm:h-10 sm:w-10 shrink-0 place-items-center rounded-xl text-background shadow-md shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowUp className="h-4 w-4" />
        </button>
      </form>
      )}

      <div role="group" aria-label={t('assistant.entry.chipsLabel')}
        className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        {chips.map(chip => (
          <button key={chip} type="button" data-testid="assistant-ask-chip" onClick={() => void chat.ask(chip)}
            className="shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:border-primary/45 hover:bg-primary/[0.09] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {chip}
          </button>
        ))}
      </div>
    </section>
  );
}

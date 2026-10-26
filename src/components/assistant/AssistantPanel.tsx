// The assistant chat in the V2 glass style: a floating sheet on the right on desktop, the whole
// screen on a phone. Radix Dialog gives the focus trap, Escape and keyboard handling. Answers are
// verified server text rendered by SafeMarkdown; the trace shows human labels only. In privacy mode
// no question, answer, thread title or trace is rendered anywhere (text, aria, title or live region).
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUp, EyeOff, History, RotateCcw, Sparkles, SquarePen, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { currentLocale } from '@/i18n';
import { SafeMarkdown } from '@/lib/safeMarkdown';
import { chatText, withHeadings } from '@/lib/assistantText';
import { useAssistantChat, type UiMessage } from '@/hooks/useAssistantChat';
import { assistantConfig } from '@/lib/assistantTransport';
import { DEMO_QUESTIONS } from '@/demo/assistantReplay';
import { useWrittenOut } from '@/hooks/useWrittenOut';
import type { TraceItem } from '../../../supabase/functions/agent/core/protocol.ts';

const iconButton = 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const SUGGESTIONS = ['trades', 'realized', 'today', 'buy'] as const;
// The public demo: prepared questions with fixed answers, no typing (the chat is switched off).
const DEMO = assistantConfig().mode === 'demo';
const chip = 'group flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-3.5 py-3 text-left text-[13px] font-medium text-foreground/90 transition-colors hover:border-primary/40 hover:bg-primary/[0.07] disabled:opacity-50';

/** The demo questions as buttons; `exclude`: questions already asked in this conversation. */
function DemoQuestions({ onAsk, exclude = [], compact }: { onAsk: (q: string) => void; exclude?: string[]; compact?: boolean }) {
  const { i18n } = useTranslation();
  const lang = i18n.language?.startsWith('en') ? 'en' : 'cs';
  const left = DEMO_QUESTIONS.map(d => d.question[lang]).filter(q => !exclude.includes(q));
  // After an answer the remaining questions are small pills, so the answer stays the focus.
  return (
    <div className={compact ? 'flex flex-wrap gap-1.5' : 'grid gap-2'}>
      {left.map(q => (
        <button key={q} type="button" data-testid="assistant-demo-question" onClick={() => onAsk(q)}
          className={compact ? 'rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/[0.09] hover:text-foreground' : chip}>
          <span>{q}</span>
        </button>
      ))}
    </div>
  );
}

const fmtTime = (iso: string, withDay = true) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(currentLocale(), withDay ? { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
};

function TraceList({ items }: { items: TraceItem[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={`${item.label}-${i}`} className="flex items-center gap-2 text-xs">
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', item.state === 'ok' ? 'bg-profit' : item.state === 'unavailable' ? 'bg-warning' : 'bg-primary animate-pulse')} />
          <span className="text-foreground/90">{item.label}</span>
          <span className="text-muted-foreground">
            · {item.state === 'ok' ? t('assistant.traceOk') : item.state === 'unavailable' ? t('assistant.traceUnavailable') : t('assistant.traceRunning')}
            {item.asOf ? ` · ${fmtTime(item.asOf)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AssistantMessage({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  // A live answer is written out paragraph by paragraph as each one is final (Ocenění v3).
  const written = useWrittenOut(message.role === 'assistant' ? withHeadings(chatText(message.content)) : '', !!message.live, message.id);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/25 bg-primary/[0.14] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }
  // Links and the "how I got there" trace are not shown under an answer (Běh 32); the unsaved badge stays.
  return (
    <div className="surface-card rounded-2xl rounded-bl-md border p-4" aria-busy={written.writing}>
      <SafeMarkdown text={written.text} links={message.links ?? []} className="text-foreground/90" />
      {message.unsaved && (
        <div className="mt-3 border-t border-white/[0.06] pt-2.5">
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">{t('assistant.notSaved')}</span>
        </div>
      )}
    </div>
  );
}

export function AssistantPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const chat = useAssistantChat();
  const [showThreads, setShowThreads] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const empty = chat.messages.length === 0 && !chat.pending && !chat.error;

  // Follow the conversation as it grows; in the demo a new answer is shown from its start (the questions follow it).
  useEffect(() => {
    const el = scroller.current;
    const last = chat.messages[chat.messages.length - 1];
    const answer = DEMO && !chat.pending && last?.role === 'assistant' ? el?.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`) : null;
    if (answer && el) { el.scrollTo({ top: Math.max(0, answer.offsetTop - 64), behavior: 'smooth' }); return; }
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chat.messages.length, chat.pending, chat.status, chat.error]);
  // While an answer is written out, keep its end in view — unless the reader scrolled up to read. The scroller mounts
  // with the dialog's content (after `open`), so the effect follows the element itself.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollEl;
    if (!el || typeof MutationObserver === 'undefined') return;
    // Only the reader unpins (scrolling up by wheel, touch or keys); our own smooth scrolling never does.
    let pinned = true;
    const atEnd = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const onScroll = () => { if (atEnd()) pinned = true; };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) pinned = false; };
    const onUser = () => { requestAnimationFrame(() => { pinned = atEnd(); }); };
    // Any change inside (a new message, the next written characters) keeps the end in view while pinned.
    const observer = new MutationObserver(() => { if (pinned) el.scrollTop = el.scrollHeight; });
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onUser, { passive: true });
    el.addEventListener('keydown', onUser);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll); el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onUser); el.removeEventListener('keydown', onUser);
    };
  }, [scrollEl]);
  useEffect(() => { if (chat.hidden) setShowThreads(false); }, [chat.hidden]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!chat.draft.trim() || chat.pending || chat.hidden) return;
    void chat.send(chat.draft);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          onOpenAutoFocus={e => { e.preventDefault(); if (!DEMO) input.current?.focus(); }}
          className={cn(
            'fixed z-50 inset-0 flex flex-col overflow-hidden border-white/10 bg-[hsl(228_27%_5%)] shadow-2xl outline-none',
            'sm:inset-y-3 sm:right-3 sm:left-auto sm:w-[440px] sm:rounded-3xl sm:border',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=closed]:duration-200',
          )}
          style={{ backgroundImage: 'radial-gradient(70% 40% at 0% 0%, hsl(256 100% 62% / 0.20), transparent 70%), radial-gradient(60% 35% at 100% 0%, hsl(174 86% 42% / 0.10), transparent 70%)' }}
        >
          <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5 border-b border-white/[0.06]">
            <div className="flex min-w-0 items-center gap-3">
              <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-lg shadow-primary/30"
                style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--cyan)))' }}>
                <Sparkles className="h-4 w-4 text-background" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Dialog.Title className="text-[15px] font-semibold tracking-tight">{t('assistant.title')}</Dialog.Title>
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{DEMO ? t('assistant.demo.badge') : t('assistant.beta')}</span>
                </div>
                <Dialog.Description className="truncate text-xs text-muted-foreground">{t('assistant.subtitle')}</Dialog.Description>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" className={cn(iconButton, showThreads && 'text-primary border-primary/40')} onClick={() => setShowThreads(v => !v)}
                disabled={chat.hidden} aria-pressed={showThreads} aria-label={t('assistant.threads')} title={t('assistant.threads')}>
                <History className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={iconButton} onClick={() => { chat.newThread(); setShowThreads(false); input.current?.focus(); }}
                disabled={chat.hidden} aria-label={t('assistant.newThread')} title={t('assistant.newThread')}>
                <SquarePen className="h-3.5 w-3.5" />
              </button>
              <Dialog.Close className={iconButton} aria-label={t('common.close')}><X className="h-4 w-4" /></Dialog.Close>
            </div>
          </header>

          <div ref={el => { scroller.current = el; setScrollEl(el); }} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
            {chat.hidden ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]"><EyeOff className="h-5 w-5 text-muted-foreground" /></span>
                <div className="text-sm font-semibold">{t('assistant.hiddenTitle')}</div>
                <p className="max-w-[280px] text-xs text-muted-foreground">{t('assistant.hiddenText')}</p>
              </div>
            ) : showThreads ? (
              <nav aria-label={t('assistant.threadsLabel')}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold">{t('assistant.threads')}</h3>
                  <button type="button" onClick={() => setShowThreads(false)} className="text-xs text-primary hover:underline">{t('assistant.back')}</button>
                </div>
                {chat.threads.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-muted-foreground">{t('assistant.noThreads')}</div>
                ) : (
                  <ul className="space-y-1.5">
                    {chat.threads.map(thread => (
                      <li key={thread.id} className={cn('group flex items-center gap-2 rounded-2xl border px-3 py-2.5 transition-colors',
                        thread.id === chat.threadId ? 'border-primary/35 bg-primary/[0.08]' : 'border-white/[0.07] bg-white/[0.03] hover:border-white/15')}>
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { void chat.selectThread(thread.id); setShowThreads(false); }}>
                          <div className="truncate text-[13px] font-medium">{thread.title}</div>
                          <div className="text-[11px] text-muted-foreground">{fmtTime(thread.updatedAt)}</div>
                        </button>
                        <button type="button" onClick={() => void chat.deleteThread(thread.id)} aria-label={t('assistant.deleteThread', { title: thread.title })}
                          className="rounded-full p-1.5 text-muted-foreground opacity-70 hover:bg-loss/10 hover:text-loss group-hover:opacity-100">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </nav>
            ) : empty ? (
              <div className="flex min-h-full flex-col justify-center py-4">
                <div className="mb-5">
                  <h3 className="text-xl font-semibold tracking-tight">{DEMO ? t('assistant.demo.title') : t('assistant.emptyTitle')}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{DEMO ? t('assistant.demo.hint') : t('assistant.emptyHint')}</p>
                </div>
                {DEMO ? <DemoQuestions onAsk={q => void chat.send(q)} /> : <div className="grid gap-2">
                  {SUGGESTIONS.map(key => (
                    <button key={key} type="button" data-testid="assistant-suggestion" onClick={() => void chat.send(t(`assistant.suggestions.${key}`))}
                      className="group flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-3.5 py-3 text-left text-[13px] font-medium text-foreground/90 transition-colors hover:border-primary/40 hover:bg-primary/[0.07]">
                      <span>{t(`assistant.suggestions.${key}`)}</span>
                    </button>
                  ))}
                </div>}
              </div>
            ) : (
              <div className="space-y-3.5">
                {chat.messages.map(m => <div key={m.id} data-message-id={m.id}><AssistantMessage message={m} /></div>)}
                {DEMO && !chat.pending && (
                  <div className="pt-2">
                    <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('assistant.demo.more')}</div>
                    <DemoQuestions compact onAsk={q => void chat.send(q)} exclude={chat.messages.filter(m => m.role === 'user').map(m => m.content)} />
                  </div>
                )}
                {chat.pending && (
                  <div className="surface-card rounded-2xl rounded-bl-md border p-4">
                    <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                      <span aria-hidden className="flex gap-1">
                        {[0, 1, 2].map(i => <span key={i} className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" style={{ animationDelay: `${i * 180}ms` }} />)}
                      </span>
                      <span>{chat.status}</span>
                    </div>
                    {chat.trace.length > 0 && <div className="mt-3 border-t border-white/[0.06] pt-2.5"><TraceList items={chat.trace} /></div>}
                  </div>
                )}
                {chat.error && (
                  <div role="alert" className="rounded-2xl border border-loss/30 bg-loss/[0.07] p-4 text-[13px]">
                    <p className="text-foreground/90">{chat.error.text}</p>
                    {chat.error.retryAt && <p className="mt-1 text-xs text-muted-foreground">{t('assistant.retryAt', { time: fmtTime(chat.error.retryAt) })}</p>}
                    {!['quota', 'auth', 'conflict', 'invalid'].includes(chat.error.code) && (
                      <button type="button" onClick={() => void chat.retry()}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs font-medium hover:border-primary/40">
                        <RotateCcw className="h-3 w-3" /> {t('assistant.retry')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Status for screen readers; empty in privacy mode because the state itself is empty. */}
          <div aria-live="polite" className="sr-only">{chat.pending ? chat.status : ''}</div>

          <footer className="border-t border-white/[0.06] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-4">
            {DEMO ? (
              <p role="note" data-testid="assistant-demo-disabled" className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
                {t('assistant.demo.disabled')}
              </p>
            ) : (
            <form onSubmit={submit} className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-1.5 pl-3.5 focus-within:border-primary/45 transition-colors">
              <textarea ref={input} rows={1} value={chat.draft} onChange={e => chat.setDraft(e.target.value)} onKeyDown={onKey}
                disabled={chat.hidden} maxLength={2000} aria-label={t('assistant.inputLabel')} placeholder={t('assistant.placeholder')}
                className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[13.5px] leading-snug text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed"
                style={{ fieldSizing: 'content' } as CSSProperties} />
              <button type="submit" disabled={chat.hidden || chat.pending || !chat.draft.trim()} aria-label={t('assistant.send')}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/30 transition-opacity hover:bg-primary/90 disabled:opacity-35 disabled:shadow-none">
                <ArrowUp className="h-4 w-4" />
              </button>
            </form>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground/75">
              <span>{DEMO ? t('assistant.demo.footer') : t('assistant.footer')}</span>
              {chat.remainingToday !== null && <span className="tabular-nums">{t('assistant.remaining', { count: chat.remainingToday })}</span>}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

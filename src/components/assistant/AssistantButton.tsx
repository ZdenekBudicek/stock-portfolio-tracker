// Top-bar control of the assistant (next to the bell), the panel itself and the Ctrl/Cmd+K shortcut.
// The open state lives in the chat context, so the launcher, the ask bar and the stock action share it.
// Without AssistantChatProvider — VITE_ASSISTANT_ENABLED off — nothing is mounted at all.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOptionalAssistantChat } from '@/hooks/useAssistantChat';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';

export function AssistantButton({ open, onClick, busy }: { open: boolean; onClick: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onClick} aria-label={t('assistant.buttonLabel')} aria-haspopup="dialog" aria-expanded={open}
      title={t('assistant.entry.shortcutHint')}
      className={cn('ai-border relative inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-1 lg:pr-3 text-xs font-semibold text-foreground/90 transition-shadow hover:text-foreground hover:shadow-[0_0_18px_-4px_hsl(var(--primary)/0.7)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        open && 'shadow-[0_0_18px_-4px_hsl(var(--primary)/0.7)]')}>
      <span aria-hidden className="ai-gradient grid h-[22px] w-[22px] place-items-center rounded-full">
        <Sparkles className={cn('h-3 w-3 text-background', busy && 'animate-pulse')} />
      </span>
      <span className="hidden lg:inline">{t('assistant.button')}</span>
      {busy && <span aria-hidden className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />}
    </button>
  );
}

/** True when the key press happens while the user is typing somewhere. */
const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
};

export function AssistantSlot() {
  const chat = useOptionalAssistantChat();
  const setOpen = chat?.setOpen;
  // Ctrl/Cmd+K opens the panel from anywhere except a text field.
  useEffect(() => {
    if (!setOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      if (typing(event.target) || typing(document.activeElement)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  if (!chat) return null;
  return (
    <>
      <AssistantButton open={chat.open} onClick={() => chat.setOpen(true)} busy={chat.pending} />
      <AssistantPanel open={chat.open} onOpenChange={chat.setOpen} />
    </>
  );
}

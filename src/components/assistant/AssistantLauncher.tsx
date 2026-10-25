// Floating "Ask AI" button at the bottom right of every protected page; hidden while the panel is open.
// Icon-only on a phone, with the label from sm up. A new user sees one gentle pulse (remembered in
// localStorage; storage failures just skip the pulse memory).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOptionalAssistantChat } from '@/hooks/useAssistantChat';

export const LAUNCHER_SEEN_KEY = 'trackora.assistant.launcherSeen';

const readSeen = () => { try { return localStorage.getItem(LAUNCHER_SEEN_KEY) === '1'; } catch { return true; } };

export function AssistantLauncher() {
  const { t } = useTranslation();
  const chat = useOptionalAssistantChat();
  const [pulse] = useState(() => !readSeen());
  useEffect(() => {
    if (!pulse) return;
    try { localStorage.setItem(LAUNCHER_SEEN_KEY, '1'); } catch { /* private window: pulse again next time */ }
  }, [pulse]);
  if (!chat || chat.open) return null;
  return (
    <button type="button" data-testid="assistant-launcher" data-pulse={pulse ? 'true' : 'false'} onClick={() => chat.setOpen(true)}
      aria-label={t('assistant.entry.launcher')} aria-haspopup="dialog" title={t('assistant.entry.shortcutHint')}
      className={cn('ai-gradient ai-glow fixed z-40 inline-flex items-center gap-2 rounded-full text-background font-semibold transition-transform hover:scale-[1.04] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'bottom-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))] right-[max(1rem,calc(env(safe-area-inset-right)+0.75rem))] h-12 w-12 justify-center sm:bottom-6 sm:right-6 sm:h-11 sm:w-auto sm:px-4 sm:pl-3.5',
        pulse && 'ai-pulse')}>
      <Sparkles aria-hidden className="h-5 w-5 sm:h-4 sm:w-4" />
      <span className="hidden sm:inline text-[13px]">{t('assistant.entry.launcher')}</span>
      {chat.pending && <span aria-hidden className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_8px_hsl(var(--cyan))] animate-pulse" />}
    </button>
  );
}

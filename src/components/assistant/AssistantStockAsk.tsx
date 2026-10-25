// Stock detail: "Ask AI about {ticker}" with two ready questions. The main button opens the panel;
// a suggestion opens it and sends at once. The ticker is page context, not portfolio data, so it can show
// in privacy mode; ask() then only opens the panel and sends nothing.
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { useOptionalAssistantChat } from '@/hooks/useAssistantChat';
import { assistantConfig } from '@/lib/assistantTransport';

export function AssistantStockAsk({ ticker }: { ticker: string }) {
  const { t } = useTranslation();
  const chat = useOptionalAssistantChat();
  // The public demo answers only its prepared questions (on the overview and in the panel), not per-stock ones.
  if (!chat || !ticker || assistantConfig().mode === 'demo') return null;
  const questions = [t('assistant.entry.stock.buy', { ticker }), t('assistant.entry.stock.why', { ticker })];
  return (
    <div role="group" aria-label={t('assistant.entry.stock.groupLabel', { ticker })} className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => chat.setOpen(true)} aria-haspopup="dialog"
        className="ai-border inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs font-semibold text-foreground/90 transition-shadow hover:text-foreground hover:shadow-[0_0_18px_-4px_hsl(var(--primary)/0.7)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden className="ai-gradient grid h-[22px] w-[22px] place-items-center rounded-full"><Sparkles className="h-3 w-3 text-background" /></span>
        {t('assistant.entry.stock.open', { ticker })}
      </button>
      {questions.map(q => (
        <button key={q} type="button" onClick={() => void chat.ask(q)}
          className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/[0.09] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {q}
        </button>
      ))}
    </div>
  );
}

// Building blocks of the V2 (aurora / glass) screens — docs/design/V2-*.dc.html.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

type Tone = 'profit' | 'loss' | 'warning' | 'primary' | 'info' | 'neutral';

/** Glass card. `glow` tints it from the top-right corner like the hero cards in the mockups. */
export const Panel = ({ title, action, children, className, glow, as = 'section', to }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  glow?: Tone;
  as?: 'section' | 'div';
  /** Makes the whole card a link (drill-down). */
  to?: string;
}) => {
  const glowStyle = glow && glow !== 'neutral'
    ? { backgroundImage: `radial-gradient(120% 120% at 100% 0%, hsl(var(--${glow === 'primary' ? 'primary' : glow}) / 0.22), transparent 60%), var(--gradient-card)`, borderColor: `hsl(var(--${glow === 'primary' ? 'primary' : glow}) / 0.28)` }
    : undefined;
  const body = (
    <>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {title ? <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </>
  );
  const cls = cn('surface-card relative rounded-3xl border p-5 sm:p-[22px] min-w-0', to && 'block transition-colors hover:border-primary/40', className);
  if (to) return <Link to={to} className={cls} style={glowStyle}>{body}</Link>;
  const Tag = as;
  return <Tag className={cls} style={glowStyle}>{body}</Tag>;
};

export const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('text-xs font-medium text-muted-foreground', className)}>{children}</div>
);

const toneText: Record<Tone, string> = {
  profit: 'text-profit', loss: 'text-loss', warning: 'text-warning', primary: 'text-primary', info: 'text-info', neutral: 'text-foreground',
};
const toneBg: Record<Tone, string> = {
  profit: 'bg-profit/15 text-profit', loss: 'bg-loss/15 text-loss', warning: 'bg-warning/15 text-warning',
  primary: 'bg-primary/15 text-primary', info: 'bg-info/15 text-info', neutral: 'bg-white/5 text-muted-foreground',
};

export const signTone = (v: number | null | undefined): Tone => (v == null || v === 0 ? 'neutral' : v > 0 ? 'profit' : 'loss');

export const Pill = ({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) => (
  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', toneBg[tone], className)}>{children}</span>
);

/** Small labelled figure. */
export const Kpi = ({ label, value, sub, tone = 'neutral', size = 'md', className }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string;
}) => (
  <div className={cn('min-w-0', className)}>
    <Label>{label}</Label>
    <div className={cn(
      'font-semibold tracking-tight tabular-nums mt-1 truncate',
      size === 'sm' && 'text-base', size === 'md' && 'text-xl', size === 'lg' && 'text-3xl', size === 'xl' && 'text-4xl sm:text-5xl',
      toneText[tone],
    )}>{value}</div>
    {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
  </div>
);

/** Segmented pill switch (period, mode, currency…). */
export function Segmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap',
            o.value === value ? 'bg-foreground text-background font-semibold' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Horizontal bar with a gradient fill; `pct` is 0–100 of the track. */
export const Bar = ({ pct, tone = 'primary', className, height = 'h-2' }: { pct: number; tone?: Tone; className?: string; height?: string }) => {
  const color = tone === 'loss' ? 'var(--loss)' : tone === 'profit' ? 'var(--profit)' : tone === 'warning' ? 'var(--warning)' : 'var(--primary)';
  return (
    <div className={cn('rounded-full bg-white/[0.06] overflow-hidden', height, className)}>
      <div className={cn('rounded-full', height)} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: `linear-gradient(90deg, hsl(${color} / 0.3), hsl(${color}))` }} />
    </div>
  );
};

/** Muted footnote under a screen — where a figure is an estimate, say so here. */
export const Footnote = ({ children }: { children: ReactNode }) => (
  <p className="text-center text-[11px] text-muted-foreground/70 mt-6">{children}</p>
);

export const PageTitle = ({ eyebrow, title, right, back }: { eyebrow?: ReactNode; title: ReactNode; right?: ReactNode; back?: { to: string; label: string } }) => (
  <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
    <div>
      {back && <Link to={back.to} className="text-xs text-muted-foreground hover:text-foreground">← {back.label}</Link>}
      {eyebrow && !back && <Label>{eyebrow}</Label>}
      <h1 className="mt-1.5 text-3xl sm:text-[34px] font-semibold tracking-[-0.035em]">{title}</h1>
    </div>
    {right}
  </div>
);

export const EmptyNote = ({ children }: { children: ReactNode }) => (
  <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>
);

/**
 * Floating detail card for a hovered/tapped column of a hand-drawn chart. `at` is the column's
 * centre in % of the chart width; the card sits beside it on the roomier side.
 */
export const ChartTip = ({ at, children, className }: { at: number; children: ReactNode; className?: string }) => (
  <div
    className={cn('pointer-events-none absolute top-0 z-20 min-w-[180px] max-w-[260px] rounded-xl border border-white/15 bg-[hsl(228_24%_8%/0.94)] px-3 py-2.5 text-xs shadow-2xl backdrop-blur-md animate-in fade-in-0 duration-150', className)}
    // Beside the column (towards the roomier side), so the highlighted bar itself stays visible.
    style={at <= 50 ? { left: `calc(${at}% + 30px)` } : { right: `calc(${100 - at}% + 30px)` }}
  >
    {children}
  </div>
);

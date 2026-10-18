// Trackora mark: an aurora squircle with a white "T" whose crossbar is a rising chart line
// ending in an arrow — the letter of the name and a growing portfolio in one glyph.
// Kept in sync with public/favicon.svg (same geometry and colours).
import { useId } from 'react';
import { cn } from '@/lib/utils';

export const BrandMark = ({ size = 32, className, glow = true }: { size?: number; className?: string; glow?: boolean }) => {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" role="img" aria-hidden="true"
      className={cn('shrink-0', className)}
      style={glow ? { filter: 'drop-shadow(0 0 14px hsl(var(--primary) / 0.55))' } : undefined}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="hsl(258 95% 70%)" />
          <stop offset="0.55" stopColor="hsl(214 95% 62%)" />
          <stop offset="1" stopColor="hsl(158 80% 50%)" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="16" y1="1" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0.32" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="16" rx="9" fill={`url(#${id}-shine)`} />
      {/* crossbar: a rising chart line with an arrow head */}
      <path d="M7.5 15.2 L12.4 11.4 L16 13.4 L23.6 8" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.4 7.6 L23.9 7.7 L23.7 12" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* stem of the T */}
      <path d="M16 13.4 V24.5" stroke="white" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
};

/** "Trackora" set in the app's display weight; the tail picks up the mark's gradient. */
export const BrandName = ({ className }: { className?: string }) => (
  <span className={cn('font-bold tracking-[-0.03em]', className)}>
    Track<span className="bg-gradient-to-r from-[hsl(214_95%_66%)] to-[hsl(158_80%_55%)] bg-clip-text text-transparent">ora</span>
  </span>
);

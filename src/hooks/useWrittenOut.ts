import { useEffect, useRef, useState } from 'react';

/** About 900 characters a second, and no paragraph takes longer than ~1.2 s however long it is. */
const TICK_MS = 16;
const MIN_STEP = 14;
const MAX_TICKS = 75;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A cut inside **bold** would show stray asterisks: close the open pair. */
function closeBold(text: string): string {
  return (text.match(/\*\*/g)?.length ?? 0) % 2 ? `${text}**` : text;
}

/**
 * Writes a live answer out paragraph by paragraph, strictly top to bottom, the way chat assistants do: nothing below
 * the paragraph being written is shown, so text only ever grows at its end (a paragraph written earlier is never
 * pushed down by one inserted above it). Answers from history, and everything under reduced motion, appear at once.
 */
export function useWrittenOut(text: string, live: boolean): { text: string; writing: boolean } {
  const blocks = text.split(/\n{2,}/).filter(Boolean);
  const done = useRef(new Set<string>());
  const [current, setCurrent] = useState<{ block: string; chars: number } | null>(null);
  const animate = live && !reducedMotion();
  const next = animate ? blocks.find(b => !done.current.has(b)) ?? null : null;

  useEffect(() => {
    if (!next) { setCurrent(null); return; }
    let chars = 0;
    const step = Math.max(MIN_STEP, Math.ceil(next.length / MAX_TICKS));
    setCurrent({ block: next, chars: 0 });
    const timer = setInterval(() => {
      chars = Math.min(next.length, chars + step);
      if (chars >= next.length) {
        clearInterval(timer);
        done.current.add(next);
        setCurrent(null);
      } else setCurrent({ block: next, chars });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [next]);

  if (!animate) return { text, writing: false };
  const shown: string[] = [];
  for (const b of blocks) {
    if (done.current.has(b)) { shown.push(b); continue; }
    if (current?.block === b && current.chars > 0) shown.push(closeBold(b.slice(0, current.chars)));
    break;
  }
  return { text: shown.join('\n\n'), writing: !!next };
}

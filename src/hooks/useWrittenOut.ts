import { useEffect, useState } from 'react';

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
 * Paragraphs already written out, by message id: the panel unmounts its messages when it is closed, and a reopened
 * chat shows what was written at once instead of writing it out again (only a paragraph cut off by closing resumes).
 */
const WRITTEN = new Map<string, Set<string>>();
const WRITTEN_MAX = 50;
function writtenOf(id: string | undefined): Set<string> {
  if (!id) return new Set();
  let set = WRITTEN.get(id);
  if (!set) {
    WRITTEN.set(id, set = new Set());
    if (WRITTEN.size > WRITTEN_MAX) WRITTEN.delete(WRITTEN.keys().next().value!);
  }
  return set;
}

/**
 * Writes a live answer out paragraph by paragraph, strictly top to bottom, the way chat assistants do: nothing below
 * the paragraph being written is shown, so text only ever grows at its end (a paragraph written earlier is never
 * pushed down by one inserted above it). Answers from history, and everything under reduced motion, appear at once.
 */
export function useWrittenOut(text: string, live: boolean, id?: string): { text: string; writing: boolean } {
  const blocks = text.split(/\n{2,}/).filter(Boolean);
  const [done] = useState(() => writtenOf(id));
  const [current, setCurrent] = useState<{ block: string; chars: number } | null>(null);
  const animate = live && !reducedMotion();
  const next = animate ? blocks.find(b => !done.has(b)) ?? null : null;

  useEffect(() => {
    if (!next) { setCurrent(null); return; }
    let chars = 0;
    const step = Math.max(MIN_STEP, Math.ceil(next.length / MAX_TICKS));
    setCurrent({ block: next, chars: 0 });
    const timer = setInterval(() => {
      chars = Math.min(next.length, chars + step);
      if (chars >= next.length) {
        clearInterval(timer);
        done.add(next);
        setCurrent(null);
      } else setCurrent({ block: next, chars });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [next, done]);

  if (!animate) return { text, writing: false };
  const shown: string[] = [];
  for (const b of blocks) {
    if (done.has(b)) { shown.push(b); continue; }
    if (current?.block === b && current.chars > 0) shown.push(closeBold(b.slice(0, current.chars)));
    break;
  }
  return { text: shown.join('\n\n'), writing: !!next };
}

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWrittenOut } from '@/hooks/useWrittenOut';

// Ocenění v3: a live answer is written out paragraph by paragraph, each one only once final.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const motion = (reduce: boolean) => vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: reduce && q.includes('reduce'), media: q,
  onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }) as MediaQueryList);

describe('written-out answers', () => {
  it('writes strictly top to bottom: text only grows at its end, never half a bold marker', () => {
    motion(false); vi.useFakeTimers();
    const text = '**Shrnutí:** firma roste díky cloudu a AI.\n\n**O firmě**\n• prodává software a cloud.\n\n**Ocenění**\nAkcie dnes stojí 533 USD.';
    const { result } = renderHook(() => useWrittenOut(text, true));
    const seen: string[] = [];
    for (let i = 0; i < 400 && result.current.writing; i++) {
      act(() => { vi.advanceTimersByTime(16); });
      seen.push(result.current.text);
      expect((result.current.text.match(/\*\*/g)?.length ?? 0) % 2).toBe(0);
    }
    expect(result.current).toEqual({ text, writing: false });
    // Every frame extends the previous one at its end (bold closers aside): nothing appears above text already shown.
    const plain = (t: string) => t.replace(/\*\*/g, '');
    for (let i = 1; i < seen.length; i++) expect(plain(seen[i]).startsWith(plain(seen[i - 1]).slice(0, -1))).toBe(true);
  });
  it('a longer final answer than the text shown keeps writing below it, never above', () => {
    motion(false); vi.useFakeTimers();
    const first = 'První odstavec odpovědi.';
    const { result, rerender } = renderHook(({ text }) => useWrittenOut(text, true), { initialProps: { text: first } });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.text).toBe(first);
    rerender({ text: `${first}\n\nDruhý odstavec.` });
    act(() => { vi.advanceTimersByTime(16); });
    expect(result.current.text.startsWith(first)).toBe(true);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.text).toBe(`${first}\n\nDruhý odstavec.`);
  });
  it('shows history and reduced-motion answers at once', () => {
    motion(true);
    expect(renderHook(() => useWrittenOut('A\n\nB', true)).result.current).toEqual({ text: 'A\n\nB', writing: false });
    motion(false);
    expect(renderHook(() => useWrittenOut('A\n\nB', false)).result.current).toEqual({ text: 'A\n\nB', writing: false });
  });
});

describe('section headings in the chat', () => {
  it('bolds a short first line that heads more lines, never a sentence, bullet or one-line block', async () => {
    const { withHeadings } = await import('@/lib/assistantText');
    const text = '**Shrnutí:** Firma roste.\n\nO firmě\n• **Software:** prodává Office.\n\nOcenění a kde může být cena za 2 roky\nAkcie dnes stojí 533 USD.\n\nJen jedna věta bez dalších řádků\n\nAnalytici: 5 z 9 koupit.\nDruhý řádek.';
    expect(withHeadings(text)).toBe('**Shrnutí:** Firma roste.\n\n**O firmě**\n• **Software:** prodává Office.\n\n**Ocenění a kde může být cena za 2 roky**\nAkcie dnes stojí 533 USD.\n\nJen jedna věta bez dalších řádků\n\nAnalytici: 5 z 9 koupit.\nDruhý řádek.');
  });
});

describe('a reopened chat', () => {
  it('shows an answer written out before at once: closing and reopening the panel does not write it out again', () => {
    motion(false); vi.useFakeTimers();
    const text = 'První odstavec.\n\nDruhý odstavec.';
    const first = renderHook(() => useWrittenOut(text, true, 'local-r1-a'));
    for (let i = 0; i < 400 && first.result.current.writing; i++) act(() => { vi.advanceTimersByTime(16); });
    expect(first.result.current).toEqual({ text, writing: false });
    first.unmount();
    // The panel mounts its messages again: the whole answer is there in the first frame.
    expect(renderHook(() => useWrittenOut(text, true, 'local-r1-a')).result.current).toEqual({ text, writing: false });
  });
  it('closed while writing, it keeps the finished paragraphs and only resumes the cut one', () => {
    motion(false); vi.useFakeTimers();
    const text = 'Hotový odstavec.\n\n' + 'Rozepsaný odstavec, který se ještě píše. '.repeat(20);
    const first = renderHook(() => useWrittenOut(text, true, 'local-r2-a'));
    for (let i = 0; i < 400 && !first.result.current.text.startsWith('Hotový odstavec.\n\n'); i++) act(() => { vi.advanceTimersByTime(16); });
    first.unmount();
    const again = renderHook(() => useWrittenOut(text, true, 'local-r2-a'));
    expect(again.result.current.text).toBe('Hotový odstavec.');
    expect(again.result.current.writing).toBe(true);
  });
});

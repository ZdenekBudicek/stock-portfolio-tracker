import { describe, expect, it } from 'vitest';
import { createSseParser, SseError } from '@/lib/sse';

const bytes = (text: string) => new TextEncoder().encode(text);
const done = '{"type":"done","requestId":"r","persisted":true,"outcome":"ok"}';

describe('SSE parser', () => {
  it('joins a Czech character split between bytes', () => {
    const parser = createSseParser();
    const all = bytes('data: {"type":"status","text":"Načítám č"}\n\n');
    const events = [...all].flatMap(b => parser.push(new Uint8Array([b])));
    expect(events).toEqual([{ type: 'status', text: 'Načítám č' }]);
  });

  it('accepts CRLF, several data lines, comments and several events in one chunk', () => {
    const parser = createSseParser();
    const events = parser.push(bytes(': keep-alive\r\n\r\ndata: {"type":"status",\r\ndata: "text":"A"}\r\n\r\nevent: x\ndata: {"type":"status","text":"B"}\n\n'));
    expect(events).toEqual([{ type: 'status', text: 'A' }, { type: 'status', text: 'B' }]);
  });

  it('keeps a frame split over chunks and ends cleanly after done', () => {
    const parser = createSseParser();
    expect(parser.push(bytes('data: {"type":"answer","text":"Hotovo","links":[],"verified":true}\n'))).toEqual([]);
    expect(parser.push(bytes(`\ndata: ${done}\n\n`))).toHaveLength(2);
    expect(parser.finish()).toEqual([]);
  });

  it('rejects invalid JSON and an unknown event shape explicitly', () => {
    expect(() => createSseParser().push(bytes('data: {nope\n\n'))).toThrow(SseError);
    expect(() => createSseParser().push(bytes('data: {"type":"html","text":"<b>"}\n\n'))).toThrow(SseError);
  });

  it('EOF without done is an explicit error, never a silent end', () => {
    const parser = createSseParser();
    parser.push(bytes('data: {"type":"status","text":"Pracuji"}\n\n'));
    expect(() => parser.finish()).toThrow(/done/);
    const partial = createSseParser();
    partial.push(bytes(`data: ${done}`));
    // A final frame without its blank line still counts once the stream ends.
    expect(partial.finish()).toEqual([JSON.parse(done)]);
  });

  it('stops at the first done and ignores anything after it', () => {
    const parser = createSseParser();
    const events = parser.push(bytes(`data: ${done}\n\ndata: {"type":"answer","text":"pozdě","links":[],"verified":true}\n\n`));
    expect(events).toEqual([JSON.parse(done)]);
    expect(parser.finish()).toEqual([]);
  });
});

describe('section events (Ocenění v3)', () => {
  it('accepts a finished section and rejects a malformed one', () => {
    const events = createSseParser().push(bytes('data: {"type":"section","key":"valuation","order":50,"text":"Ocenění"}\n\n'));
    expect(events).toEqual([{ type: 'section', key: 'valuation', order: 50, text: 'Ocenění' }]);
    expect(() => createSseParser().push(bytes('data: {"type":"section","key":"valuation","text":"x"}\n\n'))).toThrow(SseError);
  });
});

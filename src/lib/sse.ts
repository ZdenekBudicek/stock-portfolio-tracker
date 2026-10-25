// Incremental parser of the assistant's SSE stream: bytes in, validated events out. A frame
// split anywhere (even inside a multi-byte Czech letter) is joined; a stream that ends without
// `done`, or carries anything that is not a known event, is an explicit error — never a chat
// left pending forever.
import type { AgentEvent } from '../../supabase/functions/agent/core/protocol.ts';

export class SseError extends Error {
  readonly code: 'invalid' | 'eof';
  constructor(code: 'invalid' | 'eof', message: string) { super(message); this.code = code; }
}

const str = (v: unknown) => typeof v === 'string';
const ERROR_CODES = ['auth', 'quota', 'timeout', 'failed', 'conflict', 'invalid'];
const OUTCOMES = ['ok', 'fallback', 'quota', 'timeout', 'error', 'cancelled'];

/** Shape check of one event; the server is trusted for content, not for the frame format. */
function validEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  switch (e.type) {
    case 'meta': return str(e.requestId) && str(e.threadId) && (e.remainingToday === null || Number.isInteger(e.remainingToday));
    case 'status': return str(e.text);
    case 'section': return str(e.key) && Number.isFinite(e.order) && str(e.text);
    case 'trace': return Array.isArray(e.items) && e.items.every(i => i && typeof i === 'object' && str((i as { label?: unknown }).label)
      && ['running', 'ok', 'unavailable'].includes((i as { state?: string }).state ?? ''));
    case 'answer': return str(e.text) && e.verified === true && Array.isArray(e.links)
      && e.links.every(l => l && typeof l === 'object' && str((l as { url?: unknown }).url) && str((l as { title?: unknown }).title));
    case 'error': return ERROR_CODES.includes(String(e.code)) && str(e.text) && (e.retryAt === undefined || str(e.retryAt));
    case 'done': return str(e.requestId) && typeof e.persisted === 'boolean' && OUTCOMES.includes(String(e.outcome));
    default: return false;
  }
}

export function createSseParser(): { push(chunk: Uint8Array): AgentEvent[]; finish(): AgentEvent[] } {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let ended = false;

  function frames(final: boolean): AgentEvent[] {
    const out: AgentEvent[] = [];
    pending = pending.replace(/\r\n?/g, '\n');
    while (!ended) {
      let boundary = pending.indexOf('\n\n');
      if (boundary < 0) {
        if (!final || !pending.trim()) break;
        boundary = pending.length;
      }
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new SseError('invalid', 'Invalid event data'); }
      if (!validEvent(event)) throw new SseError('invalid', 'Unknown event');
      out.push(event);
      if (event.type === 'done') { ended = true; pending = ''; }
    }
    return out;
  }

  return {
    push(chunk) {
      if (ended) return [];
      pending += decoder.decode(chunk, { stream: true });
      return frames(false);
    },
    finish() {
      if (ended) return [];
      pending += decoder.decode();
      const events = frames(true);
      if (!ended) throw new SseError('eof', 'Stream ended without done');
      return events;
    },
  };
}

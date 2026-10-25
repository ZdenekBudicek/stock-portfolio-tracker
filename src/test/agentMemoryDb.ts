import type { AgentDb } from '../../supabase/functions/agent/core/ports.ts';
import type { Reservation, RunMetrics, StoredAnswer, Thread } from '../../supabase/functions/agent/core/dataTypes.ts';
import type { ChatMessage, Lang } from '../../supabase/functions/agent/core/protocol.ts';

// In-memory stand-in for the two storage RPCs and owner-scoped history reads, following the SQL in
// `20261025100000_ai_assistant.sql` (quota 20, 50 s lease, replay, conflict, busy). It is a fixture
// for service tests and the loopback runner only: it proves orchestration, never real RLS.

type Request = { userId: string; requestId: string; threadId: string; requestedThreadId: string | null; fingerprint: string; question: string;
  lang: Lang; state: 'active' | 'completed' | 'timeout'; token: string; createdAt: number; answer: StoredAnswer | null };
type Row = Thread & { userId: string };
type Message = ChatMessage & { userId: string; threadId: string };

export const DAILY_LIMIT = 20, LEASE_MS = 50_000;

export function createMemoryAgentStore(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const threads: Row[] = [], messages: Message[] = [], requests: Request[] = [], runs: (RunMetrics & { requestId: string })[] = [];
  const used = new Map<string, number>();
  let failComplete = false, ids = 0;
  const uuid = () => `00000000-0000-4000-a000-${String(++ids).padStart(12, '0')}`;
  const iso = (ms: number) => new Date(ms).toISOString();
  const pragueDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(ms));

  function forUser(userId: string): AgentDb {
    const own = (id: string) => threads.find(t => t.id === id && t.userId === userId);
    const nextSeq = (threadId: string) => Math.max(0, ...messages.filter(m => m.threadId === threadId).map(m => m.seq)) + 1;
    return {
      async begin(input) {
        const t = now(), day = pragueDay(t), key = `${userId}:${day}`, count = used.get(key) ?? 0;
        for (const r of requests) if (r.userId === userId && r.state === 'active' && r.createdAt + LEASE_MS <= t) {
          r.state = 'timeout';
          r.answer = { text: 'Čas na odpověď vypršel. Zkus nový dotaz.', links: [], trace: [], lang: r.lang, outcome: 'timeout', verified: true };
        }
        const existing = requests.find(r => r.userId === userId && r.requestId === input.requestId);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint || existing.question !== input.question || existing.lang !== input.lang
            || existing.requestedThreadId !== (input.threadId ?? null) || !own(existing.threadId)) return { kind: 'conflict' };
          if (existing.state === 'active') return { kind: 'busy', retryAt: iso(existing.createdAt + LEASE_MS) };
          return { kind: 'replay', threadId: existing.threadId, answer: existing.answer!, remainingToday: DAILY_LIMIT - count } as Reservation;
        }
        if (input.threadId) {
          if (!own(input.threadId)) return { kind: 'conflict' };
          const active = requests.find(r => r.userId === userId && r.threadId === input.threadId && r.state === 'active');
          if (active) return { kind: 'busy', retryAt: iso(active.createdAt + LEASE_MS) };
        }
        if (count >= DAILY_LIMIT) return { kind: 'quota', retryAt: `${day}T22:00:00.000Z` };
        let threadId = input.threadId;
        if (!threadId) {
          threadId = uuid();
          threads.push({ id: threadId, userId, title: input.question.slice(0, 120), updatedAt: iso(t) });
        }
        used.set(key, count + 1);
        requests.push({ userId, requestId: input.requestId, threadId, requestedThreadId: input.threadId ?? null, fingerprint: input.fingerprint,
          question: input.question, lang: input.lang, state: 'active', token: input.executionToken, createdAt: t, answer: null });
        messages.push({ id: uuid(), userId, threadId, requestId: input.requestId, seq: nextSeq(threadId), role: 'user', content: input.question,
          lang: input.lang, createdAt: iso(t) });
        own(threadId)!.updatedAt = iso(t);
        return { kind: 'accepted', threadId, remainingToday: DAILY_LIMIT - 1 - count };
      },
      async complete(input) {
        if (failComplete) throw new Error('Database operation failed');
        const r = requests.find(x => x.userId === userId && x.requestId === input.requestId);
        if (!r || r.token !== input.executionToken) throw new Error('Invalid execution');
        if (r.state === 'completed') return;
        if (r.state !== 'active' || r.createdAt + LEASE_MS <= now()) throw new Error('Execution expired');
        if (!own(r.threadId)) throw new Error('Thread unavailable');
        if (input.answer.lang !== r.lang || input.metrics.outcome !== input.answer.outcome || !input.answer.text) throw new Error('Invalid completion');
        messages.push({ id: uuid(), userId, threadId: r.threadId, requestId: r.requestId, seq: nextSeq(r.threadId), role: 'assistant',
          content: input.answer.text, lang: r.lang, createdAt: iso(now()) });
        runs.push({ ...input.metrics, requestId: r.requestId });
        r.state = 'completed';
        r.answer = input.answer;
        own(r.threadId)!.updatedAt = iso(now());
      },
      async listThreads() {
        return threads.filter(t => t.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
      },
      async loadThread(id) {
        const thread = own(id);
        if (!thread) return null;
        return { thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt },
          messages: messages.filter(m => m.threadId === id && m.userId === userId).sort((a, b) => a.seq - b.seq)
            .map(({ id: mid, requestId, seq, role, content, lang, createdAt }) => ({ id: mid, requestId, seq, role, content, lang, createdAt })) };
      },
      async deleteThread(id) {
        if (!own(id)) return false;
        threads.splice(threads.findIndex(t => t.id === id), 1);
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].threadId === id) messages.splice(i, 1);
        return true;
      },
    };
  }
  return {
    forUser, threads, messages, requests, runs,
    usedToday: (userId: string) => used.get(`${userId}:${pragueDay(now())}`) ?? 0,
    failCompletion(value: boolean) { failComplete = value; },
  };
}

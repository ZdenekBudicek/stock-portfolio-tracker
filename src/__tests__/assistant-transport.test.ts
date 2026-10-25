import { describe, expect, it, vi } from 'vitest';
import { createAssistantTransport } from '@/lib/assistantTransport';

describe('assistant authentication cancellation', () => {
  it.each(['stream', 'threads', 'history', 'remove'] as const)('aborts %s while its token is hung and never fetches with a late token', async method => {
    let resolve!: (value: string) => void;
    const fetchImpl = vi.fn();
    const transport = createAssistantTransport('live', { baseUrl: 'http://localhost/agent', fetchImpl,
      token: () => new Promise(r => { resolve = r; }) });
    const controller = new AbortController();
    const promise = method === 'stream' ? transport.stream({ requestId: 'r', question: 'q' }, controller.signal)[Symbol.asyncIterator]().next()
      : method === 'threads' ? transport.threads(controller.signal) : transport[method]('thread', controller.signal);
    let outcome = 'pending';
    void promise.then(() => { outcome = 'resolved'; }, e => { outcome = e.name; });
    controller.abort();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(outcome).toBe('AbortError');
    resolve('synthetic-late-token');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

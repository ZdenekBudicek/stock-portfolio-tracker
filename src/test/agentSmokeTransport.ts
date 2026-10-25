import type { AgentEvent, ChatRequest } from '../../supabase/functions/agent/core/protocol.ts';

export async function readAgentEvents(response: Response, onEvent?: (event: AgentEvent) => void): Promise<AgentEvent[]> {
  if (!response.ok || !response.body) throw new Error(`Chat HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: AgentEvent[] = [];
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as AgentEvent;
        events.push(event);
        onEvent?.(event);
        if (event.type === 'done') return events;
      }
      if (done) throw new Error('SSE ended without done');
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function renderSmokeAnswer(url: string, jwt: string, input: ChatRequest, target: { textContent: string | null }): Promise<void> {
  const events = await readAgentEvents(await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
  target.textContent = events.filter((event): event is Extract<AgentEvent, { type: 'answer' }> => event.type === 'answer').map(event => event.text).join('');
}

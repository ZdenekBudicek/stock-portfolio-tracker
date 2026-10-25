// A deterministic fake of the model endpoint for the loopback eval runner (`--fake-llm`): no live
// model, no key. The router is rate-limited (so the keyword router decides), and the writer always
// returns a provocative draft — an invented number and a tool name in the text — that grounding must
// reject, so every answer is the verified template. Evidence of the harness and of the safety path,
// never of model quality.

export const FAKE_LLM_MODEL = 'fake-llm (rate-limited router, provocative writer)';

const ROUTER_MARKER = 'Classify a question';

function langOf(body: { messages?: { role: string; content: string | null }[] }): string {
  const system = body.messages?.find(m => m.role === 'system')?.content ?? '';
  return /Write in Slovak/.test(system) ? 'sk' : /Write in English/.test(system) ? 'en' : 'cs';
}

export function createFakeLlmFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.groq.com') throw new Error('The fake model serves only api.groq.com');
    init?.signal?.throwIfAborted();
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string | null }[] };
    if ((body.messages?.[0]?.content ?? '').startsWith(ROUTER_MARKER)) {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached (fake)' } }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    const lang = langOf(body);
    const draft = { lang, blocks: [{ kind: 'facts', text: 'Hodnota je 999 999 USD podle get_portfolio_summary.', claims: {}, sourceIds: [] }] };
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(draft) } }],
      usage: { prompt_tokens: 900, completion_tokens: 60 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

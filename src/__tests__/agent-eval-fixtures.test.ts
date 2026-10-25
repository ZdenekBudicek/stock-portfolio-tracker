// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAgentServer } from '../../scripts/agent-local.ts';
import { fixtureSnapshot } from '../../supabase/functions/agent/core/fixture.ts';
import { createFakeLlmFetch } from '../test/agentFakeLlm.ts';
import { readAgentEvents } from '../test/agentSmokeTransport.ts';

// Users C/D/E of the eval case set (Běh 20): OTHER residence, missing purchase FX, empty account.
let server: Awaited<ReturnType<typeof startAgentServer>>;
beforeAll(async () => {
  server = await startAgentServer({ fixtureAuth: true, port: 0, agent: { keys: { GROQ_API_KEY: 'fake' }, fetchImpl: createFakeLlmFetch() } });
});
afterAll(async () => { await server.close(); });
let seq = 0;
async function ask(user: string, question: string) {
  const requestId = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const response = await fetch(`${server.url}/agent/chat`, { method: 'POST', headers: { Authorization: `Bearer fixture-user-${user}-${seq}` },
    body: JSON.stringify({ requestId, question }) });
  const events = await readAgentEvents(response);
  const answer = events.find(e => e.type === 'answer');
  return answer?.type === 'answer' ? answer.text : '';
}

describe('eval fixture users', () => {
  it('are distinct synthetic snapshots with the intended property', () => {
    expect(fixtureSnapshot('C').settings.taxResidence).toBe('OTHER');
    expect(fixtureSnapshot('E').positions).toEqual([]);
    expect(fixtureSnapshot('E').transactions).toEqual([]);
    // D's purchase predates the first rate of the bundled ČNB file, so it stays missing whatever the daily refresh adds.
    const firstCnb = Object.keys(JSON.parse(readFileSync('src/data/cnbUsdCzk.json', 'utf8')).rates).sort()[0];
    const buy = fixtureSnapshot('D').transactions.find(t => t.side === 'BUY')!;
    expect(buy.executed_at.slice(0, 10) < firstCnb).toBe(true);
  });

  it('an empty account says nothing is held, not that data are unavailable', async () => {
    expect(await ask('e', 'Čo držím v portfóliu?')).toMatch(/zatiaľ nič nedržíš/i);
  });

  it('missing purchase FX qualifies the tax estimate instead of presenting it as complete', async () => {
    const text = await ask('d', 'What is my estimated tax for 2026?');
    expect(text).toMatch(/exchange rates are missing/i);
    expect(text).toMatch(/incomplete/i);
  });

  it('the runner maps every numbered identity to its own fixture', async () => {
    expect(await ask('c', 'Kolik letos zaplatím daň z prodeje akcií?')).not.toMatch(/odhad daně/i);
  });
});

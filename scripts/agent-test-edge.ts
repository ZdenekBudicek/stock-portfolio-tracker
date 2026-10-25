import { createClient } from '@supabase/supabase-js';
import { makeEdgeTestHandler } from '../src/test/agentEdgeHandler.ts';
import { verifyUser } from '../supabase/functions/agent/live/auth.ts';
import { createAgentDb } from '../supabase/functions/agent/live/db.ts';
import type { CallerDbClient } from '../supabase/functions/agent/core/ports.ts';
import { getTestDbConfig, testDbFetch, TEST_DB_SKIP } from '../src/test/agentTestDb.ts';
import { withTestDb } from './agent-test-db.ts';
import { runGatewaySmoke } from './agent-gateway-smoke.ts';

// Separate test runner: real Auth A/B only, never production fixture authentication.
const config = getTestDbConfig();
if (!config) console.info(TEST_DB_SKIP);
else {
  const handler = makeEdgeTestHandler({ now: () => Date.now(),
    authenticate: (req, signal) => verifyUser(req, { url: config.url, anonKey: config.anonKey, fetchImpl: testDbFetch(config.url) }, signal),
    dbFor: user => createAgentDb(createClient(config.url, config.anonKey, {
      global: { headers: { Authorization: `Bearer ${user.jwt}` }, fetch: testDbFetch(config.url) },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) as unknown as CallerDbClient),
  });
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler);
  try {
    // The fixture session requires pristine accounts and removes the tracked requests and usage days afterwards.
    await withTestDb(async session => {
      for (const [owner, other] of [[session.users.A, session.users.B], [session.users.B, session.users.A]]) {
        const result = await runGatewaySmoke({ base: `http://127.0.0.1:${server.addr.port}/agent`, jwtA: owner.jwt, jwtB: other.jwt,
          track: id => session.track(id) });
        if (Object.values(result.checks).some(state => state !== 'PASS')) throw new Error(`Deno HTTP checks failed: ${JSON.stringify(result.checks)}`);
      }
    });
    console.info('PASS: Deno HTTP real Auth A/B, persistence, own history, foreign 404 and own cleanup; gateway not verified');
  } finally { await server.shutdown(); }
}

import { createClient } from 'npm:@supabase/supabase-js@2.106.2';
import * as lib from './_lib/trackora-lib.js';
import { readAgentConfig } from './config.ts';
import { complete, createTokenBudget } from './core/llm.ts';
import { buildModelPolicy } from './core/modelPolicy.ts';
import type { CallerDbClient } from './core/ports.ts';
import { makeHandler } from './handler.ts';
import { verifyUser } from './live/auth.ts';
import { createAgentDb } from './live/db.ts';
import { createMarketSource } from './live/market.ts';
import { readWithinDeadline } from './live/paging.ts';
import { createPortfolioRepo } from './live/repo.ts';
import { createAgentRoutes, createChatService, DEFAULT_PREFERENCES, pragueToday } from './service.ts';

// Production entrypoint. Off unless AGENT_ENABLED=true (503 before auth, storage or models).
// Every request gets its own caller client with the user's JWT and the anon key: RLS decides what
// it reads, the service key never enters the chat path, and nothing is shared between users.
const url = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const config = readAgentConfig(name => Deno.env.get(name));
const secret = (names: string[]) => Object.fromEntries(names.flatMap(name => { const value = Deno.env.get(name); return value ? [[name, value]] : []; }));
const modelKeys = secret(['GROQ_API_KEY', 'OPENROUTER_API_KEY']);
// TAVILY_API_KEY (optional): article text for move/movers news analysis; without it Finnhub summaries are the text.
const marketKeys = secret(['FINNHUB_API_KEY', 'TWELVE_DATA_KEY', 'TAVILY_API_KEY']);
// Production stores the Twelve Data key under the name refresh-prices uses.
if (!marketKeys.TWELVE_DATA_KEY && Deno.env.get('TWELVE_DATA_API_KEY')) marketKeys.TWELVE_DATA_KEY = Deno.env.get('TWELVE_DATA_API_KEY')!;
const policy = buildModelPolicy(undefined);
const pinnedFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

/** company-data as the signed-in user: it checks the user, the hourly quota and what is already stored. */
const requestData = (jwt: string) => async (ticker: string, signal: AbortSignal) => {
  const res = await pinnedFetch(`${url}/functions/v1/company-data`, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker }) });
  return res.ok ? await res.json() : (await res.body?.cancel(), null);
};

function callerClient(jwt: string): CallerDbClient {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: pinnedFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as CallerDbClient;
}

const handler = makeHandler({
  enabled: config.enabled,
  now: () => Date.now(),
  allowedOrigins: config.allowedOrigins,
  authenticate: (req, signal) => verifyUser(req, { url, anonKey, fetchImpl: pinnedFetch }, signal),
  chat: (input, user, budget) => {
    const client = callerClient(user.jwt);
    return createChatService({ db: createAgentDb(client), repo: createPortfolioRepo(client), lib,
      market: createMarketSource(client, { fetchImpl: pinnedFetch, now: Date.now, keys: marketKeys, requestData: requestData(user.jwt),
        reserveSearch: async ctx => {
          const unit = await readWithinDeadline(signal => client.rpc('reserve_agent_resource', { p_request_id: input.requestId, p_resource: 'tavily', p_units: 1 })
            .abortSignal(signal), ctx);
          return !unit.error && unit.data === true;
        } }),
      llm: { complete, policy, keys: modelKeys, tokens: createTokenBudget(), fetchImpl: pinnedFetch } })(input, user, budget);
  },
  dispatch: (req, user, budget) => {
    const client = callerClient(user.jwt);
    // Direct tools only on an explicit test deployment, and then under the same daily quota.
    return createAgentRoutes({ db: createAgentDb(client), directTools: config.directTools ? { reserve: true, context: b => ({
      repo: createPortfolioRepo(client), market: createMarketSource(client, { fetchImpl: pinnedFetch, now: Date.now, keys: marketKeys }), lib,
      budget: b, today: pragueToday(), lang: 'cs', preferences: DEFAULT_PREFERENCES }) } : null })(req, user, budget);
  },
});

if (import.meta.main) Deno.serve(handler);

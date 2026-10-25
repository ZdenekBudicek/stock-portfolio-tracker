import * as lib from '../../supabase/functions/agent/_lib/trackora-lib.js';
import { fixtureMarket, fixtureRepo, FIXTURE_TODAY } from '../../supabase/functions/agent/core/fixture.ts';
import { complete, createTokenBudget } from '../../supabase/functions/agent/core/llm.ts';
import { buildModelPolicy } from '../../supabase/functions/agent/core/modelPolicy.ts';
import type { AgentDb } from '../../supabase/functions/agent/core/ports.ts';
import { makeHandler, type HandlerDeps } from '../../supabase/functions/agent/handler.ts';
import type { VerifiedUser } from '../../supabase/functions/agent/live/auth.ts';
import { createAgentRoutes, createChatService } from '../../supabase/functions/agent/service.ts';

/** Real Auth/caller-JWT storage is supplied by the Deno runner; portfolio and market are synthetic. */
export function makeEdgeTestHandler(deps: Pick<HandlerDeps, 'authenticate' | 'now'> & { dbFor: (user: VerifiedUser) => AgentDb }) {
  return makeHandler({ now: deps.now, authenticate: deps.authenticate, allowedOrigins: [],
    dispatch: (req, user, budget) => createAgentRoutes({ db: deps.dbFor(user), directTools: null })(req, user, budget),
    chat: (input, user, budget) => createChatService({ db: deps.dbFor(user), repo: fixtureRepo('E'), market: fixtureMarket(), lib,
      today: () => FIXTURE_TODAY, llm: { complete, policy: buildModelPolicy(undefined), keys: {}, tokens: createTokenBudget(),
        fetchImpl: async () => { throw new Error('Models are disabled in the Deno Auth runner'); } },
    })(input, user, budget),
  });
}

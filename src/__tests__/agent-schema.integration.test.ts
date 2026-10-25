// @vitest-environment node
import { expect, it } from 'vitest';
import { getTestDbConfig, TEST_DB_SKIP } from '../test/agentTestDb.ts';
import { withTestDb } from '../../scripts/agent-test-db.ts';

const config = getTestDbConfig();
if (!config) console.info(TEST_DB_SKIP);
const live = it.skipIf(!config);

live('exposes compatible news and analyst columns and preserves every existing news item field', async () => {
  await withTestDb(async s => {
    const items = await s.seedMarket();
    for (const user of ['A', 'B'] as const) {
      const news = await s.rest(user, `stock_news?symbol=eq.${s.symbol}&select=symbol,items,fetched_at`);
      expect(news.status).toBe(200); expect(news.data[0].items).toEqual(items);
      const analyst = await s.rest(user, `analyst_snapshots?symbol=eq.${s.symbol}&select=symbol,data,fetched_at,last_attempt_at,status`);
      expect(analyst.status).toBe(200); expect(analyst.data[0]).toMatchObject({ symbol: s.symbol, status: 'ok', data: { target: 123 } });
    }
  });
}, 240000);

live('shared caches deny authenticated/anonymous writes, including direct REST', async () => {
  await withTestDb(async s => {
    await s.seedMarket();
    for (const user of ['A', 'B', 'anon'] as const) {
      for (const table of ['stock_news', 'analyst_snapshots']) {
        for (const method of ['POST', 'PATCH', 'DELETE']) {
          expect((await s.rest(user, `${table}?symbol=eq.${s.symbol}`, method, method === 'DELETE' ? undefined : { symbol: s.symbol })).status).toBeGreaterThanOrEqual(400);
        }
      }
    }
  });
}, 240000);

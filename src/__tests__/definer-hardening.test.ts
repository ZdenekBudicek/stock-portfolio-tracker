// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('hardens the older definer functions: empty search_path, no PUBLIC/anon execute, validated shared aliases', () => {
  const sql = readFileSync('supabase/migrations/20261027100100_definer_hardening.sql', 'utf8');
  for (const fn of ['seed_ticker_aliases', 'price_history_coverage', 'reserve_fundamentals_requests', 'release_fundamentals_requests']) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${fn}(`));
    expect(body.slice(0, body.indexOf('$$', body.indexOf('$$') + 2) + 400), fn).toMatch(/set search_path = ''/);
    expect(sql, fn).toContain(`revoke all on function public.${fn}(`);
    expect(sql.slice(sql.indexOf(`revoke all on function public.${fn}(`)).split('\n')[0], fn).toMatch(/\) from public, anon/);
  }
  // Only valid ISINs, only the caller's own tickers, bounded, never overwriting a known ISIN.
  expect(sql).toContain('public.isin_valid(a.isin)');
  expect(sql).toContain('t.user_id = v_user and upper(t.ticker) = a.alias');
  expect(sql).toContain('jsonb_array_length(p_rows) > 500');
  expect(sql).toContain('coalesce(public.ticker_alias.isin, excluded.isin)');
  expect(sql).not.toMatch(/drop table|truncate (?:table )?public\.|delete from public\.(?!fundamentals_requests)/i);
});

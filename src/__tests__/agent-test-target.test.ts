// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { assertTestTarget, getTestDbConfig, signInTestUser, testDbFetch, TEST_DB_SKIP } from '../test/agentTestDb.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('returns explicit SKIP without falling back to application configuration', () => {
  vi.stubEnv('TEST_DB_URL', '');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://production.invalid');
  vi.stubEnv('SUPABASE_URL', 'https://production.invalid');
  expect(getTestDbConfig()).toBeNull();
  expect(TEST_DB_SKIP).toBe('SKIP: TEST_DB_URL unset; real RLS/HTTP integration not verified');
});
it.each(['https://your-project-ref.supabase.co', 'https://unknown.supabase.co', 'http://localhost.evil.invalid:54321', 'http://127.0.0.1:54321/other', 'http://user:secret@127.0.0.1:54321'])('rejects unsafe target %s before auth', async url => {
  const fetchImpl = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubEnv('TEST_DB_URL', url);
  expect(() => assertTestTarget(url)).toThrow();
  await expect(signInTestUser('A')).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('accepts only explicitly configured loopback and fails incomplete configuration', () => {
  expect(() => assertTestTarget('http://127.0.0.1:54321')).not.toThrow();
  vi.stubEnv('TEST_DB_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('TEST_DB_ANON_KEY', '');
  expect(() => getTestDbConfig()).toThrow('Incomplete TEST_DB configuration');
});

it('pins SDK requests to the approved origin and disables redirects', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('[]'));
  vi.stubGlobal('fetch', fetchImpl);
  const guarded = testDbFetch('http://127.0.0.1:54321');
  expect(() => guarded('https://unknown.supabase.co/rest/v1/chat_threads')).toThrow('Unsafe test request');
  expect(() => guarded('http://user:secret@127.0.0.1:54321/rest/v1/chat_threads')).toThrow('Unsafe test request');
  expect(fetchImpl).not.toHaveBeenCalled();
  await guarded('http://127.0.0.1:54321/rest/v1/chat_threads', { redirect: 'follow' });
  expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
});

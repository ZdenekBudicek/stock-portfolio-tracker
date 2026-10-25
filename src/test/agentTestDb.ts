import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const TEST_DB_SKIP = 'SKIP: TEST_DB_URL unset; real RLS/HTTP integration not verified';
export type TestDbConfig = { url: string; anonKey: string; users: Record<'A' | 'B', { email: string; password: string }> };

export function assertTestTarget(value: string): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const target = JSON.parse(readFileSync(resolve(root, 'docs/ai-assistant/test-target.json'), 'utf8'));
  const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8');
  const productionRef = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  const url = new URL(value);
  if (!productionRef || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Unsafe test target');
  if (url.hostname === `${productionRef}.supabase.co` || target.projectRef === productionRef) throw new Error('Production target forbidden');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && target.loopbackOrigins.includes(url.origin);
  const hosted = target.projectName === 'trackora-test' && typeof target.projectRef === 'string' && /^[a-z0-9]{20}$/.test(target.projectRef)
    && url.origin === `https://${target.projectRef}.supabase.co`;
  if (!local && !hosted) throw new Error('Test target not explicitly allowed');
}

export function getTestDbConfig(): TestDbConfig | null {
  const url = process.env.TEST_DB_URL;
  if (!url) return null;
  assertTestTarget(url);
  const anonKey = process.env.TEST_DB_ANON_KEY;
  const emailA = process.env.TEST_USER_A_EMAIL, passwordA = process.env.TEST_USER_A_PASSWORD;
  const emailB = process.env.TEST_USER_B_EMAIL, passwordB = process.env.TEST_USER_B_PASSWORD;
  // No service key is read or passed to a chat runner; it belongs to later seed/cleanup only.
  if (!anonKey || !emailA || !passwordA || !emailB || !passwordB) throw new Error('Incomplete TEST_DB configuration');
  return { url: new URL(url).origin, anonKey, users: { A: { email: emailA, password: passwordA }, B: { email: emailB, password: passwordB } } };
}

export async function signInTestUser(user: 'A' | 'B'): Promise<{ id: string; jwt: string }> {
  const config = getTestDbConfig();
  if (!config) throw new Error(TEST_DB_SKIP);
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(config.users[user]), redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Test authentication failed');
  const data = await response.json();
  if (!data.user?.id || !data.access_token) throw new Error('Test authentication returned incomplete identity');
  return { id: data.user.id, jwt: data.access_token };
}

/** Pin every test SDK request to the reviewed API origin; never follow redirects. */
export function testDbFetch(url: string): typeof fetch {
  assertTestTarget(url);
  const origin = new URL(url).origin;
  return (input, init) => {
    const destination = new URL(input instanceof Request ? input.url : String(input));
    if (destination.origin !== origin || destination.username || destination.password) throw new Error('Unsafe test request');
    return fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(8000) });
  };
}

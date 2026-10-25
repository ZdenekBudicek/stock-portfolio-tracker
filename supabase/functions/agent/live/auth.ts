export type VerifiedUser = { id: string; jwt: string };

export async function verifyUser(req: Request, deps: { url: string; anonKey: string; fetchImpl: typeof fetch }, signal: AbortSignal): Promise<VerifiedUser | null> {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.get('Authorization') ?? '');
  if (!match) return null;
  const response = await deps.fetchImpl(`${deps.url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${match[1]}`, apikey: deps.anonKey }, signal, redirect: 'error',
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Authentication unavailable');
  const user = await response.json();
  return user && typeof user.id === 'string' && user.id ? { id: user.id, jwt: match[1] } : null;
}

// Scheduler-only endpoints. pg_cron calls them through net.http_post with
// `Authorization: Bearer <secret>`, where the secret is the project's service-role key (read
// from Vault, see docs/superpowers/plans/2026-06-23-production-foundation.md, Task 1.4) or
// CRON_SECRET. The same rule daily-snapshot-cron applies. Nothing else qualifies: the anon
// key is public (it ships in the frontend bundle) and any signed-up user holds a valid JWT,
// so "has a JWT" is no protection for a job that touches every user's data.
//
// Usage: isSchedulerToken(req.headers.get("Authorization"),
//          [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("CRON_SECRET")])
export function isSchedulerToken(authorization: string | null | undefined, secrets: (string | null | undefined)[]): boolean {
  const token = String(authorization ?? "").replace(/^Bearer\s*/i, "").trim();
  if (!token) return false;
  // An unset secret must never match (an empty CRON_SECRET would otherwise admit anyone).
  return secrets.some((s) => !!s && constantTimeEqual(token, s));
}

// Compare without an early exit, so the response time does not leak how much of the secret
// a guess got right.
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

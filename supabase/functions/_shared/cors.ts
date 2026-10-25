// Browser access for the user-facing data functions (audit A6): only the app's own origins, from
// AGENT_ALLOWED_ORIGINS (comma-separated, exact scheme://host[:port]) — the list the agent already uses.
// A request without an Origin header (another edge function, a server) needs no CORS headers at all.
export const allowedOrigins = (list: string | undefined): string[] => (list ?? "").split(",").map((o) => o.trim()).filter(Boolean);
export function corsHeadersFor(req: Request, allowed: readonly string[]): Record<string, string> {
  const origin = req.headers.get("Origin");
  const base = { "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", Vary: "Origin" };
  return origin && allowed.includes(origin) ? { ...base, "Access-Control-Allow-Origin": origin } : base;
}

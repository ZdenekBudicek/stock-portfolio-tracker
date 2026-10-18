// auto-sync, refresh-prices and sync-earnings' all-users run are scheduler-only: pg_cron
// calls them with the service-role key (read from Vault) or CRON_SECRET. Anything else —
// the public anon key, a signed-in user's JWT, nothing at all — must be turned away.
import { describe, it, expect } from "vitest";
import { isSchedulerToken } from "../../supabase/functions/_shared/auth";

const SERVICE = "eyJservice.role.key";
const CRON = "cron-secret-123";

describe("isSchedulerToken", () => {
  it("accepts the service-role key or CRON_SECRET as a bearer token", () => {
    expect(isSchedulerToken(`Bearer ${SERVICE}`, [SERVICE, CRON])).toBe(true);
    expect(isSchedulerToken(`bearer ${CRON}`, [SERVICE, CRON])).toBe(true);
  });

  it("rejects the anon key, a user JWT and a missing header", () => {
    expect(isSchedulerToken("Bearer eyJanon.key", [SERVICE, CRON])).toBe(false);
    expect(isSchedulerToken("Bearer eyJuser.jwt", [SERVICE, CRON])).toBe(false);
    expect(isSchedulerToken(null, [SERVICE, CRON])).toBe(false);
    expect(isSchedulerToken("", [SERVICE, CRON])).toBe(false);
  });

  it("never matches an unset secret", () => {
    // CRON_SECRET not configured: an empty bearer must not equal the empty secret.
    expect(isSchedulerToken("Bearer ", [SERVICE, undefined])).toBe(false);
    expect(isSchedulerToken("Bearer", [undefined, ""])).toBe(false);
  });

  it("rejects a prefix or an extension of a secret", () => {
    expect(isSchedulerToken(`Bearer ${SERVICE.slice(0, -1)}`, [SERVICE])).toBe(false);
    expect(isSchedulerToken(`Bearer ${SERVICE}x`, [SERVICE])).toBe(false);
  });
});

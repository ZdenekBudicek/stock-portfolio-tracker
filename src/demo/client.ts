// Demo-build replacement for src/integrations/supabase/client.ts (swapped in by the alias in
// vite.config.ts when building with `--mode demo`). Same export, but every request is served
// by the in-memory mock backend and the session is a fixed, fake demo user. No real project
// URL or key is referenced anywhere in the demo bundle.
import { createClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { createDemoAuthStorage, demoFetch } from "./mockBackend";

export const supabase = createClient<Database>("https://demo.invalid", "demo-anon-key", {
  auth: {
    storage: createDemoAuthStorage(),
    storageKey: "sb-demo-auth-token",
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: { fetch: demoFetch },
});

// Keep visitors inside the demo: "Odhlásit" explains itself instead of dropping them on a
// login screen they have no account for.
supabase.auth.signOut = (async () => {
  toast.info("V demu se nelze odhlásit — jsi přihlášen jako ukázkový uživatel.");
  return { error: null };
}) as typeof supabase.auth.signOut;

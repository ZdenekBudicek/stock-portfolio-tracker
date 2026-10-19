import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const queryClient = useQueryClient();
  // The id the cache was last filled for (undefined = not known yet). Most query keys carry
  // no user id (["positions"], ["transactions"], …), so when the identity changes in the same
  // tab — sign-out of A, sign-in of B — the cache would hand A's portfolio to B until each
  // query happened to refetch. Drop the whole cache on every identity change instead.
  const cacheOwner = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const adopt = (s: Session | null) => {
      const id = s?.user?.id ?? null;
      if (cacheOwner.current !== undefined && cacheOwner.current !== id) {
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      cacheOwner.current = id;
      setSession(s);
      setUser(s?.user ?? null);
    };

    // Listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      adopt(s);
    });

    // Then hydrate existing session
    supabase.auth.getSession().then(({ data }) => {
      adopt(data.session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

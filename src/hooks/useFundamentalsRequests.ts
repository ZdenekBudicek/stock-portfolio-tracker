// Statements for a company nobody had yet: ask for them right away instead of waiting for the
// nightly job (request-fundamentals edge function → GitHub Actions run, ~1–3 minutes).
//
// One watcher in the app shell covers every way a company gets in — a manual trade, a
// statement import, a broker sync on the server, the watchlist: it compares the user's
// holdings and watchlist with the companies that already have data and asks only for the rest,
// in batches of 10. The server decides again (aliases, crypto, runs already going, quota), so
// this is a cheap pre-filter plus a per-ticker guard in this browser: a day once the server
// answered, an hour after an error or while the feature is not configured.
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows, usePositions } from '@/hooks/usePortfolio';
import { useWatchlist } from '@/hooks/useExtras';
import { isCryptoHolding } from '../../supabase/functions/_shared/crypto.js';

const db = supabase as unknown as SupabaseClient;
const GUARD_KEY = 'trackuju.fundamentalsAsked';
const ANSWERED_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const BATCH = 10;
/** A run normally ends in 1–3 minutes; a pending request older than this is treated as stuck. */
export const STALE_PENDING_MS = 30 * 60 * 1000;

type Guard = Record<string, number>; // ticker → "do not ask again before" (epoch ms)
const readGuard = (): Guard => { try { return JSON.parse(localStorage.getItem(GUARD_KEY) ?? '{}'); } catch { return {}; } };
function writeGuard(tickers: string[], ms: number) {
  try {
    const g = readGuard();
    const now = Date.now();
    for (const [k, v] of Object.entries(g)) if (v < now) delete g[k];
    for (const t of tickers) g[t] = now + ms;
    localStorage.setItem(GUARD_KEY, JSON.stringify(g));
  } catch { /* private mode: the server-side guard still applies */ }
}

export interface RequestAnswer { dispatched: string[]; known?: string[]; recent?: string[]; ignored?: string[]; configured?: boolean; error?: string }

export async function requestFundamentals(tickers: string[]): Promise<RequestAnswer | null> {
  const list = [...new Set(tickers.map((t) => t.trim()).filter(Boolean))].slice(0, BATCH);
  if (list.length === 0) return null;
  const { data, error } = await supabase.functions.invoke('request-fundamentals', { body: { tickers: list } });
  if (error) throw error;
  return data as RequestAnswer;
}

/** Symbols with stored statements (just the keys, paged — never capped at one page). */
export function useKnownFundamentals() {
  return useQuery({
    queryKey: ['company-fundamentals-symbols'],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const rows = await fetchAllRows<{ symbol: string }>((from, to) => db.from('company_fundamentals').select('symbol').order('symbol').range(from, to));
      return new Set(rows.map((r) => r.symbol.toUpperCase()));
    },
  });
}

/** Mounted once in the app shell. */
export function useAutoRequestFundamentals() {
  const { data: positions = [] } = usePositions();
  const { data: watchlist = [] } = useWatchlist();
  const { data: known } = useKnownFundamentals();
  const qc = useQueryClient();
  const running = useRef(false);
  useEffect(() => {
    if (!known || running.current) return;
    const guard = readGuard();
    const now = Date.now();
    const candidates = [
      ...positions.filter((p: any) => Number(p.shares) > 0 && p.ticker !== 'CASH' && p.type !== 'Cash' && !isCryptoHolding(p.ticker, p.type)).map((p: any) => String(p.ticker)),
      ...watchlist.map((w: any) => String(w.ticker)),
    ];
    const missing = [...new Set(candidates)].filter((t) => !known.has(t.toUpperCase()) && !((guard[t] ?? 0) > now));
    if (missing.length === 0) return;
    running.current = true;
    (async () => {
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        try {
          const r = await requestFundamentals(batch);
          // Not configured yet / refused: try again in an hour, not tomorrow.
          writeGuard(batch, !r || r.configured === false || r.error ? RETRY_MS : ANSWERED_MS);
          if (r?.dispatched?.length) qc.invalidateQueries({ queryKey: ['fundamentals-request'] });
        } catch {
          writeGuard(batch, RETRY_MS); // offline or server error
          break;
        }
      }
    })().finally(() => { running.current = false; });
  }, [positions, watchlist, known, qc]);
}

export interface RequestState { status: 'pending' | 'done' | 'failed'; requested_at: string; finished_at: string | null }
export const isStalePending = (r: RequestState | null | undefined) =>
  !!r && r.status === 'pending' && Date.now() - Date.parse(r.requested_at) > STALE_PENDING_MS;

/**
 * The on-demand state of one company for the stock detail, keyed by its CANONICAL symbol (as
 * the server stores it — FB → META). While it is pending this polls; when it finishes the
 * statements and price history are reloaded (for the ticker the page shows, too).
 */
export function useFundamentalsRequest(ticker: string, enabled: boolean) {
  const qc = useQueryClient();
  const raw = ticker.trim();
  const q = useQuery({
    queryKey: ['fundamentals-request', raw.toUpperCase()],
    enabled: enabled && !!raw,
    queryFn: async (): Promise<RequestState | null> => {
      const { data: alias, error: aliasError } = await db.from('ticker_alias')
        .select('canonical').ilike('alias', raw.replace(/[\\%_]/g, '\\$&')).maybeSingle();
      if (aliasError) throw aliasError;
      const symbol = (alias?.canonical?.trim() || raw).toUpperCase();
      const { data, error } = await db.from('fundamentals_requests').select('status,requested_at,finished_at').eq('symbol', symbol).maybeSingle();
      if (error) throw error;
      return (data as RequestState | null) ?? null;
    },
    // Poll only while a run is under way and not stuck.
    refetchInterval: (query) => {
      const d = query.state.data as RequestState | null | undefined;
      return d?.status === 'pending' && !isStalePending(d) ? 15_000 : false;
    },
  });
  const status = q.data?.status;
  useEffect(() => {
    if (status === 'done' || status === 'failed') {
      qc.invalidateQueries({ queryKey: ['company-fundamentals', raw.toUpperCase()] });
      qc.invalidateQueries({ queryKey: ['company-fundamentals-symbols'] });
      qc.invalidateQueries({ queryKey: ['price-history', raw] });
    }
  }, [status, raw, qc]);
  return q;
}

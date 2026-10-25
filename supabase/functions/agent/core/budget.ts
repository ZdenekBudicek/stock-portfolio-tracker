export const REQUEST_TIMEOUT_MS = 45_000;
// The last 3 s of the request belong to persistence and the terminal answer: models and tools stop at 42 s.
export const TERMINAL_RESERVE_MS = 3_000;
export const MODEL_TIMEOUT_MS = 20_000;
export type RequestBudget = { startedAt: number; deadline: number; signal: AbortSignal; remainingMs(): number };

export function createRequestBudget(now: () => number, parent: AbortSignal): RequestBudget {
  const startedAt = now();
  const deadline = startedAt + REQUEST_TIMEOUT_MS;
  return { startedAt, deadline, signal: parent, remainingMs: () => Math.max(0, deadline - now()) };
}

/** A view of the request budget that ends `reserveMs` earlier; the signal stays the request's. */
export function stageBudget(budget: RequestBudget, reserveMs = TERMINAL_RESERVE_MS): RequestBudget {
  const deadline = budget.deadline - reserveMs;
  return { ...budget, deadline, remainingMs: () => Math.max(0, budget.remainingMs() - reserveMs) };
}

export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, budget: RequestBudget): Promise<T> {
  const controller = new AbortController();
  const duration = Math.min(ms, budget.remainingMs());
  if (budget.signal.aborted) throw budget.signal.reason ?? new DOMException('Cancelled', 'AbortError');
  if (duration <= 0) throw new DOMException('Deadline exceeded', 'TimeoutError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason = budget.signal.reason ?? new DOMException('Cancelled', 'AbortError');
      controller.abort(reason);
      reject(reason);
    };
    budget.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      const reason = new DOMException('Deadline exceeded', 'TimeoutError');
      controller.abort(reason);
      reject(reason);
    }, duration);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]);
  } finally {
    clearTimeout(timer);
    budget.signal.removeEventListener('abort', abort);
  }
}

export function chooseCpuPolicy(p95Ms: number): 'full' | 'limited' {
  return Number.isFinite(p95Ms) && p95Ms >= 0 && p95Ms < 1200 ? 'full' : 'limited';
}

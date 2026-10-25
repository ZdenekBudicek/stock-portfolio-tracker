import { isRealTradeTx, runFifo, type FifoResult, type FifoTx } from './fifo';

export interface CalculationCache {
  fifo(transactions: FifoTx[], filter: 'all' | 'real'): FifoResult;
  model<I extends object, O>(compute: (input: I, cache?: CalculationCache) => O, input: I): O;
}

/** One request only. Inputs and returned models must remain immutable while cached. */
export function createCalculationCache(): CalculationCache {
  const fifos = { all: new WeakMap<FifoTx[], FifoResult>(), real: new WeakMap<FifoTx[], FifoResult>() };
  const models = new WeakMap<object, WeakMap<object, unknown>>();
  const cache: CalculationCache = {
    fifo(transactions, filter) {
      let result = fifos[filter].get(transactions);
      if (!result) {
        result = runFifo(filter === 'real' ? transactions.filter(isRealTradeTx) : transactions);
        fifos[filter].set(transactions, result);
      }
      return result;
    },
    model(compute, input) {
      let entries = models.get(compute);
      if (!entries) { entries = new WeakMap(); models.set(compute, entries); }
      if (!entries.has(input)) entries.set(input, compute(input, cache));
      return entries.get(input) as ReturnType<typeof compute>;
    },
  };
  return cache;
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Production stores the Twelve Data key as TWELVE_DATA_API_KEY (used by refresh-prices); the agent's
// market source reads TWELVE_DATA_KEY. The entrypoint must accept the production name.
describe('agent secret names', () => {
  it('index.ts maps TWELVE_DATA_API_KEY to the market key', () => {
    const src = readFileSync('supabase/functions/agent/index.ts', 'utf8');
    expect(src).toMatch(/TWELVE_DATA_API_KEY/);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { corsHeadersFor } from '../../supabase/functions/_shared/cors.ts';

const req = (origin?: string) => new Request('https://x.supabase.co/functions/v1/company-data', { headers: origin ? { Origin: origin } : {} });
const allowed = ['https://portfolio-tracker-mauve-kappa.vercel.app'];

describe('data functions answer browsers only from the app origins (audit A6)', () => {
  it('echoes an allowed origin and never a wildcard', () => {
    expect(corsHeadersFor(req(allowed[0]), allowed)['Access-Control-Allow-Origin']).toBe(allowed[0]);
    expect(Object.values(corsHeadersFor(req(allowed[0]), allowed))).not.toContain('*');
  });
  it('gives a foreign origin no allow-origin header; a server call (no Origin) needs none', () => {
    expect(corsHeadersFor(req('https://evil.example'), allowed)).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(corsHeadersFor(req(), allowed)).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(corsHeadersFor(req('https://evil.example'), allowed).Vary).toBe('Origin');
  });
});

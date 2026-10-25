// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mainPrompt } from '../../supabase/functions/agent/core/prompts.ts';

// The app speaks to the user informally (tykání / Slovak "ty") everywhere: UI chrome, server
// answers, templates, errors and the SQL timeout text. This scans every Czech/Slovak string
// literal the assistant can show for the formal plural address.

const ROOT = join(__dirname, '..', '..');
const FILES = [
  ...walk('supabase/functions/agent').filter(f => /\.ts$/.test(f) && !/[\\/](_lib|fixtures)[\\/]/.test(f)),
  'supabase/migrations/20261025100000_ai_assistant.sql', 'supabase/migrations/20261025100010_ai_market_cache.sql',
  'supabase/migrations/20261025100020_agent_runs_analyst_call.sql',
  'src/demo/assistantReplay.ts', 'src/lib/assistantTransport.ts', 'src/hooks/useAssistantChat.ts', 'src/contexts/AssistantChatContext.tsx',
  ...walk('src/components/assistant'), 'scripts/agent-local.ts', 'src/i18n/locales/cs/pages.ts',
];
function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

// Pronouns and 2nd person plural verb endings; only strings with Czech/Slovak letters are checked.
const FORMAL = /(?<![\p{L}])(vás|vám|vámi|vaš\p{L}*|váš\p{L}*|\p{L}{2,}(?:íte|ete|ěte|ejte|ujte|ajte|ite|áte|ste|šte))(?![\p{L}])/giu;
// Czech/Slovak words that only look like a plural ending.
const NOT_FORMAL = new Set(['roste', 'poroste', 'vyroste', 'vzroste', 'naroste']);
const CZSK = /[áčďéěíňóřšťúůýžäľĺŕô]/i;
function literals(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.|'')*)'|`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter(s => CZSK.test(s));
}
function formalIn(file: string): string[] {
  return literals(readFileSync(join(ROOT, file), 'utf8')).flatMap(s => [...s.matchAll(FORMAL)].filter(m => !NOT_FORMAL.has(m[0].toLowerCase())).map(m => `${m[0]} — ${s.slice(0, 80)}`));
}

describe('informal address (tykání) in Czech and Slovak', () => {
  it('scans the assistant files it is meant to scan', () => {
    expect(FILES).toContain('supabase/functions/agent/core/answerTemplate.ts');
    expect(FILES).toContain('supabase/functions/agent/service.ts');
    // The scanner itself finds formal address.
    expect([...'Zkuste to prosím znovu, rozhodnutí je na vás.'.matchAll(FORMAL)].map(m => m[0])).toEqual(['Zkuste', 'vás']);
  });

  it.each(FILES)('%s has no formal address', file => {
    expect(formalIn(file)).toEqual([]);
  });

  it('the model is told to address the user informally', () => {
    for (const lang of ['cs', 'sk'] as const) expect(mainPrompt(lang, true)).toMatch(/informal/i);
  });

  it('the SQL lease-timeout answer is informal in cs and sk', () => {
    const sql = readFileSync(join(ROOT, 'supabase/migrations/20261025100000_ai_assistant.sql'), 'utf8');
    expect(sql).toMatch(/Zkus nový dotaz/);
    expect(sql).toMatch(/Skús novú otázku/);
  });
});

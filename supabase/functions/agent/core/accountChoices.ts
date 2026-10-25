import { ToolInputError, type AccountChoice, type Fact, type ToolCtx } from './types.ts';

type Selection = { ticker: string; choice: AccountChoice };
const selections = new WeakMap<Map<string, Fact>, Selection>();

/** Only a server reading of this question can authorize a choice; references never survive a request. */
export function selectAccount(ctx: ToolCtx, ticker: string, choices: AccountChoice[], question: string): string | undefined {
  const parts = question.split(/[,;.!?]/u).filter(part => !/(?<![\p{L}])(?:ne|nie|not|except|kromě|okrem)(?![\p{L}])/iu.test(part));
  const mentions = (text: string, value: string) => {
    if (!value) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  };
  const candidates = choices.filter(c => parts.some(part => /úč(?:et|t\p{L}*)|account/iu.test(part) && mentions(part, c.account)));
  const matched = candidates.length > 1 ? candidates.filter(c => parts.some(part => mentions(part, c.broker))) : candidates;
  if (matched.length !== 1) return undefined;
  selections.set(ctx.facts, { ticker, choice: matched[0] });
  return matched[0].id;
}

export function selectedAccount(ctx: ToolCtx, ticker: string, ref: string): AccountChoice {
  const selected = selections.get(ctx.facts);
  if (!selected || selected.ticker !== ticker || selected.choice.id !== ref) throw new ToolInputError('clarify', 'Choose the account in the current question.');
  return selected.choice;
}

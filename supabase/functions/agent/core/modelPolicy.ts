// Free models only. Every model the chat may call is listed here or explicitly verified as a
// zero-price OpenRouter `:free` model; anything else is refused before a request is made.

export type ModelRef = { provider: 'groq' | 'openrouter'; id: string; reasoningEffort?: 'low' };
export type VerifiedFree = { verifiedAt: string; inputPrice: 0; outputPrice: 0; privacyApproved: true; tools: true };
export type ModelPolicy = { main: ModelRef[]; router: ModelRef[]; openRouterEnabled: boolean; verifiedFree: ReadonlyMap<string, VerifiedFree> };

/**
 * Groq models confirmed on the family account in phase 0 (`llama-3.3-70b-versatile` is no longer
 * served). `max_completion_tokens` caps reasoning and answer together for all of them, so the
 * per-call budget is a real ceiling; a model without such a documented cap is not listed.
 */
// `maxOutput`: the free tier's own cap on requested output (Běh 27: qwen refuses any request above 1,000 output tokens a
// minute as "too large", so a larger `max_completion_tokens` never reaches it).
export const GROQ_MODELS: Readonly<Record<string, { reasoningEffort: boolean; outputCapIncludesReasoning: true; maxOutput?: number }>> = Object.freeze({
  'openai/gpt-oss-120b': { reasoningEffort: true, outputCapIncludesReasoning: true },
  'openai/gpt-oss-20b': { reasoningEffort: true, outputCapIncludesReasoning: true },
  'qwen/qwen3.8-27b': { reasoningEffort: false, outputCapIncludesReasoning: true, maxOutput: 1000 },
});

export const DEFAULT_MODEL_POLICY: ModelPolicy = Object.freeze({
  main: [{ provider: 'groq', id: 'openai/gpt-oss-120b', reasoningEffort: 'low' }, { provider: 'groq', id: 'qwen/qwen3.8-27b' }],
  router: [{ provider: 'groq', id: 'openai/gpt-oss-20b', reasoningEffort: 'low' }, { provider: 'groq', id: 'openai/gpt-oss-120b', reasoningEffort: 'low' }],
  openRouterEnabled: false,
  verifiedFree: new Map(),
}) as ModelPolicy;

/**
 * The news analyst's chain (Běh 28): the main model, then gpt-oss-20b — its own daily quota and no small output cap — and
 * then the rest of the main chain (qwen, whose 1,000-token output cap often cannot hold a repair).
 */
export function analystChain(policy: ModelPolicy): ModelRef[] {
  const backup: ModelRef = { provider: 'groq', id: 'openai/gpt-oss-20b', reasoningEffort: 'low' };
  const [first, ...rest] = policy.main;
  return first ? [first, ...(rest.some(r => r.id === backup.id) || first.id === backup.id ? [] : [backup]), ...rest] : [backup];
}

export class ModelPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelPolicyError'; }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const FREE_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/;

function verifiedEntry(id: string, raw: unknown): VerifiedFree {
  if (!FREE_ID.test(id)) throw new ModelPolicyError('Only explicit vendor/model:free OpenRouter models can be verified.');
  if (!record(raw) || raw.inputPrice !== 0 || raw.outputPrice !== 0 || raw.privacyApproved !== true || raw.tools !== true
    || typeof raw.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw.verifiedAt)) {
    throw new ModelPolicyError('An OpenRouter model needs a dated verification with zero prices, privacy approval and tool calling.');
  }
  return Object.freeze({ verifiedAt: raw.verifiedAt, inputPrice: 0, outputPrice: 0, privacyApproved: true, tools: true });
}

function modelRef(raw: unknown, openRouter: boolean, verified: ReadonlyMap<string, VerifiedFree>): ModelRef {
  if (!record(raw) || Object.keys(raw).some(k => !['provider', 'id', 'reasoningEffort'].includes(k)) || typeof raw.id !== 'string') {
    throw new ModelPolicyError('Invalid model reference.');
  }
  if (raw.reasoningEffort !== undefined && raw.reasoningEffort !== 'low') throw new ModelPolicyError('Only low reasoning effort is allowed.');
  if (raw.provider === 'groq') {
    const known = GROQ_MODELS[raw.id];
    if (!known) throw new ModelPolicyError('Unknown Groq model; only verified free models are allowed.');
    if (raw.reasoningEffort && !known.reasoningEffort) throw new ModelPolicyError('This model does not support reasoning effort.');
    return Object.freeze({ provider: 'groq', id: raw.id, ...(raw.reasoningEffort ? { reasoningEffort: 'low' as const } : {}) });
  }
  if (raw.provider === 'openrouter') {
    if (!openRouter) throw new ModelPolicyError('OpenRouter is disabled.');
    if (!verified.has(raw.id)) throw new ModelPolicyError('This OpenRouter model has not been verified as free and private.');
    if (raw.reasoningEffort) throw new ModelPolicyError('Reasoning effort is not verified for OpenRouter models.');
    return Object.freeze({ provider: 'openrouter', id: raw.id });
  }
  throw new ModelPolicyError('Unknown provider.');
}

/** Validates a configuration (e.g. parsed from an Edge secret); undefined gives the default policy. */
export function buildModelPolicy(config: unknown): ModelPolicy {
  if (config === undefined || config === null) return DEFAULT_MODEL_POLICY;
  if (!record(config) || Object.keys(config).some(k => !['main', 'router', 'openRouter'].includes(k))) throw new ModelPolicyError('Unknown model configuration.');
  let openRouterEnabled = false;
  const verified = new Map<string, VerifiedFree>();
  if (config.openRouter !== undefined) {
    const or = config.openRouter;
    if (!record(or) || Object.keys(or).some(k => !['enabled', 'verified'].includes(k)) || typeof or.enabled !== 'boolean') throw new ModelPolicyError('Invalid OpenRouter configuration.');
    openRouterEnabled = or.enabled;
    if (or.verified !== undefined) {
      if (!record(or.verified)) throw new ModelPolicyError('Invalid OpenRouter verification list.');
      for (const [id, entry] of Object.entries(or.verified)) verified.set(id, verifiedEntry(id, entry));
    }
  }
  const chain = (raw: unknown, fallback: ModelRef[]) => {
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new ModelPolicyError('A model chain has one to three models.');
    return raw.map(r => modelRef(r, openRouterEnabled, verified));
  };
  return Object.freeze({ main: chain(config.main, DEFAULT_MODEL_POLICY.main), router: chain(config.router, DEFAULT_MODEL_POLICY.router),
    openRouterEnabled, verifiedFree: verified });
}

/** Checked again right before each request, so a hand-built chain cannot reach a paid model. */
export function modelAllowed(policy: ModelPolicy, ref: ModelRef): boolean {
  if (ref.provider === 'groq') {
    const known = GROQ_MODELS[ref.id];
    return !!known && (!ref.reasoningEffort || known.reasoningEffort);
  }
  return ref.provider === 'openrouter' && policy.openRouterEnabled && policy.verifiedFree.has(ref.id) && FREE_ID.test(ref.id) && !ref.reasoningEffort;
}

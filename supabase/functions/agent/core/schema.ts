import type { JsonSchema } from './types.ts';

// A small runtime validator for the JSON Schema subset the tool registry uses. Every tool input
// and output passes through it: a TypeScript cast is not validation. Unknown keywords are rejected
// when a schema is registered (see assertSupported), so a schema cannot silently stop checking.
const KEYWORDS = new Set(['type', 'description', 'enum', 'const', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'anyOf', 'oneOf']);
type Schema = JsonSchema & {
  type?: string | string[]; enum?: unknown[]; const?: unknown; pattern?: string; format?: 'date' | 'date-time';
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number;
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema; minItems?: number; maxItems?: number; anyOf?: JsonSchema[]; oneOf?: JsonSchema[];
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A real calendar date: 2026-02-30 is rejected, not rolled over to March. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const isDateTime = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  && isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : Number.isFinite(value) ? 'number' : 'nonfinite';
  if (record(value)) return 'object';
  // Maps, class instances and functions are never valid tool data (they do not serialize).
  return typeof value === 'object' ? 'instance' : typeof value;
}

export function assertSupported(schema: JsonSchema, path = '$'): void {
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
  const s = schema as Schema;
  for (const [key, child] of Object.entries(s.properties ?? {})) assertSupported(child, `${path}.${key}`);
  if (s.items) assertSupported(s.items, `${path}[]`);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') assertSupported(s.additionalProperties, `${path}.*`);
  for (const child of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) assertSupported(child, path);
}

/** Returns the list of violations; empty means valid. */
export function validateSchema(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const s = schema as Schema, errors: string[] = [];
  const actual = typeOf(value);
  if (!['null', 'array', 'integer', 'number', 'object', 'string', 'boolean'].includes(actual)) return [`${path}: unsupported value`];
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => t === actual || (t === 'number' && actual === 'integer'))) {
      return [`${path}: expected ${types.join('|')}`];
    }
  }
  if (s.const !== undefined && value !== s.const) errors.push(`${path}: expected constant`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: not allowed`);
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: too short`);
    if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path}: too long`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: bad format`);
    if (s.format === 'date' && !isCalendarDate(value)) errors.push(`${path}: not a calendar date`);
    if (s.format === 'date-time' && !isDateTime(value)) errors.push(`${path}: not a date-time`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above maximum`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${path}: not above minimum`);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) errors.push(`${path}: not below maximum`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: too few items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: too many items`);
    if (s.items) value.forEach((item, i) => errors.push(...validateSchema(s.items!, item, `${path}[${i}]`)));
  }
  if (record(value)) {
    for (const key of s.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const known = s.properties && Object.prototype.hasOwnProperty.call(s.properties, key) ? s.properties[key] : undefined;
      if (known) errors.push(...validateSchema(known, child, `${path}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') errors.push(...validateSchema(s.additionalProperties, child, `${path}.${key}`));
    }
  }
  if (s.anyOf && !s.anyOf.some(branch => validateSchema(branch, value, path).length === 0)) errors.push(`${path}: matches no allowed shape`);
  if (s.oneOf && s.oneOf.filter(branch => validateSchema(branch, value, path).length === 0).length !== 1) errors.push(`${path}: must match exactly one shape`);
  return errors;
}

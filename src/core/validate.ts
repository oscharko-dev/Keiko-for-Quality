import { ValidationError } from "./brands.js";

/**
 * Minimal structural validation.
 *
 * Every accessor names the field it is validating so a rejection says which key was wrong without
 * ever echoing the value — configuration can carry an endpoint, and a rejected engine result can
 * carry candidate content.
 */

export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(field);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ValidationError(field);
  }
  return value;
}

export function asInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(field);
  }
  return value;
}

export function asArray(value: unknown, field: string, max = 4096): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError(field);
  return value;
}

export function asStringArray(value: unknown, field: string, max = 4096): string[] {
  return asArray(value, field, max).map((entry, i) => asString(entry, `${field}[${String(i)}]`));
}

/**
 * Rejects any key the schema does not know.
 *
 * This is the difference between a configuration mistake that fails loudly and one that silently
 * reviews less than the consumer believed they asked for — a misspelled `reviewRelevant` key would
 * otherwise leave the reviewer with an empty include list and a clean-looking run.
 */
export function rejectUnknownKeys(
  object: Readonly<Record<string, unknown>>,
  known: readonly string[],
  field: string,
): void {
  const allowed = new Set(known);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new ValidationError(`${field}.${key}`);
  }
}

export function requireKeys(
  object: Readonly<Record<string, unknown>>,
  required: readonly string[],
  field: string,
): void {
  for (const key of required) {
    if (!(key in object)) throw new ValidationError(`${field}.${key}`);
  }
}

/** Parses JSON without letting a parser error carry the document into the message. */
export function parseJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError(field);
  }
}

import { ValidationError } from "../core/brands.js";
import { asInteger, asObject, asString, rejectUnknownKeys, requireKeys } from "../core/validate.js";

/** Wire protocol the model endpoint speaks. */
export type ProviderProtocol = "openai" | "anthropic";

const PROTOCOLS: ReadonlySet<string> = new Set<string>(["openai", "anthropic"]);

/**
 * Everything the reviewer needs to run, minus every secret.
 *
 * The model credential is referenced by the *name* of the environment variable that holds it and is
 * read only at the moment the engine is spawned. It therefore never enters this object, and cannot
 * reach a diagnostic, an error message, or a serialized configuration dump — including one produced
 * by a future change that did not think about it.
 */
export interface RuntimeConfig {
  readonly protocol: ProviderProtocol;
  readonly endpoint: string;
  readonly model: string;
  /** Name of the environment variable carrying the model token. Never the token. */
  readonly tokenEnvName: string;
  readonly language: string;
  readonly concurrency: number;
  /** Per-file engine timeout. */
  readonly fileTimeoutSeconds: number;
  /** Whole-review wall-clock ceiling. */
  readonly reviewTimeoutSeconds: number;
  /** Hard token ceiling for one review. */
  readonly tokenBudget: number;
  /** Maximum findings this run may publish before the result is treated as implausible. */
  readonly maxFindings: number;
  /**
   * Git rename-detection similarity threshold, as a percentage. Explicit because it changes
   * classification: below it, a rename is reported as an unrelated delete plus add, and the
   * deletion half may then be judged review-critical when nothing was actually removed.
   */
  readonly renameDetectionPercent: number;
  /**
   * Gates the change-level cross-artifact pass (`contracts/change-pass.ts`, issue #80 technique
   * C): one additional bounded model call per run asking only cross-file contract questions.
   * Default `false` — a dark-shipped prototype whose promotion depends on a later qualification-
   * corpus measurement, not on this flag's own existence.
   *
   * Optional on this TYPE — not just defaulted by whoever builds a `RuntimeConfig` — because
   * several existing call sites across the codebase construct a `RuntimeConfig` object literal
   * directly (test fixtures predating this flag), and every one of them means "off" by simply not
   * mentioning it. `parseRuntimeConfig` below is the only real parser boundary, and it still
   * requires the raw key be present in its input, exactly like every other field: the action's
   * actual config-building path (`runtimeConfigFromInputs`) always supplies a concrete value, and
   * only hand-rolled fixtures elsewhere benefit from the type-level optionality.
   */
  readonly crossArtifactPass?: boolean;
}

const KEYS = [
  "protocol",
  "endpoint",
  "model",
  "tokenEnvName",
  "language",
  "concurrency",
  "fileTimeoutSeconds",
  "reviewTimeoutSeconds",
  "tokenBudget",
  "maxFindings",
  "renameDetectionPercent",
  "crossArtifactPass",
] as const;

/**
 * Accepts only an absolute https endpoint.
 *
 * Plain http would put a model credential and the full diff on the wire in clear text, and a
 * relative or scheme-less value would be resolved by the engine in a way this adapter cannot see.
 */
function parseEndpoint(value: unknown, field: string): string {
  const raw = asString(value, field, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(field);
  }
  if (url.protocol !== "https:") throw new ValidationError(field);
  if (url.username !== "" || url.password !== "") throw new ValidationError(field);
  return url.toString();
}

function parseTokenEnvName(value: unknown, field: string): string {
  const name = asString(value, field, 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new ValidationError(field);
  // Refusing to read the runner's own credentials closes the most direct exfiltration path: a
  // configuration that names GITHUB_TOKEN would hand the repository token to the model process.
  if (name === "GITHUB_TOKEN" || name.startsWith("ACTIONS_")) throw new ValidationError(field);
  return name;
}

/**
 * No shared `asBoolean` exists in `core/validate.ts` yet — every other typed accessor there
 * (`asString`, `asInteger`, …) is used by several modules, and this one so far has exactly one
 * caller. Kept local rather than adding a shared export on a single call site's behalf.
 */
function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(field);
  return value;
}

export function parseRuntimeConfig(input: unknown, field = "config"): RuntimeConfig {
  const object = asObject(input, field);
  requireKeys(object, [...KEYS], field);
  rejectUnknownKeys(object, [...KEYS], field);

  const protocol = asString(object.protocol, `${field}.protocol`, 32);
  if (!PROTOCOLS.has(protocol)) throw new ValidationError(`${field}.protocol`);

  return {
    protocol: protocol as ProviderProtocol,
    endpoint: parseEndpoint(object.endpoint, `${field}.endpoint`),
    model: asString(object.model, `${field}.model`, 256),
    tokenEnvName: parseTokenEnvName(object.tokenEnvName, `${field}.tokenEnvName`),
    language: asString(object.language, `${field}.language`, 64),
    concurrency: asInteger(object.concurrency, `${field}.concurrency`, 1, 32),
    fileTimeoutSeconds: asInteger(
      object.fileTimeoutSeconds,
      `${field}.fileTimeoutSeconds`,
      5,
      3600,
    ),
    reviewTimeoutSeconds: asInteger(
      object.reviewTimeoutSeconds,
      `${field}.reviewTimeoutSeconds`,
      30,
      21600,
    ),
    tokenBudget: asInteger(object.tokenBudget, `${field}.tokenBudget`, 1000, 100_000_000),
    maxFindings: asInteger(object.maxFindings, `${field}.maxFindings`, 1, 500),
    renameDetectionPercent: asInteger(
      object.renameDetectionPercent,
      `${field}.renameDetectionPercent`,
      1,
      100,
    ),
    crossArtifactPass: asBoolean(object.crossArtifactPass, `${field}.crossArtifactPass`),
  };
}

/**
 * Reads the model token at the point of use.
 *
 * Returns `undefined` rather than throwing so the caller decides whether a missing credential is a
 * configuration error or an intentional dry run.
 */
export function readModelToken(config: RuntimeConfig, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[config.tokenEnvName];
  return value !== undefined && value.length > 0 ? value : undefined;
}

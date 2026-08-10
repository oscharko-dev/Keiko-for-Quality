import { createHash } from "node:crypto";

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ScriptTarget,
  SyntaxKind,
  createSourceFile,
  forEachChild,
  getScriptKindFromFileName,
  isCallExpression,
  isExternalModuleReference,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedImports,
  isStringLiteralLike,
} from "typescript";

import { FIXED_PATH } from "./fixed-path.mjs";

/**
 * The qualification binding: what produced a measurement.
 *
 * A corpus score without this is an anecdote. Recall and precision are properties of a *pairing* —
 * this engine binary, this rule text, this model — and any one of the three can move without a
 * commit in this repository. The binding is what lets a later run say "the number changed and here
 * is the only input that changed with it" instead of "the number changed."
 *
 * Everything recorded here is a digest, a version, or an identifier. The endpoint is reduced to a
 * digest rather than omitted: drift in *which* endpoint answered is exactly the kind of thing a
 * re-qualification must notice, and a digest detects it without writing a URL into an artifact that
 * may be attached to an issue.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_CLOSURE_FORMAT = "keiko-for-quality/qualification-source-closure-v1";
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
export const QUALIFICATION_SCORER_ENTRYPOINTS = Object.freeze(["corpus/run.mjs"]);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function runtimeImport(declaration) {
  const clause = declaration.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (!isNamedImports(bindings) || bindings.elements.some((element) => !element.isTypeOnly))
  );
}

function runtimeExport(declaration) {
  if (declaration.isTypeOnly) return false;
  const clause = declaration.exportClause;
  return (
    clause === undefined ||
    !isNamedImports(clause) ||
    clause.elements.some((element) => !element.isTypeOnly)
  );
}

function stringSpecifier(node) {
  return node !== undefined && isStringLiteralLike(node) ? node.text : undefined;
}

function importDeclarationSpecifier(node) {
  if (!isImportDeclaration(node) || !runtimeImport(node)) return undefined;
  return stringSpecifier(node.moduleSpecifier);
}

function exportDeclarationSpecifier(node) {
  if (!isExportDeclaration(node) || !runtimeExport(node)) return undefined;
  return stringSpecifier(node.moduleSpecifier);
}

function importEqualsSpecifier(node) {
  if (
    !isImportEqualsDeclaration(node) ||
    node.isTypeOnly ||
    !isExternalModuleReference(node.moduleReference)
  ) {
    return undefined;
  }
  return stringSpecifier(node.moduleReference.expression);
}

function dynamicImportSpecifier(node) {
  if (!isCallExpression(node) || node.expression.kind !== SyntaxKind.ImportKeyword)
    return undefined;
  return stringSpecifier(node.arguments[0]);
}

function commonJsRequireSpecifier(node) {
  if (
    !isCallExpression(node) ||
    !isIdentifier(node.expression) ||
    node.expression.text !== "require" ||
    node.arguments.length !== 1
  ) {
    return undefined;
  }
  return stringSpecifier(node.arguments[0]);
}

function runtimeSpecifier(node) {
  const imported = importDeclarationSpecifier(node);
  if (imported !== undefined) return imported;
  const exported = exportDeclarationSpecifier(node);
  if (exported !== undefined) return exported;
  const importEquals = importEqualsSpecifier(node);
  if (importEquals !== undefined) return importEquals;
  const dynamicImport = dynamicImportSpecifier(node);
  if (dynamicImport !== undefined) return dynamicImport;
  return commonJsRequireSpecifier(node);
}

function isLocalSpecifier(specifier) {
  return specifier?.startsWith("./") === true || specifier?.startsWith("../") === true;
}

function localRuntimeSpecifiers(path, source) {
  if (!SOURCE_EXTENSIONS.has(extname(path))) return [];
  const sourceFile = createSourceFile(
    path,
    source,
    ScriptTarget.Latest,
    true,
    getScriptKindFromFileName(path),
  );
  const specifiers = new Set();
  const visit = (node) => {
    const specifier = runtimeSpecifier(node);
    if (isLocalSpecifier(specifier)) specifiers.add(specifier);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers];
}

function sourceCandidates(importer, specifier) {
  const requested = resolve(dirname(importer), specifier);
  const extension = extname(requested);
  if (extension === ".js") return [requested, `${requested.slice(0, -3)}.ts`];
  if (extension !== "") return [requested];
  return [
    requested,
    `${requested}.ts`,
    `${requested}.js`,
    `${requested}.mjs`,
    `${requested}.json`,
    join(requested, "index.ts"),
    join(requested, "index.js"),
  ];
}

function repositoryRelativePath(repositoryRoot, path) {
  const value = relative(repositoryRoot, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new TypeError("qualification source must stay inside the repository");
  }
  return value.split(sep).join("/");
}

function resolveLocalSource(repositoryRoot, importer, specifier) {
  for (const candidate of sourceCandidates(importer, specifier)) {
    repositoryRelativePath(repositoryRoot, candidate);
    if (isFile(candidate)) return candidate;
  }
  throw new TypeError(`qualification source import cannot be resolved: ${specifier}`);
}

function compareSourcePaths(left, right) {
  return left.localeCompare(right, "en");
}

function resolveEntrypoint(repositoryRoot, entrypoint) {
  if (typeof entrypoint !== "string" || entrypoint === "" || isAbsolute(entrypoint)) {
    throw new TypeError("qualification source entry point must be repository-relative");
  }
  const path = resolve(repositoryRoot, entrypoint);
  repositoryRelativePath(repositoryRoot, path);
  if (!isFile(path)) {
    throw new TypeError(`qualification source entry point is missing: ${entrypoint}`);
  }
  return path;
}

/**
 * Canonical, inspectable manifest behind a source-closure digest.
 *
 * Entry points are explicit. Their local runtime imports are then followed to a fixed point, while
 * type-only and package imports are deliberately excluded: neither can alter the JavaScript that
 * assembles prompts or invokes the model. Paths are repository-relative and sorted, so identical
 * source trees at different checkout locations produce the same manifest and digest.
 */
export function qualificationSourceClosureManifest(identity) {
  if (identity?.kind !== "source-closure") {
    throw new TypeError("qualification source closure identity is required");
  }
  const repositoryRoot = resolve(identity.repositoryRoot);
  if (!Array.isArray(identity.entrypoints) || identity.entrypoints.length === 0) {
    throw new TypeError("qualification source closure requires entry points");
  }
  const resolvedEntrypoints = identity.entrypoints.map((entrypoint) =>
    resolveEntrypoint(repositoryRoot, entrypoint),
  );
  const entrypoints = [
    ...new Set(resolvedEntrypoints.map((path) => repositoryRelativePath(repositoryRoot, path))),
  ].sort(compareSourcePaths);
  const pending = entrypoints.map((entrypoint) => resolve(repositoryRoot, entrypoint));
  const sources = new Map();
  while (pending.length > 0) {
    const path = pending.pop();
    const relativePath = repositoryRelativePath(repositoryRoot, path);
    if (sources.has(relativePath)) continue;
    const bytes = readFileSync(path);
    sources.set(relativePath, sha256Bytes(bytes));
    const source = bytes.toString("utf8");
    for (const specifier of localRuntimeSpecifiers(path, source)) {
      pending.push(resolveLocalSource(repositoryRoot, path, specifier));
    }
  }
  return {
    format: SOURCE_CLOSURE_FORMAT,
    entrypoints,
    sources: [...sources]
      .sort(([left], [right]) => compareSourcePaths(left, right))
      .map(([path, sha256]) => ({ path, sha256 })),
  };
}

export function qualificationSourceClosureDigest(identity) {
  return sha256Text(JSON.stringify(qualificationSourceClosureManifest(identity)));
}

/** The classic identity remains the binary's byte digest; staged mode hashes its source manifest. */
export function qualificationEngineDigest(identity) {
  if (identity?.kind === "file") return sha256File(identity.path);
  return qualificationSourceClosureDigest(identity);
}

function adapterCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      env: { PATH: FIXED_PATH },
    }).trim();
  } catch {
    // A measurement taken outside a checkout is still a measurement; it is just less traceable,
    // and saying so is more useful than failing the run over provenance.
    return "unknown";
  }
}

/**
 * @param {{ engine: object, rule: string | undefined, model: string, protocol: string,
 *           endpoint: string, measuredAt: string }} inputs
 */
export function buildBinding(inputs) {
  const repositoryRoot = join(HERE, "..");
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  return {
    measuredAt: inputs.measuredAt,
    adapter: { version: manifest.version, commit: adapterCommit() },
    engine: { sha256: qualificationEngineDigest(inputs.engine) },
    rule: { sha256: sha256File(inputs.rule) },
    // Both halves of the corpus: the cases and the scorer. Digesting only the data would let a
    // change to what counts as a "find" move every number with nothing in the record to show it.
    corpus: {
      cases: sha256File(join(HERE, "cases.mjs")),
      scorer: qualificationSourceClosureDigest({
        kind: "source-closure",
        repositoryRoot,
        entrypoints: QUALIFICATION_SCORER_ENTRYPOINTS,
      }),
    },
    model: {
      id: inputs.model,
      protocol: inputs.protocol,
      endpointDigest: sha256Text(inputs.endpoint),
    },
  };
}

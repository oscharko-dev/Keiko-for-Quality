import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commitSha } from "../core/brands.js";
import type { RepositoryEvidenceEntry } from "./evidence.js";
import { toRetrievedEvidence } from "./retrieved-evidence.js";
import { evidenceProvenanceKey } from "./substantiate.js";
import {
  MAX_REPOSITORY_FOLLOW_UP_TERMS,
  RepositoryContextRetrievalError,
  collectInitialRepositoryContext,
  collectRepositoryContextFollowUp,
  mergeRepositoryEvidenceContexts,
  validatedRetrieveTerms,
  type RepositoryContextRequest,
} from "./repository-context.js";

// The pinned parser and its acquisition path have dedicated hermetic suites. Default owner
// enrichment is disabled here so repository/Git tests stay offline on a runner with an empty tool
// cache; owner-specific cases inject the exact owner result they exercise.
vi.mock("./ast-grep-search.js", async (importOriginal) => ({
  ...(await importOriginal()),
  findAstAnchorOwnerAtHead: (): Promise<undefined> => Promise.resolve(undefined),
}));

const temporaryRepositories: string[] = [];

async function write(repository: string, path: string, content: string): Promise<void> {
  await mkdir(join(repository, path.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(join(repository, path), content, "utf8");
}

async function writeSaturatedTerm(repository: string, term: string): Promise<void> {
  const content = Array.from({ length: 12 }, () => `${term}();`).join("\n");
  for (let index = 0; index < 9; index += 1) {
    await write(repository, `src/saturated-${String(index)}.ts`, content);
  }
}

function git(repository: string, ...args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
}

async function fixture(): Promise<{
  readonly repository: string;
  readonly request: RepositoryContextRequest;
}> {
  const repository = await mkdtemp(join(tmpdir(), "kfq-repository-context-"));
  temporaryRepositories.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  await write(repository, "src/review.ts", "const result = useCapability(input);\n");
  await write(
    repository,
    "src/definition.ts",
    "export function useCapability(value: string): string { return runtimeGuard(value); }\n",
  );
  await write(repository, "src/caller.ts", "return useCapability(value);\n");
  await write(repository, "tests/capability.test.ts", 'expect(useCapability("x")).toBe("x");\n');
  await write(
    repository,
    "src/follow-up.ts",
    "export function secondaryContract(): boolean { return true; }\n",
  );
  await write(repository, "src/follow-up-caller.ts", "return secondaryContract();\n");
  await write(
    repository,
    "src/Ambiguous.java",
    "class Ambiguous {\n  public boolean ambiguousContract() { return true; }\n}\n",
  );
  await write(
    repository,
    "src/payload.ts",
    "// $(touch PWNED)\nexport const inertCandidateData = true;\n",
  );
  await write(
    repository,
    "package.json",
    '{\n  "engines": { "node": ">=22" },\n  "dependencies": { "react": "19.1.0" }\n}\n',
  );
  await write(
    repository,
    "tsconfig.json",
    '{\n  "compilerOptions": { "target": "ES2024", "jsx": "react-jsx" }\n}\n',
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "fixture");
  const head = commitSha(git(repository, "rev-parse", "HEAD"));
  const request: RepositoryContextRequest = {
    repositoryPath: repository,
    pathValue: process.env.PATH ?? "",
    head,
    base: head,
    reviewPath: "src/review.ts",
    baseReviewPath: "src/review.ts",
    findingAnchor: { startLine: 1, endLine: 1 },
    findingContent: "Calling useCapability bypasses the runtime guard.",
    anchorText: "const result = useCapability(input);",
  };
  return { repository, request };
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("validatedRetrieveTerms", () => {
  it("accepts only three closed identifier shapes for the one follow-up", () => {
    expect(
      validatedRetrieveTerms([
        "secondaryContract",
        "state.member",
        "$(touch PWNED)",
        "the",
        "thirdContract",
        "fourthContract",
      ]),
    ).toEqual(["secondaryContract", "state.member", "thirdContract"]);
    expect(MAX_REPOSITORY_FOLLOW_UP_TERMS).toBe(3);
  });

  it("keeps an exact qualified term while rejecting its broad stop-word tail", () => {
    expect(validatedRetrieveTerms(["String.length", "length"])).toEqual(["String.length"]);
  });
});

describe("repository context collection", () => {
  it("reads definitions, callsites, tests, and runtime manifests from the exact HEAD", async () => {
    const { repository, request } = await fixture();
    await write(repository, "src/definition.ts", "const WORKTREE_ONLY = true;\n");

    const context = await collectInitialRepositoryContext(request);
    const kinds = new Set(context.entries.map((entry) => entry.kind));
    const renderedLines = context.entries.map((entry) => entry.content).join("\n");

    expect(kinds).toEqual(new Set(["definition", "callsite", "test", "manifest"]));
    expect(renderedLines).toContain("function useCapability");
    expect(renderedLines).toContain("return useCapability");
    expect(renderedLines).toContain("expect(useCapability");
    expect(renderedLines).toMatch(/node|react|ES2024/u);
    expect(renderedLines).not.toContain("WORKTREE_ONLY");
    expect(context.headCommit).toBe(request.head);
    expect(await readFile(join(repository, "src/payload.ts"), "utf8")).toContain("touch PWNED");
    await expect(readFile(join(repository, "PWNED"), "utf8")).rejects.toThrow();
  });

  it("searches the immutable BASE commit only when the closed base source is requested", async () => {
    const { repository, request } = await fixture();
    await write(
      repository,
      "src/base-only.ts",
      "export function removedContract(): boolean { return true; }\n",
    );
    git(repository, "add", "src/base-only.ts");
    git(repository, "commit", "-qm", "add base-only contract");
    const base = commitSha(git(repository, "rev-parse", "HEAD"));
    await rm(join(repository, "src/base-only.ts"));
    git(repository, "add", "-A");
    git(repository, "commit", "-qm", "remove base-only contract");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const bound = { ...request, head, base };

    const headContext = await collectRepositoryContextFollowUp(bound, ["removedContract"]);
    const baseContext = await collectRepositoryContextFollowUp(bound, ["removedContract"], {
      sourceSide: "B",
      structuralSearch: () => Promise.resolve([]),
    });

    expect(headContext).toEqual({ sourceCommit: head, side: "H", entries: [] });
    expect(baseContext.sourceCommit).toBe(base);
    expect(baseContext.side).toBe("B");
    expect(baseContext.entries).toContainEqual({
      path: "src/base-only.ts",
      line: 1,
      content: "export function removedContract(): boolean { return true; }",
      kind: "definition",
    });
  });

  it("withholds a BASE challenge when an added file has no BASE anchor", async () => {
    const { repository, request } = await fixture();
    const base = request.head;
    await write(
      repository,
      "src/added.ts",
      "export function addedContract(): boolean { return true; }\n",
    );
    git(repository, "add", "src/added.ts");
    git(repository, "commit", "-qm", "add contract fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    let ownerCalls = 0;
    let structuralCalls = 0;

    const context = await collectRepositoryContextFollowUp(
      {
        ...request,
        head,
        base,
        reviewPath: "src/added.ts",
        baseReviewPath: "src/added.ts",
        findingAnchor: { startLine: 1, endLine: 1 },
      },
      ["addedContract"],
      {
        sourceSide: "B",
        anchorOwnerSearch: () => {
          ownerCalls += 1;
          return Promise.reject(new Error("must not inspect an absent BASE file"));
        },
        structuralSearch: () => {
          structuralCalls += 1;
          return Promise.reject(new Error("must not inspect an absent BASE file"));
        },
      },
    );

    expect(context).toEqual({ sourceCommit: base, side: "B", entries: [] });
    expect(ownerCalls).toBe(0);
    expect(structuralCalls).toBe(0);
  });

  it("keeps strong-term sightings when a later noisy initial term fails", async () => {
    const { repository, request } = await fixture();
    const wrapper = join(repository, "term-isolation-bin");
    await mkdir(wrapper);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(wrapper, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "commonValue" ]; then printf 'searched\\n' > "$PWD/noisy-term-searched"; exit 2; fi\ndone\nexec "${realGit}" "$@"\n`,
      "utf8",
    );
    await chmod(join(wrapper, "git"), 0o755);

    const context = await collectInitialRepositoryContext({
      ...request,
      pathValue: `${wrapper}:${request.pathValue}`,
      findingContent: "Call `secondaryContract` before returning.",
      anchorText: "const result = secondaryContract();",
      unifiedDiff: "@@ -1 +1 @@\n-oldValue();\n+commonValue();",
    });

    expect(
      context.entries.some(
        (entry) => entry.kind === "definition" && entry.content.includes("secondaryContract"),
      ),
    ).toBe(true);
    await expect(readFile(join(repository, "noisy-term-searched"), "utf8")).resolves.toBe(
      "searched\n",
    );
  });

  it("keeps package and lockfile evidence lexical for historical finding 3740855222", async () => {
    const { repository, request } = await fixture();
    await write(repository, "package.json", '{\n  "dependencies": { "undici": "7.13.0" }\n}\n');
    await write(
      repository,
      "package-lock.json",
      '{\n  "packages": { "node_modules/undici": { "version": "7.13.0" } }\n}\n',
    );
    git(repository, "add", "package.json", "package-lock.json");
    git(repository, "commit", "-qm", "add lockfile fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    let structuralCalls = 0;

    const context = await collectRepositoryContextFollowUp(
      {
        ...request,
        head,
        base: head,
        reviewPath: "package.json",
        baseReviewPath: "package.json",
        findingAnchor: { startLine: 2, endLine: 2 },
        findingContent: "The `undici` dependency and lockfile must agree.",
        anchorText: '  "dependencies": { "undici": "7.13.0" }',
      },
      ["undici"],
      {
        structuralSearch: () => {
          structuralCalls += 1;
          return Promise.reject(new Error("JSON must stay outside ast-grep"));
        },
      },
    );

    expect(structuralCalls).toBe(0);
    expect(context.entries).toContainEqual({
      path: "package-lock.json",
      line: 2,
      content: '  "packages": { "node_modules/undici": { "version": "7.13.0" } }',
      kind: "callsite",
    });
  });

  it("does not let optional code-owner parsing erase package and lockfile evidence", async () => {
    const { repository, request } = await fixture();
    await write(repository, request.reviewPath, "const undici = useCapability(input);\n");
    await write(repository, "package.json", '{\n  "dependencies": { "undici": "7.13.0" }\n}\n');
    await write(
      repository,
      "package-lock.json",
      '{\n  "packages": { "node_modules/undici": { "version": "7.13.0" } }\n}\n',
    );
    git(repository, "add", request.reviewPath, "package.json", "package-lock.json");
    git(repository, "commit", "-qm", "add parser-independent package evidence");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    let structuralCalls = 0;

    const context = await collectRepositoryContextFollowUp(
      { ...request, head, base: head },
      ["undici"],
      {
        anchorOwnerSearch: () =>
          Promise.resolve({
            name: "useCapability",
            definition: {
              path: request.reviewPath,
              line: 1,
              content: "const result = useCapability(input);",
              kind: "definition",
            },
          }),
        structuralSearch: () => {
          structuralCalls += 1;
          return Promise.reject(new Error("optional owner parser unavailable"));
        },
      },
    );

    expect(structuralCalls).toBe(1);
    expect(context.entries).toContainEqual({
      path: "package-lock.json",
      line: 2,
      content: '  "packages": { "node_modules/undici": { "version": "7.13.0" } }',
      kind: "callsite",
    });
  });

  it("reserves matches for a later term when the first term saturates its share", async () => {
    const { repository, request } = await fixture();
    const repeated = Array.from(
      { length: 12 },
      (_value, index) => `export const commonValue = ${String(index)};`,
    ).join("\n");
    for (let index = 0; index < 9; index += 1) {
      await write(repository, `src/noise-${String(index)}.ts`, repeated);
    }
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add saturated search fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));

    const context = await collectInitialRepositoryContext({
      ...request,
      head,
      findingContent: "Check `commonValue` before calling the contract.",
      anchorText: "const result = secondaryContract();",
    });

    expect(
      context.entries.some(
        (entry) => entry.kind === "definition" && entry.content.includes("secondaryContract"),
      ),
    ).toBe(true);
  });

  it("keeps search-term relevance ahead of repository path ordering", async () => {
    const { request } = await fixture();
    const context = await collectInitialRepositoryContext({
      ...request,
      findingContent: "Check `secondaryContract` before dispatch.",
      anchorText: "const result = useCapability(input);",
    });

    expect(context.entries.find((entry) => entry.kind === "definition")?.content).toContain(
      "secondaryContract",
    );
  });

  it("reserves a top-term cross-file sighting after review-file noise", async () => {
    const { repository, request } = await fixture();
    const reviewNoise = Array.from(
      { length: 12 },
      (_value, index) => `parseGatewayConfigUpload(localValue${String(index)});`,
    ).join("\n");
    await write(repository, request.reviewPath, reviewNoise);
    await write(
      repository,
      "zz/exact-contract.ts",
      "return parseGatewayConfigUpload(uploadedConfig);\n",
    );
    await write(
      repository,
      "src/generic-a-definition.ts",
      "export function genericAlpha(): boolean { return true; }\n",
    );
    await write(repository, "src/generic-e-definition.ts", "export const genericAlpha = true;\n");
    await write(repository, "tests/generic-beta.test.ts", "expect(genericBeta()).toBe(true);\n");
    await write(repository, "src/generic-c-call.ts", "return genericGamma();\n");
    await write(repository, "src/generic-d-definition.ts", "export const genericDelta = true;\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add ranked retrieval fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));

    const context = await collectInitialRepositoryContext({
      ...request,
      head,
      findingContent: "Validate `parseGatewayConfigUpload` before dispatch.",
      anchorText: "const result = genericAlpha(genericBeta, genericGamma, genericDelta);",
    });

    expect(context.entries).toContainEqual({
      path: "zz/exact-contract.ts",
      line: 1,
      content: "return parseGatewayConfigUpload(uploadedConfig);",
      kind: "callsite",
    });
  });

  it("admits distant same-file producer and consumer evidence only on explicit follow-up", async () => {
    const { repository, request } = await fixture();
    const source = [
      "const voiceRoles = partitionProviders(input);",
      ...Array.from({ length: 23 }, (_value, index) => `const filler${String(index)} = true;`),
      "partitionProviders(alreadyVisible);",
      "export function partitionProviders(input: unknown): unknown { return input; }",
      "return partitionProviders(providerInput);",
    ].join("\n");
    await write(repository, request.reviewPath, `${source}\n`);
    for (const path of [
      "src/a-contract.ts",
      "src/b-contract.ts",
      "src/c-contract.ts",
      "src/d-contract.ts",
    ]) {
      await write(repository, path, "partitionProviders(crossFileInput);\n");
    }
    git(repository, "add", "src");
    git(repository, "commit", "-qm", "add distant same-file contract");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const anchoredRequest: RepositoryContextRequest = {
      ...request,
      head,
      findingAnchor: { startLine: 1, endLine: 1 },
      findingContent: "Check `partitionProviders` before deriving voice roles.",
      anchorText: "const voiceRoles = partitionProviders(input);",
    };

    const initial = await collectInitialRepositoryContext(anchoredRequest);
    expect(initial.entries.some((entry) => entry.path === request.reviewPath)).toBe(false);

    const followUp = await collectRepositoryContextFollowUp(
      anchoredRequest,
      ["partitionProviders"],
      {
        structuralSearch: ({ candidatePaths, findingAnchor }) => {
          expect(candidatePaths).toContain(request.reviewPath);
          expect(findingAnchor).toEqual({ startLine: 1, endLine: 1 });
          return Promise.resolve([
            {
              path: request.reviewPath,
              line: 1,
              content: "const voiceRoles = partitionProviders(input);",
              kind: "callsite" as const,
            },
            {
              path: request.reviewPath,
              line: 25,
              content: "partitionProviders(alreadyVisible);",
              kind: "callsite" as const,
            },
            {
              path: request.reviewPath,
              line: 26,
              content:
                "export function partitionProviders(input: unknown): unknown { return input; }",
              kind: "definition" as const,
            },
            {
              path: request.reviewPath,
              line: 27,
              content: "return partitionProviders(providerInput);",
              kind: "callsite" as const,
            },
          ]);
        },
      },
    );

    const sameFile = followUp.entries.filter((entry) => entry.path === request.reviewPath);
    expect(sameFile).toEqual([
      expect.objectContaining({ line: 26, kind: "definition" }),
      expect.objectContaining({ line: 27, kind: "callsite" }),
    ]);
    expect(sameFile.some((entry) => entry.line <= 25)).toBe(false);
    expect(followUp.entries.length).toBeLessThanOrEqual(12);
    expect(new Set(followUp.entries.map((entry) => entry.path)).size).toBeLessThanOrEqual(5);
  });

  it("falls back from an anchor-only private helper to its adjacent public owner and tests", async () => {
    const { repository, request } = await fixture();
    const source = [
      ...Array.from({ length: 28 }, (_value, index) => `const filler${String(index)} = true;`),
      "function privateArtifactFailures(manifest: unknown): string[] {",
      "  const failures: string[] = [];",
      "  if (manifest === undefined) failures.push('malformed');",
      "  return failures;",
      "}",
      "export function publicManifestFailures(manifest: unknown): string[] {",
      "  return privateArtifactFailures(manifest);",
      "}",
    ].join("\n");
    await write(repository, request.reviewPath, `${source}\n`);
    await write(
      repository,
      "tests/manifest.test.ts",
      "expect(publicManifestFailures(validManifest)).toEqual([]);\n",
    );
    git(repository, "add", "src/review.ts", "tests/manifest.test.ts");
    git(repository, "commit", "-qm", "add adjacent owner fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const anchored: RepositoryContextRequest = {
      ...request,
      head,
      base: head,
      findingAnchor: { startLine: 31, endLine: 31 },
      findingContent:
        "`privateArtifactFailures` rejects valid manifests when the malformed-entry guard fires.",
      anchorText: "  if (manifest === undefined) failures.push('malformed');",
    };
    let structuralTerms: readonly string[] = [];

    const context = await collectRepositoryContextFollowUp(anchored, ["privateArtifactFailures"], {
      anchorOwnerSearch: () =>
        Promise.resolve({
          name: "publicManifestFailures",
          definition: {
            path: request.reviewPath,
            line: 34,
            content: "export function publicManifestFailures(manifest: unknown): string[] {",
            kind: "definition",
          },
        }),
      structuralSearch: ({ terms }) => {
        structuralTerms = terms;
        return Promise.resolve([]);
      },
    });
    const known = new Set(
      context.entries
        .filter((entry) => entry.path === request.reviewPath)
        .map((entry) => evidenceProvenanceKey(entry.path, "H", entry.line)),
    );
    const retrieved = toRetrievedEvidence(context, known);

    expect(structuralTerms).toContain("publicManifestFailures");
    expect(retrieved.chunks).toEqual([
      {
        path: "tests/manifest.test.ts",
        side: "H",
        lines: [
          {
            line: 1,
            text: "expect(publicManifestFailures(validManifest)).toEqual([]);",
          },
        ],
      },
    ]);
  });

  it("keeps clear primary evidence ahead of independently derived owner context", async () => {
    const { request } = await fixture();
    let searchedTerms: readonly string[] = [];

    const context = await collectRepositoryContextFollowUp(request, ["secondaryContract"], {
      anchorOwnerSearch: () =>
        Promise.resolve({
          name: "useCapability",
          definition: {
            path: request.reviewPath,
            line: 1,
            content: "const result = useCapability(input);",
            kind: "definition",
          },
        }),
      structuralSearch: ({ terms }) => {
        searchedTerms = terms;
        return Promise.resolve([]);
      },
    });

    expect(searchedTerms).toEqual(["secondaryContract", "useCapability"]);
    expect(context.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(true);
    expect(context.entries.some((entry) => entry.content.includes("useCapability"))).toBe(true);
  });

  it("does not add a broad adjacent fallback when clear primary owner enrichment is unavailable", async () => {
    const { request } = await fixture();
    let searchedTerms: readonly string[] = [];

    const context = await collectRepositoryContextFollowUp(request, ["secondaryContract"], {
      anchorOwnerSearch: () => Promise.reject(new Error("owner unavailable")),
      structuralSearch: ({ terms }) => {
        searchedTerms = terms;
        return Promise.resolve([]);
      },
    });

    // `useCapability` is visible at the reviewed anchor and would be the deterministic fallback.
    // A clear cross-file primary hit cannot activate that broader search merely because optional
    // owner discovery failed.
    expect(searchedTerms).toEqual(["secondaryContract"]);
    expect(context.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(true);
    expect(context.entries.every((entry) => !entry.content.includes("useCapability"))).toBe(true);
  });

  it("reserves all four ambiguous primary blobs ahead of optional owner enrichment", async () => {
    const { repository, request } = await fixture();
    await write(repository, request.reviewPath, "return publicOwner(input);\n");
    for (let index = 0; index < 4; index += 1) {
      await write(
        repository,
        `src/primary-${String(index)}.ts`,
        "return contract.primary(input);\n",
      );
    }
    for (let index = 0; index < 3; index += 1) {
      await write(repository, `src/owner-${String(index)}.ts`, "return publicOwner(input);\n");
    }
    git(repository, "add", "src");
    git(repository, "commit", "-qm", "add ambiguous primary and owner candidates");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const primaryPaths = Array.from(
      { length: 4 },
      (_value, index) => `src/primary-${String(index)}.ts`,
    );
    let searchedTerms: readonly string[] = [];

    const context = await collectRepositoryContextFollowUp(
      { ...request, head, base: head },
      ["contract.primary"],
      {
        anchorOwnerSearch: () =>
          Promise.resolve({
            name: "publicOwner",
            definition: {
              path: request.reviewPath,
              line: 1,
              content: "return publicOwner(input);",
              kind: "definition",
            },
          }),
        structuralSearch: ({ candidatePaths, terms }) => {
          searchedTerms = terms;
          expect(candidatePaths.slice(0, 4)).toEqual(primaryPaths);
          return Promise.resolve([
            {
              path: primaryPaths[0] ?? "",
              line: 1,
              content: "return contract.primary(input);",
              kind: "callsite" as const,
            },
          ]);
        },
      },
    );

    expect(searchedTerms[0]).toBe("primary");
    expect(context.entries).toContainEqual({
      path: primaryPaths[0],
      line: 1,
      content: "return contract.primary(input);",
      kind: "callsite",
    });
  });

  it.each([
    [3740721453, "downloadAssets"],
    [3741289682, "applyUploadedVoiceRoles"],
    [3741289718, "voiceRoles"],
  ] as const)(
    "recovers owner callers and tests for historical finding %i (%s)",
    async (_databaseId, ownerName) => {
      const { repository, request } = await fixture();
      const source = [
        `function ${ownerName}(): void {`,
        "  verifyChangedContract();",
        "}",
        ...Array.from(
          { length: 25 },
          (_value, index) => `const ownerPadding${String(index)} = true;`,
        ),
        `${ownerName}();`,
      ].join("\n");
      await write(repository, request.reviewPath, `${source}\n`);
      await write(
        repository,
        `tests/${ownerName}.test.ts`,
        `expect(${ownerName}()).toBeDefined();\n`,
      );
      git(repository, "add", request.reviewPath, `tests/${ownerName}.test.ts`);
      git(repository, "commit", "-qm", `add ${ownerName} historical shape`);
      const head = commitSha(git(repository, "rev-parse", "HEAD"));
      const anchored: RepositoryContextRequest = {
        ...request,
        head,
        base: head,
        findingAnchor: { startLine: 1, endLine: 3 },
        findingContent: "The changed contract may fail at its owner.",
        anchorText: "  verifyChangedContract();",
      };

      const context = await collectRepositoryContextFollowUp(
        anchored,
        ["DefinitelyMissingIdentifier"],
        {
          anchorOwnerSearch: ({ head: selected, reviewPath, findingAnchor }) => {
            expect(selected).toBe(head);
            expect(reviewPath).toBe(request.reviewPath);
            expect(findingAnchor).toEqual({ startLine: 1, endLine: 3 });
            return Promise.resolve({
              name: ownerName,
              definition: {
                path: request.reviewPath,
                line: 1,
                content: `function ${ownerName}(): void {`,
                kind: "definition",
              },
            });
          },
          structuralSearch: () => Promise.resolve([]),
        },
      );
      const retrieved = toRetrievedEvidence(context);

      expect(retrieved.chunks).toHaveLength(2);
      expect(new Set(retrieved.chunks.map((chunk) => chunk.path))).toEqual(
        new Set([request.reviewPath, `tests/${ownerName}.test.ts`]),
      );
      expect(retrieved.chunks.flatMap((chunk) => chunk.lines)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: `${ownerName}();` }),
          expect.objectContaining({ text: `expect(${ownerName}()).toBeDefined();` }),
        ]),
      );
    },
  );

  it("keeps the one follow-up separate and combines only the same exact commit", async () => {
    const { request } = await fixture();
    const initial = await collectInitialRepositoryContext(request);
    const followUp = await collectRepositoryContextFollowUp(
      request,
      ["secondaryContract", "$(touch PWNED)"],
      { structuralSearch: () => Promise.resolve([]) },
    );
    const merged = mergeRepositoryEvidenceContexts(initial, followUp);

    expect(initial.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(
      false,
    );
    expect(followUp.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(
      true,
    );
    expect(merged.entries.length).toBe(initial.entries.length + followUp.entries.length);
    expect(merged.entries.slice(0, followUp.entries.length)).toEqual(followUp.entries);

    const otherHead = { ...followUp, sourceCommit: commitSha("a".repeat(40)) };
    expect(mergeRepositoryEvidenceContexts(initial, otherHead)).toBe(initial);
  });

  it("continues after a saturated term without treating its prefix as lexical evidence", async () => {
    const { repository, request } = await fixture();
    await writeSaturatedTerm(repository, "overflowContract");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add saturated follow-up fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    let structuralCalls = 0;

    const context = await collectRepositoryContextFollowUp(
      { ...request, head },
      ["overflowContract", "secondaryContract"],
      {
        structuralSearch: ({ candidatePaths }) => {
          structuralCalls += 1;
          expect(
            candidatePaths.filter((path) => path.startsWith("src/saturated-")).length,
          ).toBeLessThanOrEqual(4);
          return Promise.resolve([]);
        },
      },
    );

    expect(structuralCalls).toBe(1);
    expect(context.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(true);
    expect(context.entries.some((entry) => entry.content.includes("overflowContract"))).toBe(false);
  });

  it("uses only bounded saturated paths for AST and returns no lexical prefix when AST is empty", async () => {
    const { repository, request } = await fixture();
    await writeSaturatedTerm(repository, "overflowContract");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add saturated-only fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    let astPaths: readonly string[] = [];

    const empty = await collectRepositoryContextFollowUp(
      { ...request, head },
      ["overflowContract"],
      {
        structuralSearch: ({ candidatePaths }) => {
          astPaths = candidatePaths;
          return Promise.resolve([]);
        },
      },
    );
    expect(astPaths).toHaveLength(5);
    expect(astPaths[0]).toBe(request.reviewPath);
    expect(empty.entries).toEqual([]);

    const structural = await collectRepositoryContextFollowUp(
      { ...request, head },
      ["overflowContract"],
      {
        structuralSearch: ({ candidatePaths }) =>
          Promise.resolve([
            {
              path: candidatePaths[1] ?? "",
              line: 1,
              content: "overflowContract();",
              kind: "callsite" as const,
            },
          ]),
      },
    );
    expect(structural.entries).toHaveLength(1);
    expect(structural.entries[0]?.path).toBe(astPaths[1]);
  });

  it("reserves a later reviewed file when a saturated grep prefix never reaches it", async () => {
    const { repository, request } = await fixture();
    await writeSaturatedTerm(repository, "overflowContract");
    const reviewedPath = "zz/review.ts";
    await write(
      repository,
      reviewedPath,
      `${Array.from({ length: 25 }, () => "const padding = true;").join("\n")}\nexport function overflowContract(): boolean { return true; }\n`,
    );
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add late reviewed contract");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));

    const context = await collectRepositoryContextFollowUp(
      {
        ...request,
        head,
        reviewPath: reviewedPath,
        baseReviewPath: reviewedPath,
        findingAnchor: { startLine: 1, endLine: 1 },
      },
      ["overflowContract"],
      {
        structuralSearch: ({ candidatePaths }) => {
          expect(candidatePaths[0]).toBe(reviewedPath);
          expect(candidatePaths).toHaveLength(5);
          return Promise.resolve([
            {
              path: reviewedPath,
              line: 26,
              content: "export function overflowContract(): boolean { return true; }",
              kind: "definition",
            },
          ]);
        },
      },
    );

    expect(context.entries).toContainEqual({
      path: reviewedPath,
      line: 26,
      content: "export function overflowContract(): boolean { return true; }",
      kind: "definition",
    });
  });

  it("reserves structural evidence ahead of twelve lexical ballast entries", async () => {
    const { repository, request } = await fixture();
    await write(
      repository,
      "src/a-ballast.ts",
      Array.from({ length: 12 }, () => "Namespace.frequentContract();").join("\n"),
    );
    for (const path of ["src/b-ballast.ts", "src/c-ballast.ts", "src/z-structural.ts"] as const) {
      await write(repository, path, "Namespace.frequentContract();\n");
    }
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add structural-priority fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));

    const context = await collectRepositoryContextFollowUp(
      { ...request, head },
      ["Namespace.frequentContract"],
      {
        structuralSearch: ({ candidatePaths }) => {
          expect(candidatePaths).toContain("src/z-structural.ts");
          return Promise.resolve([
            {
              path: "src/z-structural.ts",
              line: 1,
              content: "Namespace.frequentContract();",
              kind: "definition" as const,
            },
          ]);
        },
      },
    );

    expect(context.entries).toContainEqual({
      path: "src/z-structural.ts",
      line: 1,
      content: "Namespace.frequentContract();",
      kind: "definition",
    });
    expect(context.entries).toHaveLength(12);
  });

  it("reserves structural type and path diversity before same-path callsite ballast", async () => {
    const { request } = await fixture();
    const structuralCallsites: RepositoryEvidenceEntry[] = Array.from(
      { length: 12 },
      (_value, index) => ({
        path: "src/structural-a.ts",
        line: index + 1,
        content: `ambiguousContract(call${String(index)});`,
        kind: "callsite" as const,
      }),
    );
    const structuralPaths: RepositoryEvidenceEntry[] = Array.from(
      { length: 7 },
      (_value, index) => ({
        path: `src/structural-extra-${String(index)}.ts`,
        line: 1,
        content: `ambiguousContract(extra${String(index)});`,
        kind: "callsite" as const,
      }),
    );

    const context = await collectRepositoryContextFollowUp(request, ["ambiguousContract"], {
      structuralSearch: () =>
        Promise.resolve([
          ...structuralCallsites,
          {
            path: "src/structural-b.ts",
            line: 1,
            content: "export function ambiguousContract(): boolean { return true; }",
            kind: "definition" as const,
          },
          {
            path: "tests/structural-c.test.ts",
            line: 1,
            content: "expect(ambiguousContract()).toBe(true);",
            kind: "test" as const,
          },
          ...structuralPaths,
        ]),
    });

    expect(context.entries).toHaveLength(12);
    expect(new Set(context.entries.map((entry) => entry.path)).size).toBe(5);
    expect(context.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/structural-b.ts", kind: "definition" }),
        expect.objectContaining({ path: "tests/structural-c.test.ts", kind: "test" }),
      ]),
    );
  });

  it("preserves three requested term anchors through the verifier's three-path boundary", async () => {
    const { request } = await fixture();
    const terms = ["secondaryContract", "ambiguousContract", "useCapability"];
    const context = await collectRepositoryContextFollowUp(request, terms, {
      structuralSearch: ({ terms: searched }) => {
        expect(searched).toEqual(terms);
        return Promise.resolve([
          {
            path: "src/term-zero-definition.ts",
            line: 1,
            content: "export function secondaryContract(): boolean { return true; }",
            kind: "definition" as const,
          },
          {
            path: "src/term-one-definition.ts",
            line: 1,
            content: "export function ambiguousContract(): boolean { return true; }",
            kind: "definition" as const,
          },
          {
            path: "src/term-two-definition.ts",
            line: 1,
            content: "export function useCapability(): boolean { return true; }",
            kind: "definition" as const,
          },
          {
            path: "tests/term-zero.test.ts",
            line: 1,
            content: "expect(secondaryContract()).toBe(true);",
            kind: "test" as const,
          },
          {
            path: "src/term-zero-caller.ts",
            line: 1,
            content: "return secondaryContract();",
            kind: "callsite" as const,
          },
        ]);
      },
    });
    const retrieved = toRetrievedEvidence(context);

    expect(context.entries.length).toBeLessThanOrEqual(12);
    expect(new Set(context.entries.map((entry) => entry.path)).size).toBeLessThanOrEqual(5);
    expect(retrieved.chunks.map((chunk) => chunk.path)).toEqual([
      "src/term-zero-definition.ts",
      "src/term-one-definition.ts",
      "src/term-two-definition.ts",
    ]);
    expect(retrieved.chunks.map((chunk) => chunk.lines[0]?.text)).toEqual([
      expect.stringContaining("secondaryContract"),
      expect.stringContaining("ambiguousContract"),
      expect.stringContaining("useCapability"),
    ]);
  });

  it("binds term-anchor reservations to normalized unique structural terms", async () => {
    const { request } = await fixture();
    const context = await collectRepositoryContextFollowUp(
      request,
      ["Namespace.secondaryContract", "secondaryContract", "useCapability"],
      {
        structuralSearch: ({ terms }) => {
          expect(terms).toEqual(["secondaryContract", "useCapability"]);
          return Promise.resolve([
            {
              path: "src/normalized-secondary.ts",
              line: 1,
              content: "export function secondaryContract(): boolean { return true; }",
              kind: "definition" as const,
            },
            {
              path: "src/normalized-capability.ts",
              line: 1,
              content: "export function useCapability(): boolean { return true; }",
              kind: "definition" as const,
            },
            {
              path: "src/secondary-ballast.ts",
              line: 1,
              content: "return secondaryContract();",
              kind: "callsite" as const,
            },
            {
              path: "tests/secondary.test.ts",
              line: 1,
              content: "expect(secondaryContract()).toBe(true);",
              kind: "test" as const,
            },
          ]);
        },
      },
    );

    expect(toRetrievedEvidence(context).chunks.map((chunk) => chunk.path)).toEqual([
      "src/normalized-secondary.ts",
      "src/normalized-capability.ts",
      "tests/secondary.test.ts",
    ]);
  });

  it("enforces the whole-review deadline during a streaming follow-up", async () => {
    const { repository, request } = await fixture();
    const wrapper = join(repository, "slow-stream-bin");
    await mkdir(wrapper);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(wrapper, "git"),
      `#!/bin/sh\nif [ "$1" = "--no-pager" ] && [ "$2" = "grep" ]; then\n  for arg in "$@"; do\n    if [ "$arg" = "-q" ]; then exec "${realGit}" "$@"; fi\n  done\n  exec sleep 10\nfi\nexec "${realGit}" "$@"\n`,
      "utf8",
    );
    await chmod(join(wrapper, "git"), 0o755);

    await expect(
      collectRepositoryContextFollowUp(
        {
          ...request,
          pathValue: `${wrapper}:${request.pathValue}`,
          deadlineMs: Date.now() + 500,
        },
        ["secondaryContract"],
      ),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
  });

  it("uses structural enrichment for clear hits and still requires it for ambiguous hits", async () => {
    const { request } = await fixture();
    let structuralCalls = 0;
    const dependencies = {
      structuralSearch: (): Promise<readonly RepositoryEvidenceEntry[]> => {
        structuralCalls += 1;
        return Promise.resolve([
          {
            path: "src/Ambiguous.java",
            line: 2,
            content: "  public boolean ambiguousContract() { return true; }",
            kind: "definition" as const,
          },
        ]);
      },
    };

    await collectRepositoryContextFollowUp(request, ["secondaryContract"], dependencies);
    expect(structuralCalls).toBe(1);

    const ambiguous = await collectRepositoryContextFollowUp(
      request,
      ["ambiguousContract"],
      dependencies,
    );
    expect(structuralCalls).toBe(2);
    expect(ambiguous.entries.some((entry) => entry.kind === "definition")).toBe(true);
  });

  it("keeps clear lexical evidence when optional structural enrichment is unavailable", async () => {
    const { request } = await fixture();
    const context = await collectRepositoryContextFollowUp(request, ["secondaryContract"], {
      anchorOwnerSearch: () => Promise.reject(new Error("owner unavailable")),
      structuralSearch: () => Promise.reject(new Error("unavailable")),
    });

    expect(context.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "definition",
          content: expect.stringContaining("secondaryContract"),
        }),
        expect.objectContaining({
          kind: "callsite",
          content: expect.stringContaining("secondaryContract"),
        }),
      ]),
    );
  });

  it("does not invoke structural retrieval when lexical search has no occurrence", async () => {
    const { request } = await fixture();
    let structuralCalls = 0;
    const result = await collectRepositoryContextFollowUp(
      request,
      ["DefinitelyMissingIdentifier"],
      {
        anchorOwnerSearch: () => Promise.resolve(undefined),
        structuralSearch: () => {
          structuralCalls += 1;
          return Promise.resolve([]);
        },
      },
    );
    expect(result.entries).toEqual([]);
    expect(structuralCalls).toBe(0);
  });

  it("reports an unavailable required structural fallback instead of treating it as no match", async () => {
    const { request } = await fixture();
    await expect(
      collectRepositoryContextFollowUp(request, ["ambiguousContract"], {
        structuralSearch: () => Promise.reject(new Error("unavailable")),
      }),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
  });

  it("refuses follow-up Git and structural calls after the whole-review deadline", async () => {
    const { request } = await fixture();
    let structuralCalls = 0;
    await expect(
      collectRepositoryContextFollowUp(
        { ...request, deadlineMs: Date.now() - 1 },
        ["ambiguousContract"],
        {
          structuralSearch: () => {
            structuralCalls += 1;
            return Promise.resolve([]);
          },
        },
      ),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
    expect(structuralCalls).toBe(0);
  });

  it("distinguishes a valid zero-match follow-up from an infrastructure failure", async () => {
    const { request } = await fixture();
    await expect(
      collectRepositoryContextFollowUp(request, ["DefinitelyMissingIdentifier"]),
    ).resolves.toEqual({ sourceCommit: request.head, side: "H", entries: [] });

    const unavailable = { ...request, head: commitSha("f".repeat(40)) };
    await expect(collectInitialRepositoryContext(unavailable)).resolves.toEqual({
      headCommit: unavailable.head,
      entries: [],
    });
    await expect(
      collectRepositoryContextFollowUp(unavailable, ["secondaryContract"]),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
  });

  it("rejects a non-search Git failure after the exact HEAD was verified", async () => {
    const { repository, request } = await fixture();
    const wrapper = join(repository, "trusted-bin");
    await mkdir(wrapper);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(wrapper, "git"),
      `#!/bin/sh\nif [ "$1" = "--no-pager" ] && [ "$2" = "grep" ]; then exit 2; fi\nexec "${realGit}" "$@"\n`,
      "utf8",
    );
    await chmod(join(wrapper, "git"), 0o755);

    await expect(
      collectRepositoryContextFollowUp(
        { ...request, pathValue: `${wrapper}:${request.pathValue}` },
        ["secondaryContract"],
      ),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
  });

  it("rejects a malformed complete streaming record", async () => {
    const { repository, request } = await fixture();
    const wrapper = join(repository, "malformed-stream-bin");
    await mkdir(wrapper);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(wrapper, "git"),
      `#!/bin/sh\nif [ "$1" = "--no-pager" ] && [ "$2" = "grep" ]; then\n  for arg in "$@"; do\n    if [ "$arg" = "-q" ]; then exec "${realGit}" "$@"; fi\n  done\n  printf 'candidate-malformed\\n'\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
      "utf8",
    );
    await chmod(join(wrapper, "git"), 0o755);

    await expect(
      collectRepositoryContextFollowUp(
        { ...request, pathValue: `${wrapper}:${request.pathValue}` },
        ["secondaryContract"],
      ),
    ).rejects.toBeInstanceOf(RepositoryContextRetrievalError);
  });
});

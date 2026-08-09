import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import type { RepositoryEvidenceEntry } from "./evidence.js";
import {
  MAX_REPOSITORY_FOLLOW_UP_TERMS,
  RepositoryContextRetrievalError,
  collectInitialRepositoryContext,
  collectRepositoryContextFollowUp,
  mergeRepositoryEvidenceContexts,
  validatedRetrieveTerms,
  type RepositoryContextRequest,
} from "./repository-context.js";

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
    reviewPath: "src/review.ts",
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

  it("keeps strong-term sightings when a later noisy initial term fails", async () => {
    const { repository, request } = await fixture();
    const wrapper = join(repository, "term-isolation-bin");
    await mkdir(wrapper);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      join(wrapper, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "commonValue" ]; then exit 2; fi\ndone\nexec "${realGit}" "$@"\n`,
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

  it("keeps the one follow-up separate and combines only the same exact commit", async () => {
    const { request } = await fixture();
    const initial = await collectInitialRepositoryContext(request);
    const followUp = await collectRepositoryContextFollowUp(request, [
      "secondaryContract",
      "$(touch PWNED)",
    ]);
    const merged = mergeRepositoryEvidenceContexts(initial, followUp);

    expect(initial.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(
      false,
    );
    expect(followUp.entries.some((entry) => entry.content.includes("secondaryContract"))).toBe(
      true,
    );
    expect(merged.entries.length).toBe(initial.entries.length + followUp.entries.length);

    const otherHead = { ...followUp, headCommit: "a".repeat(40) };
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
    expect(astPaths).toHaveLength(4);
    expect(empty.entries).toEqual([]);

    const structural = await collectRepositoryContextFollowUp(
      { ...request, head },
      ["overflowContract"],
      {
        structuralSearch: ({ candidatePaths }) =>
          Promise.resolve([
            {
              path: candidatePaths[0] ?? "",
              line: 1,
              content: "overflowContract();",
              kind: "callsite" as const,
            },
          ]),
      },
    );
    expect(structural.entries).toHaveLength(1);
    expect(structural.entries[0]?.path).toBe(astPaths[0]);
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
        ]),
    });

    expect(context.entries).toHaveLength(12);
    expect(context.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/structural-b.ts", kind: "definition" }),
        expect.objectContaining({ path: "tests/structural-c.test.ts", kind: "test" }),
      ]),
    );
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

  it("runs structural retrieval only when lexical hits cannot identify a definition", async () => {
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
    expect(structuralCalls).toBe(0);

    const ambiguous = await collectRepositoryContextFollowUp(
      request,
      ["ambiguousContract"],
      dependencies,
    );
    expect(structuralCalls).toBe(1);
    expect(ambiguous.entries.some((entry) => entry.kind === "definition")).toBe(true);
  });

  it("does not invoke structural retrieval when lexical search has no occurrence", async () => {
    const { request } = await fixture();
    let structuralCalls = 0;
    const result = await collectRepositoryContextFollowUp(
      request,
      ["DefinitelyMissingIdentifier"],
      {
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
    ).resolves.toEqual({ headCommit: request.head, entries: [] });

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

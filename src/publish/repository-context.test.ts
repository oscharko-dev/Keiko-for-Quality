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
        "thirdContract",
        "fourthContract",
      ]),
    ).toEqual(["secondaryContract", "state.member", "thirdContract"]);
    expect(MAX_REPOSITORY_FOLLOW_UP_TERMS).toBe(3);
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
});

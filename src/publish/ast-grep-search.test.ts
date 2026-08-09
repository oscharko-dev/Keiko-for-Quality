import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import type { GitContext } from "../git/plumbing.js";
import { AstGrepSearchError, searchAstGrepAtHead } from "./ast-grep-search.js";

const temporaryDirectories: string[] = [];

function git(repository: string, ...args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).trim();
}

async function executable(directory: string, body: string): Promise<string> {
  const path = join(directory, "fake-ast-grep");
  await writeFile(path, `#!${process.execPath}\n${body}`, "utf8");
  await chmod(path, 0o700);
  return path;
}

async function fixture(): Promise<{
  readonly repository: string;
  readonly context: GitContext;
  readonly head: ReturnType<typeof commitSha>;
}> {
  const repository = await mkdtemp(join(tmpdir(), "kfq-ast-grep-search-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  await mkdir(join(repository, "src"));
  await writeFile(
    join(repository, "src/definition.ts"),
    "export function target(): void {\n  target(); // $(touch PWNED)\n}\n",
  );
  await writeFile(
    join(repository, "src/z-priority.ts"),
    "export function target(): void {\n  target();\n}\n",
  );
  await writeFile(
    join(repository, "src/a-lower.ts"),
    "export function target(): void {\n  target();\n}\n",
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "fixture");
  const head = commitSha(git(repository, "rev-parse", "HEAD"));
  await writeFile(join(repository, "src/definition.ts"), "const WORKTREE_ONLY = true;\n");
  return {
    repository,
    head,
    context: { cwd: repository, pathValue: process.env.PATH ?? "", timeoutMs: 5_000 },
  };
}

const SUCCESSFUL_TOOL = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  if (!args.includes("--stdin") || args.some((arg) => arg.includes("definition.ts"))) process.exit(2);
  if (!input.includes("function target") || input.includes("WORKTREE_ONLY")) process.exit(3);
  const lines = input.split("\n");
  if (args[0] === "outline") {
    process.stdout.write(JSON.stringify([{path:"STDIN",language:"TypeScript",items:[{name:"target",range:{byteOffset:{start:0,end:Buffer.byteLength(input)-1},start:{line:0,column:0},end:{line:2,column:1}}}]}]));
    return;
  }
  const matches = [];
  let cursor = input.indexOf("target");
  while (cursor >= 0) {
    const before = input.slice(0, cursor).split("\n");
    const line = before.length - 1;
    const column = before.at(-1).length;
    matches.push({text:"target",file:"STDIN",language:"TypeScript",range:{byteOffset:{start:cursor,end:cursor+6},start:{line,column},end:{line,column:column+6}}});
    cursor = input.indexOf("target", cursor + 6);
  }
  process.stdout.write(JSON.stringify(matches));
});
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("searchAstGrepAtHead", () => {
  it("passes only exact immutable HEAD blobs through stdin and never checks candidate content out", async () => {
    const { repository, context, head } = await fixture();
    const tools = await mkdtemp(join(tmpdir(), "kfq-fake-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, SUCCESSFUL_TOOL);

    const entries = await searchAstGrepAtHead(
      {
        context,
        head,
        reviewPath: "src/review.ts",
        candidatePaths: ["src/definition.ts"],
        terms: ["target"],
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(entries.some((entry) => entry.kind === "definition")).toBe(true);
    expect(entries.some((entry) => entry.kind === "callsite")).toBe(true);
    expect(entries.some((entry) => entry.content.includes("function target"))).toBe(true);
    expect(entries.some((entry) => entry.content.includes("target();"))).toBe(true);
    expect(await readFile(join(repository, "src/definition.ts"), "utf8")).toContain(
      "WORKTREE_ONLY",
    );
    await expect(readFile(join(repository, "PWNED"), "utf8")).rejects.toThrow();
  });

  it("does not acquire a binary for unsupported source languages", async () => {
    const { context, head } = await fixture();
    let acquisitions = 0;
    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          candidatePaths: ["README.txt"],
          terms: ["target"],
        },
        {
          acquireBinary: () => {
            acquisitions += 1;
            return Promise.reject(new Error("must not acquire"));
          },
        },
      ),
    ).resolves.toEqual([]);
    expect(acquisitions).toBe(0);
  });

  it("preserves caller-ranked candidate path priority", async () => {
    const { context, head } = await fixture();
    const tools = await mkdtemp(join(tmpdir(), "kfq-priority-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, SUCCESSFUL_TOOL);

    const entries = await searchAstGrepAtHead(
      {
        context,
        head,
        reviewPath: "src/review.ts",
        candidatePaths: ["src/z-priority.ts", "src/a-lower.ts"],
        terms: ["target"],
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(entries[0]?.path).toBe("src/z-priority.ts");
  });

  it("fails closed on malformed tool output", async () => {
    const { context, head } = await fixture();
    const tools = await mkdtemp(join(tmpdir(), "kfq-bad-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(
      tools,
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"));',
    );
    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          candidatePaths: ["src/definition.ts"],
          terms: ["target"],
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).rejects.toBeInstanceOf(AstGrepSearchError);
  });

  it("kills a parser that exceeds the hard process timeout", async () => {
    const { context, head } = await fixture();
    const tools = await mkdtemp(join(tmpdir(), "kfq-slow-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(
      tools,
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => undefined, 10000));",
    );
    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          candidatePaths: ["src/definition.ts"],
          terms: ["target"],
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).rejects.toBeInstanceOf(AstGrepSearchError);
  }, 5_000);
});

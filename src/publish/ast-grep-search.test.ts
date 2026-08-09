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
    "export function target(): void {\n  target(); // $(touch PWNED)\n}\nconst SIBLING_ONLY = true;\n",
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
    // Deliberately include the newline after the closing brace. The half-open range therefore ends
    // at column zero of the sibling line; treating end.line as inclusive would leak SIBLING_ONLY.
    const definitionEnd = input.indexOf("\n}") + 3;
    if (definitionEnd < 3) process.exit(4);
    const throughDefinition = input.slice(0, definitionEnd).split("\n");
    const endLine = throughDefinition.length - 1;
    const endColumn = throughDefinition.at(-1).length;
    process.stdout.write(JSON.stringify([{path:"STDIN",language:"TypeScript",items:[{name:"target",range:{byteOffset:{start:0,end:definitionEnd},start:{line:0,column:0},end:{line:endLine,column:endColumn}}}]}]));
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

const TERM_PRIORITY_TOOL = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const position = (offset) => {
    const before = input.slice(0, offset).split("\n");
    return {line: before.length - 1, column: before.at(-1).length};
  };
  const range = (start, end) => ({
    byteOffset: {start, end},
    start: position(start),
    end: position(end),
  });
  if (args[0] === "outline") {
    const items = [];
    const definitions = /export function (alpha|beta|gamma)\b/g;
    let match;
    while ((match = definitions.exec(input)) !== null) {
      items.push({name: match[1], range: range(match.index, input.length)});
    }
    process.stdout.write(JSON.stringify([{path:"STDIN",language:"TypeScript",items}]));
    return;
  }
  const matches = [];
  const identifiers = /\b(alpha|beta|gamma)\b/g;
  let match;
  while ((match = identifiers.exec(input)) !== null) {
    matches.push({
      text: match[1],
      file: "STDIN",
      language: "TypeScript",
      range: range(match.index, match.index + match[1].length),
    });
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
    expect(entries.some((entry) => entry.content === "}")).toBe(true);
    expect(entries.some((entry) => entry.content.includes("SIBLING_ONLY"))).toBe(false);
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
    expect(new Set(entries.map((entry) => entry.path))).toEqual(
      new Set(["src/z-priority.ts", "src/a-lower.ts"]),
    );
  });

  it("emits one anchor per requested term before kind and path ballast", async () => {
    const { repository, context } = await fixture();
    await mkdir(join(repository, "tests"));
    await writeFile(
      join(repository, "src/alpha-definition.ts"),
      "export function alpha(): void {\n  alpha();\n}\n",
    );
    await writeFile(
      join(repository, "tests/alpha-beta.test.ts"),
      "alpha();\nexport function beta(): void {\n  beta();\n}\n",
    );
    await writeFile(
      join(repository, "src/alpha-gamma-caller.ts"),
      "alpha();\nexport function gamma(): void {\n  gamma();\n}\n",
    );
    git(
      repository,
      "add",
      "src/alpha-definition.ts",
      "tests/alpha-beta.test.ts",
      "src/alpha-gamma-caller.ts",
    );
    git(repository, "commit", "-qm", "add term-priority fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const tools = await mkdtemp(join(tmpdir(), "kfq-term-priority-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, TERM_PRIORITY_TOOL);

    const entries = await searchAstGrepAtHead(
      {
        context,
        head,
        reviewPath: "src/review.ts",
        candidatePaths: [
          "src/alpha-definition.ts",
          "tests/alpha-beta.test.ts",
          "src/alpha-gamma-caller.ts",
        ],
        terms: ["alpha", "beta", "gamma"],
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(entries.slice(0, 3).map((entry) => entry.path)).toEqual([
      "src/alpha-definition.ts",
      "tests/alpha-beta.test.ts",
      "src/alpha-gamma-caller.ts",
    ]);
    expect(entries.slice(0, 3).map((entry) => entry.content)).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("beta"),
      expect.stringContaining("gamma"),
    ]);
    expect(entries.some((entry) => entry.kind === "test" && entry.content.includes("alpha"))).toBe(
      true,
    );
    expect(
      entries.some((entry) => entry.kind === "callsite" && entry.content.includes("alpha")),
    ).toBe(true);
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

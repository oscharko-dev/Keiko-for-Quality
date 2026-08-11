import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import type { GitContext } from "../git/plumbing.js";
import {
  AstGrepSearchError,
  findAstAnchorOwnerAtHead,
  findAstCallerOwnerAtHead,
  searchAstGrepAtHead,
} from "./ast-grep-search.js";

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

const CALLER_OWNER_TOOL = String.raw`
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
  const structures = () => {
    const items = [];
    const declarations = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)[^\{]*\{/g;
    let match;
    while ((match = declarations.exec(input)) !== null) {
      const open = input.indexOf("{", match.index);
      let depth = 0;
      let end = -1;
      for (let cursor = open; cursor < input.length; cursor += 1) {
        if (input[cursor] === "{") depth += 1;
        if (input[cursor] === "}") depth -= 1;
        if (depth === 0) { end = cursor + 1; break; }
      }
      if (end < 0) process.exit(7);
      items.push({name: match[1], range: range(match.index, end)});
    }
    return items;
  };
  if (args[0] === "outline") {
    process.stdout.write(JSON.stringify([{path:"STDIN",language:"TypeScript",items:structures()}]));
    return;
  }
  const rule = args[args.indexOf("--inline-rules") + 1] || "";
  if (!rule.includes("kind: call_expression") || !rule.includes("kind: identifier") ||
      !rule.includes("regex: '^downloadAssets$'")) process.exit(8);
  const matches = [];
  const marker = "/* DIRECT */ downloadAssets()";
  let cursor = input.indexOf(marker);
  while (cursor >= 0) {
    const start = cursor + "/* DIRECT */ ".length;
    const end = start + "downloadAssets()".length;
    matches.push({text:input.slice(start,end),file:"STDIN",language:"TypeScript",range:range(start,end)});
    cursor = input.indexOf(marker, cursor + marker.length);
  }
  const propertyMarker = "/* PROPERTY */ downloadAssets.member()";
  cursor = input.indexOf(propertyMarker);
  while (cursor >= 0) {
    const start = cursor + "/* PROPERTY */ ".length;
    const end = start + "downloadAssets.member()".length;
    matches.push({text:input.slice(start,end),file:"STDIN",language:"TypeScript",range:range(start,end)});
    cursor = input.indexOf(propertyMarker, cursor + propertyMarker.length);
  }
  process.stdout.write(JSON.stringify(matches));
});
`;

function concurrencyTrackingTool(stateDirectory: string): string {
  return String.raw`
const { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(${JSON.stringify(stateDirectory)}, "state.json");
const lockPath = join(${JSON.stringify(stateDirectory)}, "state.lock");
const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const update = (delta) => {
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      if (error === null || typeof error !== "object" || error.code !== "EEXIST") throw error;
      sleep(2);
    }
  }
  try {
    const state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { active: 0, maximum: 0 };
    state.active += delta;
    state.maximum = Math.max(state.maximum, state.active);
    writeFileSync(statePath, JSON.stringify(state));
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.includes("function target")) process.exit(3);
  update(1);
  sleep(500);
  update(-1);
  const args = process.argv.slice(2);
  process.stdout.write(args[0] === "outline"
    ? JSON.stringify([{path:"STDIN",language:"TypeScript",items:[]}])
    : "[]");
});
`;
}

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
        findingAnchor: { startLine: 1, endLine: 1 },
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

  it("keeps distant same-file structural contracts while excluding the visible anchor window", async () => {
    const { repository, context } = await fixture();
    const source = [
      "alpha();",
      ...Array.from({ length: 23 }, (_value, index) => `const filler${String(index)} = true;`),
      "alpha();",
      "export function alpha(): void {",
      "  alpha();",
      "}",
    ].join("\n");
    await writeFile(join(repository, "src/same-file.ts"), `${source}\n`, "utf8");
    git(repository, "add", "src/same-file.ts");
    git(repository, "commit", "-qm", "add distant same-file AST fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const tools = await mkdtemp(join(tmpdir(), "kfq-same-file-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, TERM_PRIORITY_TOOL);

    const entries = await searchAstGrepAtHead(
      {
        context,
        head,
        reviewPath: "src/same-file.ts",
        findingAnchor: { startLine: 1, endLine: 1 },
        candidatePaths: ["src/same-file.ts"],
        terms: ["alpha"],
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(entries.every((entry) => entry.path === "src/same-file.ts" && entry.line > 25)).toBe(
      true,
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 26, kind: "definition" }),
        expect.objectContaining({ line: 27, kind: "callsite" }),
      ]),
    );
  });

  it("reports candidate sources as unavailable when none has a supported readable blob", async () => {
    const { context, head } = await fixture();
    let acquisitions = 0;
    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
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
    ).rejects.toBeInstanceOf(AstGrepSearchError);
    expect(acquisitions).toBe(0);
  });

  it("returns an ordinary zero-match result when no structural candidate path exists", async () => {
    const { context, head } = await fixture();
    let acquisitions = 0;
    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
          candidatePaths: [],
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

  it("backfills four real sources when a reserved reviewed path is absent", async () => {
    const { repository, context } = await fixture();
    for (const path of ["src/b-backfill.ts", "src/c-backfill.ts"] as const) {
      await writeFile(join(repository, path), "export function target(): void {\n  target();\n}\n");
    }
    git(repository, "add", "src/b-backfill.ts", "src/c-backfill.ts");
    git(repository, "commit", "-qm", "add AST backfill fixtures");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const tools = await mkdtemp(join(tmpdir(), "kfq-backfill-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, SUCCESSFUL_TOOL);

    const entries = await searchAstGrepAtHead(
      {
        context,
        head,
        reviewPath: "src/deleted.ts",
        findingAnchor: { startLine: 1, endLine: 1 },
        candidatePaths: [
          "src/deleted.ts",
          "src/z-priority.ts",
          "src/a-lower.ts",
          "src/b-backfill.ts",
          "src/c-backfill.ts",
        ],
        terms: ["target"],
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(new Set(entries.map((entry) => entry.path))).toEqual(
      new Set(["src/z-priority.ts", "src/a-lower.ts", "src/b-backfill.ts", "src/c-backfill.ts"]),
    );
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
        findingAnchor: { startLine: 1, endLine: 1 },
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

  it("processes source blobs sequentially while each blob's scan and outline run concurrently", async () => {
    const { repository, context } = await fixture();
    for (const path of ["src/b-concurrency.ts", "src/c-concurrency.ts"] as const) {
      await writeFile(join(repository, path), "export function target(): void {}\n", "utf8");
    }
    git(repository, "add", "src/b-concurrency.ts", "src/c-concurrency.ts");
    git(repository, "commit", "-qm", "add concurrency fixtures");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    const tools = await mkdtemp(join(tmpdir(), "kfq-concurrency-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, concurrencyTrackingTool(tools));

    await expect(
      searchAstGrepAtHead(
        {
          context,
          head,
          reviewPath: "src/review.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
          candidatePaths: [
            "src/definition.ts",
            "src/z-priority.ts",
            "src/b-concurrency.ts",
            "src/c-concurrency.ts",
          ],
          terms: ["target"],
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).resolves.toEqual([]);

    await expect(readFile(join(tools, "state.json"), "utf8")).resolves.toBe(
      JSON.stringify({ active: 0, maximum: 2 }),
    );
  }, 10_000);

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
        findingAnchor: { startLine: 1, endLine: 1 },
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
          findingAnchor: { startLine: 1, endLine: 1 },
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
          findingAnchor: { startLine: 1, endLine: 1 },
          candidatePaths: ["src/definition.ts"],
          terms: ["target"],
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).rejects.toBeInstanceOf(AstGrepSearchError);
  }, 5_000);
});

describe("findAstAnchorOwnerAtHead", () => {
  it("derives the complete anchor owner from the exact immutable blob through stdin", async () => {
    const { repository, context, head } = await fixture();
    const tools = await mkdtemp(join(tmpdir(), "kfq-owner-ast-grep-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, SUCCESSFUL_TOOL);

    const owner = await findAstAnchorOwnerAtHead(
      {
        context,
        head,
        reviewPath: "src/definition.ts",
        findingAnchor: { startLine: 1, endLine: 3 },
      },
      { acquireBinary: () => Promise.resolve(binary) },
    );

    expect(owner).toEqual({
      name: "target",
      definition: {
        path: "src/definition.ts",
        line: 1,
        content: "export function target(): void {",
        kind: "definition",
      },
    });
    expect(await readFile(join(repository, "src/definition.ts"), "utf8")).toContain(
      "WORKTREE_ONLY",
    );
  });

  it("does not acquire a parser for an invalid anchor", async () => {
    const { context, head } = await fixture();
    let acquisitions = 0;

    await expect(
      findAstAnchorOwnerAtHead(
        {
          context,
          head,
          reviewPath: "src/definition.ts",
          findingAnchor: { startLine: 0, endLine: 0 },
        },
        {
          acquireBinary: () => {
            acquisitions += 1;
            return Promise.reject(new Error("must not acquire"));
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(acquisitions).toBe(0);
  });
});

describe("findAstCallerOwnerAtHead", () => {
  async function callerFixture(source: string): Promise<{
    readonly context: GitContext;
    readonly head: ReturnType<typeof commitSha>;
    readonly binary: string;
    readonly repository: string;
  }> {
    const { repository, context } = await fixture();
    await writeFile(join(repository, "src/caller.ts"), `${source}\n`, "utf8");
    git(repository, "add", "src/caller.ts");
    git(repository, "commit", "-qm", "add caller-owner fixture");
    const head = commitSha(git(repository, "rev-parse", "HEAD"));
    await writeFile(join(repository, "src/caller.ts"), "const WORKTREE_ONLY = true;\n", "utf8");
    const tools = await mkdtemp(join(tmpdir(), "kfq-caller-owner-"));
    temporaryDirectories.push(tools);
    const binary = await executable(tools, CALLER_OWNER_TOOL);
    return { repository, context, head, binary };
  }

  it("maps one distant direct call to its smallest distinct named owner", async () => {
    const source = [
      "async function downloadAssets(): Promise<void> {",
      "  await fetchArtifact();",
      "}",
      ...Array.from({ length: 25 }, (_value, index) => `const pad${String(index)} = true;`),
      "function unrelatedText(): void {",
      '  const note = "downloadAssets()";',
      "  /* PROPERTY */ downloadAssets.member();",
      "}",
      "export async function runPortablePrerelease(): Promise<void> {",
      "  /* DIRECT */ downloadAssets();",
      "}",
    ].join("\n");
    const { repository, context, head, binary } = await callerFixture(source);

    await expect(
      findAstCallerOwnerAtHead(
        {
          context,
          head,
          reviewPath: "src/caller.ts",
          findingAnchor: { startLine: 1, endLine: 3 },
          ownerName: "downloadAssets",
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).resolves.toEqual({
      name: "runPortablePrerelease",
      definition: {
        path: "src/caller.ts",
        line: 33,
        content: "export async function runPortablePrerelease(): Promise<void> {",
        kind: "definition",
      },
    });
    expect(await readFile(join(repository, "src/caller.ts"), "utf8")).toContain("WORKTREE_ONLY");
  });

  it("ignores comments, strings, imports, and property-only mentions", async () => {
    const source = [
      "function downloadAssets(): void {}",
      ...Array.from({ length: 25 }, (_value, index) => `const pad${String(index)} = true;`),
      'import { downloadAssets as importedAsset } from "./remote";',
      "function unrelatedText(): void {",
      "  // downloadAssets();",
      '  const note = "downloadAssets()";',
      "  api.downloadAssets();",
      "}",
    ].join("\n");
    const { context, head, binary } = await callerFixture(source);

    await expect(
      findAstCallerOwnerAtHead(
        {
          context,
          head,
          reviewPath: "src/caller.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
          ownerName: "downloadAssets",
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).resolves.toBeUndefined();
  });

  it("stops at a recursive call instead of walking outward to another owner", async () => {
    const source = [
      "function downloadAssets(): void {",
      ...Array.from({ length: 25 }, (_value, index) => `  consume(${String(index)});`),
      "  /* DIRECT */ downloadAssets();",
      "}",
    ].join("\n");
    const { context, head, binary } = await callerFixture(source);

    await expect(
      findAstCallerOwnerAtHead(
        {
          context,
          head,
          reviewPath: "src/caller.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
          ownerName: "downloadAssets",
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).resolves.toBeUndefined();
  });

  it("does not acquire a parser for a qualified or otherwise invalid owner name", async () => {
    const { context, head } = await fixture();
    let acquisitions = 0;

    await expect(
      findAstCallerOwnerAtHead(
        {
          context,
          head,
          reviewPath: "src/definition.ts",
          findingAnchor: { startLine: 1, endLine: 1 },
          ownerName: "api.downloadAssets",
        },
        {
          acquireBinary: () => {
            acquisitions += 1;
            return Promise.reject(new Error("must not acquire"));
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(acquisitions).toBe(0);
  });
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import type { GitContext } from "../git/plumbing.js";
import { AST_GREP_PIN, astGrepPlatformKey } from "./ast-grep-pin.js";
import {
  CLOSED_RUNTIME_FACT_CATALOG,
  CLOSED_RUNTIME_FACT_CATALOG_VERSION,
  CLOSED_RUNTIME_FACT_IDS,
} from "./runtime-fact-catalog.js";
import {
  ClosedRuntimeFactsError,
  MAX_CLOSED_RUNTIME_FACTS,
  collectClosedRuntimeFactsAtCommit,
  type ClosedRuntimeFactsRequest,
} from "./runtime-facts.js";

const temporaryDirectories: string[] = [];

function cachedPinnedBinary(): Buffer | undefined {
  const platform = astGrepPlatformKey(process.platform, process.arch);
  const target = AST_GREP_PIN.platforms[platform];
  if (target === undefined) return undefined;
  const root =
    process.env.RUNNER_TOOL_CACHE ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const path = join(
    root,
    "keiko-for-quality",
    "ast-grep",
    AST_GREP_PIN.version,
    platform,
    "ast-grep",
  );
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex") === target.binarySha256
    ? bytes
    : undefined;
}

const CACHED_PINNED_BINARY = cachedPinnedBinary();

const COMMITTED_SOURCE = [
  "const base = {};",
  "const objectCopy = { ...base, ...maybe }; // $(touch PWNED)",
  "const arrayCopy = [...maybe];",
  "invoke(...maybe);",
  "const { ...rest } = input;",
  "const nestedArray = { nested: [...maybe] };",
  "const nestedCall = { nested: invoke(...maybe) };",
  'const text = "{ ...maybe }";',
  "// const commented = { ...maybe };",
  "const template = `literal ...maybe`;",
  "const second = { ...other };",
  "const third = { ...last };",
  "",
].join("\n");

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

interface Fixture {
  readonly repository: string;
  readonly context: GitContext;
  readonly commit: ReturnType<typeof commitSha>;
}

async function fixture(): Promise<Fixture> {
  const repository = await mkdtemp(join(tmpdir(), "kfq-runtime-facts-"));
  temporaryDirectories.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src/runtime.ts"), COMMITTED_SOURCE, "utf8");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "fixture");
  const commit = commitSha(git(repository, "rev-parse", "HEAD"));
  await writeFile(
    join(repository, "src/runtime.ts"),
    "const WORKTREE_ONLY = { ...wrong };\n",
    "utf8",
  );
  return {
    repository,
    commit,
    context: { cwd: repository, pathValue: process.env.PATH ?? "", timeoutMs: 5_000 },
  };
}

function request(
  value: Fixture,
  startLine: number,
  endLine = startLine,
): ClosedRuntimeFactsRequest {
  return {
    context: value.context,
    commit: value.commit,
    path: "src/runtime.ts",
    side: "H",
    findingAnchor: { startLine, endLine },
  };
}

const SUCCESSFUL_TOOL = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const ruleIndex = args.indexOf("--inline-rules");
  const rule = ruleIndex >= 0 ? args[ruleIndex + 1] : "";
  if (
    args[0] !== "scan" ||
    !args.includes("--stdin") ||
    args.some((arg) => arg.includes("runtime.ts")) ||
    !args.includes("--json=compact") ||
    !args.includes("--max-results") ||
    !rule.includes("id: kfq-closed-runtime-object-spread") ||
    !rule.includes("language: TypeScript") ||
    !rule.includes("kind: spread_element") ||
    !rule.includes("inside:\n    kind: object")
  ) process.exit(2);
  if (input.includes("WORKTREE_ONLY")) process.exit(3);
  const maximumIndex = args.indexOf("--max-results");
  if (Number(args[maximumIndex + 1]) !== Math.floor(Buffer.byteLength(input, "utf8") / 3) + 1) {
    process.exit(4);
  }

  const position = (offset) => {
    const before = input.slice(0, offset).split("\n");
    return {line: before.length - 1, column: before.at(-1).length};
  };
  const result = [];
  const lines = input.split("\n");
  // These are the only direct object-literal spread declarations licensed by the fixtures. Array
  // and argument spread, object-rest destructuring, nested array/call spread, comments and strings
  // are omitted. Line numbers deliberately come from the anchor-local stdin slice.
  for (const [lineIndex, line] of lines.entries()) {
    if (!/^const (?:objectCopy|second|third|prior\d+|target) = \{/u.test(line)) continue;
    const lineStart = lines.slice(0, lineIndex).reduce((sum, item) => sum + item.length + 1, 0);
    const spreads = /\.\.\.[A-Za-z_$][\w$]*/g;
    let match;
    while ((match = spreads.exec(line)) !== null) {
      const start = lineStart + match.index;
      const end = start + match[0].length;
      result.push({
        text: match[0],
        file: "STDIN",
        language: "TypeScript",
        ruleId: "kfq-closed-runtime-object-spread",
        range: {byteOffset: {start, end}, start: position(start), end: position(end)},
      });
    }
  }
  process.stdout.write(JSON.stringify(result));
});
`;

async function successfulBinary(): Promise<string> {
  const tools = await mkdtemp(join(tmpdir(), "kfq-runtime-facts-tool-"));
  temporaryDirectories.push(tools);
  return executable(tools, SUCCESSFUL_TOOL);
}

async function outputBinary(outputExpression: string, extra = ""): Promise<string> {
  const tools = await mkdtemp(join(tmpdir(), "kfq-runtime-facts-output-"));
  temporaryDirectories.push(tools);
  return executable(
    tools,
    String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  ${extra}
  process.stdout.write(${outputExpression});
});
`,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("collectClosedRuntimeFactsAtCommit", () => {
  it("emits only the closed v1 fact from an exact immutable commit blob over stdin", async () => {
    const value = await fixture();
    const binary = await successfulBinary();

    await expect(
      collectClosedRuntimeFactsAtCommit(request(value, 2), {
        acquireBinary: () => Promise.resolve(binary),
      }),
    ).resolves.toEqual([
      {
        catalogVersion: CLOSED_RUNTIME_FACT_CATALOG_VERSION,
        id: "ecmascript.object_spread.nullish_source_is_noop",
        statement: CLOSED_RUNTIME_FACT_CATALOG["ecmascript.object_spread.nullish_source_is_noop"],
        source: { path: "src/runtime.ts", side: "H", line: 2 },
      },
    ]);
    expect(CLOSED_RUNTIME_FACT_IDS).toEqual(["ecmascript.object_spread.nullish_source_is_noop"]);
    expect(await readFile(join(value.repository, "src/runtime.ts"), "utf8")).toContain(
      "WORKTREE_ONLY",
    );
    await expect(readFile(join(value.repository, "PWNED"), "utf8")).rejects.toThrow();
  });

  it("distinguishes object spread from array/argument spread, rest, nesting, comments and strings", async () => {
    const value = await fixture();
    const binary = await successfulBinary();
    const acquireBinary = (): Promise<string> => Promise.resolve(binary);

    for (const line of [3, 4, 5, 6, 7, 8, 9, 10]) {
      await expect(
        collectClosedRuntimeFactsAtCommit(request(value, line), { acquireBinary }),
      ).resolves.toEqual([]);
    }
    await expect(
      collectClosedRuntimeFactsAtCommit(request(value, 11), { acquireBinary }),
    ).resolves.toHaveLength(1);
  });

  it("deduplicates same-line matches and caps facts at two in source order", async () => {
    const value = await fixture();
    const binary = await successfulBinary();

    const facts = await collectClosedRuntimeFactsAtCommit(request(value, 1, 12), {
      acquireBinary: () => Promise.resolve(binary),
    });

    expect(MAX_CLOSED_RUNTIME_FACTS).toBe(2);
    expect(facts.map((fact) => fact.source.line)).toEqual([2, 11]);
  });

  it("cannot starve an anchored match behind more than 24 earlier object spreads", async () => {
    const value = await fixture();
    const preceding = Array.from(
      { length: 30 },
      (_unused, index) => `const prior${String(index)} = { ...value${String(index)} };`,
    );
    await writeFile(
      join(value.repository, "src/starvation.ts"),
      `${[...preceding, "const target = { ...maybe };"].join("\n")}\n`,
      "utf8",
    );
    git(value.repository, "add", "src/starvation.ts");
    git(value.repository, "commit", "-qm", "starvation fixture");
    const commit = commitSha(git(value.repository, "rev-parse", "HEAD"));
    const binary = await successfulBinary();

    await expect(
      collectClosedRuntimeFactsAtCommit(
        {
          ...request(value, 31),
          commit,
          path: "src/starvation.ts",
        },
        { acquireBinary: () => Promise.resolve(binary) },
      ),
    ).resolves.toMatchObject([{ source: { path: "src/starvation.ts", line: 31 } }]);
  });

  it.runIf(CACHED_PINNED_BINARY !== undefined)(
    "finds a multiline anchored spread behind 30 earlier matches with pinned ast-grep 0.45.1",
    async () => {
      const value = await fixture();
      const preceding = Array.from(
        { length: 30 },
        (_unused, index) => `const prior${String(index)} = { ...value${String(index)} };`,
      );
      await writeFile(
        join(value.repository, "src/multiline.ts"),
        `${[...preceding, "const target = {", "  ...maybe,", "};"].join("\n")}\n`,
        "utf8",
      );
      git(value.repository, "add", "src/multiline.ts");
      git(value.repository, "commit", "-qm", "multiline runtime fixture");
      const commit = commitSha(git(value.repository, "rev-parse", "HEAD"));
      const tools = await mkdtemp(join(tmpdir(), "kfq-runtime-facts-pinned-tool-"));
      temporaryDirectories.push(tools);
      const binary = join(tools, "ast-grep");
      await writeFile(binary, CACHED_PINNED_BINARY!);
      await chmod(binary, 0o700);

      await expect(
        collectClosedRuntimeFactsAtCommit(
          {
            ...request(value, 32),
            commit,
            path: "src/multiline.ts",
          },
          { acquireBinary: () => Promise.resolve(binary) },
        ),
      ).resolves.toMatchObject([{ source: { path: "src/multiline.ts", line: 32 } }]);
    },
  );

  it("does not acquire the parser for invalid anchors, paths, extensions or absent blobs", async () => {
    const value = await fixture();
    let acquisitions = 0;
    const dependencies = {
      acquireBinary: (): Promise<string> => {
        acquisitions += 1;
        return Promise.reject(new Error("must not acquire"));
      },
    };

    const variants: ClosedRuntimeFactsRequest[] = [
      { ...request(value, 0), findingAnchor: { startLine: 0, endLine: 1 } },
      { ...request(value, 2), path: "../src/runtime.ts" },
      { ...request(value, 2), path: "src\\runtime.ts" },
      { ...request(value, 2), path: "README.md" },
      { ...request(value, 2), path: "src/absent.ts" },
    ];
    for (const variant of variants) {
      await expect(collectClosedRuntimeFactsAtCommit(variant, dependencies)).resolves.toEqual([]);
    }
    expect(acquisitions).toBe(0);
  });

  it("does not acquire the parser for a committed blob larger than 192 KiB", async () => {
    const value = await fixture();
    await writeFile(join(value.repository, "src/large.ts"), "x".repeat(192 * 1024 + 1));
    git(value.repository, "add", "src/large.ts");
    git(value.repository, "commit", "-qm", "large source");
    const commit = commitSha(git(value.repository, "rev-parse", "HEAD"));
    let acquisitions = 0;

    await expect(
      collectClosedRuntimeFactsAtCommit(
        { ...request(value, 1), commit, path: "src/large.ts" },
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

  it("fails closed on expired deadlines and nonexistent commits", async () => {
    const value = await fixture();
    let acquisitions = 0;
    const dependencies = {
      acquireBinary: (): Promise<string> => {
        acquisitions += 1;
        return Promise.reject(new Error("must not acquire"));
      },
    };

    await expect(
      collectClosedRuntimeFactsAtCommit(
        { ...request(value, 2), deadlineMs: Date.now() - 1 },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(ClosedRuntimeFactsError);
    await expect(
      collectClosedRuntimeFactsAtCommit(
        { ...request(value, 2), commit: commitSha("a".repeat(40)) },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(ClosedRuntimeFactsError);
    expect(acquisitions).toBe(0);
  });

  it("fails closed on malformed or forged parser records", async () => {
    const value = await fixture();
    const cases = [
      '"not-json"',
      "JSON.stringify({})",
      "JSON.stringify(Array.from({length: 25}, () => ({})))",
      'JSON.stringify([{file:"candidate.ts"}])',
      'JSON.stringify([{text:"...base",file:"STDIN",language:"JavaScript",ruleId:"kfq-closed-runtime-object-spread",range:{byteOffset:{start:23,end:30},start:{line:1,column:21},end:{line:1,column:28}}}])',
      'JSON.stringify([{text:"...forged",file:"STDIN",language:"TypeScript",ruleId:"kfq-closed-runtime-object-spread",range:{byteOffset:{start:23,end:30},start:{line:1,column:21},end:{line:1,column:28}}}])',
      'JSON.stringify([{text:"...base",file:"STDIN",language:"TypeScript",ruleId:"wrong",range:{byteOffset:{start:23,end:30},start:{line:1,column:21},end:{line:1,column:28}}}])',
      'JSON.stringify([{text:"...base",file:"STDIN",language:"TypeScript",ruleId:"kfq-closed-runtime-object-spread",range:{byteOffset:{start:23,end:30},start:{line:99,column:0},end:{line:99,column:7}}}])',
    ];

    for (const output of cases) {
      const binary = await outputBinary(output);
      await expect(
        collectClosedRuntimeFactsAtCommit(request(value, 2), {
          acquireBinary: () => Promise.resolve(binary),
        }),
      ).rejects.toBeInstanceOf(ClosedRuntimeFactsError);
    }
  });

  it("fails closed on parser stderr, nonzero exit, output overflow and timeout", async () => {
    const value = await fixture();
    const binaries = [
      await outputBinary('"[]"', 'process.stderr.write("warning");'),
      await outputBinary('"[]"', "process.exit(7);"),
      await outputBinary('"x".repeat(384 * 1024 + 1)'),
      await outputBinary('"[]"', "setTimeout(() => undefined, 10_000);"),
    ];

    for (const [index, binary] of binaries.entries()) {
      const current = request(value, 2);
      await expect(
        collectClosedRuntimeFactsAtCommit(
          index === 3 ? { ...current, context: { ...current.context, timeoutMs: 20 } } : current,
          { acquireBinary: () => Promise.resolve(binary) },
        ),
      ).rejects.toBeInstanceOf(ClosedRuntimeFactsError);
    }
  });
});

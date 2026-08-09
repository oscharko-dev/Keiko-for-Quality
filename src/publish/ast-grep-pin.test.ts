import { describe, expect, it } from "vitest";

import { sha256 } from "../core/brands.js";
import {
  AST_GREP_PIN,
  AST_GREP_RETRIEVAL_IDENTITY,
  astGrepRetrievalIdentity,
} from "./ast-grep-pin.js";

describe("AST_GREP_PIN", () => {
  it("pins archive and executable digests for every engine-supported action platform", () => {
    expect(Object.keys(AST_GREP_PIN.platforms).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    for (const target of Object.values(AST_GREP_PIN.platforms)) {
      expect(target.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(target.binarySha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(AST_GREP_PIN.platforms["win32-x64"]).toBeUndefined();
  });

  it("binds cache identity to digest bytes, not only the release tag", () => {
    const changed = {
      ...AST_GREP_PIN,
      platforms: {
        ...AST_GREP_PIN.platforms,
        "linux-x64": {
          ...AST_GREP_PIN.platforms["linux-x64"]!,
          binarySha256: sha256("f".repeat(64)),
        },
      },
    };
    expect(AST_GREP_RETRIEVAL_IDENTITY).toHaveLength(64);
    expect(astGrepRetrievalIdentity(changed)).not.toBe(AST_GREP_RETRIEVAL_IDENTITY);
  });
});

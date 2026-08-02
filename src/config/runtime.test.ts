import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import { parseRuntimeConfig, readModelToken } from "./runtime.js";

const VALID = {
  protocol: "anthropic",
  endpoint: "https://api.example.test/v1",
  model: "test-model-2026-01",
  tokenEnvName: "KFQ_MODEL_TOKEN",
  language: "English",
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 1800,
  tokenBudget: 2_000_000,
  maxFindings: 50,
  renameDetectionPercent: 50,
};

describe("parseRuntimeConfig", () => {
  it("accepts a complete configuration", () => {
    expect(parseRuntimeConfig(VALID).model).toBe("test-model-2026-01");
  });

  // A misspelled key would otherwise leave a default in place and quietly change what gets
  // reviewed, which is the failure mode this rejection exists to prevent.
  it("rejects an unknown key", () => {
    expect(() => parseRuntimeConfig({ ...VALID, conccurency: 8 })).toThrow(ValidationError);
  });

  it("rejects a missing key rather than substituting a default", () => {
    const { tokenBudget: _omitted, ...incomplete } = VALID;
    expect(() => parseRuntimeConfig(incomplete)).toThrow(ValidationError);
  });

  describe("endpoint", () => {
    it("rejects plaintext http, which would put the credential and diff on the wire", () => {
      expect(() => parseRuntimeConfig({ ...VALID, endpoint: "http://api.example.test" })).toThrow(
        ValidationError,
      );
    });

    it("rejects an endpoint carrying inline credentials", () => {
      expect(() =>
        parseRuntimeConfig({ ...VALID, endpoint: "https://user:pass@api.example.test" }),
      ).toThrow(ValidationError);
    });

    it("rejects a value that is not a URL at all", () => {
      expect(() => parseRuntimeConfig({ ...VALID, endpoint: "api.example.test" })).toThrow(
        ValidationError,
      );
    });
  });

  describe("token environment variable name", () => {
    it("rejects a lowercase or malformed name", () => {
      expect(() => parseRuntimeConfig({ ...VALID, tokenEnvName: "model-token" })).toThrow(
        ValidationError,
      );
    });

    // Naming the repository token here would hand it straight to the model subprocess.
    it("refuses to name GITHUB_TOKEN", () => {
      expect(() => parseRuntimeConfig({ ...VALID, tokenEnvName: "GITHUB_TOKEN" })).toThrow(
        ValidationError,
      );
    });

    it("refuses to name an ACTIONS_ runtime variable", () => {
      expect(() => parseRuntimeConfig({ ...VALID, tokenEnvName: "ACTIONS_RUNTIME_TOKEN" })).toThrow(
        ValidationError,
      );
    });
  });

  describe("bounds", () => {
    it.each([
      ["concurrency", "concurrency", 0],
      ["concurrency", "concurrency", 33],
      ["review timeout", "reviewTimeoutSeconds", 10],
      ["token budget", "tokenBudget", 10],
      ["max findings", "maxFindings", 0],
      ["rename detection", "renameDetectionPercent", 101],
    ])("rejects out-of-range %s", (_name, key, value) => {
      expect(() => parseRuntimeConfig({ ...VALID, [key]: value })).toThrow(ValidationError);
    });

    it("rejects a non-integer numeric value", () => {
      expect(() => parseRuntimeConfig({ ...VALID, concurrency: 2.5 })).toThrow(ValidationError);
    });
  });

  it("rejects an unsupported protocol", () => {
    expect(() => parseRuntimeConfig({ ...VALID, protocol: "gemini" })).toThrow(ValidationError);
  });

  it("never stores the credential itself", () => {
    const config = parseRuntimeConfig(VALID);
    expect(JSON.stringify(config)).not.toContain("secret");
    expect(Object.values(config)).not.toContain("KFQ_MODEL_TOKEN_VALUE");
  });
});

describe("readModelToken", () => {
  const config = parseRuntimeConfig(VALID);

  it("reads the credential from the named variable at the point of use", () => {
    expect(readModelToken(config, { KFQ_MODEL_TOKEN: "secret-value" })).toBe("secret-value");
  });

  it("returns undefined when the variable is absent or empty", () => {
    expect(readModelToken(config, {})).toBeUndefined();
    expect(readModelToken(config, { KFQ_MODEL_TOKEN: "" })).toBeUndefined();
  });
});

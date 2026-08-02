import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import {
  parseEventContext,
  readIntegerInput,
  readInput,
  runtimeConfigFromInputs,
} from "./inputs.js";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "synchronize",
    pull_request: {
      number: 42,
      draft: false,
      head: { sha: "b".repeat(40), repo: { full_name: "acme/widget" } },
      base: { sha: "a".repeat(40), ref: "dev", repo: { full_name: "acme/widget" } },
    },
    ...overrides,
  };
}

describe("parseEventContext", () => {
  it("reads the immutable commit pair from the event snapshot", () => {
    const context = parseEventContext(payload());
    expect(context).toMatchObject({
      owner: "acme",
      repo: "widget",
      pullNumber: 42,
      base: "a".repeat(40),
      head: "b".repeat(40),
      baseRef: "dev",
      draft: false,
      headRepoFullName: "acme/widget",
    });
  });

  // The activity type lives in the payload; GITHUB_EVENT_NAME is `pull_request_target` for all of
  // them, so reading it from the environment would make every edit look like a synchronize.
  it("reads the activity type from the payload", () => {
    expect(parseEventContext(payload({ action: "edited" })).action).toBe("edited");
  });

  it("detects a base retarget from the changes block", () => {
    const context = parseEventContext(
      payload({ action: "edited", changes: { base: { ref: { from: "main" } } } }),
    );
    expect(context.previousBaseRef).toBe("main");
  });

  it("reports no previous base for a metadata-only edit", () => {
    const context = parseEventContext(
      payload({ action: "edited", changes: { title: { from: "old" } } }),
    );
    expect(context.previousBaseRef).toBeUndefined();
  });

  it("reports a fork head as a different repository", () => {
    const forked = payload();
    (forked.pull_request as Record<string, unknown>).head = {
      sha: "b".repeat(40),
      repo: { full_name: "attacker/widget" },
    };
    expect(parseEventContext(forked).headRepoFullName).toBe("attacker/widget");
  });

  it("reports an undefined head repository for a deleted fork", () => {
    const orphaned = payload();
    (orphaned.pull_request as Record<string, unknown>).head = { sha: "b".repeat(40) };
    expect(parseEventContext(orphaned).headRepoFullName).toBeUndefined();
  });

  it.each([
    ["a truncated head sha", { head: { sha: "abc", repo: { full_name: "acme/widget" } } }],
    ["a missing pull request number", { number: undefined }],
  ])("rejects an event with %s", (_name, override) => {
    const broken = payload();
    Object.assign(broken.pull_request as Record<string, unknown>, override);
    expect(() => parseEventContext(broken)).toThrow(ValidationError);
  });

  it("rejects an event whose repository cannot be identified", () => {
    const broken = payload();
    (broken.pull_request as Record<string, unknown>).base = {
      sha: "a".repeat(40),
      ref: "dev",
      repo: {},
    };
    expect(() => parseEventContext(broken)).toThrow(ValidationError);
  });
});

describe("action inputs", () => {
  it("maps an input name to its environment variable", () => {
    expect(readInput({ INPUT_MODEL_ID: " test-model " }, "model_id")).toBe("test-model");
  });

  it("falls back when an integer input is absent", () => {
    expect(readIntegerInput({}, "concurrency", 4)).toBe(4);
  });

  it("rejects a non-integer input rather than coercing it", () => {
    expect(() => readIntegerInput({ INPUT_CONCURRENCY: "four" }, "concurrency", 4)).toThrow(
      ValidationError,
    );
  });

  it("builds a runtime configuration from inputs without ever reading the credential", () => {
    const config = runtimeConfigFromInputs({
      INPUT_MODEL_PROTOCOL: "anthropic",
      INPUT_MODEL_ENDPOINT: "https://api.example.test/v1",
      INPUT_MODEL_ID: "test-model",
      INPUT_MODEL_TOKEN_ENV: "KFQ_MODEL_TOKEN",
      KFQ_MODEL_TOKEN: "super-secret-value",
    });
    expect(config.tokenEnvName).toBe("KFQ_MODEL_TOKEN");
    expect(JSON.stringify(config)).not.toContain("super-secret-value");
  });

  it("rejects a configuration that names the repository token as the model credential", () => {
    expect(() =>
      runtimeConfigFromInputs({
        INPUT_MODEL_PROTOCOL: "openai",
        INPUT_MODEL_ENDPOINT: "https://api.example.test/v1",
        INPUT_MODEL_ID: "test-model",
        INPUT_MODEL_TOKEN_ENV: "GITHUB_TOKEN",
      }),
    ).toThrow(ValidationError);
  });
});

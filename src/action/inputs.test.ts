import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import {
  parseEventContext,
  readBooleanInput,
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

  it("reads pull request labels for the large-review override gate", () => {
    const context = parseEventContext(
      withPull({
        labels: [{ name: "keiko-review-override" }, { name: "needs work" }, { color: "red" }],
      }),
    );
    expect(context.labels).toEqual(["keiko-review-override", "needs work"]);
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

  // The run-summary comment (Keiko-for-Quality#31) states this verbatim rather than substituting
  // this process's own wall clock, which would reflect when a queued job happened to run rather
  // than when the reviewed activity actually occurred.
  describe("eventTimestamp", () => {
    it("reads pull_request.updated_at from the webhook payload", () => {
      const withTimestamp = payload();
      (withTimestamp.pull_request as Record<string, unknown>).updated_at = "2026-08-02T10:15:00Z";
      expect(parseEventContext(withTimestamp).eventTimestamp).toBe("2026-08-02T10:15:00Z");
    });

    it("is empty rather than fatal when the payload carries none", () => {
      expect(parseEventContext(payload()).eventTimestamp).toBe("");
    });

    it("is empty rather than a coerced string when the field is present but not a string", () => {
      const malformed = payload();
      (malformed.pull_request as Record<string, unknown>).updated_at = 12345;
      expect(parseEventContext(malformed).eventTimestamp).toBe("");
    });
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

  it("maps review_timeout_seconds to the one whole-review ceiling", () => {
    const base = {
      INPUT_MODEL_PROTOCOL: "openai",
      INPUT_MODEL_ENDPOINT: "https://api.example.test/v1",
      INPUT_MODEL_ID: "test-model",
      INPUT_MODEL_TOKEN_ENV: "KFQ_MODEL_TOKEN",
    };
    expect(runtimeConfigFromInputs(base).reviewTimeoutSeconds).toBe(1800);
    expect(
      runtimeConfigFromInputs({ ...base, INPUT_REVIEW_TIMEOUT_SECONDS: "37" }).reviewTimeoutSeconds,
    ).toBe(37);
  });

  // Dark-shipped prototype (issue #80 technique C, contracts/change-pass.ts): defaults off, and
  // an explicit `true` flows through exactly like every other boolean input's `true`.
  describe("crossArtifactPass", () => {
    const BASE = {
      INPUT_MODEL_PROTOCOL: "anthropic",
      INPUT_MODEL_ENDPOINT: "https://api.example.test/v1",
      INPUT_MODEL_ID: "test-model",
      INPUT_MODEL_TOKEN_ENV: "KFQ_MODEL_TOKEN",
    };

    it("defaults to false when the input is absent", () => {
      expect(runtimeConfigFromInputs(BASE).crossArtifactPass).toBe(false);
    });

    it("is true when the input is explicitly set to true", () => {
      const config = runtimeConfigFromInputs({ ...BASE, INPUT_CROSS_ARTIFACT_PASS: "true" });
      expect(config.crossArtifactPass).toBe(true);
    });

    it("rejects a value that is not the literal true or false, like its sibling boolean inputs", () => {
      expect(() => runtimeConfigFromInputs({ ...BASE, INPUT_CROSS_ARTIFACT_PASS: "yes" })).toThrow(
        ValidationError,
      );
    });
  });

  describe("large review controls", () => {
    const BASE = {
      INPUT_MODEL_PROTOCOL: "anthropic",
      INPUT_MODEL_ENDPOINT: "https://api.example.test/v1",
      INPUT_MODEL_ID: "test-model",
      INPUT_MODEL_TOKEN_ENV: "KFQ_MODEL_TOKEN",
    };

    it("defaults to bounded automatic review with a label override", () => {
      const config = runtimeConfigFromInputs(BASE);
      expect(config.largeReviewMaxFiles).toBe(100);
      expect(config.budgetFailureRetryLimit).toBe(2);
      expect(config.budgetFailureMinFiles).toBe(20);
      expect(config.largeReviewOverrideLabel).toBe("keiko-review-override");
    });

    it("maps explicit large-review inputs", () => {
      const config = runtimeConfigFromInputs({
        ...BASE,
        INPUT_LARGE_REVIEW_MAX_FILES: "0",
        INPUT_BUDGET_FAILURE_RETRY_LIMIT: "1",
        INPUT_BUDGET_FAILURE_MIN_FILES: "10",
        INPUT_LARGE_REVIEW_OVERRIDE_LABEL: "force-large-review",
      });
      expect(config.largeReviewMaxFiles).toBe(0);
      expect(config.budgetFailureRetryLimit).toBe(1);
      expect(config.budgetFailureMinFiles).toBe(10);
      expect(config.largeReviewOverrideLabel).toBe("force-large-review");
    });

    it("allows an explicit empty override label to disable the bypass label", () => {
      const config = runtimeConfigFromInputs({
        ...BASE,
        INPUT_LARGE_REVIEW_OVERRIDE_LABEL: "",
      });
      expect(config.largeReviewOverrideLabel).toBe("");
    });
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

  describe("readBooleanInput", () => {
    it("falls back when the input is absent", () => {
      expect(readBooleanInput({}, "run_summary", true)).toBe(true);
      expect(readBooleanInput({}, "run_summary", false)).toBe(false);
    });

    it("reads the literal string true", () => {
      expect(readBooleanInput({ INPUT_RUN_SUMMARY: "true" }, "run_summary", false)).toBe(true);
    });

    it("reads the literal string false, overriding a true fallback", () => {
      expect(readBooleanInput({ INPUT_RUN_SUMMARY: "false" }, "run_summary", true)).toBe(false);
    });

    it("rejects any other value rather than coercing it", () => {
      expect(() => readBooleanInput({ INPUT_RUN_SUMMARY: "yes" }, "run_summary", true)).toThrow(
        ValidationError,
      );
    });
  });
});

/** `payload`'s overrides land at the root; the intent lives on `pull_request`, so it merges there. */
function withPull(fields: Record<string, unknown>): Record<string, unknown> {
  const base = payload();
  return { ...base, pull_request: { ...(base.pull_request as object), ...fields } };
}

describe("change intent from the webhook payload", () => {
  /**
   * The model was never told what a change was for — no title, no description. This is the source
   * end of that channel; `model-proxy.ts` is where it reaches the model, and the rule text is
   * deliberately NOT the path, because the rule digest keys the review cache.
   */
  it("joins the title and the description into one stated purpose", () => {
    const event = parseEventContext(
      withPull({
        title: "Restore the retry ceiling",
        body: "Fixes #42. The cap was dropped in #40.",
      }),
    );

    expect(event.changeIntent).toBe(
      "Restore the retry ceiling\n\nFixes #42. The cap was dropped in #40.",
    );
  });

  /** A bot-opened pull request with a title and no body is the ordinary case, not a malformed one. */
  it("keeps the title alone when there is no description", () => {
    expect(parseEventContext(withPull({ title: "Bump the pin", body: null })).changeIntent).toBe(
      "Bump the pin",
    );
  });

  /** No stated purpose is a review with no stated purpose — never a parse failure. */
  it("reports an empty intent rather than throwing when the payload states none", () => {
    expect(parseEventContext(payload()).changeIntent).toBe("");
    expect(parseEventContext(withPull({ title: "   ", body: "  " })).changeIntent).toBe("");
  });
});

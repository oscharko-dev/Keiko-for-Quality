import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadReleasedQualityEvidence,
  parseCardQualityEvidence,
  withQualityEvidence,
} from "../src/quality-evidence.ts";

const VERSION = "v0.24.0";
const SHA = "a".repeat(40);

function clonedEvidence() {
  return JSON.parse(JSON.stringify(evidence()));
}

function evidence() {
  return {
    artifact: "keiko-for-quality/historical-replay-evidence",
    schemaVersion: 6,
    generatedAt: "2026-08-12T12:00:00.000Z",
    binding: { model: "gpt-oss-120b", protocol: "openai" },
    plan: { locallyBoundCases: 61 },
    execution: { attemptedCases: 61 },
    score: {
      schemaVersion: 1,
      chronological: {
        holdout: {
          after: {
            eligibleDecisions: { keep: 18 },
            confusionMatrix: { truePositive: 5, falsePositive: 13 },
            metrics: { precision: 5 / 18 },
          },
        },
      },
    },
  };
}

test("projects the released chronological holdout, not a synthetic headline number", () => {
  const parsed = parseCardQualityEvidence(evidence(), VERSION);
  assert.deepEqual(parsed, {
    historicalHoldoutPrecisionPct: (5 / 18) * 100,
    qualityVersion: VERSION,
  });
});

test("withholds precision when binding, population, or arithmetic is inconsistent", () => {
  const wrongModel = clonedEvidence();
  wrongModel.binding.model = "some-other-model";
  assert.equal(parseCardQualityEvidence(wrongModel, VERSION), undefined);

  const partial = clonedEvidence();
  partial.execution.attemptedCases = 60;
  assert.equal(parseCardQualityEvidence(partial, VERSION), undefined);

  const beautified = clonedEvidence();
  beautified.score.chronological.holdout.after.metrics.precision = 0.95;
  assert.equal(parseCardQualityEvidence(beautified, VERSION), undefined);
});

test("loads evidence only through the newest immutable GitHub Release tag", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const href = String(url);
    if (href.endsWith("/releases/latest")) {
      return Response.json({ tag_name: VERSION });
    }
    if (href.includes("/git/trees/")) {
      return Response.json({
        truncated: false,
        tree: [
          {
            type: "blob",
            path: `corpus/evidence/historical-replay-2026-08-12-${VERSION}.json`,
            sha: SHA,
          },
        ],
      });
    }
    if (href.endsWith(`/git/blobs/${SHA}`)) {
      const body = JSON.stringify(evidence());
      return Response.json({
        encoding: "base64",
        size: Buffer.byteLength(body),
        content: Buffer.from(body).toString("base64"),
      });
    }
    return new Response("missing", { status: 404 });
  };
  assert.deepEqual(await loadReleasedQualityEvidence("token", fetchImpl), {
    historicalHoldoutPrecisionPct: (5 / 18) * 100,
    qualityVersion: VERSION,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[1], /git\/trees\/v0\.24\.0\?recursive=1$/u);
});

test("a truncated release tree or ambiguous evidence path is unknown", async () => {
  const responses = [
    { tag_name: VERSION },
    {
      truncated: true,
      tree: [
        {
          type: "blob",
          path: `corpus/evidence/historical-replay-2026-08-12-${VERSION}.json`,
          sha: SHA,
        },
      ],
    },
  ];
  let index = 0;
  const fetchImpl = async () => Response.json(responses[index++]);
  assert.equal(await loadReleasedQualityEvidence("token", fetchImpl), undefined);
  assert.equal(index, 2);
});

test("quality evidence merges without inventing fields when absent", () => {
  const data = { owner: "o", repo: "r", completionPct: 50 };
  assert.equal(withQualityEvidence(data, undefined), data);
  assert.deepEqual(withQualityEvidence(data, parseCardQualityEvidence(evidence(), VERSION)), {
    ...data,
    historicalHoldoutPrecisionPct: (5 / 18) * 100,
    qualityVersion: VERSION,
  });
});

import { describe, expect, it } from "vitest";

import {
  describeParallelMappingCrossover,
  detectParallelMappingCrossovers,
  isParallelMappingCandidatePath,
} from "./parallel-mapping.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";

const BASE = `export const capabilities = (config: Config) => ({
  figma: isFigmaConnectorAuthorized(config),
  jira: isJiraConnectorAuthorized(config),
});`;

describe("detectParallelMappingCrossovers", () => {
  it("finds an exact two-way helper swap and renders publishable prose", () => {
    const result = detectParallelMappingCrossovers(
      BASE,
      BASE.replace(
        "figma: isFigmaConnectorAuthorized(config),\n  jira: isJiraConnectorAuthorized(config)",
        "figma: isJiraConnectorAuthorized(config),\n  jira: isFigmaConnectorAuthorized(config)",
      ),
    );

    expect(result).toEqual([
      {
        leftKey: "figma",
        rightKey: "jira",
        leftHelper: "isJiraConnectorAuthorized",
        rightHelper: "isFigmaConnectorAuthorized",
        line: 2,
      },
    ]);
    expect(sanitizeFindingBody(describeParallelMappingCrossover(result[0]!)).ok).toBe(true);
  });

  it("matches multiword keys against their camel-case helpers", () => {
    const base = `const capabilities = {
  googleDrive: isGoogleDriveAuthorized(config),
  sharePoint: isSharePointAuthorized(config),
};`;
    const head = base
      .replace("isGoogleDriveAuthorized(config)", "isSharePointAuthorized(config)")
      .replace("isSharePointAuthorized(config),\n};", "isGoogleDriveAuthorized(config),\n};");

    expect(detectParallelMappingCrossovers(base, head)).toHaveLength(1);
  });

  it("ignores mapping-shaped prose in comments and template literals", () => {
    const examples = [
      `/*\n${BASE}\n*/`,
      `const documentation = \`\n${BASE}\n\`;`,
      `// figma: isFigmaConnectorAuthorized(config),\n// jira: isJiraConnectorAuthorized(config),`,
    ];

    for (const base of examples) {
      const head = base
        .replace("figma: isFigmaConnectorAuthorized", "figma: isJiraConnectorAuthorized")
        .replace("jira: isJiraConnectorAuthorized", "jira: isFigmaConnectorAuthorized");
      expect(detectParallelMappingCrossovers(base, head)).toEqual([]);
    }
  });

  it("stays silent when a shown translation table proves the cross-map intentional", () => {
    const base = `${BASE}\nconst sourceFor = {\n  figma: "figma",\n  jira: "jira",\n};`;
    const head = base
      .replace("figma: isFigmaConnectorAuthorized", "figma: isJiraConnectorAuthorized")
      .replace("jira: isJiraConnectorAuthorized", "jira: isFigmaConnectorAuthorized")
      .replace('figma: "figma"', 'figma: "jira"')
      .replace('jira: "jira"', 'jira: "figma"');

    expect(detectParallelMappingCrossovers(base, head)).toEqual([]);
  });

  it("rejects helpers that also name the sibling key", () => {
    const base = `const rates = {
  usd: convertEurToUsd(value),
  eur: convertUsdToEur(value),
};`;
    const head = base
      .replace("convertEurToUsd(value)", "convertUsdToEur(value)")
      .replace("convertUsdToEur(value),\n};", "convertEurToUsd(value),\n};");

    expect(detectParallelMappingCrossovers(base, head)).toEqual([]);
  });

  it.each([
    ["unchanged", BASE],
    [
      "one changed helper",
      BASE.replace("isFigmaConnectorAuthorized(config)", "isJiraConnectorAuthorized(config)"),
    ],
    [
      "changed arguments",
      BASE.replace(
        "figma: isFigmaConnectorAuthorized(config),\n  jira: isJiraConnectorAuthorized(config)",
        "figma: isJiraConnectorAuthorized(other),\n  jira: isFigmaConnectorAuthorized(config)",
      ),
    ],
    [
      "base without a name-aligned contract",
      BASE.replace("isFigmaConnectorAuthorized", "selectPrimaryConnector"),
    ],
    ["ambiguous duplicate key", `${BASE}\nconst duplicate = { figma: anotherFigma(config) };`],
  ])("stays silent for %s", (_name, head) => {
    expect(detectParallelMappingCrossovers(BASE, head)).toEqual([]);
  });

  it("limits the production gate to executable JavaScript and TypeScript paths", () => {
    expect(isParallelMappingCandidatePath("src/capabilities.ts")).toBe(true);
    expect(isParallelMappingCandidatePath("src/capabilities.cjs")).toBe(true);
    expect(isParallelMappingCandidatePath("docs/capabilities.md")).toBe(false);
    expect(isParallelMappingCandidatePath("fixtures/capabilities.txt")).toBe(false);
  });
});

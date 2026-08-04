import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These suites build real temporary git repositories and drive the action end to end, and the
    // coverage lane re-runs all of it under V8 instrumentation on a shared CI runner. The 5s
    // default has already expired one such test under coverage while the identical test passed in
    // the uninstrumented verify job moments earlier — a slow lane is not a failing test, and a
    // timeout that fires only under instrumentation load measures the runner, not the code.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/testing/**"],
    },
  },
});

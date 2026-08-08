import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const NODE_SCRIPT_GLOBALS = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  fetch: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
};

// The `extends` helper is ESLint core's `defineConfig`, not `tseslint.config` — typescript-eslint
// deprecated its own wrapper in favour of it. The two resolve `extends` differently on one point
// only: core intersects a block's `files` with the extended config's, where tseslint replaced them.
// For every block below that is the same selection, because the one extended config that carries
// `files` of its own (`typescript-eslint/eslint-recommended`, `**/*.{ts,tsx,mts,cts}`) is a superset
// of the block that extends it (`src/**/*.ts`), and the others declare none.
export default defineConfig(
  {
    ignores: ["build/**", "dist/**", "coverage/**", "node_modules/**"],
  },

  // Product and test sources: fully type-checked.
  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      // Product output goes through the diagnostics sink, which cannot carry free-form text.
      // A stray console call would bypass the entire redaction contract.
      "no-restricted-globals": ["error", { name: "console", message: "Use the diagnostics sink." }],
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // Destructuring a key off an object to build the rest is a deliberate omission, not dead
          // code, and it is how several tests construct an invalid-by-omission fixture.
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Tests describe scenarios; the shape rules that keep product code small get in the way.
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // The widget service is a second, self-contained TypeScript program (widget/tsconfig.json,
  // WebWorker lib) held to the same discipline as src/ — minus the console rule, which guards
  // the product's diagnostics sink, a contract the worker does not participate in.
  {
    files: ["widget/src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      eqeqeq: ["error", "always"],
    },
  },

  // Build and gate scripts are plain Node ESM, outside the TypeScript program.
  {
    files: ["scripts/**/*.mjs", "corpus/**/*.mjs", "widget/test/**/*.mjs", "*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: NODE_SCRIPT_GLOBALS,
    },
  },
);

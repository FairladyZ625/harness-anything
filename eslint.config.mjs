import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = Object.fromEntries([
  "AbortController",
  "AbortSignal",
  "Blob",
  "Buffer",
  "ByteLengthQueuingStrategy",
  "CompressionStream",
  "CountQueuingStrategy",
  "CustomEvent",
  "DecompressionStream",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessageEvent",
  "MessagePort",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLPattern",
  "URLSearchParams",
  "WritableStream",
  "atob",
  "btoa",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "fetch",
  "global",
  "globalThis",
  "performance",
  "process",
  "queueMicrotask",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "structuredClone"
].map((name) => [name, "readonly"]));

export default tseslint.config(
  {
    ignores: [
      ".git/",
      ".claude/",
      ".gstack/",
      ".harness/",
      ".harness-private/",
      ".worktrees/",
      "coverage/",
      "dist/",
      "harness/",
      "node_modules/",
      "packages/**/dist/",
      "tmp/"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: nodeGlobals,
      sourceType: "module"
    },
    rules: {
      "no-control-regex": "off",
      "no-regex-spaces": "off",
      "no-unused-vars": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-undef": "off"
    }
  },
  {
    files: ["packages/**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/kernel/src/**/*", "!**/kernel/src/index.ts"],
              message: "Import kernel through its public barrel instead of deep src paths."
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.type='Literal'][source.value=/kernel\\/src\\/(?!index\\.ts$)/u]",
          message: "Dynamic imports must not bypass the kernel public barrel."
        }
      ]
    }
  },
  {
    // tools/*.mjs are gate/tooling scripts and are intentionally exempted in the
    // first boundary pass; this task only closes the packages/** consumer graph.
    files: ["tools/**/*.mjs"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off"
    }
  }
);

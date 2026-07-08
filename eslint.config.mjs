import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { kernelImportBoundaryKnownDebt } from "./tools/kernel-import-boundary-known-debt.mjs";
import { portPhysicalIoBoundaryKnownDebt } from "./tools/port-physical-io-boundary-known-debt.mjs";

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

const kernelDeepImportPattern = {
  group: ["**/kernel/src/**/*", "!**/kernel/src/index.ts"],
  message: "Import kernel through its public barrel instead of deep src paths."
};

function noRestrictedKernelImportOptions(allowedPatterns = []) {
  return {
    patterns: [
      {
        ...kernelDeepImportPattern,
        group: [
          ...kernelDeepImportPattern.group,
          ...allowedPatterns
        ]
      }
    ]
  };
}

function noRestrictedKernelImports(allowedPatterns = []) {
  return ["error", noRestrictedKernelImportOptions(allowedPatterns)];
}

const physicalIoBoundaryMessage = "Kernel/application physical I/O must be routed through an explicit port implementation file.";
const physicalIoRestrictedImportPaths = [
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process"
].map((name) => ({
  name,
  message: physicalIoBoundaryMessage
}));
const physicalIoSourcePattern = String.raw`^(?:node:)?(?:fs|fs\/promises|child_process)$`;
const physicalIoSyntaxRestrictions = [
  {
    selector: `ImportExpression[source.type='Literal'][source.value=/${physicalIoSourcePattern}/u]`,
    message: physicalIoBoundaryMessage
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${physicalIoSourcePattern}/u]`,
    message: physicalIoBoundaryMessage
  }
];
const portPhysicalIoBoundaryKnownDebtFiles = portPhysicalIoBoundaryKnownDebt.map((entry) => entry.file);

function noRestrictedKernelAndPhysicalIoImports() {
  const kernelOptions = noRestrictedKernelImportOptions();
  return [
    "error",
    {
      paths: physicalIoRestrictedImportPaths,
      patterns: kernelOptions.patterns
    }
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function kernelDeepImportSyntaxRestrictions(allowedTargets = []) {
  const allowedTails = [
    "index\\.ts",
    ...allowedTargets.map((target) => escapeRegExp(target.replace(/^packages\/kernel\/src\//u, "")))
  ];
  const sourcePattern = `kernel\\/src\\/(?!(?:${allowedTails.join("|")})$)`;
  return [
    {
      selector: `ImportDeclaration[source.value=/${sourcePattern}/u]`,
      message: kernelDeepImportPattern.message
    },
    {
      selector: `ExportNamedDeclaration[source.value=/${sourcePattern}/u]`,
      message: kernelDeepImportPattern.message
    },
    {
      selector: `ExportAllDeclaration[source.value=/${sourcePattern}/u]`,
      message: kernelDeepImportPattern.message
    },
    {
      selector: `ImportExpression[source.type='Literal'][source.value=/${sourcePattern}/u]`,
      message: "Dynamic imports must not bypass the kernel public barrel."
    }
  ];
}

const guiBridgeOnlyMessage = "GUI renderer must consume window.harness bridge only.";
const guiRendererRestrictedImportPaths = [
  "electron",
  "@harness-anything/application",
  "@harness-anything/kernel"
].map((name) => ({
  name,
  message: guiBridgeOnlyMessage
}));
const guiRendererRestrictedImportPatterns = [
  "@harness-anything/application/*",
  "@harness-anything/kernel/*",
  "@harness-anything/adapter-*",
  "@harness-anything/adapter-*/*",
  "packages/application/**",
  "packages/kernel/**",
  "packages/adapters/**",
  "**/packages/application/**",
  "**/packages/kernel/**",
  "**/packages/adapters/**",
  "**/application/**",
  "**/kernel/**",
  "**/adapters/**",
  "../main/**",
  "../preload/**",
  "**/main/**",
  "**/preload/**"
];
const guiRendererRestrictedImportSourcePattern = String.raw`(?:^electron$|@harness-anything\/(?:application|kernel|adapter-[^/]+)(?:\/|$)|(?:^|\/)(?:packages\/)?(?:application|kernel|adapters)(?:\/|$)|(?:^|\/)(?:main|preload)(?:\/|$))`;
const guiIpcRestrictedSyntax = [
  {
    selector: "MemberExpression[object.name='ipcMain'][property.name='handle']",
    message: "Register Harness IPC handlers only in packages/gui/src/main/ipc-handlers.ts."
  },
  {
    selector: "Identifier[name='ipcRenderer']",
    message: "Use ipcRenderer only in packages/gui/src/preload/electron-preload.ts."
  }
];
const guiIpcSyntaxWithoutIpcRenderer = guiIpcRestrictedSyntax.filter((entry) => !entry.selector.includes("ipcRenderer"));
const guiIpcSyntaxWithoutIpcMainHandle = guiIpcRestrictedSyntax.filter((entry) => !entry.selector.includes("ipcMain"));
const packageSyntaxRestrictions = [
  {
    selector: "ImportExpression[source.type='Literal'][source.value=/kernel\\/src\\/(?!index\\.ts$)/u]",
    message: "Dynamic imports must not bypass the kernel public barrel."
  }
];

const kernelImportKnownDebtOverrides = Object.values(Object.groupBy(
  kernelImportBoundaryKnownDebt,
  (entry) => entry.file
)).map((entries) => ({
  files: [entries[0].file],
  rules: {
    "no-restricted-imports": "off",
    "no-restricted-syntax": [
      "error",
      ...kernelDeepImportSyntaxRestrictions(entries.map((entry) => entry.target))
    ]
  }
}));

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
      "packages/gui/build-resources/",
      "packages/gui/.runtime-cache/",
      "packages/**/dist/",
      "packages/**/dist-electron/",
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
        ...noRestrictedKernelImports()
      ],
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions
      ]
    }
  },
  {
    files: [
      "packages/application/src/**/*.{ts,tsx,js,mjs}",
      "packages/kernel/src/**/*.{ts,tsx,js,mjs}"
    ],
    ignores: portPhysicalIoBoundaryKnownDebtFiles,
    rules: {
      "no-restricted-imports": [
        ...noRestrictedKernelAndPhysicalIoImports()
      ],
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions,
        ...physicalIoSyntaxRestrictions
      ]
    }
  },
  {
    files: ["packages/gui/src/renderer/**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: guiRendererRestrictedImportPaths,
          patterns: [
            {
              group: guiRendererRestrictedImportPatterns,
              message: guiBridgeOnlyMessage
            }
          ]
        }
      ],
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions,
        {
          selector: `ImportExpression[source.type='Literal'][source.value=/${guiRendererRestrictedImportSourcePattern}/u]`,
          message: guiBridgeOnlyMessage
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${guiRendererRestrictedImportSourcePattern}/u]`,
          message: guiBridgeOnlyMessage
        }
      ]
    }
  },
  {
    files: ["packages/gui/src/**/*.{ts,tsx,js,mjs}"],
    ignores: [
      "packages/gui/src/main/ipc-handlers.ts",
      "packages/gui/src/preload/electron-preload.ts"
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions,
        ...guiIpcRestrictedSyntax
      ]
    }
  },
  {
    files: ["packages/gui/src/main/ipc-handlers.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions,
        ...guiIpcSyntaxWithoutIpcMainHandle
      ]
    }
  },
  {
    files: ["packages/gui/src/preload/electron-preload.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...packageSyntaxRestrictions,
        ...guiIpcSyntaxWithoutIpcRenderer
      ]
    }
  },
  ...kernelImportKnownDebtOverrides,
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

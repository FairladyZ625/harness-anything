{
  "schema": "architecture-manifest/v1",
  "enabled": true,
  "modelContract": "architecture-model/v1",
  "provider": {
    "id": "likec4",
    "config": "likec4.config.json"
  },
  "modelRoot": "model",
  "views": [
    {
      "id": "landscape",
      "providerView": "landscape",
      "path": "views/landscape.c4"
    },
    {
      "id": "write-path",
      "providerView": "writePath",
      "path": "views/write-path.c4"
    },
    {
      "id": "runtime",
      "providerView": "runtime",
      "path": "views/runtime.c4"
    }
  ],
  "sourceScopes": [
    {
      "id": "repository-js-ts",
      "nodeId": "system.repository",
      "include": [
        "**/*.js",
        "**/*.jsx",
        "**/*.mjs",
        "**/*.cjs",
        "**/*.ts",
        "**/*.tsx",
        "**/*.mts",
        "**/*.cts"
      ],
      "exclude": [
        ".git/**",
        ".harness/**",
        ".harness-private/**",
        ".worktrees/**",
        "harness/**",
        "**/.git/**",
        "**/.next/**",
        "**/.turbo/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**",
        "**/test/**",
        "**/tests/**",
        "**/__tests__/**",
        "**/e2e/**",
        "**/*.test.*",
        "**/*.spec.*",
        "**/*.vitest.*"
      ]
    }
  ],
  "extractors": [
    {
      "id": "js-ts-imports",
      "adapter": "javascript-typescript/imports-v1",
      "sourceScopeIds": [
        "repository-js-ts"
      ]
    }
  ]
}

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkArchitecture, explainFile } from "./check-c4-architecture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-c4-architecture.mjs");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-c4-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function source(root, packageName, relativePath, text) {
  const file = path.join(root, "packages", packageName, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

async function workspacePackage(root, name, exports, type) {
  const packageRoot = path.join(root, "packages", name);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: `@harness-anything/${name}`,
      ...(exports ? { exports } : {}),
      ...(type ? { type } : {}),
    }),
  );
}

test("accepts modeled package imports and the four-plane dependency direction", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "cli");
  await workspacePackage(root, "daemon");
  await workspacePackage(root, "kernel");
  await source(root, "cli", "src/index.ts", 'import "@harness-anything/daemon";\n');
  await source(root, "daemon", "src/daemon-host/open.ts", 'import "../writer-cell/write.ts";\n');
  await source(root, "daemon", "src/writer-cell/write.ts", "export const write = true;\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.equal(result.checkedImports, 2);
  assert.equal(explainFile("packages/daemon/src/runtime-engine/run.ts").plane.id, "runtime-engine");
  assert.deepEqual(explainFile("packages/daemon/src/runtime-engine/run.ts").plane.allowedTargets, [
    "writer-cell",
    "runtime-engine",
  ]);
});

// dec_89D06D7360CBEC09795F7B12EC CH1/C4 keeps both forbidden import directions fail-closed.
test("rejects forbidden package imports and reverse-plane imports", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "cli");
  await workspacePackage(root, "daemon");
  await workspacePackage(root, "kernel");
  await source(root, "cli", "src/index.ts", 'import type { Event } from "@harness-anything/kernel";\n');
  await source(root, "daemon", "src/runtime-engine/run.ts", 'import "../daemon-host/open.ts";\n');
  await source(root, "daemon", "src/daemon-host/open.ts", "export {};\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((message) => message.includes("cli -> kernel is forbidden")));
  assert.ok(result.violations.some((message) => message.includes("runtime-engine -> daemon-host is forbidden")));
});

test("rejects imports in both directions when a workspace package has no architecture endpoint", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "kernel");
  await workspacePackage(root, "authorization-builtin");
  await source(root, "kernel", "src/index.ts", 'import "@harness-anything/authorization-builtin";\n');
  await source(root, "authorization-builtin", "src/index.ts", 'import "@harness-anything/kernel";\n');

  const result = await checkArchitecture(root);
  const unknownPackage = "unmodeled:@harness-anything/authorization-builtin";

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((message) =>
      message.includes("@harness-anything/authorization-builtin has no canonical architecture endpoint"),
    ),
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes(`kernel -> ${unknownPackage} has no canonical allowed relation`),
    ),
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes(`${unknownPackage} -> kernel has no canonical allowed relation`),
    ),
  );
});

test("resolves package self-reference exports before enforcing daemon plane direction", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "daemon", {
    ".": "./src/daemon-host/index.ts",
    "./writer": { default: "./src/writer-cell/write.ts" },
    "./host": "./src/daemon-host/open.ts",
    "./internal/*": "./src/*.ts",
  });
  await source(
    root,
    "daemon",
    "src/runtime-engine/run.ts",
    [
      'import "@harness-anything/daemon/writer";',
      'import "@harness-anything/daemon/host";',
      'import "@harness-anything/daemon/internal/writer-cell/write";',
      "",
    ].join("\n"),
  );
  await source(root, "daemon", "src/writer-cell/write.ts", "export {};\n");
  await source(root, "daemon", "src/daemon-host/index.ts", "export {};\n");
  await source(root, "daemon", "src/daemon-host/open.ts", "export {};\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((message) => message.includes("runtime-engine -> daemon-host is forbidden")));
  assert.equal(
    result.violations.some((message) => message.includes("cannot resolve daemon workspace export")),
    false,
  );
  assert.equal(
    result.violations.some((message) => message.includes("imports an unassigned daemon source file")),
    false,
  );
});

test("selects the active import and require export conditions independently", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "daemon", {
    "./dual": {
      import: "./src/writer-cell/write.ts",
      require: "./src/daemon-host/open.cts",
    },
  });
  await source(root, "daemon", "src/runtime-engine/dynamic.mts", 'import("@harness-anything/daemon/dual");\n');
  await source(root, "daemon", "src/runtime-engine/require.cts", 'require("@harness-anything/daemon/dual");\n');
  await source(root, "daemon", "src/writer-cell/write.ts", "export {};\n");
  await source(root, "daemon", "src/daemon-host/open.cts", "export {};\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((message) =>
      message.includes("src/runtime-engine/require.cts:1: runtime-engine -> daemon-host is forbidden"),
    ),
  );
  assert.equal(
    result.violations.some((message) => message.includes("src/runtime-engine/dynamic.mts:1:")),
    false,
  );
});

test("ignores inactive browser export conditions for Node imports", async (t) => {
  const root = await fixture(t);
  await workspacePackage(root, "daemon", {
    "./entry": {
      browser: "./src/daemon-host/browser-entry.ts",
      import: "./src/writer-cell/node-entry.ts",
      default: "./src/writer-cell/fallback-entry.ts",
    },
  });
  await source(root, "daemon", "src/runtime-engine/run.mts", 'import("@harness-anything/daemon/entry");\n');
  await source(root, "daemon", "src/daemon-host/browser-entry.ts", "export {};\n");
  await source(root, "daemon", "src/writer-cell/node-entry.ts", "export {};\n");
  await source(root, "daemon", "src/writer-cell/fallback-entry.ts", "export {};\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, true, result.violations.join("\n"));
});

test("honors type import resolution modes and NodeNext defaults", async (t) => {
  const root = await fixture(t);
  await workspacePackage(
    root,
    "daemon",
    {
      "./dual": {
        import: "./src/writer-cell/write.ts",
        require: "./src/daemon-host/open.cts",
      },
    },
    "module",
  );
  await source(
    root,
    "daemon",
    "src/runtime-engine/run.mts",
    [
      'import type { X as RequireDeclaration } from "@harness-anything/daemon/dual" with { "resolution-mode": "require" };',
      'import type { X as ImportDeclaration } from "@harness-anything/daemon/dual" with { "resolution-mode": "import" };',
      'type RequireExpression = import("@harness-anything/daemon/dual", { with: { "resolution-mode": "require" } }).X;',
      'type ImportExpression = import("@harness-anything/daemon/dual", { with: { "resolution-mode": "import" } }).X;',
      "",
    ].join("\n"),
  );
  await source(
    root,
    "daemon",
    "src/runtime-engine/default-esm.ts",
    [
      'import type { X as DefaultImportDeclaration } from "@harness-anything/daemon/dual";',
      'type DefaultImportExpression = import("@harness-anything/daemon/dual").X;',
      "",
    ].join("\n"),
  );
  await source(
    root,
    "daemon",
    "src/runtime-engine/default-commonjs.cts",
    [
      'import type { X as DefaultRequireDeclaration } from "@harness-anything/daemon/dual";',
      'type DefaultRequireExpression = import("@harness-anything/daemon/dual").X;',
      "",
    ].join("\n"),
  );
  await source(root, "daemon", "src/writer-cell/write.ts", "export interface X {}\n");
  await source(root, "daemon", "src/daemon-host/open.cts", "export interface X {}\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((message) =>
      message.includes("src/runtime-engine/run.mts:1: runtime-engine -> daemon-host is forbidden"),
    ),
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes("src/runtime-engine/run.mts:3: runtime-engine -> daemon-host is forbidden"),
    ),
  );
  assert.equal(
    result.violations.some((message) => message.includes("run.mts:2:")),
    false,
  );
  assert.equal(
    result.violations.some((message) => message.includes("run.mts:4:")),
    false,
  );
  assert.equal(
    result.violations.some((message) => message.includes("default-esm.ts:")),
    false,
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes("default-commonjs.cts:1: runtime-engine -> daemon-host is forbidden"),
    ),
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes("default-commonjs.cts:2: runtime-engine -> daemon-host is forbidden"),
    ),
  );
});

test("rejects model relations that drift from deterministic package rules", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), "{}");
  const modelPath = path.join(root, ".harness/ledger-files/context/architecture/model/model.c4");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(
    modelPath,
    "  cli -> daemon 'imports daemon' {\n    metadata {\n      archId 'relation.code.cli-daemon'\n      expectation 'allowed'\n      extractorIds ['js-ts-imports']\n    }\n  }\n",
  );

  const result = await checkArchitecture(root);

  assert.equal(result.model.status, "checked");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((message) => message.includes("model.c4 import relations differ")));
});

test("does not count block-commented model relations as active imports", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), "{}");
  const modelPath = path.join(root, ".harness/ledger-files/context/architecture/model/model.c4");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(
    modelPath,
    [
      "model {}",
      "/*",
      "  cli -> daemon 'imports daemon' {",
      "    metadata {",
      "      archId 'relation.code.cli-daemon'",
      "      expectation 'allowed'",
      "      extractorIds ['js-ts-imports']",
      "    }",
      "  }",
      "*/",
      "",
    ].join("\n"),
  );

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((message) =>
      message.includes("model.c4 import relations differ: missing cli->daemon (allowed)"),
    ),
  );
});

test("prints a JSON explanation for the requested source file", () => {
  const result = spawnSync(
    process.execPath,
    [checkerPath, "--explain", "packages/daemon/src/runtime-engine/run.ts", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const explanation = JSON.parse(result.stdout);
  assert.equal(explanation.file, "packages/daemon/src/runtime-engine/run.ts");
  assert.equal(explanation.package.id, "daemon");
  assert.equal(explanation.plane.id, "runtime-engine");
  assert.ok(explanation.plane.forbiddenTargets.includes("daemon-host"));
});

test("explains a discovered workspace package without a C4 endpoint as unmodeled", () => {
  const result = spawnSync(
    process.execPath,
    [checkerPath, "--explain", "packages/authorization-builtin/src/builtin-policy-adapter.ts", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const explanation = JSON.parse(result.stdout);
  assert.equal(explanation.package.id, "@harness-anything/authorization-builtin");
  assert.equal(explanation.package.status, "unmodeled");
  assert.deepEqual(explanation.package.allowedTargets, []);
  assert.ok(explanation.package.forbiddenTargets.includes("kernel"));
  assert.ok(explanation.package.forbiddenTargets.includes("daemon"));
});

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
const canonicalPackages = [
  "kernel",
  "storage",
  "application",
  "preset",
  "authorization-builtin",
  "authorization-keycloak",
  "authorization-gui",
  "authorization-keycloak-gui",
  "dsh-plugin",
  "daemon",
  "cli",
  "gui",
];
const privateCanonicalPackages = new Set(["authorization-gui", "authorization-keycloak-gui", "dsh-plugin"]);

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

async function workspacePackage(root, name, options = {}) {
  const normalizedOptions =
    options &&
    ("exports" in options ||
      "type" in options ||
      "private" in options ||
      "dependencies" in options ||
      "devDependencies" in options)
      ? options
      : { exports: options };
  const packageRoot = path.join(root, "packages", name);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: `@harness-anything/${name}`,
      ...(normalizedOptions.private !== undefined
        ? { private: normalizedOptions.private }
        : privateCanonicalPackages.has(name)
          ? { private: true }
          : {}),
      ...(normalizedOptions.exports ? { exports: normalizedOptions.exports } : {}),
      ...(normalizedOptions.type ? { type: normalizedOptions.type } : {}),
      ...(normalizedOptions.dependencies ? { dependencies: normalizedOptions.dependencies } : {}),
      ...(normalizedOptions.devDependencies ? { devDependencies: normalizedOptions.devDependencies } : {}),
    }),
  );
}

async function seedClosedWorldPackages(root, overrides = {}) {
  for (const name of canonicalPackages) {
    await workspacePackage(root, name, overrides[name]);
    const defaultSource = name === "daemon" ? "src/daemon-host/index.ts" : "src/index.ts";
    await source(root, name, defaultSource, "export {};\n");
  }
}

test("accepts modeled package imports and the four-plane dependency direction", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root, {
    cli: { dependencies: { "@harness-anything/daemon": "0.1.0", "@harness-anything/kernel": "0.1.0" } },
  });
  await source(
    root,
    "cli",
    "src/index.ts",
    'import "@harness-anything/daemon";\nimport type { Event } from "@harness-anything/kernel";\n',
  );
  await source(root, "daemon", "src/daemon-host/open.ts", 'import "../writer-cell/write.ts";\n');
  await source(root, "daemon", "src/writer-cell/write.ts", "export const write = true;\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.equal(result.checkedImports, 3);
  assert.equal(explainFile("packages/daemon/src/runtime-engine/run.ts").plane.id, "runtime-engine");
  assert.deepEqual(explainFile("packages/daemon/src/runtime-engine/run.ts").plane.allowedTargets, [
    "writer-cell",
    "runtime-engine",
  ]);
});

// dec_04A9211B073F29F0FC1E1CA573 CH1/CH3 & dec_7C93DEBCFB2D1A94C6FA07AAAD CH2:
// cli -> application and gui -> application are forbidden while cli -> kernel is allowed.
test("rejects forbidden package imports and reverse-plane imports", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root, {
    cli: { dependencies: { "@harness-anything/kernel": "0.1.0" } },
  });
  await source(
    root,
    "cli",
    "src/index.ts",
    'import type { Event } from "@harness-anything/kernel";\nimport "@harness-anything/application";\n',
  );
  await source(root, "gui", "src/index.ts", 'import "@harness-anything/application";\n');
  await source(root, "daemon", "src/runtime-engine/run.ts", 'import "../daemon-host/open.ts";\n');
  await source(root, "daemon", "src/daemon-host/open.ts", "export {};\n");

  const result = await checkArchitecture(root);

  assert.equal(result.ok, false);
  assert.equal(
    result.violations.some((message) => message.includes("cli -> kernel is forbidden")),
    false,
  );
  assert.ok(result.violations.some((message) => message.includes("cli -> application is forbidden")));
  assert.ok(result.violations.some((message) => message.includes("gui -> application is forbidden")));
  assert.ok(result.violations.some((message) => message.includes("runtime-engine -> daemon-host is forbidden")));
});

test("rejects imports in both directions when a workspace package has no architecture endpoint", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root);
  await workspacePackage(root, "extra-unmodeled");
  await source(root, "kernel", "src/index.ts", 'import "@harness-anything/extra-unmodeled";\n');
  await source(root, "extra-unmodeled", "src/index.ts", 'import "@harness-anything/kernel";\n');

  const result = await checkArchitecture(root);
  const unknownPackage = "unmodeled:@harness-anything/extra-unmodeled";

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((message) =>
      message.includes("@harness-anything/extra-unmodeled has no canonical architecture endpoint"),
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
  await seedClosedWorldPackages(root, {
    daemon: {
      exports: {
        ".": "./src/daemon-host/index.ts",
        "./writer": { default: "./src/writer-cell/write.ts" },
        "./host": "./src/daemon-host/open.ts",
        "./internal/*": "./src/*.ts",
      },
    },
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
  await seedClosedWorldPackages(root, {
    daemon: {
      exports: {
        "./dual": {
          import: "./src/writer-cell/write.ts",
          require: "./src/daemon-host/open.cts",
        },
      },
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
  await seedClosedWorldPackages(root, {
    daemon: {
      exports: {
        "./entry": {
          browser: "./src/daemon-host/browser-entry.ts",
          import: "./src/writer-cell/node-entry.ts",
          default: "./src/writer-cell/fallback-entry.ts",
        },
      },
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
  await seedClosedWorldPackages(root, {
    daemon: {
      type: "module",
      exports: {
        "./dual": {
          import: "./src/writer-cell/write.ts",
          require: "./src/daemon-host/open.cts",
        },
      },
    },
  });
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
      'import { X as DefaultImportStatic } from "@harness-anything/daemon/dual";',
      'export { X as DefaultImportReexport } from "@harness-anything/daemon/dual";',
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
      'import { X as DefaultRequireStatic } from "@harness-anything/daemon/dual";',
      'export { X as DefaultRequireReexport } from "@harness-anything/daemon/dual";',
      'import type { X as DefaultRequireDeclaration } from "@harness-anything/daemon/dual";',
      'type DefaultRequireExpression = import("@harness-anything/daemon/dual").X;',
      'void import("@harness-anything/daemon/dual");',
      "",
    ].join("\n"),
  );
  await source(root, "daemon", "src/writer-cell/write.ts", "export class X {}\n");
  await source(root, "daemon", "src/daemon-host/open.cts", "export class X {}\n");

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
      message.includes("default-commonjs.cts:3: runtime-engine -> daemon-host is forbidden"),
    ),
  );
  assert.ok(
    result.violations.some((message) =>
      message.includes("default-commonjs.cts:4: runtime-engine -> daemon-host is forbidden"),
    ),
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
  assert.equal(
    result.violations.some((message) => message.includes("default-commonjs.cts:5:")),
    false,
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

test("explains authorization-builtin as a modeled C4 endpoint and passes CLI --scope packages", () => {
  const result = spawnSync(
    process.execPath,
    [checkerPath, "--explain", "packages/authorization-builtin/src/builtin-policy-adapter.ts", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const explanation = JSON.parse(result.stdout);
  assert.equal(explanation.package.id, "authorization-builtin");
  assert.equal(explanation.package.status, "modeled");
  assert.deepEqual(explanation.package.allowedTargets, ["kernel"]);
  assert.ok(explanation.package.forbiddenTargets.includes("daemon"));

  const cliCheck = spawnSync(process.execPath, [checkerPath, "--scope", "packages", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(cliCheck.status, 0, cliCheck.stderr || cliCheck.stdout);
  const parsed = JSON.parse(cliCheck.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scope, "packages");
});

// dec_04A9211B073F29F0FC1E1CA573 CH3 & dec_7C93DEBCFB2D1A94C6FA07AAAD CH2
test("enforces closed-world workspace inventory and --scope packages", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root);
  await source(root, "daemon", "src/unassigned-top.ts", "export const ok = true;\n");

  const defaultScope = await checkArchitecture(root);
  assert.equal(defaultScope.ok, false);
  assert.ok(defaultScope.violations.some((m) => m.includes("must be assigned to one of")));

  const packagesScope = await checkArchitecture(root, { scope: "packages" });
  assert.equal(packagesScope.ok, true, packagesScope.violations.join("\n"));

  await rm(path.join(root, "packages/dsh-plugin/package.json"));
  const missingPkg = await checkArchitecture(root, { scope: "packages" });
  assert.equal(missingPkg.ok, false);
  assert.ok(missingPkg.violations.some((m) => m.includes("@harness-anything/dsh-plugin is missing from packages/")));
});

test("reconciles package.json internal dependencies against AST imports and C4 rules", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root, {
    cli: { dependencies: { "@harness-anything/application": "0.1.0", "@harness-anything/preset": "0.1.0" } },
    gui: {
      dependencies: { "@harness-anything/authorization-gui": "0.1.0" },
      devDependencies: { "@harness-anything/authorization-keycloak-gui": "0.1.0" },
    },
    storage: { devDependencies: { "@harness-anything/authorization-keycloak": "0.1.0" } },
  });
  await source(root, "application", "src/index.ts", 'import "@harness-anything/kernel";\n');

  const result = await checkArchitecture(root, { scope: "packages" });

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((m) =>
      m.includes("dependencies.@harness-anything/application (cli -> application) is forbidden"),
    ),
  );
  assert.ok(
    result.violations.some((m) => m.includes("dependencies.@harness-anything/preset is a ghost internal dependency")),
  );
  assert.ok(
    result.violations.some((m) =>
      m.includes("public package must not declare private @harness-anything/authorization-gui"),
    ),
  );
  assert.ok(
    result.violations.some((m) =>
      m.includes("devDependencies.@harness-anything/authorization-keycloak-gui is a ghost internal dependency"),
    ),
  );
  assert.ok(
    result.violations.some((m) =>
      m.includes("without declaring it in packages/application/package.json dependencies/peerDependencies"),
    ),
  );
  assert.equal(
    result.violations.some((m) => m.includes("packages/storage/package.json")),
    false,
  );

  await seedClosedWorldPackages(root, {
    gui: { devDependencies: { "@harness-anything/authorization-gui": "0.1.0" } },
  });
  await source(root, "gui", "src/index.ts", 'import "@harness-anything/authorization-gui";\n');
  const validPrivateBundle = await checkArchitecture(root, { scope: "packages" });
  assert.equal(validPrivateBundle.ok, true, validPrivateBundle.violations.join("\n"));
});

test("resolves explicit --model paths and worktree parent harness fallback cleanly", async (t) => {
  const root = await fixture(t);
  await seedClosedWorldPackages(root);

  const missingExplicit = await checkArchitecture(root, { scope: "packages", modelPath: "missing/model.c4" });
  assert.equal(missingExplicit.ok, false);
  assert.ok(missingExplicit.violations.some((m) => m.includes("missing/model.c4: model.c4 not found")));

  const worktreeContainer = path.join(root, ".worktrees/task_sample");
  await seedClosedWorldPackages(worktreeContainer);
  const mainModel = path.join(root, "harness/context/architecture/model/model.c4");
  await mkdir(path.dirname(mainModel), { recursive: true });
  await writeFile(mainModel, "model {}\n");
  const worktreeResult = await checkArchitecture(worktreeContainer, { scope: "packages" });
  assert.equal(worktreeResult.ok, false);
  assert.equal(worktreeResult.model.status, "checked");
  assert.ok(worktreeResult.model.paths.some((p) => p.endsWith("harness/context/architecture/model/model.c4")));
});

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

async function workspacePackage(root, name) {
  const packageRoot = path.join(root, "packages", name);
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: `@harness-anything/${name}` }));
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

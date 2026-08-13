// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyModule, classifyPath, isProductionPath, isTestPath, MODULES } from "../module-policy.mjs";

test("module-policy is the single ordered module catalog", () => {
  assert.deepEqual(MODULES, [
    "kernel", "task-lifecycle", "write-contract", "doc-sync", "preset", "cli", "gui",
    "daemon", "fleet", "authority-write-path", "identity-rbac", "agent-runtime", "decision-fact", "test-infra"
  ]);
  assert.equal(classifyModule("packages/kernel/src/domain/task.ts"), "kernel");
  assert.equal(classifyModule("packages/application/src/task-lifecycle-gates.ts"), "task-lifecycle");
  assert.equal(classifyModule("packages/kernel/src/domain/write-chain.contract.ts"), "write-contract");
  assert.equal(classifyModule("packages/cli/src/daemon/doc-sync-service.ts"), "doc-sync");
  assert.equal(classifyModule("packages/cli/src/commands/extensions/preset.ts"), "preset");
  assert.equal(classifyModule("packages/cli/src/index.ts"), "cli");
  assert.equal(classifyModule("packages/gui/src/index.ts"), "gui");
  assert.equal(classifyModule("packages/daemon/src/index.ts"), "daemon");
  assert.equal(classifyModule("packages/authority-write-path/src/index.ts"), "authority-write-path");
  assert.equal(classifyModule("packages/daemon/src/identity/authorization.ts"), "identity-rbac");
  assert.equal(classifyModule("packages/agent-runtime/src/index.ts"), "agent-runtime");
  assert.equal(classifyModule("packages/gui/src/renderer/agent-runtime-view.tsx"), "agent-runtime");
  assert.equal(classifyModule("packages/daemon/src/agent-runtime-registry.ts"), "agent-runtime");
  assert.equal(classifyModule("tools/gates/line-budget.mjs"), "test-infra");
});

test("production and test classification are disjoint", () => {
  assert.equal(isProductionPath("packages/kernel/src/domain/task.ts"), true);
  assert.equal(isTestPath("packages/kernel/test/domain/task.test.ts"), true);
  assert.equal(isProductionPath("packages/kernel/test/domain/task.test.ts"), false);
  assert.deepEqual(classifyPath("packages/kernel/test/domain/task.test.ts"), { module: "test-infra", kind: "test" });
  assert.deepEqual(classifyPath("README.md"), { module: null, kind: "other" });
});

test("runtime Slice B fixture classifies dedicated and shared registry paths into their budget buckets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-runtime-slice-b-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture) assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("preset Slice A fixture classifies canonical and shared paths into their ratcheted buckets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/preset-slice-a-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture) assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("preset Slice B fixture keeps the process service in preset and shared seams in frozen buckets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/preset-slice-b-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture) assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("Decision/Fact Slice A fixture assigns the vertical cut and shared seams to their budgets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/decision-fact-slice-a-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture) assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("Fleet Slice 1 fixture isolates transport production from daemon seams", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/fleet-slice-1-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture) assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

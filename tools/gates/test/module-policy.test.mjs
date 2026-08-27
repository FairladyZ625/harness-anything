// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BUDGETED_MODULES,
  classifyModule,
  classifyPath,
  isBudgetedProductionPath,
  isProductionPath,
  isTestPath,
  MODULE_POLICY,
  MODULES,
} from "../module-policy.mjs";

test("module-policy is the single ordered module catalog", () => {
  assert.deepEqual(MODULES, [
    "kernel",
    "task-lifecycle",
    "write-contract",
    "doc-sync",
    "preset",
    "cli",
    "gui",
    "daemon",
    "fleet",
    "authority-write-path",
    "identity-rbac",
    "agent-runtime",
    "decision",
    "fact",
    "tooling",
  ]);
  assert.deepEqual(
    BUDGETED_MODULES,
    MODULES.filter((moduleName) => !MODULE_POLICY[moduleName].budgetExempt),
  );
  assert.deepEqual(MODULE_POLICY.tooling, { production: true, budgetExempt: true });
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
  assert.equal(classifyModule("packages/kernel/src/domain/decision-event.ts"), "decision");
  assert.equal(classifyModule("packages/kernel/src/domain/fact-event.ts"), "fact");
  assert.equal(classifyModule("tools/gates/line-budget.mjs"), "tooling");
});

test("production and test classification are disjoint", () => {
  assert.equal(isProductionPath("packages/kernel/src/domain/task.ts"), true);
  assert.equal(isTestPath("packages/kernel/test/domain/task.test.ts"), true);
  assert.equal(isProductionPath("packages/kernel/test/domain/task.test.ts"), false);
  assert.deepEqual(classifyPath("packages/kernel/test/domain/task.test.ts"), { module: null, kind: "test" });
  assert.deepEqual(classifyPath("README.md"), { module: null, kind: "other" });
});

test("tool source is production but explicitly outside the line-budget scope", () => {
  assert.deepEqual(classifyPath("tools/gates/line-budget.mjs"), { module: "tooling", kind: "production" });
  assert.equal(isBudgetedProductionPath("tools/gates/line-budget.mjs"), false);
  assert.equal(isBudgetedProductionPath("packages/kernel/src/domain/task.ts"), true);
});

test("tool tests, fixtures, and snapshots stay outside production classification", () => {
  for (const filePath of [
    "tools/gates/rule.test.mjs",
    "tools/gates/test/rule.mjs",
    "tools/gates/fixtures/rule.mjs",
    "tools/gates/snapshots/rule.mjs",
    "tools/gates/__snapshots__/rule.mjs",
  ]) {
    assert.deepEqual(classifyPath(filePath), { module: null, kind: "test" }, filePath);
  }
});

test("runtime Slice B fixture classifies dedicated and shared registry paths into their budget buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/agent-runtime-slice-b-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("runtime instances Slice 1 fixture bills the instance store and shared seams to their production buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/runtime-instances-s1-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("runtime instances Slice 2 fixture bills spawn, provenance, GUI, and preset seams to their production buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/runtime-instances-s2-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("runtime instances Slice 3 fixture bills GUI management, auth terminal, and safe DTO seams to their production buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/runtime-instances-s3-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("preset Slice A fixture classifies canonical and shared paths into their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/preset-slice-a-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("preset Slice B fixture keeps the process service in preset and shared seams in frozen buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/preset-slice-b-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("W3 Slice 1 fixture keeps the canonical catalog resolver in the preset budget", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/w3-s1-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("W3 Slice 2 fixture keeps inventory and dynamic help in their production budgets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/w3-s2-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("W3 Slice 3 fixture keeps user shadow lifecycle paths in their production budgets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/w3-s3-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("Decision/Fact split fixture assigns both concepts and shared seams to their budgets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/decision-fact-slice-a-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("Fleet Slice 1 fixture isolates transport production from daemon seams", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/fleet-slice-1-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("W5 R1 fixture assigns replica cut production paths to their ratcheted buckets", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/w5-r1-production-paths.json", import.meta.url), "utf8"));
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI graph rework fixture bills the ego canvas + territory progress paths to gui", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-graph-rework-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("backend truth fixture bills the read path, contract, and readiness projection to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/backend-truth-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("P6 cold rebuild fixture bills every autonomous L1 materialization path to kernel", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/p6-cold-rebuild-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI S3 R1 fixture bills repo isolation and truthful catalog/system paths to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-s3-r1-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI S3 R2 fixture bills runtime truth, secure control, and direct PTY paths to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-s3-r2-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("migration import fixture bills the native CLI, daemon, GUI, and kernel seams to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/migration-import-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("task surface fixture bills CLI, daemon, GUI, kernel, and preset seams to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/task-surface-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("decision surface fixture bills CLI, daemon, Decision, and kernel seams to their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/decision-surface-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI gap-fix fixture bills the legend, navigation, and terminal fidelity paths to gui", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-gap-fix-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("preset provider fixture keeps catalog resolution and its public contract in the preset budget", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/preset-provider-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI territory rebuild fixture bills the two-level layout paths to gui", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-territory-rebuild-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI i18n fixture bills renderer copy paths into their ratcheted buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-i18n-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("territory root-cluster fixture bills the graph clustering seam to the gui bucket", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/territory-root-cluster-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("GUI archive-parity fixture bills the terminal repair, recents rail, filter parity, and system detail seams to the gui bucket", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/gui-archive-parity-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("daemon autostart fixture bills the shared autostart seam and both client wirings to their buckets", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/daemon-autostart-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

test("authored content migration fixture bills replay and symlink materialization to daemon and kernel", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/authored-content-migration-production-paths.json", import.meta.url), "utf8"),
  );
  for (const row of fixture)
    assert.deepEqual(classifyPath(row.path), { module: row.module, kind: "production" }, row.path);
});

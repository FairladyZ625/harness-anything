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

const productionPathFixtures = [
  "agent-runtime-slice-b",
  "authored-content-migration",
  "backend-truth",
  "daemon-autostart",
  "decision-fact-slice-a",
  "decision-surface",
  "fleet-slice-1",
  "gui-archive-parity",
  "gui-gap-fix",
  "gui-graph-rework",
  "gui-i18n",
  "gui-s3-r1",
  "gui-s3-r2",
  "gui-territory-rebuild",
  "migration-import",
  "p6-cold-rebuild",
  "preset-provider",
  "preset-slice-a",
  "preset-slice-b",
  "runtime-instances-s1",
  "runtime-instances-s2",
  "runtime-instances-s3",
  "task-surface",
  "territory-root-cluster",
  "w3-s1",
  "w3-s2",
  "w3-s3",
  "w5-r1",
];

test("production path fixtures stay in their ratcheted module buckets", () => {
  for (const fixtureName of productionPathFixtures) {
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/${fixtureName}-production-paths.json`, import.meta.url), "utf8"),
    );
    for (const row of fixture) {
      assert.deepEqual(
        classifyPath(row.path),
        { module: row.module, kind: "production" },
        `${fixtureName}: ${row.path}`,
      );
    }
  }
});

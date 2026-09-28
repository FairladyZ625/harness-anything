// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildManifestGatePlan,
  parseManifestGateArgs,
  selectManifestGateIds,
  shouldSkipTestQuarantine,
} from "./run-manifest-gates.mjs";

test("manifest gate runner appends shard args only to shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "integration-shard", "--shard", "3"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 3" },
  ]);
});

test("manifest gate runner executes gates declared for non-pull-request workflow jobs", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["windows-integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "windows-integration-shard", "--shard", "4"]);
  options.eventName = "schedule";

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 4" },
  ]);
});

test("manifest gate runner selects workflow gates for the current event surface", () => {
  const manifest = {
    gates: [
      {
        id: "lint",
        command: "npm run lint",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["crlf-checkout"], nonPullRequestJobs: ["crlf-checkout"] },
        },
      },
      {
        id: "test-fast",
        command: "npm run test:fast",
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["crlf-checkout"] } },
      },
    ],
  };
  const pullRequest = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  pullRequest.eventName = "pull_request";
  const schedule = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  schedule.eventName = "schedule";
  const push = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  push.eventName = "push";

  assert.deepEqual(buildManifestGatePlan(manifest, pullRequest), [{ id: "lint", command: "npm run lint" }]);
  assert.deepEqual(buildManifestGatePlan(manifest, schedule), [
    { id: "lint", command: "npm run lint" },
    { id: "test-fast", command: "npm run test:fast" },
  ]);
  assert.deepEqual(buildManifestGatePlan(manifest, push), buildManifestGatePlan(manifest, schedule));
});

test("manifest gate runner selects gates declared in the PR-body workflow", () => {
  const manifest = {
    gates: [
      {
        id: "pr-body-lint",
        command: "node tools/check-pr-body-bilingual.mjs --env PR_BODY",
        executionSurfaces: { prBody: { pullRequestJobs: ["pr-body-lint"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "pr-body-lint"]);
  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "pr-body-lint", command: "node tools/check-pr-body-bilingual.mjs --env PR_BODY" },
  ]);
});

test("manifest gate runner rejects --shard for non-shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "npm run harness:check-example",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--shard", "1"]);

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /manifest gate check-example is not shardable but --shard was provided/u,
  );
});

test("manifest gate runner selects locally scoped gates for fully covered changed paths", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/contributing/en/guide.md"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
  ]);
  assert.equal(options.changed, "origin/main");
});

test("manifest gate runner falls back to the full job when any changed path is unclassified", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/guide.md", "packages/kernel/src/index.ts"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("manifest gate runner preserves the full CI plan when --changed is absent", () => {
  const options = parseManifestGateArgs(["--workflow-job", "boundaries"]);

  assert.deepEqual(buildManifestGatePlan(selectionManifest(), options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("standalone changed mode derives its local PR gates from manifest path globs", () => {
  const manifest = selectionManifest();
  for (const gate of manifest.gates) {
    gate.deterministic = true;
    gate.executionSurfaces.classes = ["local", "pr"];
  }
  const options = parseManifestGateArgs(["--changed", "origin/main"]);
  options.changedPaths = ["docs-release/guide.md"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
  ]);
});

test("standalone changed mode selects rebuild-gates checks for the paths they read", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "gate-manifest.json"), "utf8"));
  const plan = (changedPaths) => {
    const options = parseManifestGateArgs(["--changed", "origin/main"]);
    options.changedPaths = changedPaths;
    return buildManifestGatePlan(manifest, options);
  };
  const cases = [
    ["entity-id-links", "node tools/gates/entity-id-links.mjs", "packages/gui/src/renderer/views/DecisionJudgeTab.tsx"],
    ["derived-contracts", "node tools/gates/derived-contracts.mjs --check", "tools/gates/contracts/gates.contract.mjs"],
    ["schema-closure", "node tools/gates/schema-closure.mjs --check", "packages/daemon/fixtures/contracts/x.json"],
    ["dependency-policy", "node tools/gates/dependency-policy.mjs", "package-lock.json"],
    ["cost-budget", "node tools/gates/cost-budget.mjs", "packages/kernel/src/store/task-event-store.ts"],
  ];
  for (const [id, command, changedPath] of cases) {
    assert.ok(
      plan([changedPath]).some((entry) => entry.id === id && entry.command === command),
      `${id} selected by ${changedPath}`,
    );
  }
  const docsPlan = plan(["docs-release/guide.md"]);
  for (const [id] of cases)
    assert.equal(
      docsPlan.some((entry) => entry.id === id),
      false,
      `${id} skipped for docs`,
    );
});

test("standalone changed mode selects every cheap local gate for a path it checks and for its own checker", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "gate-manifest.json"), "utf8"));
  const scripts = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).scripts;
  // Whole-suite, packaging and platform gates stay off the stop path; CI runs them.
  const suiteGates = new Set([
    "typecheck",
    "test-fast",
    "test-contract",
    "test-integration",
    "test-gui",
    "smoke-cli-package",
    "check-package-tarball-exports",
    "windows-first-run",
  ]);
  // One path per gate that the gate reads; the first four are paths a local stop run once missed.
  const representativePaths = {
    "canonical-event-compat": "packages/daemon/src/protocol/readside-validator.ts",
    "check-write-coordinator-boundary": "packages/cli/src/new-command.ts",
    "check-write-road-registry": "packages/cli/src/new-command.ts",
    "check-file-complexity": "packages/daemon/src/entity-action-catalog-executor.ts",
    "entity-id-links": "packages/gui/src/renderer/views/DecisionJudgeTab.tsx",
    "check-poll-spin-boundary": "packages/daemon/src/runtime-poll.ts",
    "check-fallback-boundaries": "tools/gates/receipt-verify.mjs",
    "check-entity-doc-contract": "packages/kernel/src/domain/entity-kind-registry.ts",
    lint: "packages/cli/src/index.ts",
    "check-test-tier-manifest": "packages/kernel/test/store/task-event-store.test.ts",
    "check-cli-structure": "packages/cli/src/new-command.ts",
    "check-cli-help-contract": "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    "check-cli-error-codes": "packages/cli/src/new-command.ts",
    "check-error-classification": "packages/adapters/local/src/index.ts",
    "check-import-boundaries": "packages/daemon/package.json",
    "check-bypass-write-boundary": "packages/kernel/src/store/task-event-store.ts",
    "check-kernel-dead-exports": "packages/daemon/src/repo-cell.ts",
    "check-relation-cycle-substrate": "packages/kernel/src/projection/relation-graph-projection.ts",
    "check-domain-judgment-single-definition": "packages/gui/src/renderer/task-adapter.ts",
    "check-relation-canonical-direction": "packages/daemon/src/repo-cell.ts",
    "check-task-event-aggregate-entry": "packages/application/src/task-lifecycle-service.ts",
    "scan-forbidden-symbols": "packages/gui/src/main.ts",
    "check-integrity-single-source": "packages/kernel/src/integrity/stable-hash.ts",
    "check-private-boundary": ".gitignore",
    "check-integration-test-shards": ".github/workflows/rewrite-ci.yml",
    "check-docs-release-map": "README.md",
    "check-gate-surface": ".github/branch-protection.md",
    "check-gate-manifest-invariants": "tools/gate-manifest.json",
    "check-template-command-surface": "packages/cli/src/cli/thin-command.ts",
    "check-locale-content": "packages/cli/src/cli/thin-command.ts",
    "check-catalog-schema": "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    "check-runtime-release-readiness": "packages/gui/src/distribution/runtime-release-readiness.ts",
    "check-package-policy": "packages/cli/package.json",
    "check-implementation-contracts": "package-lock.json",
    "check-service-mappability": "packages/application/src/index.ts",
    "check-api-contract-registry": "packages/daemon/src/daemon-host.ts",
    "check-schema-contracts": "packages/kernel/fixtures/schemas/task-plan/valid.json",
    "check-schema-field-coverage": "packages/kernel/src/domain/entity-field-contracts.ts",
    "check-legacy-intake-readiness": "tools/legacy-intake/behavior-corpus-classification.json",
    "smoke-legacy-intake": "packages/cli/src/commands/migration.ts",
    "check-status-vocabulary": "packages/kernel/src/domain/status-vocabulary.ts",
    "check-sync-subprocess": "packages/daemon/src/repo-cell.ts",
    "derived-contracts": "tools/gates/contracts/gates.contract.mjs",
    "schema-closure": "packages/daemon/fixtures/contracts/x.json",
    "dependency-policy": "package-lock.json",
    "cost-budget": "packages/kernel/src/store/task-event-store.ts",
  };
  const selectedIds = (changedPath) => {
    const options = parseManifestGateArgs(["--changed", "origin/main"]);
    options.changedPaths = [changedPath];
    return selectManifestGateIds(manifest, options);
  };
  const localGates = manifest.gates.filter(
    (gate) =>
      !gate.aggregate &&
      gate.deterministic === true &&
      gate.executionSurfaces?.classes?.includes("local") &&
      gate.executionSurfaces?.classes?.includes("pr") &&
      !suiteGates.has(gate.id),
  );

  assert.deepEqual(
    localGates.map((gate) => gate.id).sort(),
    Object.keys(representativePaths).sort(),
    "every cheap local gate names a representative path",
  );
  for (const gate of localGates) {
    assert.ok(selectedIds(representativePaths[gate.id]).includes(gate.id), `${gate.id} selected by its path`);
    const command = gate.command.replace(/^npm run (\S+)/u, (_, script) => scripts[script]);
    const checker = /^node (tools\/\S+\.mjs)/u.exec(command)?.[1];
    if (checker) assert.ok(selectedIds(checker).includes(gate.id), `${gate.id} selected by ${checker}`);
  }
  for (const id of suiteGates) assert.equal(selectedIds("packages/kernel/src/index.ts").includes(id), false, id);
});

test("test quarantine skips pull-request L0 jobs", () => {
  assert.equal(
    shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" }),
    true,
  );
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request" }), true);
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "schedule" }), false);
  assert.equal(
    shouldSkipTestQuarantine("windows-integration-shard", {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/x",
    }),
    false,
  );
});

function selectionManifest() {
  const executionSurfaces = { rewriteCi: { pullRequestJobs: ["boundaries"] } };
  return {
    gates: [
      {
        id: "check-docs",
        command: "node check-docs.mjs",
        localPathGlobs: ["README.md", "docs-release/**"],
        executionSurfaces,
      },
      {
        id: "check-release",
        command: "node check-release.mjs",
        localPathGlobs: ["docs-release/**"],
        executionSurfaces,
      },
      { id: "check-everything", command: "node check-everything.mjs", executionSurfaces },
    ],
  };
}

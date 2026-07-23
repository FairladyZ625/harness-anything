import path from "node:path";
import { loadEnforcementConstant } from "./enforcement-constants.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const integrationShardIds = loadEnforcementConstant(repoRoot, "ci-integration-shard-sequence");
export const integrationShardCount = integrationShardIds.length;
export const defaultIntegrationTestWeightMs = 1000;
// The same successful run showed 2.465x aggregate file-test time versus shard
// wall time. Round to a stable scheduler estimate instead of pretending the
// concurrent Node runner is serial.
export const observedCiIntegrationParallelism = 2.5;

// File-level timings extracted from successful rewrite-ci run 29720318100,
// with drifted integration files refreshed from successful run 29987267590.
// Nightly tests are not sharded, but keeping their observed cost registered
// makes tier moves and future drift visible instead of falling back to 1000ms.
export const nightlyTestFileWeightsMs = Object.freeze({
  "packages/cli/test/production-authority-canonical-ingress/canonical-ingress.test.ts": 186900,
  "packages/cli/test/production-authority-host-services/adapter-golden.test.ts": 6600,
  "packages/cli/test/production-authority-startup-performance.test.ts": 25900
});

// Optional balancing overrides. New tests need no entry: they receive the
// deterministic default weight and are placed into the lightest shard.
export const integrationTestFileWeightsMs = Object.freeze({
  "packages/adapters/multica/test/multica-readonly-adopt.test.ts": 782.5,
  "packages/application/test/local-controller-service.test.ts": 507.0,
  "packages/application/test/execution-saga.test.ts": 1200.0,
  "packages/cli/test/actor-attribution-cli.test.ts": 21000,
  "packages/cli/test/anchor-backfill-cli.test.ts": 36500,
  "packages/cli/test/architecture-script-cli.test.ts": 91400,
  "packages/cli/test/attribution-diff-cli.test.ts": 4299.9,
  "packages/cli/test/check-governance-cli.test.ts": 93300,
  "packages/cli/test/completion-facade-cli.test.ts": 98700,
  "packages/cli/test/conflict-preflight-cli.test.ts": 11956,
  "packages/cli/test/daemon-cold-start-launch-spec.test.ts": 85134,
  "packages/cli/test/daemon-command-outcomes.test.ts": 47939,
  "packages/cli/test/daemon-execution-claim-cli.test.ts": 35400,
  "packages/cli/test/daemon-generation-disease-integration.test.ts": 10554,
  "packages/cli/test/daemon-lease-executor-cli.test.ts": 11738,
  "packages/cli/test/daemon-lifecycle-cli.test.ts": 43200,
  "packages/cli/test/daemon-local-identity-cli.test.ts": 16779,
  "packages/cli/test/daemon-multi-repo-lifecycle-cli.test.ts": 69400,
  "packages/cli/test/daemon-refresh-authority-retention.test.ts": 15215,
  "packages/cli/test/daemon-refresh-preflight.test.ts": 35700,
  "packages/cli/test/daemon-snapshot-integration.test.ts": 41263,
  "packages/cli/test/daemon-thin-client-cli.test.ts": 161000,
  "packages/cli/test/daemon-thin-client-registry-cli.test.ts": 47500,
  "packages/cli/test/decision-cli.test.ts": 62800,
  "packages/cli/test/decision-body-cli.test.ts": 20664,
  "packages/cli/test/decision-content-pin-cli.test.ts": 22500,
  "packages/cli/test/decision-coverage-cli.test.ts": 98200,
  "packages/cli/test/decision-policy-conformance-cli.test.ts": 26049,
  "packages/cli/test/decision-task-metadata-cli.test.ts": 27800,
  "packages/cli/test/diagnostics-cli.test.ts": 551.7,
  "packages/cli/test/direct-mode-fail-close.test.ts": 13264,
  "packages/cli/test/distill-cli.test.ts": 15570,
  "packages/cli/test/doc-sync-cli.test.ts": 10748,
  "packages/cli/test/doctor-cli.test.ts": 20082,
  "packages/cli/test/extension-cli.test.ts": 64200,
  "packages/cli/test/fact-cli.test.ts": 31800,
  "packages/cli/test/fact-execution-migration-cli.test.ts": 16090,
  "packages/cli/test/graph-cli.test.ts": 2433.0,
  "packages/cli/test/gui-cli.test.ts": 8459,
  "packages/cli/test/init-cli.test.ts": 20822,
  "packages/cli/test/local-lifecycle-cli.test.ts": 149800,
  "packages/cli/test/local-lifecycle-crlf-cli.test.ts": 10618,
  "packages/cli/test/materializer-recovery-cli.test.ts": 40800,
  "packages/cli/test/migration-adopt-cli.test.ts": 75600,
  "packages/cli/test/new-task-cli.test.ts": 52200,
  "packages/cli/test/p16-command-parity-cli.test.ts": 10596.6,
  "packages/cli/test/post-merge-check-cli.test.ts": 47500,
  "packages/cli/test/production-authority-canonical-ingress-tracer.test.ts": 6800,
  "packages/cli/test/production-authority-journal-upgrade.test.ts": 8975,
  "packages/cli/test/production-authority-script-scope-ingress.test.ts": 14767,
  "packages/cli/test/projection-readers-cli.test.ts": 11963,
  "packages/cli/test/preset-check-smoke-cli.test.ts": 21934,
  "packages/cli/test/preset-create-milestone-cli.test.ts": 4114.3,
  "packages/cli/test/preset-create-milestone-render-html-cli.test.ts": 3185.5,
  "packages/cli/test/preset-document-cli.test.ts": 7456,
  "packages/cli/test/preset-github-issue-repair-cli.test.ts": 2819.6,
  "packages/cli/test/preset-legacy-migration-cli.test.ts": 9930,
  "packages/cli/test/preset-milestone-closeout-cli.test.ts": 2414.0,
  "packages/cli/test/preset-module-cli.test.ts": 64200,
  "packages/cli/test/preset-preflight-cli.test.ts": 15389,
  "packages/cli/test/preset-script-cli.test.ts": 43800,
  "packages/cli/test/preset-script-imports-cli.test.ts": 20400,
  "packages/cli/test/preset-script-staging-boundary.test.ts": 25400,
  "packages/cli/test/preset-uninstall-safety-cli.test.ts": 28900,
  "packages/cli/test/perf/cli-latency-budget.test.ts": 16500,
  "packages/cli/test/progress-evidence-cli.test.ts": 700.0,
  "packages/cli/test/preset-subtask-expansion-cli.test.ts": 17807.0,
  "packages/cli/test/preset-user-root-cli.test.ts": 15751,
  "packages/cli/test/preset-v3-canary-equivalence-cli.test.ts": 82434,
  "packages/cli/test/projection-freshness-cli.test.ts": 1723.3,
  "packages/cli/test/retired-attribution-field-migration-cli.test.ts": 8922,
  "packages/cli/test/runtime-event-cli.test.ts": 36100,
  "packages/cli/test/script-host-boundary.test.ts": 17682,
  "packages/cli/test/self-host-git-boundary-cli.test.ts": 777.2,
  "packages/cli/test/session-cli.test.ts": 14528,
  "packages/cli/test/submit-lifecycle-cli.test.ts": 29500,
  "packages/cli/test/settings-cli.test.ts": 55900,
  "packages/cli/test/task-archive-distill-cli.test.ts": 29100,
  "packages/cli/test/task-delete-disposition-cli.test.ts": 37000,
  "packages/cli/test/task-document-gates-cli.test.ts": 114100,
  "packages/cli/test/task-lease-cli.test.ts": 73400,
  "packages/cli/test/task-lifecycle-facade-cli.test.ts": 55608,
  "packages/cli/test/task-list-cli.test.ts": 20140,
  "packages/cli/test/task-show-relation-list-cli.test.ts": 24100,
  "packages/cli/test/task-transition-sweep-cli.test.ts": 44263,
  "packages/cli/test/task-tree-cli.test.ts": 29900,
  "packages/cli/test/worktree-cli.test.ts": 2230.1,
  "packages/cli/test/worktree-root-resolution-cli.test.ts": 24997,
  "packages/cli/test/write-lock-retry-cli.test.ts": 3640.9,
  "packages/daemon/test/transport-integration.test.ts": 413.2,
  "packages/kernel/test/store/conditional-delta-writes.test.ts": 1083.6,
  "packages/kernel/test/store/crash-before-watermark.test.ts": 892.2,
  "packages/kernel/test/store/daemon-registry.test.ts": 190.1,
  "packages/daemon/test/runtime/repo-runtime.test.ts": 2829.0,
  "packages/kernel/test/store/entity-registry-substrate.test.ts": 500.0,
  "packages/kernel/test/store/entity-disposition.test.ts": 487.3,
  "packages/kernel/test/store/global-committer-lock.test.ts": 1579.8,
  "packages/kernel/test/store/journal-idempotency.test.ts": 574.4,
  "packages/kernel/test/store/ledger-materializer.test.ts": 1657.2,
  "packages/kernel/test/store/payload-hash.test.ts": 493.8,
  "packages/kernel/test/store/portable-path-collision.test.ts": 423.7,
  "packages/kernel/test/store/progress-append-delta.test.ts": 1531.3,
  "packages/kernel/test/store/relation-cascade-direction.test.ts": 446.4,
  "packages/kernel/test/store/relation-graph-projection.test.ts": 850.9,
  "packages/kernel/test/store/relation-graph-toctou.test.ts": 473.9,
  "packages/kernel/test/store/same-task-fifo.test.ts": 7647.4,
  "packages/kernel/test/store/session-entity.test.ts": 500.0,
  "packages/gui/test/projection-notification-live.test.ts": 7964,
  "packages/kernel/test/store/sqlite-incremental-projection.test.ts": 12209,
  "packages/kernel/test/store/sqlite-rebuild.test.ts": 734.2,
  "tools/check-docs-release-map.test.mjs": 590.0,
  "tools/check-import-boundaries.test.mjs": 27223,
  "tools/check-kernel-dead-exports.test.mjs": 8249,
  "tools/check-runtime-release-readiness.test.mjs": 9983,
  "tools/check-supply-chain.test.mjs": 29200,
  "tools/graph-panorama.test.mjs": 455.6,
  "tools/quickstart-demo.test.mjs": 12269,
  "tools/relation-weathering-spike.test.mjs": 182.9
});

export function assignIntegrationTestShards(
  manifestFiles,
  weightOverrides = integrationTestFileWeightsMs,
  shardCount = integrationShardCount,
  defaultWeightMs = defaultIntegrationTestWeightMs
) {
  const shards = Array.from({ length: shardCount }, (_, index) => ({ id: index + 1, files: [], estimatedMs: 0 }));
  const weightedFiles = [...new Set(manifestFiles)]
    .map((file) => ({ file, weight: weightOverrides[file] ?? defaultWeightMs }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const { file, weight } of weightedFiles) {
    const lightest = [...shards].sort((left, right) => left.estimatedMs - right.estimatedMs || left.id - right.id)[0];
    lightest.files.push(file);
    lightest.estimatedMs += weight;
  }

  return shards.map(({ id, files }) => ({ id, files: files.sort() }));
}

export function parseIntegrationShardId(value, shardCount = integrationShardCount) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > shardCount) {
    throw new Error(`--shard must be an integer from 1 to ${shardCount}`);
  }
  return parsed;
}

export function selectIntegrationShardFiles(shardValue, manifestFiles) {
  const shards = assignIntegrationTestShards(manifestFiles);
  const shardId = parseIntegrationShardId(shardValue, shards.length);
  return [...shards[shardId - 1].files];
}

export function integrationShardSummaries(manifestFiles, weightOverrides = integrationTestFileWeightsMs) {
  return assignIntegrationTestShards(manifestFiles, weightOverrides).map((shard) => ({
    id: shard.id,
    files: shard.files.length,
    estimatedWorkMs: shard.files.reduce(
      (sum, file) => sum + (weightOverrides[file] ?? defaultIntegrationTestWeightMs),
      0
    ),
    estimatedMs: shard.files.reduce(
      (sum, file) => sum + (weightOverrides[file] ?? defaultIntegrationTestWeightMs),
      0
    ) / observedCiIntegrationParallelism
  }));
}

export function validateIntegrationTestShards(manifestFiles, weightOverrides = integrationTestFileWeightsMs) {
  const errors = [];
  const manifestSet = new Set(manifestFiles);
  const shards = assignIntegrationTestShards(manifestFiles, weightOverrides);
  const assigned = shards.flatMap((shard) => shard.files);

  if (manifestSet.size !== manifestFiles.length) errors.push("integration manifest contains duplicate files");
  if (assigned.length !== manifestSet.size || assigned.some((file) => !manifestSet.has(file))) {
    errors.push("derived integration shards do not exactly cover the integration manifest");
  }
  for (const [file, weight] of Object.entries(weightOverrides)) {
    if (!manifestSet.has(file)) errors.push(`integration weight references non-integration file: ${file}`);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`integration file has invalid weight: ${file}`);
  }
  if (shards.some((shard) => shard.files.length === 0)) errors.push("derived integration shard is empty");

  return { ok: errors.length === 0, errors, shards };
}

export function validateNightlyTestWeights(manifestFiles, weightOverrides = nightlyTestFileWeightsMs) {
  const errors = [];
  const manifestSet = new Set(manifestFiles);
  for (const [file, weight] of Object.entries(weightOverrides)) {
    if (!manifestSet.has(file)) errors.push(`nightly weight references non-nightly file: ${file}`);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`nightly file has invalid weight: ${file}`);
  }
  return { ok: errors.length === 0, errors };
}

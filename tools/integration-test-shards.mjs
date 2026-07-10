import { testTierManifest } from "./test-tier-manifest.mjs";

export const integrationShardCount = 6;

export const integrationTestFileWeightsMs = Object.freeze({
  "packages/adapters/multica/test/multica-readonly-adopt.test.ts": 782.5,
  "packages/application/test/local-controller-service.test.ts": 507.0,
  "packages/cli/test/actor-attribution-cli.test.ts": 3640.4,
  "packages/cli/test/anchor-backfill-cli.test.ts": 16962.1,
  "packages/cli/test/attribution-diff-cli.test.ts": 4299.9,
  "packages/cli/test/check-governance-cli.test.ts": 37788.5,
  "packages/cli/test/conflict-preflight-cli.test.ts": 4766.7,
  "packages/cli/test/daemon-multi-repo-lifecycle-cli.test.ts": 15469.7,
  "packages/cli/test/daemon-thin-client-cli.test.ts": 38159.7,
  "packages/cli/test/decision-cli.test.ts": 15299.0,
  "packages/cli/test/decision-coverage-cli.test.ts": 26753.8,
  "packages/cli/test/decision-task-metadata-cli.test.ts": 13473.5,
  "packages/cli/test/diagnostics-cli.test.ts": 551.7,
  "packages/cli/test/distill-cli.test.ts": 5975.6,
  "packages/cli/test/docmap-cli.test.ts": 4214.7,
  "packages/cli/test/doctor-cli.test.ts": 3606.3,
  "packages/cli/test/extension-cli.test.ts": 7000.4,
  "packages/cli/test/fact-cli.test.ts": 11411.7,
  "packages/cli/test/graph-cli.test.ts": 2433.0,
  "packages/cli/test/gui-cli.test.ts": 1187.3,
  "packages/cli/test/init-cli.test.ts": 6346.2,
  "packages/cli/test/local-lifecycle-cli.test.ts": 52850.8,
  "packages/cli/test/local-lifecycle-crlf-cli.test.ts": 3951.3,
  "packages/cli/test/migration-adopt-cli.test.ts": 21829.1,
  "packages/cli/test/new-task-cli.test.ts": 5417.7,
  "packages/cli/test/p16-command-parity-cli.test.ts": 10596.6,
  "packages/cli/test/post-merge-check-cli.test.ts": 13476.9,
  "packages/cli/test/preset-create-milestone-cli.test.ts": 4114.3,
  "packages/cli/test/preset-create-milestone-render-html-cli.test.ts": 3185.5,
  "packages/cli/test/preset-github-issue-repair-cli.test.ts": 2819.6,
  "packages/cli/test/preset-milestone-closeout-cli.test.ts": 2414.0,
  "packages/cli/test/preset-module-cli.test.ts": 22821.6,
  "packages/cli/test/preset-user-root-cli.test.ts": 3000.0,
  "packages/cli/test/preset-script-cli.test.ts": 21150.1,
  "packages/cli/test/preset-script-imports-cli.test.ts": 1132.0,
  "packages/cli/test/preset-subtask-expansion-cli.test.ts": 17807.0,
  "packages/cli/test/projection-freshness-cli.test.ts": 1723.3,
  "packages/cli/test/runtime-event-cli.test.ts": 5222.8,
  "packages/cli/test/self-host-git-boundary-cli.test.ts": 777.2,
  "packages/cli/test/session-cli.test.ts": 3130.5,
  "packages/cli/test/settings-cli.test.ts": 20342.2,
  "packages/cli/test/task-archive-distill-cli.test.ts": 15682.0,
  "packages/cli/test/task-delete-disposition-cli.test.ts": 15148.2,
  "packages/cli/test/task-document-gates-cli.test.ts": 10050.9,
  "packages/cli/test/task-lease-cli.test.ts": 2210.6,
  "packages/cli/test/task-list-cli.test.ts": 4079.4,
  "packages/cli/test/task-show-relation-list-cli.test.ts": 9469.7,
  "packages/cli/test/task-transition-sweep-cli.test.ts": 24335.2,
  "packages/cli/test/task-tree-cli.test.ts": 10262.2,
  "packages/cli/test/worktree-cli.test.ts": 2230.1,
  "packages/cli/test/write-lock-retry-cli.test.ts": 3640.9,
  "packages/daemon/test/transport-integration.test.ts": 413.2,
  "packages/kernel/test/store/conditional-delta-writes.test.ts": 1083.6,
  "packages/kernel/test/store/crash-before-watermark.test.ts": 892.2,
  "packages/kernel/test/store/daemon-registry.test.ts": 190.1,
  "packages/kernel/test/store/daemon-runtime.test.ts": 2829.0,
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
  "packages/kernel/test/store/sqlite-incremental-projection.test.ts": 4800.3,
  "packages/kernel/test/store/sqlite-rebuild.test.ts": 734.2,
  "tools/check-docs-release-map.test.mjs": 590.0,
  "tools/check-import-boundaries.test.mjs": 1230.7,
  "tools/check-kernel-dead-exports.test.mjs": 1909.3,
  "tools/check-runtime-release-readiness.test.mjs": 1003.8,
  "tools/check-supply-chain.test.mjs": 8797.4,
  "tools/graph-panorama.test.mjs": 455.6,
  "tools/quickstart-demo.test.mjs": 5488.9,
  "tools/relation-weathering-spike.test.mjs": 182.9
});

export const integrationTestShards = Object.freeze([
  Object.freeze({
    id: 1,
    files: Object.freeze([
      "packages/cli/test/local-lifecycle-cli.test.ts",
      "packages/cli/test/task-delete-disposition-cli.test.ts",
      "packages/cli/test/task-document-gates-cli.test.ts",
      "packages/cli/test/distill-cli.test.ts",
      "packages/cli/test/attribution-diff-cli.test.ts",
      "packages/cli/test/write-lock-retry-cli.test.ts",
      "packages/cli/test/graph-cli.test.ts",
      "packages/cli/test/projection-freshness-cli.test.ts",
      "packages/kernel/test/store/crash-before-watermark.test.ts",
      "packages/cli/test/self-host-git-boundary-cli.test.ts",
      "packages/kernel/test/store/relation-cascade-direction.test.ts"
    ])
  }),
  Object.freeze({
    id: 2,
    files: Object.freeze([
      "packages/cli/test/daemon-thin-client-cli.test.ts",
      "packages/cli/test/anchor-backfill-cli.test.ts",
      "packages/cli/test/post-merge-check-cli.test.ts",
      "packages/cli/test/task-show-relation-list-cli.test.ts",
      "tools/quickstart-demo.test.mjs",
      "packages/cli/test/conflict-preflight-cli.test.ts",
      "packages/cli/test/local-lifecycle-crlf-cli.test.ts",
      "tools/check-kernel-dead-exports.test.mjs",
      "tools/check-runtime-release-readiness.test.mjs",
      "tools/check-docs-release-map.test.mjs",
      "packages/application/test/local-controller-service.test.ts",
      "packages/kernel/test/store/portable-path-collision.test.ts"
    ])
  }),
  Object.freeze({
    id: 3,
    files: Object.freeze([
      "packages/cli/test/check-governance-cli.test.ts",
      "packages/cli/test/preset-subtask-expansion-cli.test.ts",
      "packages/cli/test/decision-task-metadata-cli.test.ts",
      "tools/check-supply-chain.test.mjs",
      "packages/cli/test/init-cli.test.ts",
      "packages/cli/test/docmap-cli.test.ts",
      "packages/cli/test/actor-attribution-cli.test.ts",
      "packages/cli/test/preset-milestone-closeout-cli.test.ts",
      "packages/kernel/test/store/global-committer-lock.test.ts",
      "packages/cli/test/preset-script-imports-cli.test.ts",
      "packages/cli/test/diagnostics-cli.test.ts",
      "packages/kernel/test/store/entity-disposition.test.ts",
      "packages/kernel/test/store/daemon-registry.test.ts"
    ])
  }),
  Object.freeze({
    id: 4,
    files: Object.freeze([
      "packages/cli/test/decision-coverage-cli.test.ts",
      "packages/cli/test/settings-cli.test.ts",
      "packages/cli/test/decision-cli.test.ts",
      "packages/cli/test/task-tree-cli.test.ts",
      "packages/cli/test/extension-cli.test.ts",
      "packages/kernel/test/store/sqlite-incremental-projection.test.ts",
      "packages/cli/test/preset-create-milestone-cli.test.ts",
      "packages/cli/test/doctor-cli.test.ts",
      "packages/cli/test/worktree-cli.test.ts",
      "packages/kernel/test/store/ledger-materializer.test.ts",
      "packages/kernel/test/store/conditional-delta-writes.test.ts",
      "packages/kernel/test/store/journal-idempotency.test.ts",
      "packages/kernel/test/store/payload-hash.test.ts",
      "packages/daemon/test/transport-integration.test.ts"
    ])
  }),
  Object.freeze({
    id: 5,
    files: Object.freeze([
      "packages/cli/test/task-transition-sweep-cli.test.ts",
      "packages/cli/test/preset-script-cli.test.ts",
      "packages/cli/test/daemon-multi-repo-lifecycle-cli.test.ts",
      "packages/cli/test/p16-command-parity-cli.test.ts",
      "packages/kernel/test/store/same-task-fifo.test.ts",
      "packages/cli/test/new-task-cli.test.ts",
      "packages/cli/test/preset-create-milestone-render-html-cli.test.ts",
      "packages/kernel/test/store/daemon-runtime.test.ts",
      "tools/check-import-boundaries.test.mjs",
      "packages/cli/test/gui-cli.test.ts",
      "packages/kernel/test/store/sqlite-rebuild.test.ts",
      "packages/kernel/test/store/relation-graph-toctou.test.ts"
    ])
  }),
  Object.freeze({
    id: 6,
    files: Object.freeze([
      "packages/cli/test/preset-module-cli.test.ts",
      "packages/cli/test/preset-user-root-cli.test.ts",
      "packages/cli/test/migration-adopt-cli.test.ts",
      "packages/cli/test/task-archive-distill-cli.test.ts",
      "packages/cli/test/fact-cli.test.ts",
      "packages/cli/test/runtime-event-cli.test.ts",
      "packages/cli/test/task-list-cli.test.ts",
      "packages/cli/test/session-cli.test.ts",
      "packages/cli/test/preset-github-issue-repair-cli.test.ts",
      "packages/kernel/test/store/progress-append-delta.test.ts",
      "packages/kernel/test/store/relation-graph-projection.test.ts",
      "packages/cli/test/task-lease-cli.test.ts",
      "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
      "tools/graph-panorama.test.mjs",
      "tools/relation-weathering-spike.test.mjs"
    ])
  })
]);

export function parseIntegrationShardId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > integrationShardCount) {
    throw new Error(`--shard must be an integer from 1 to ${integrationShardCount}`);
  }
  return parsed;
}

export function selectIntegrationShardFiles(shardValue) {
  const validation = validateIntegrationTestShards();
  if (!validation.ok) {
    throw new Error(`integration shard declaration is invalid:\n${validation.errors.join("\n")}`);
  }
  const shardId = parseIntegrationShardId(shardValue);
  const shard = integrationTestShards.find((candidate) => candidate.id === shardId);
  if (!shard) {
    throw new Error(`integration shard ${shardId} is not declared`);
  }
  return [...shard.files].sort();
}

export function integrationShardSummaries() {
  return integrationTestShards.map((shard) => ({
    id: shard.id,
    files: shard.files.length,
    estimatedMs: shard.files.reduce((sum, file) => sum + (integrationTestFileWeightsMs[file] ?? 0), 0)
  }));
}

export function validateIntegrationTestShards(manifestFiles = testTierManifest.integration) {
  const errors = [];
  const manifestSet = new Set(manifestFiles);
  const shardIds = new Set();
  const seen = new Map();

  for (const shard of integrationTestShards) {
    if (!Number.isInteger(shard.id) || shard.id < 1 || shard.id > integrationShardCount) {
      errors.push(`invalid integration shard id: ${String(shard.id)}`);
    }
    if (shardIds.has(shard.id)) {
      errors.push(`duplicate integration shard id: ${shard.id}`);
    }
    shardIds.add(shard.id);
    if (!Array.isArray(shard.files) || shard.files.length === 0) {
      errors.push(`integration shard ${shard.id} is empty`);
      continue;
    }
    for (const file of shard.files) {
      if (!manifestSet.has(file)) {
        errors.push(`integration shard ${shard.id} references non-integration file: ${file}`);
      }
      const previous = seen.get(file);
      if (previous !== undefined) {
        errors.push(`integration file appears in multiple shards: ${file} (${previous}, ${shard.id})`);
      }
      seen.set(file, shard.id);
    }
  }

  for (let id = 1; id <= integrationShardCount; id += 1) {
    if (!shardIds.has(id)) {
      errors.push(`missing integration shard id: ${id}`);
    }
  }

  for (const file of manifestFiles) {
    if (!seen.has(file)) {
      errors.push(`integration file missing from shards: ${file}`);
    }
    const weight = integrationTestFileWeightsMs[file];
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`integration file has no positive weight: ${file}`);
    }
  }

  for (const file of Object.keys(integrationTestFileWeightsMs)) {
    if (!manifestSet.has(file)) {
      errors.push(`integration weight references non-integration file: ${file}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

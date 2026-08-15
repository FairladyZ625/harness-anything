export const integrationShardCount = 6;
export const defaultIntegrationTestWeightMs = 1000;

// Optional balancing overrides. New tests need no entry: they receive the
// deterministic default weight and are placed into the lightest shard.
export const integrationTestFileWeightsMs = Object.freeze({
  "packages/cli/test/daemon-multi-repo-lifecycle-cli.test.ts": 15469.7,
  "packages/cli/test/daemon-thin-client-cli.test.ts": 38159.7,
  "packages/kernel/test/store/daemon-registry.test.ts": 190.1,
  "packages/kernel/test/store/entity-disposition.test.ts": 487.3,
  "packages/kernel/test/store/relation-cascade-direction.test.ts": 446.4,
  "packages/kernel/test/store/relation-graph-projection.test.ts": 850.9,
  "tools/check-docs-release-map.test.mjs": 590.0,
  "tools/check-import-boundaries.test.mjs": 1230.7,
  "tools/check-kernel-dead-exports.test.mjs": 1909.3,
  "tools/check-runtime-release-readiness.test.mjs": 1003.8,
  "tools/check-supply-chain.test.mjs": 8797.4,
  "tools/quickstart-demo.test.mjs": 5488.9,
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
    estimatedMs: shard.files.reduce(
      (sum, file) => sum + (weightOverrides[file] ?? defaultIntegrationTestWeightMs),
      0
    )
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

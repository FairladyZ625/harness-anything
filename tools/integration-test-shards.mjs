import { readFileSync } from "node:fs";

export const integrationShardCount = 24;
// The median cost of an integration file added between 2026-10-25 and 2026-11-08 was 8.7s; the
// previous 1s default let 354 unweighted files pile into shards that looked light.
export const defaultIntegrationTestWeightMs = 10_000;
// Budgets are in the weights' unit: one file's serial duration on a GitHub ubuntu runner, which
// runs three files at a time on four cores. A shard's wall is at most about its weight sum / 2.6
// (measured 2026-11-08 in task_34470c99bb4b77644b9ce3a246; raising the concurrency to 4 or 6 made
// no shard faster and failed timing-sensitive tests), so this sum keeps the test step near
// 6 minutes, under the 7-minute job line. The 24 shards leave headroom for runner variance.
export const integrationShardBudgetMs = 1_000_000;
// A file runs its tests serially, so one file is a floor on its shard's wall. Files above this
// either split or name their reason in entries.overBudgetFiles of
// tools/gate-allowlists/check-integration-test-shards.json.
export const integrationFileBudgetMs = 180_000;
// The runner fails a file whose measured duration exceeds this multiple of its declared weight
// plus the slack: the declaration is what the shard budget sums, so it has to stay honest. The
// slack absorbs the runner noise measured over four runs of main (p99 of max/median 1.57).
export const integrationWeightOverrunFactor = 2;
export const integrationWeightOverrunSlackMs = 60_000;

// Measured per-file durations are kept in integration-test-weights.json. A file without an entry
// takes the default weight and is placed into the lightest shard.
export const integrationTestFileWeightsMs = Object.freeze(
  JSON.parse(readFileSync(new URL("./integration-test-weights.json", import.meta.url), "utf8")),
);

export function assignIntegrationTestShards(
  manifestFiles,
  weightOverrides = integrationTestFileWeightsMs,
  shardCount = integrationShardCount,
  defaultWeightMs = defaultIntegrationTestWeightMs,
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
    estimatedMs: shard.files.reduce((sum, file) => sum + (weightOverrides[file] ?? defaultIntegrationTestWeightMs), 0),
  }));
}

export function validateIntegrationTestShards(
  manifestFiles,
  weightOverrides = integrationTestFileWeightsMs,
  { overBudgetFiles = [], shardBudgetMs = integrationShardBudgetMs } = {},
) {
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
  for (const summary of integrationShardSummaries(manifestFiles, weightOverrides)) {
    if (summary.estimatedMs > shardBudgetMs)
      errors.push(
        `integration shard ${summary.id} is over budget: ${summary.estimatedMs}ms of declared file weight > ${shardBudgetMs}ms; make the slowest files cheaper or add a shard (integrationShardCount, workflow matrix and required contexts)`,
      );
  }
  for (const [file, weight] of Object.entries(weightOverrides)) {
    if (weight > integrationFileBudgetMs && !overBudgetFiles.includes(file))
      errors.push(
        `integration file is over the ${integrationFileBudgetMs}ms per-file budget (${weight}ms): ${file}; split it, or record why it cannot be split in entries.overBudgetFiles of tools/gate-allowlists/check-integration-test-shards.json`,
      );
  }
  for (const file of overBudgetFiles) {
    if (!((weightOverrides[file] ?? 0) > integrationFileBudgetMs))
      errors.push(`integration file budget exception is stale (the file is within budget or gone): ${file}`);
  }

  return { ok: errors.length === 0, errors, shards };
}

// The weights are the only input the shard budget sees, so a run checks them against what it measured.
export function integrationWeightOverruns(measuredMs, weightOverrides = integrationTestFileWeightsMs) {
  return [...measuredMs]
    .map(([file, durationMs]) => ({
      file,
      durationMs,
      declaredMs: weightOverrides[file] ?? defaultIntegrationTestWeightMs,
    }))
    .filter(
      ({ durationMs, declaredMs }) =>
        durationMs > declaredMs * integrationWeightOverrunFactor + integrationWeightOverrunSlackMs,
    )
    .sort((left, right) => left.file.localeCompare(right.file));
}

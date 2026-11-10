import { readFileSync } from "node:fs";

export const integrationShardCount = 10;
// The median cost of an integration file added between 2026-10-25 and 2026-11-08 was 8.7s; the
// previous 1s default let 354 unweighted files pile into shards that looked light.
export const defaultIntegrationTestWeightMs = 10_000;
// Budgets are in the weights' unit: one file's serial duration on a GitHub ubuntu runner, which
// runs three files at a time on four cores. Run 42562323998 measured 4,091s of test step across
// the 14-shard matrix for 11,988s of declared weight, an effective factor of 2.93 (the previous
// comment used 2.6). dec_127E3F9C47D2842DA7AB86E0F4/CH2 moves the PR matrix to 10 shards with a
// 9-minute job target: 1,250,000ms / 2.93 is about 7.1 minutes of test step, leaving room for the
// ~40s install/extract steps. The budget stays a ceiling per shard, not a per-shard allowance.
// task_1520e155e64d4d5261d87ab16b tightens the observed PR target to 8 minutes: the eleven
// successful runs after #4481/#4483 measured 6.7-8.4 minutes per shard although every weight sum
// was ~1.20M ms, so the same budget needs the heavy-first hand-over below to stay inside 8 minutes.
export const integrationShardBudgetMs = 1_250_000;
// A file runs its tests serially, so one file is a floor on its shard's wall. Files above this
// either split or name their reason in entries.overBudgetFiles of
// tools/gate-allowlists/check-integration-test-shards.json.
export const integrationFileBudgetMs = 180_000;
// The runner fails a file whose measured duration exceeds this multiple of its declared weight
// plus the slack: the declaration is what the shard budget sums, so it has to stay honest. The
// slack absorbs the runner noise measured over four runs of main (p99 of max/median 1.57).
export const integrationWeightOverrunFactor = 2;
export const integrationWeightOverrunSlackMs = 60_000;
// node --test runs three files at a time on the four-core GitHub runner (its default concurrency is
// cores - 1), so a shard's wall is the finish time of the latest of three file lanes, not its weight
// sum. The runner starts files in the order this module returns; the 2026-11-09/10 PR runs showed
// 6.7-8.4 minute shards whose weight sums were all ~1.20M ms because the alphabetical return order
// let a heavy file start late. Keep the estimated spread across shards inside this window.
export const integrationShardLaneCount = 3;
export const integrationShardWallSpreadBudgetMs = 30_000;

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

  // Keep the heavy-first order. `node --test` starts files in this order, so an alphabetical sort
  // here would put the longest file last on whichever lane it lands and extend that shard's wall.
  return shards.map(({ id, files }) => ({ id, files }));
}

// Simulates node --test's file scheduling: each file starts on the first lane that is free, in the
// order the shard hands them over. The longest lane is the shard's estimated wall.
export function estimateIntegrationShardWallMs(
  files,
  weightOverrides = integrationTestFileWeightsMs,
  laneCount = integrationShardLaneCount,
  defaultWeightMs = defaultIntegrationTestWeightMs,
) {
  const lanes = Array.from({ length: Math.max(1, laneCount) }, () => 0);
  for (const file of files) {
    const lane = lanes.indexOf(Math.min(...lanes));
    lanes[lane] += weightOverrides[file] ?? defaultWeightMs;
  }
  return Math.max(...lanes);
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
    estimatedWallMs: estimateIntegrationShardWallMs(shard.files, weightOverrides),
  }));
}

export function validateIntegrationTestShards(
  manifestFiles,
  weightOverrides = integrationTestFileWeightsMs,
  {
    overBudgetFiles = [],
    shardBudgetMs = integrationShardBudgetMs,
    wallSpreadBudgetMs = integrationShardWallSpreadBudgetMs,
  } = {},
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
  const summaries = integrationShardSummaries(manifestFiles, weightOverrides);
  for (const summary of summaries) {
    if (summary.estimatedMs > shardBudgetMs)
      errors.push(
        `integration shard ${summary.id} is over budget: ${summary.estimatedMs}ms of declared file weight > ${shardBudgetMs}ms; make the slowest files cheaper or add a shard (integrationShardCount, workflow matrix and required contexts)`,
      );
  }
  const estimatedWalls = summaries.map((summary) => summary.estimatedWallMs);
  const estimatedWallSpreadMs = Math.max(...estimatedWalls) - Math.min(...estimatedWalls);
  if (estimatedWallSpreadMs > wallSpreadBudgetMs) {
    errors.push(
      `integration shard estimated wall spread is ${estimatedWallSpreadMs}ms > ${wallSpreadBudgetMs}ms: ${summaries.map((summary) => `${summary.id}=${summary.estimatedWallMs}ms`).join(", ")}; return the heavy files first and keep the lane assignment balanced`,
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

import { availableParallelism } from "node:os";

import {
  DEFAULT_CORES_PER_TEST_PROCESS,
  resolveLocalCoreBudget
} from "./local-resource-governance.mjs";

export const SHARD_PARALLELISM_ENV = "HARNESS_SHARD_PARALLELISM";

// 并行度 = 可用核心预算 ÷ (每 shard 并发 × 每个测试文件实测占用的核心数)，不看 loadavg。
// loadavg 分不清负载是用户的还是我们自己的，一旦把自己的负载算进去就会自我节流
// (实测 requested 5 掉到 3)；动态让路交给 QoS(taskpolicy -c utility)，静态预算只封顶。
// 系数来自实测而非估算，理由见 DEFAULT_CORES_PER_TEST_PROCESS：把 fan-out 从 3 拉到 6
// 只买到 1% 墙钟却多花 70% 机器时间，说明超过预算继续加并行是纯负和。
export function resolveShardParallelism({
  raw = process.env[SHARD_PARALLELISM_ENV],
  shardCount,
  localSlots,
  perShardConcurrency,
  cpuCount = availableParallelism(),
  reservationRaw
}) {
  assertPositiveInteger(shardCount, "shard count");
  assertPositiveInteger(localSlots, "local slot count");
  assertPositiveInteger(perShardConcurrency, "per-shard concurrency");
  assertPositiveInteger(cpuCount, "CPU count");

  const budget = resolveLocalCoreBudget({
    cpuCount,
    ...(reservationRaw === undefined ? {} : { raw: reservationRaw })
  });
  const coresPerShard = perShardConcurrency * DEFAULT_CORES_PER_TEST_PROCESS;
  const coreCap = Math.max(1, Math.floor(budget.usableCores / coresPerShard));
  const explicit = parseExplicitParallelism(raw);
  const requested = explicit ?? coreCap;
  const parallelism = Math.min(requested, shardCount, localSlots, coreCap);

  return {
    parallelism,
    source: explicit === null ? "core-budget" : "explicit",
    requested,
    usableCores: budget.usableCores,
    reservedCores: budget.reserved,
    coreCap,
    localSlots,
    perShardConcurrency
  };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  assertPositiveInteger(concurrency, "shard parallelism");
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext()
  ));
  return results;
}

function parseExplicitParallelism(raw) {
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${SHARD_PARALLELISM_ENV} must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

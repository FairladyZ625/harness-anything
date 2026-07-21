import { availableParallelism, loadavg } from "node:os";

export const SHARD_PARALLELISM_ENV = "HARNESS_SHARD_PARALLELISM";

export function resolveShardParallelism({
  raw = process.env[SHARD_PARALLELISM_ENV],
  shardCount,
  localSlots,
  perShardConcurrency,
  cpuCount = availableParallelism(),
  loadOne = loadavg()[0]
}) {
  assertPositiveInteger(shardCount, "shard count");
  assertPositiveInteger(localSlots, "local slot count");
  assertPositiveInteger(perShardConcurrency, "per-shard concurrency");
  assertPositiveInteger(cpuCount, "CPU count");

  const normalizedLoad = Number.isFinite(loadOne) && loadOne >= 0 ? loadOne : cpuCount;
  const freeCores = Math.max(1, Math.floor(cpuCount - normalizedLoad));
  const adaptive = Math.max(1, Math.floor(freeCores / perShardConcurrency));
  const explicit = parseExplicitParallelism(raw);
  const requested = explicit ?? adaptive;
  const cpuCap = Math.max(1, Math.floor(cpuCount / perShardConcurrency));
  const parallelism = Math.min(requested, shardCount, localSlots, cpuCap);

  return {
    parallelism,
    source: explicit === null ? "adaptive" : "explicit",
    requested,
    freeCores,
    cpuCap,
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

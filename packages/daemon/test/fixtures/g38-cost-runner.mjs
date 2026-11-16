import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTemporaryDirectory } from "../../../../tools/temporary-directory-cleanup.mjs";

const WORKER_SPEC_ENV = "G38_WORKER_SLICE";
const WORKER_OUT_ENV = "G38_WORKER_OUTPUT";

function resolveCollectionModuleHref(rootDir) {
  const candidate = path.join(rootDir, "packages/daemon/test/fixtures/g38-collection-cost.mjs");
  return existsSync(candidate)
    ? pathToFileURL(candidate).href
    : new URL("./g38-collection-cost.mjs", import.meta.url).href;
}

function resolveG1ModuleHref(rootDir) {
  return pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g1-write-cost-scaling.ts")).href;
}

function resolveWorkerSlots(rawSlots = process.env.G38_WORKERS) {
  if (rawSlots !== undefined) {
    const parsed = Number(rawSlots);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new Error(`G38_WORKERS must be a positive integer: ${rawSlots}`);
    return parsed;
  }
  return Math.max(2, Math.min(4, availableParallelism()));
}

async function runWorkerSlice(rootDir, rawSpec, outputPath) {
  if (!outputPath) throw new Error("worker output path is required");
  const slice = JSON.parse(rawSpec);
  let value;
  if (slice.kind === "g1-scale") {
    const { measureWriteCostScaling } = await import(resolveG1ModuleHref(rootDir));
    value = await measureWriteCostScaling(slice.scaleValue);
  } else if (slice.kind === "collection-scale") {
    const { COLLECTION_PROBES, COLLECTION_SCALES } = await import(resolveCollectionModuleHref(rootDir));
    const probe = COLLECTION_PROBES[slice.probeId];
    if (!probe) throw new Error(`unknown collection probe slice: ${slice.probeId}`);
    value = await probe.run(rootDir, COLLECTION_SCALES[slice.scaleKey]);
  } else if (slice.kind === "collection-batch") {
    const { COLLECTION_PROBES, COLLECTION_SCALES } = await import(resolveCollectionModuleHref(rootDir));
    const entries = {};
    for (const id of slice.probeIds) {
      const probe = COLLECTION_PROBES[id];
      if (!probe) throw new Error(`unknown collection probe slice: ${id}`);
      entries[id] = {
        small: await probe.run(rootDir, COLLECTION_SCALES.small),
        large: await probe.run(rootDir, COLLECTION_SCALES.large),
        ...(probe.growth ? { growth: probe.growth } : {}),
      };
    }
    value = entries;
  } else {
    throw new Error(`unknown worker slice kind: ${slice.kind}`);
  }
  writeFileSync(outputPath, JSON.stringify(value), "utf8");
}

function runChildSlice(scriptPath, rootDir, slice, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, rootDir], {
      env: {
        ...process.env,
        [WORKER_SPEC_ENV]: JSON.stringify(slice),
        [WORKER_OUT_ENV]: outputPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(`cost-budget worker ${slice.kind} exited with ${code ?? signal}${detail ? `: ${detail}` : ""}`),
        );
        return;
      }
      if (!existsSync(outputPath)) {
        reject(new Error(`cost-budget worker ${slice.kind} did not produce output at ${outputPath}`));
        return;
      }
      resolve(JSON.parse(readFileSync(outputPath, "utf8")));
    });
  });
}

export async function measureCostSuitesParallel({
  rootDir,
  workerSlots = resolveWorkerSlots(),
  scales = { small: 200, large: 2000 },
  scriptPath = fileURLToPath(import.meta.url),
} = {}) {
  if (!Number.isSafeInteger(workerSlots) || workerSlots < 1)
    throw new Error(`workerSlots must be a positive integer: ${workerSlots}`);
  const [{ COLLECTION_PROBES }, { G1_METRICS }] = await Promise.all([
    import(resolveCollectionModuleHref(rootDir)),
    import(resolveG1ModuleHref(rootDir)),
  ]);
  const probeIds = Object.keys(COLLECTION_PROBES);
  const splitWorkTasks = probeIds.includes("task-create:work-tasks");
  const remainingIds = splitWorkTasks ? probeIds.filter((id) => id !== "task-create:work-tasks") : probeIds;
  const units = [
    ...(splitWorkTasks
      ? [
          {
            slot: "work-tasks-large",
            slice: { kind: "collection-scale", probeId: "task-create:work-tasks", scaleKey: "large" },
          },
          {
            slot: "work-tasks-small",
            slice: { kind: "collection-scale", probeId: "task-create:work-tasks", scaleKey: "small" },
          },
        ]
      : []),
    { slot: "g1-large", slice: { kind: "g1-scale", scaleKey: "large", scaleValue: scales.large } },
    { slot: "g1-small", slice: { kind: "g1-scale", scaleKey: "small", scaleValue: scales.small } },
    ...(remainingIds.length > 0
      ? [{ slot: "collection-batch", slice: { kind: "collection-batch", probeIds: remainingIds } }]
      : []),
  ];
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ha-g38-workers-"));
  try {
    let nextIndex = 0;
    const outcomes = new Map();
    const laneCount = Math.min(workerSlots, units.length);
    const runLaneWorker = async () => {
      while (nextIndex < units.length) {
        const index = nextIndex;
        nextIndex += 1;
        const unit = units[index];
        const outputPath = path.join(scratchDir, `${index}-${unit.slot}.json`);
        outcomes.set(unit.slot, await runChildSlice(scriptPath, rootDir, unit.slice, outputPath));
      }
    };
    await Promise.all(Array.from({ length: laneCount }, () => runLaneWorker()));
    const g1Small = outcomes.get("g1-small");
    const g1Large = outcomes.get("g1-large");
    const operations = Object.keys(g1Small?.counts ?? {});
    if (
      operations.sort().join() !==
      Object.keys(g1Large?.counts ?? {})
        .sort()
        .join()
    )
      throw new Error("G1 scales must measure exactly the same operations");
    const batchMeasured = outcomes.get("collection-batch") ?? {};
    const collectionMeasured = {};
    for (const id of probeIds) {
      if (id === "task-create:work-tasks") {
        const probe = COLLECTION_PROBES[id];
        collectionMeasured[id] = {
          small: outcomes.get("work-tasks-small"),
          large: outcomes.get("work-tasks-large"),
          ...(probe.growth ? { growth: probe.growth } : {}),
        };
      } else {
        if (!batchMeasured[id]) throw new Error(`missing collection measurement for ${id}`);
        collectionMeasured[id] = batchMeasured[id];
      }
    }
    return {
      g1Measured: { small: g1Small, large: g1Large, operations, metrics: G1_METRICS },
      collectionMeasured,
    };
  } finally {
    removeTemporaryDirectory(scratchDir);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env[WORKER_SPEC_ENV]) {
  await runWorkerSlice(process.argv[2], process.env[WORKER_SPEC_ENV], process.env[WORKER_OUT_ENV]);
}

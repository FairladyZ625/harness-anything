// G38's read shards and their complete-matrix join share the existing gate entrypoint.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  READ_BACKENDS,
  READ_DIMENSIONS,
  evaluateReadCostScaling,
  evaluateReadMeasurements,
  readInventory,
  validateReadCoverage,
} from "./cost-budget-reads.mjs";

export function combineReadShards(shards) {
  const measured = {};
  for (const shard of shards) {
    if (shard.schema !== "g38-read-shard/v1") throw new Error("invalid G38 read shard");
    for (const [backend, dimensions] of Object.entries(shard.measured)) {
      if (!READ_BACKENDS.includes(backend)) throw new Error(`unknown G38 backend ${backend}`);
      measured[backend] ??= {};
      for (const [dimension, probes] of Object.entries(dimensions)) {
        if (!READ_DIMENSIONS.includes(dimension)) throw new Error(`unknown G38 dimension ${dimension}`);
        if (measured[backend][dimension]) throw new Error(`duplicate G38 shard ${backend}/${dimension}`);
        measured[backend][dimension] = probes;
      }
    }
  }
  for (const backend of READ_BACKENDS)
    for (const dimension of READ_DIMENSIONS)
      if (!measured[backend]?.[dimension]) throw new Error(`missing G38 shard ${backend}/${dimension}`);
  return measured;
}

export async function runReadLane({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  phase = "read",
  backend,
  dimension,
  resultsDir,
  output,
}) {
  const started = performance.now();
  const section = JSON.parse(readFileSync(budgetPath, "utf8")).readCostScaling;
  const { READ_PROBES } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs")).href
  );
  const inventory = await readInventory(rootDir);
  validateReadCoverage(section, inventory, READ_PROBES);
  let result;
  if (phase === "read-summary") {
    if (!resultsDir) throw new Error("read-summary requires --results");
    const shards = readdirSync(resultsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")));
    result = evaluateReadMeasurements({ section, inventory, probes: READ_PROBES, measured: combineReadShards(shards) });
  } else {
    if (backend && !READ_BACKENDS.includes(backend)) throw new Error("invalid G38 read backend");
    const dimensions = dimension ? dimension.split(",") : READ_DIMENSIONS;
    if (
      !dimensions.length ||
      dimensions.some((value) => !READ_DIMENSIONS.includes(value)) ||
      new Set(dimensions).size !== dimensions.length
    )
      throw new Error("invalid G38 read dimension");
    if ((!backend || backend === "pglite") && Number(process.versions.node.split(".")[0]) < 26)
      throw new Error("G38 PGlite requires Node 26; a skipped backend is not a pass");
    result = await evaluateReadCostScaling({
      rootDir,
      budgetPath,
      backends: backend ? [backend] : READ_BACKENDS,
      dimensions,
    });
  }
  const report = {
    schema: "g38-read-shard/v1",
    ...result,
    durationMs: performance.now() - started,
    node: process.versions.node,
  };
  if (output) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      schema: report.schema,
      ok: report.ok,
      durationMs: report.durationMs,
      node: report.node,
      errors: result.errors.length,
    }),
  );
  for (const error of result.errors) console.error(`G38 read-cost: ${error}`);
  console.log(`G38 read-cost: ${result.ok ? "pass" : "FAIL"} (${report.durationMs.toFixed(1)}ms)`);
  return result.ok ? 0 : 1;
}

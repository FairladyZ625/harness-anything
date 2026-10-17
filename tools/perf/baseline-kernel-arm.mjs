// Kernel arm: the scale curve. Runs tools/scale/b5-real.mjs per requested entity count (each run
// synthesizes a canonical ledger with the real compilers, cold-catches-up the real task projection,
// then samples the real daemon read model), and folds the per-size reports into one curve table:
// projection rebuild (catchUpMs) and read p50/p95 (taskList / factSearch / relationGraph / the
// single-task narrow read) against ledger size.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runSubprocess } from "./baseline-cli-arm.mjs";

export const DEFAULT_KERNEL_SIZES = [1_000, 10_000];

export async function runKernelArm({ rootDir, outDir, sizes = DEFAULT_KERNEL_SIZES, seed = 20261018, log }) {
  const runs = [];
  for (const entities of sizes) {
    const label = `perf-${entities}`;
    const jsonOut = path.join(outDir, `kernel-b5-${entities}.json`);
    log(`[kernel] entities=${entities} (ledger build + cold catch-up + read sampling)`);
    await runSubprocess(
      log,
      [
        process.execPath,
        path.join(rootDir, "tools/scale/b5-real.mjs"),
        "--entities",
        String(entities),
        "--seed",
        String(seed),
        "--label",
        label,
        "--json-out",
        jsonOut,
      ],
      [],
      rootDir,
    );
    if (!existsSync(jsonOut)) throw new Error(`b5-real did not write ${jsonOut}`);
    const report = JSON.parse(readFileSync(jsonOut, "utf8"));
    runs.push({
      entities,
      events: report.ledger.events,
      tasks: report.ledger.tasks,
      ledgerBuildMs: report.ledger.buildMs,
      catchUpMs: report.ledger.catchUpMs,
      reads: report.measurements,
    });
  }
  runs.sort((left, right) => left.entities - right.entities);
  return { schema: "perf-baseline-kernel-arm/v1", measuredAt: new Date().toISOString(), seed, runs };
}

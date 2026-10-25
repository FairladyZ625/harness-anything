// Kernel arm: canonical-volume event scale and orthogonal task/event controls.
// Each point uses the real event compilers, cold projection catch-up, and read model.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runSubprocess } from "./baseline-cli-arm.mjs";

export const DEFAULT_KERNEL_SIZES = [217_107, 1_000_000, 5_000_000];
const CANONICAL_EVENTS = 217_107;
const CANONICAL_TASKS = 4_469;
const CANONICAL_DECISIONS = 1_022;
const EVENT_CONTROL_SIZES = [100_000, 500_000, 1_000_000];
const TASK_CONTROL_SIZES = [1_000, 2_500, CANONICAL_TASKS];

export async function runKernelArm({ rootDir, outDir, sizes = DEFAULT_KERNEL_SIZES, seed = 20261018, log }) {
  const runPoint = async (events, tasks, label, decisions = null) => {
    const jsonOut = path.join(outDir, `kernel-b5-${label}.json`);
    log(`[kernel] events=${events} tasks=${tasks} fixture=${label}`);
    await runSubprocess(
      log,
      [
        process.execPath,
        path.join(rootDir, "tools/scale/b5-real.mjs"),
        "--events",
        String(events),
        "--tasks",
        String(tasks),
        ...(decisions === null ? [] : ["--decisions", String(decisions)]),
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
    return {
      label,
      events: report.ledger.events,
      tasks: report.ledger.tasks,
      decisions: report.ledger.decisions,
      baseEvents: report.ledger.baseEvents,
      fillerEvents: report.ledger.fillerEvents,
      ledgerBuildMs: report.ledger.ledgerBuildMs,
      catchUpMs: report.ledger.catchUpMs,
      fixtureDirectoryBytes: report.ledger.fixtureDirectoryBytes,
      processMaxRssBytes: report.ledger.processMaxRssBytes,
      reads: report.measurements,
    };
  };

  const runs = [];
  for (const events of sizes) {
    const tasks = Math.max(1, Math.round((events * CANONICAL_TASKS) / CANONICAL_EVENTS));
    runs.push(await runPoint(events, tasks, `${events}-canonical-ratio`));
  }
  const eventControl = [];
  for (const events of EVENT_CONTROL_SIZES)
    eventControl.push(
      await runPoint(events, CANONICAL_TASKS, `${events}-fixed-${CANONICAL_TASKS}-tasks`, CANONICAL_DECISIONS),
    );
  const taskControl = [];
  for (const tasks of TASK_CONTROL_SIZES)
    taskControl.push(await runPoint(CANONICAL_EVENTS, tasks, `${CANONICAL_EVENTS}-fixed-${tasks}-tasks`));

  const fit = (rows, x, y) => {
    const points = rows.filter((row) => Number.isFinite(row[x]) && Number.isFinite(row[y]));
    if (points.length < 3) return { points: points.length, slopePerUnit: null, intercept: null };
    const meanX = points.reduce((sum, row) => sum + row[x], 0) / points.length;
    const meanY = points.reduce((sum, row) => sum + row[y], 0) / points.length;
    const numerator = points.reduce((sum, row) => sum + (row[x] - meanX) * (row[y] - meanY), 0);
    const denominator = points.reduce((sum, row) => sum + (row[x] - meanX) ** 2, 0);
    const slopePerUnit = denominator ? numerator / denominator : null;
    return {
      points: points.length,
      slopePerUnit,
      intercept: slopePerUnit === null ? null : meanY - slopePerUnit * meanX,
    };
  };
  const metricValue = (run, metric) =>
    metric === "catchUpMs" || metric === "ledgerBuildMs" ? run[metric] : (run.reads[metric]?.p95Ms ?? null);
  const metricSlopes = {};
  const controlledSlopes = {};
  for (const metric of ["catchUpMs", "ledgerBuildMs", "taskList", "singleTaskRead", "factSearch", "relationGraph"]) {
    metricSlopes[metric] = fit(
      runs.map((run) => ({ events: run.events, value: metricValue(run, metric) })),
      "events",
      "value",
    );
    controlledSlopes[metric] = {
      eventsAtFixedTasks: fit(
        eventControl.map((run) => ({ events: run.events, value: metricValue(run, metric) })),
        "events",
        "value",
      ),
      tasksAtFixedEvents: fit(
        taskControl.map((run) => ({ events: run.tasks, value: metricValue(run, metric) })),
        "events",
        "value",
      ),
    };
  }
  return {
    schema: "perf-baseline-kernel-arm/v1",
    measuredAt: new Date().toISOString(),
    seed,
    entityRatios: {
      tasksPerEvent: CANONICAL_TASKS / CANONICAL_EVENTS,
      decisionsPerEvent: CANONICAL_DECISIONS / CANONICAL_EVENTS,
      decisionCountAtEachScale: "rounded from the measured canonical event ratio",
      factCountAtEachScale: "estimated at 0.45 per task; canonical fact count unavailable",
    },
    metricSlopes,
    controlledSlopes,
    controls: { eventControl, taskControl },
    runs,
  };
}

// Read-side half of G38 (dec_72FADB86879F5EBF366F46F162/CH3). The protocol registry
// owns the inventory; this module owns coverage and the same absolute-delta rule as G1.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const READ_SCALES = Object.freeze({ small: 200, large: 2000 });
export const READ_BACKENDS = Object.freeze(["sqlite", "pglite"]);
export const READ_DIMENSIONS = Object.freeze([
  "runtime-sessions",
  "dispatches",
  "task-outputs",
  "relations",
  "event-bytes",
]);
// Protocol methods are enumerated below. These non-RPC entry points were traced from
// repo-cell-open, daemon-host-open/recovery, squad-coordinator and schedule-scheduler.
// Keep coverage at their actual readers, so startup and timer work cannot hide behind
// a measured GUI endpoint that happens to call a different projection query.
export const BACKGROUND_READ_PATHS = Object.freeze([
  "startup-adopt",
  "startup-temp-sweep",
  "squad-recovery",
  "schedule-poll",
  "in-flight-work",
  "node-auto-claim-assignments",
  "archive-retention-inputs",
  "projection-recovery",
  "host-reattach",
  "archive-maintenance",
  "squad-reconcile",
  "worktree-reconcile",
]);
// G1's observed flat-operation noise applies to host-side reads too: no scale-dependent
// rows, at most 2 incidental hashes / 512 hashed bytes, 1 Git process, 128 file bytes.
// sqlResultBytes also catches a single row carrying an entire collection/event body: ids
// have fixed width in these fixtures, so a flat point/page read has zero byte drift.
export const READ_MARGINS = Object.freeze({
  sqlRowsRead: 20,
  sqlResultBytes: 512,
  sha256Calls: 2,
  sha256Bytes: 512,
  gitProcesses: 1,
  fileReadBytes: 128,
  // Target package contents are fixed: 2 allows incidental metadata entries while a walk
  // over the historical output directory grows by 1800 entries and cannot pass.
  directoryEntries: 2,
});

export async function readInventory(rootDir) {
  const { daemonProtocolCommands, allDaemonProtocolMethods } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/src/protocol/daemon-protocol-commands.ts")).href
  );
  return [
    ...deriveReadInventory({ daemonProtocolCommands, allDaemonProtocolMethods }),
    ...BACKGROUND_READ_PATHS.map((name) => ({ id: `background:${name}`, method: null })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function deriveReadInventory({ daemonProtocolCommands, allDaemonProtocolMethods }) {
  const commands = daemonProtocolCommands.filter((entry) => entry.commandClass === "repo-read"),
    readMethods = new Set(commands.map((entry) => entry.method));
  return [
    ...commands.map((entry) => ({ id: `command:${entry.id}`, method: entry.method })),
    ...allDaemonProtocolMethods
      .filter((entry) => entry.commandClass === "repo-read" || entry.repositoryRead || readMethods.has(entry.method))
      .map((entry) => ({ id: `method:${entry.method}`, method: entry.method })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

const required = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value) => typeof value === "string" && value.trim().length > 0;

export function validateReadCoverage(section, inventory, probes) {
  required(section?.schema === "read-cost-scaling-budget/v1", "readCostScaling must use read-cost-scaling-budget/v1");
  const coverage = section.readCoverage;
  required(coverage?.measured && !Array.isArray(coverage.measured), "readCoverage.measured must be an object");
  required(Array.isArray(coverage.notApplicable), "readCoverage.notApplicable must be an array");
  const ids = new Set(inventory.map(({ id }) => id)),
    declared = new Set();
  for (const [id, { measurements }] of Object.entries(coverage.measured)) {
    required(ids.has(id), `readCoverage has unknown read ${id}`);
    required(Array.isArray(measurements) && measurements.length > 0, `${id} requires measurements`);
    for (const probe of measurements) {
      required(probes[probe]?.reads.includes(id), `${id} has no matching production measurement ${probe}`);
    }
    declared.add(id);
  }
  for (const entry of coverage.notApplicable) {
    required(text(entry.reason), "readCoverage.notApplicable reason is required");
    required(Array.isArray(entry.reads) && entry.reads.length > 0, "notApplicable requires reads");
    for (const id of entry.reads) {
      required(ids.has(id), `readCoverage has unknown read ${id}`);
      required(!declared.has(id), `readCoverage duplicates read ${id}`);
      declared.add(id);
    }
  }
  const missing = [...ids].filter((id) => !declared.has(id));
  required(missing.length === 0, `readCoverage is missing reads: ${missing.join(", ")}`);
  const used = new Set(Object.values(coverage.measured).flatMap(({ measurements }) => measurements));
  for (const id of Object.keys(probes)) required(used.has(id), `read probe ${id} is not registered in readCoverage`);
  return [...used].sort();
}

export function evaluateReadMeasurements({
  section,
  inventory,
  probes,
  measured,
  dimensions = READ_DIMENSIONS,
  now = new Date(),
}) {
  required(
    dimensions.length > 0 && dimensions.every((dimension) => READ_DIMENSIONS.includes(dimension)),
    "invalid read dimensions",
  );
  const selected = validateReadCoverage(section, inventory, probes),
    errors = [],
    exemptions = section.knownScaling;
  required(Array.isArray(exemptions), "readCostScaling.knownScaling must be an array");
  const exemptionKeys = new Set();
  for (const entry of exemptions) {
    required(selected.includes(entry.probe), `knownScaling has unknown probe ${entry.probe}`);
    required(READ_BACKENDS.includes(entry.backend), "knownScaling requires an exact backend");
    required(READ_DIMENSIONS.includes(entry.dimension), "knownScaling requires an exact dimension");
    required(Object.hasOwn(READ_MARGINS, entry.metric), "knownScaling requires a known metric");
    required(text(entry.reason), "knownScaling reason is required");
    required(/^task_[A-Za-z0-9]+$/u.test(entry.deletionTaskId), "knownScaling deletionTaskId is required");
    required(text(entry.expiresAt) && !Number.isNaN(Date.parse(entry.expiresAt)), "knownScaling expiresAt is required");
    const key = [entry.probe, entry.backend, entry.dimension, entry.metric].join("/");
    required(!exemptionKeys.has(key), `duplicate knownScaling ${key}`);
    exemptionKeys.add(key);
    if (Date.parse(entry.expiresAt) <= now.getTime())
      errors.push(`${key}: knownScaling exemption expired (${entry.expiresAt})`);
  }
  const usedExemptions = new Set();
  for (const id of selected)
    for (const backend of READ_BACKENDS)
      for (const dimension of dimensions) {
        const pair = measured[backend]?.[dimension]?.[id];
        required(pair, `missing read measurement ${backend}/${dimension}/${id}`);
        required(
          pair.small.size === READ_SCALES.small && pair.large.size === READ_SCALES.large,
          "read measurements must use the committed 10x scales",
        );
        required(
          pair.small.resultSize === pair.large.resultSize,
          `${backend}/${dimension}/${id}: result size k changed (${pair.small.resultSize} -> ${pair.large.resultSize})`,
        );
        required(
          pair.small.firstResultSize === pair.small.resultSize && pair.large.firstResultSize === pair.large.resultSize,
          `${backend}/${dimension}/${id}: cold result size k changed`,
        );
        for (const phase of ["counts", "firstCall"])
          for (const [metric, margin] of Object.entries(READ_MARGINS)) {
            const small = pair.small[phase]?.[metric],
              large = pair.large[phase]?.[metric],
              key = [id, backend, dimension, metric].join("/");
            required(
              Number.isSafeInteger(small) && small >= 0 && Number.isSafeInteger(large) && large >= 0,
              `invalid read measurement ${key} (${phase})`,
            );
            if (large <= small + margin) continue;
            if (exemptionKeys.has(key)) usedExemptions.add(key);
            else
              errors.push(
                `${key} (${phase}): ${small} at ${READ_SCALES.small} grew to ${large} at ${READ_SCALES.large}, fixed margin ${margin}; no knownScaling exemption`,
              );
          }
      }
  for (const entry of exemptions) {
    const key = [entry.probe, entry.backend, entry.dimension, entry.metric].join("/");
    if (dimensions.includes(entry.dimension) && !usedExemptions.has(key))
      errors.push(`${key}: knownScaling exemption is stale; remove it`);
  }
  return { ok: errors.length === 0, errors, measured, inventory, knownScaling: exemptions };
}

export async function measureReadCosts(rootDir, { dimensions = READ_DIMENSIONS, probeIds } = {}) {
  const { measureReadScale, READ_PROBES } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs")).href
  );
  const selected = probeIds ?? Object.keys(READ_PROBES),
    measured = {},
    started = performance.now();
  for (const backend of READ_BACKENDS) {
    measured[backend] = {};
    for (const dimension of dimensions) {
      const small = await measureReadScale(backend, dimension, READ_SCALES.small, { probeIds: selected }),
        large = await measureReadScale(backend, dimension, READ_SCALES.large, { probeIds: selected });
      measured[backend][dimension] = Object.fromEntries(
        selected.map((id) => [id, { small: small[id], large: large[id] }]),
      );
    }
  }
  return { measured, durationMs: performance.now() - started };
}

export async function evaluateReadCostScaling({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  dimensions = READ_DIMENSIONS,
  now = new Date(),
} = {}) {
  const section = JSON.parse(readFileSync(budgetPath, "utf8")).readCostScaling,
    { READ_PROBES } = await import(
      pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs")).href
    ),
    inventory = await readInventory(rootDir),
    probeIds = validateReadCoverage(section, inventory, READ_PROBES),
    { measured, durationMs } = await measureReadCosts(rootDir, { dimensions, probeIds });
  return {
    ...evaluateReadMeasurements({ section, inventory, probes: READ_PROBES, measured, dimensions, now }),
    durationMs,
  };
}

// Read-side half of G38 (dec_72FADB86879F5EBF366F46F162/CH3). The protocol registry
// owns the inventory; this module owns coverage and the same absolute-delta rule as G1.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const READ_SCALES = Object.freeze({ small: 200, large: 2000 });
export const READ_OUTPUT_SCALES = Object.freeze({ small: 3400, large: 34000 });
export const READ_VISIBILITY_SCALES = Object.freeze({ small: 200, large: 2000 });
export const readScalesFor = (dimension) =>
  dimension === "task-outputs"
    ? READ_OUTPUT_SCALES
    : dimension === "relation-visibility"
      ? READ_VISIBILITY_SCALES
      : READ_SCALES;
// CEO 2026-11-05: known scans may use declared smaller 10x pairs in the required
// lane. Removing the last exemption restores the full scales automatically.
export function readScalesForProbe(section, id, backend, dimension) {
  const full = readScalesFor(dimension),
    entries = section.knownScaling.filter(
      (entry) => entry.probe === id && entry.backend === backend && entry.dimension === dimension,
    ),
    bounded = entries.filter((entry) => entry.measurementScales);
  if (!bounded.length) return full;
  const scales = bounded[0].measurementScales;
  required(
    dimension !== "source-events" &&
      Number.isSafeInteger(scales.small) &&
      scales.small > 0 &&
      scales.large === scales.small * 10 &&
      scales.small < full.small &&
      bounded.length === entries.length &&
      bounded.every(
        (entry) => entry.measurementScales.small === scales.small && entry.measurementScales.large === scales.large,
      ),
    `${id}/${backend}/${dimension}: inconsistent or invalid knownScaling measurementScales`,
  );
  return scales;
}
export const READ_BACKENDS = Object.freeze(["sqlite", "pglite"]);
export const READ_DIMENSIONS = Object.freeze([
  "task-history",
  "runtime-sessions",
  "dispatches",
  "task-outputs",
  "relations",
  "relation-visibility",
  "event-bytes",
  "source-events",
]);
export function readProbeAppliesTo(probe, backend, dimension) {
  if (probe.sourceAudit ? dimension !== "source-events" : dimension === "source-events") return false;
  if (probe.dimensions && !probe.dimensions.includes(dimension)) return false;
  if (probe.backends && !probe.backends.includes(backend)) return false;
  return true;
}
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
  // An indexed point lookup executes a fixed program. 128 covers bookkeeping and
  // bounded plan changes; even a 200→2000 one-row COUNT adds thousands of VM steps.
  sqliteVmSteps: 128,
  // OP_Count may walk a B-tree inside one VM instruction. Cache hits + misses
  // observe those visits even with a warm cache; 8 allows incidental point-page work.
  sqliteScanPages: 8,
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
  const { daemonRpcRoutingDeclarations } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/src/rpc-command-routing.ts")).href
  );
  return [
    ...deriveReadInventory({
      daemonProtocolCommands,
      allDaemonProtocolMethods,
      routes: daemonRpcRoutingDeclarations(),
    }),
    ...BACKGROUND_READ_PATHS.map((name) => ({ id: `background:${name}`, method: null })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function deriveReadInventory({ daemonProtocolCommands, allDaemonProtocolMethods, routes = [] }) {
  const commands = daemonProtocolCommands.filter((entry) => entry.commandClass === "repo-read"),
    readMethods = new Set([
      ...commands.map((entry) => entry.method),
      ...routes.filter((entry) => entry.topology.commandClass === "repo-read").map((entry) => entry.method),
    ]);
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
  backends = READ_BACKENDS,
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
    for (const backend of backends)
      for (const dimension of dimensions.filter((value) => readProbeAppliesTo(probes[id], backend, value))) {
        const pair = measured[backend]?.[dimension]?.[id],
          scales = readScalesForProbe(section, id, backend, dimension);
        required(pair, `missing read measurement ${backend}/${dimension}/${id}`);
        required(
          pair.small.size === scales.small && pair.large.size === scales.large,
          "read measurements must use the committed 10x scales (including exact knownScaling bounds)",
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
            if (probes[id].sourceAudit) {
              const smallInput = pair.small.inputSize,
                largeInput = pair.large.inputSize,
                ceiling = probes[id].sourceAudit.maxPerInput[metric];
              required(
                smallInput === READ_SCALES.small && largeInput === READ_SCALES.large,
                `${key}: audit input k must use the committed scales`,
              );
              required(Number.isFinite(ceiling) && ceiling > 0, `${key}: audit requires a per-input cost ceiling`);
              // Same 10% constant-term tolerance as G38's existing collection rule.
              // An audit may visit its explicit inputs once; quadratic revisits must fail.
              if (large > small * (largeInput / smallInput) * 1.1 || large > largeInput * ceiling)
                errors.push(
                  `${key} (${phase}): source audit ${small}/${smallInput} -> ${large}/${largeInput} exceeds linear slope or ${ceiling} per-input ceiling`,
                );
              continue;
            }
            if (large <= small + margin) continue;
            if (exemptionKeys.has(key)) usedExemptions.add(key);
            else
              errors.push(
                `${key} (${phase}): ${small} at ${scales.small} grew to ${large} at ${scales.large}, fixed margin ${margin}; no knownScaling exemption`,
              );
          }
      }
  for (const entry of exemptions) {
    const key = [entry.probe, entry.backend, entry.dimension, entry.metric].join("/");
    if (
      backends.includes(entry.backend) &&
      dimensions.includes(entry.dimension) &&
      readProbeAppliesTo(probes[entry.probe], entry.backend, entry.dimension) &&
      !usedExemptions.has(key)
    )
      errors.push(`${key}: knownScaling exemption is stale; remove it`);
  }
  return { ok: errors.length === 0, errors, measured, inventory, knownScaling: exemptions };
}

export async function measureReadCosts(
  rootDir,
  { dimensions = READ_DIMENSIONS, backends = READ_BACKENDS, probeIds, section = { knownScaling: [] } } = {},
) {
  const { measureReadScale, READ_PROBES } = await import(
    pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs")).href
  );
  const selected = probeIds ?? Object.keys(READ_PROBES),
    measured = {},
    started = performance.now();
  for (const backend of backends) {
    measured[backend] = {};
    for (const dimension of dimensions) {
      const dimensionProbes = selected.filter((id) => readProbeAppliesTo(READ_PROBES[id], backend, dimension));
      const groups = new Map();
      for (const id of dimensionProbes) {
        const scales = readScalesForProbe(section, id, backend, dimension),
          key = JSON.stringify(scales);
        if (!groups.has(key)) groups.set(key, { scales, ids: [] });
        groups.get(key).ids.push(id);
      }
      measured[backend][dimension] = {};
      for (const { scales, ids } of groups.values()) {
        const small = await measureReadScale(backend, dimension, scales.small, { probeIds: ids }),
          large = await measureReadScale(backend, dimension, scales.large, { probeIds: ids });
        for (const id of ids) measured[backend][dimension][id] = { small: small[id], large: large[id] };
        console.log(JSON.stringify({ g38ScaleGroup: { backend, dimension, scales, probes: ids } }));
      }
      for (const [id, pair] of Object.entries(measured[backend][dimension]))
        console.log(JSON.stringify({ g38Measurement: { backend, dimension, id, pair } }));
    }
  }
  return { measured, durationMs: performance.now() - started };
}

export async function evaluateReadCostScaling({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  dimensions = READ_DIMENSIONS,
  backends = READ_BACKENDS,
  now = new Date(),
} = {}) {
  const section = JSON.parse(readFileSync(budgetPath, "utf8")).readCostScaling,
    { READ_PROBES } = await import(
      pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs")).href
    ),
    inventory = await readInventory(rootDir),
    probeIds = validateReadCoverage(section, inventory, READ_PROBES),
    { measured, durationMs } = await measureReadCosts(rootDir, { dimensions, backends, probeIds, section });
  return {
    ...evaluateReadMeasurements({ section, inventory, probes: READ_PROBES, measured, dimensions, backends, now }),
    durationMs,
  };
}

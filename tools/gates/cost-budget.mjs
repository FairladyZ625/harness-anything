#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { COLLECTION_PROBES, measureCollectionCosts } from "../../packages/daemon/test/fixtures/g38-collection-cost.mjs";
import { repoRoot } from "./git.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";
import { runReadLane } from "./cost-budget-read-lane.mjs";
import { removeTemporaryDirectory } from "../temporary-directory-cleanup.mjs";

const METRICS = Object.freeze(["projectionRebuildGitProcesses"]);

function parseJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

export const G1_OPERATION_NAMES = Object.freeze(
  Object.keys(parseJsonFile(new URL("./cost-budget.json", import.meta.url)).writeCostScaling.baseline),
);

function validateMetricMap(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== [...METRICS].sort().join("\0"))
    throw new Error(`${label} keys must be ${METRICS.join(", ")}`);
  for (const metric of METRICS) {
    if (!Number.isSafeInteger(value[metric]) || value[metric] < 0)
      throw new Error(`${label}.${metric} must be a non-negative safe integer`);
  }
  return Object.fromEntries(METRICS.map((metric) => [metric, value[metric]]));
}

export function readCostFixture(filePath) {
  const fixture = parseJsonFile(filePath);
  if (fixture?.schema !== "cost-budget-fixture/v2") throw new Error(`${filePath} must use cost-budget-fixture/v2`);
  const events = fixture.projectionRebuild?.events;
  const repoId = fixture.projectionRebuild?.repoId;
  if (typeof repoId !== "string" || repoId.length === 0)
    throw new Error(`${filePath} must declare projectionRebuild.repoId`);
  if (!Array.isArray(events) || events.length === 0)
    throw new Error(`${filePath} must contain projectionRebuild.events`);
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event?.workspaceRevision) || event.workspaceRevision !== index + 1)
      throw new Error(`${filePath} event workspace revisions must be contiguous from 1`);
    if (event.schema !== "task-event/v1" || typeof event.opId !== "string" || typeof event.taskId !== "string")
      throw new Error(`${filePath} event ${event.workspaceRevision} must be a task-event/v1`);
  }
  return { repoId, events };
}

function git(rootDir, ...args) {
  execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
}

async function measureProjectionRebuild(fixture) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g37-cost-"));
  let projection, writer, reader;
  try {
    git(rootDir, "init", "-q");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n");
    git(rootDir, "config", "user.name", "G38 Cost Fixture");
    git(rootDir, "config", "user.email", "g37@example.invalid");
    git(rootDir, "config", "gc.auto", "0");
    git(rootDir, "config", "maintenance.auto", "false");
    git(rootDir, "add", "harness/.gitattributes");
    git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
    const [{ makeTaskEventStore }, { makeTaskProjection }, { taskLifecycleWritePlan }, { localGitObjectRefStore }] =
      await Promise.all([
        import("../../packages/storage/src/store/task-event-store.ts"),
        import("../../packages/storage/src/projection/rebuildable-task-projection.ts"),
        import("../../packages/kernel/src/domain/task-lifecycle-publication.ts"),
        import("../../packages/storage/src/store/local-version-control-system.ts"),
      ]);
    writer = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    for (const event of fixture.events) writer.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    reader = makeTaskEventStore({ repoId: fixture.repoId, rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: reader });
    const before = localGitObjectRefStore.processCount();
    const rebuilt = projection.rebuild();
    const processes = localGitObjectRefStore.processCount() - before;
    if (rebuilt.watermark !== fixture.events.at(-1).workspaceRevision)
      throw new Error(`fixture rebuild stopped at ${rebuilt.watermark}`);
    return processes;
  } finally {
    projection?.close();
    await reader?.drain();
    await writer?.drain();
    await removeTemporaryDirectory(rootDir, { retryDelayMs: 20 });
  }
}

export async function measureCosts(fixture) {
  return {
    projectionRebuildGitProcesses: await measureProjectionRebuild(fixture),
  };
}

function readBudgetFile(filePath) {
  const budget = parseJsonFile(filePath);
  if (budget?.schema !== "cost-budget/v1") throw new Error(`${filePath} must use cost-budget/v1`);
  if (typeof budget.fixture !== "string" || budget.fixture.length === 0)
    throw new Error(`${filePath}.fixture is required`);
  return {
    fixture: budget.fixture,
    baseline: validateMetricMap(budget.baseline, `${filePath}.baseline`),
    budgets: validateMetricMap(budget.budgets, `${filePath}.budgets`),
  };
}

function hasCostReceipt(receipts, metric, limit, now) {
  return receipts.some(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `cost:${metric}`,
        kind: "cost-budget",
        minimumLimit: limit,
        now,
      }).ok,
  );
}

export async function evaluateCostBudget({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  fixturePath = null,
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
} = {}) {
  const budget = readBudgetFile(budgetPath);
  const resolvedFixture = fixturePath ?? path.resolve(rootDir, budget.fixture);
  if (!existsSync(resolvedFixture)) throw new Error(`cost fixture does not exist: ${resolvedFixture}`);
  const actual = await measureCosts(readCostFixture(resolvedFixture));
  const receipts = loadReceipts(receiptsDir);
  const errors = [];
  for (const metric of METRICS) {
    if (
      budget.budgets[metric] > budget.baseline[metric] &&
      !hasCostReceipt(receipts, metric, budget.budgets[metric], now)
    )
      errors.push(
        `${metric}: budget rose from ${budget.baseline[metric]} to ${budget.budgets[metric]} without a valid cost-budget receipt`,
      );
    if (actual[metric] > budget.budgets[metric])
      errors.push(`${metric}: measured ${actual[metric]} exceeds budget ${budget.budgets[metric]}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    actual,
    baseline: budget.baseline,
    budgets: budget.budgets,
    fixture: resolvedFixture,
  };
}

// --- G1 write-path scale invariant -----------------------------------------------------------
// Extends the cost-budget gate (dec_EF5F3820E81FB8A5266F1F3342 CH1, refining dec_D507BBA7174F4BF61521CAEB61):
// the historical sampled writes and hot reads run through the production daemon request path on a
// 200-event and a 2000-event ledger, and its steady-state call (the one after a warm-up call) is
// judged; a 10x history growth must not cost meaningfully more per call.
export const G1_SCALES = Object.freeze({ small: 200, large: 2000 });

// Fixed, per-metric absolute margins (not per operation): the measured 200-scale and 2000-scale
// counts for an unexempted (operation, metric) pair must differ by no more than this. Values come
// from the noise observed on flat operations at head (task_78327209a449760a74d1992de3 report):
export const G1_MARGINS = Object.freeze({
  // Flat operations show 0 row difference between scales. The scarcest seeded kinds (decisions and
  // their relations) still grow by 36 rows between scales, so a scan of any one kind exceeds 20.
  sqlRowsRead: 20,
  // Every operation hashes a fixed number of times regardless of scale; 2 covers incidental
  // additions (e.g. one more content-addressed blob) without hiding a growing hash count.
  sha256Calls: 2,
  // Observed drift is only digits added to longer generated ids (single- to double-digit bytes);
  // 512 comfortably covers that without masking a hashed-content-scales-with-history regression.
  sha256Bytes: 512,
  // This is the exact metric #2407/#2409 fixed (Git follower re-rendering history per write); keep
  // it tight. 1 tolerates a single incidental extra spawn (e.g. a lazily-created ref) at most.
  gitProcesses: 1,
  // Observed drift is a few bytes from longer generated ids in read file content; 128 covers that
  // without masking a file read that starts scanning history.
  fileReadBytes: 128,
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateG1OperationMap(value, label, metrics) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = {};
  for (const [operation, metricMap] of Object.entries(value)) {
    if (metricMap === null || typeof metricMap !== "object" || Array.isArray(metricMap))
      throw new Error(`${label}.${operation} must be an object`);
    const keys = Object.keys(metricMap).sort();
    if (keys.join("\0") !== [...metrics].sort().join("\0"))
      throw new Error(`${label}.${operation} keys must be ${metrics.join(", ")}`);
    result[operation] = {};
    for (const metric of metrics) {
      if (!Number.isSafeInteger(metricMap[metric]) || metricMap[metric] < 0)
        throw new Error(`${label}.${operation}.${metric} must be a non-negative safe integer`);
      result[operation][metric] = metricMap[metric];
    }
  }
  return result;
}

function readG1BudgetFile(filePath, operations, metrics) {
  const budget = parseJsonFile(filePath);
  const section = budget?.writeCostScaling;
  if (section?.schema !== "write-cost-scaling-budget/v1")
    throw new Error(`${filePath}.writeCostScaling must use write-cost-scaling-budget/v1`);
  const scales = section.scales;
  if (!Number.isSafeInteger(scales?.small) || !Number.isSafeInteger(scales?.large) || scales.small >= scales.large)
    throw new Error(`${filePath}.writeCostScaling.scales must declare small < large`);
  const baseline = validateG1OperationMap(section.baseline, `${filePath}.writeCostScaling.baseline`, metrics),
    budgets = validateG1OperationMap(section.budgets, `${filePath}.writeCostScaling.budgets`, metrics);
  for (const operation of operations) {
    if (!baseline[operation])
      throw new Error(`${filePath}.writeCostScaling.baseline is missing operation ${operation}`);
    if (!budgets[operation]) throw new Error(`${filePath}.writeCostScaling.budgets is missing operation ${operation}`);
  }
  const knownScaling = Array.isArray(section.knownScaling) ? section.knownScaling : null;
  if (!knownScaling) throw new Error(`${filePath}.writeCostScaling.knownScaling must be an array`);
  for (const [index, entry] of knownScaling.entries()) {
    const label = `${filePath}.writeCostScaling.knownScaling[${index}]`;
    if (!operations.includes(entry?.operation)) throw new Error(`${label}.operation must be a known G1 operation`);
    if (!metrics.includes(entry?.metric)) throw new Error(`${label}.metric must be a known G1 metric`);
    if (!isNonEmptyString(entry?.reason)) throw new Error(`${label}.reason is required`);
    if (!isNonEmptyString(entry?.deletionTaskId)) throw new Error(`${label}.deletionTaskId is required`);
    if (!isNonEmptyString(entry?.expiresAt) || Number.isNaN(Date.parse(entry.expiresAt)))
      throw new Error(`${label}.expiresAt must be an RFC 3339 timestamp`);
  }
  return { scales, baseline, budgets, knownScaling };
}

async function canonicalWriteActions(rootDir) {
  const declarationPath = path.join(rootDir, "packages/kernel/src/domain/action-declaration.ts"),
    catalogPath = path.join(rootDir, "packages/kernel/src/domain/entity-kind-registry.ts"),
    sourceDigest = createHash("sha256").update(readFileSync(declarationPath)).digest("hex"),
    { actionDeclarations, artifactActionIngressKinds } = await import(
      `${pathToFileURL(declarationPath).href}?source=${sourceDigest}`
    ),
    { entityKindContracts } = await import(
      `${pathToFileURL(catalogPath).href}?source=${createHash("sha256").update(readFileSync(catalogPath)).digest("hex")}`
    );
  if (!Array.isArray(actionDeclarations) || !Array.isArray(artifactActionIngressKinds))
    throw new Error(`${declarationPath}: action declarations and artifact ingress must be arrays`);
  return [
    ...new Set([
      ...actionDeclarations
        .filter(({ executionClass, residency }) => executionClass !== "repo-read" && residency?.scope === "canonical")
        .map(({ kind }) => kind),
      ...artifactActionIngressKinds,
      // The entity catalog also declares internal canonical event Actions (RuntimeSession),
      // which have no CLI permission declaration. Include those writers as well as public ingress.
      ...entityKindContracts.flatMap(({ residency, actionCatalog }) =>
        Object.values(residency).includes("ledger")
          ? (actionCatalog?.actions ?? []).flatMap(({ execution }) =>
              execution && !execution.read ? [execution.ingress] : [],
            )
          : [],
      ),
    ]),
  ].sort();
}

function readActionCoverage(section, actions, measurements, label) {
  const coverage = section.actionCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage))
    throw new Error(`${label}.actionCoverage must declare measurements and inapplicable actions`);
  const measured = coverage.measured;
  if (!measured || typeof measured !== "object" || Array.isArray(measured))
    throw new Error(`${label}.actionCoverage.measured must be an object`);
  const declared = new Set(Object.keys(measured));
  for (const [action, entry] of Object.entries(measured)) {
    if (!actions.includes(action)) throw new Error(`${label}.actionCoverage.measured has unknown action ${action}`);
    if (!Array.isArray(entry?.measurements) || entry.measurements.length === 0)
      throw new Error(`${label}.actionCoverage.measured.${action} requires nonempty measurements`);
    for (const id of entry.measurements) {
      const probe = COLLECTION_PROBES[id];
      if (id === `${action}:ledger-events` && measurements.includes(action)) continue;
      if (!probe || probe.action !== action)
        throw new Error(`${label}.actionCoverage.measured.${action} has no matching production measurement ${id}`);
    }
  }
  if (!Array.isArray(coverage.notApplicable)) throw new Error(`${label}.actionCoverage.notApplicable must be an array`);
  for (const [index, entry] of coverage.notApplicable.entries()) {
    const entryLabel = `${label}.actionCoverage.notApplicable[${index}]`;
    if (!Array.isArray(entry?.actions) || entry.actions.length === 0)
      throw new Error(`${entryLabel}.actions must be a non-empty array`);
    if (!isNonEmptyString(entry?.reason) || entry.reason.trim().length === 0)
      throw new Error(`${entryLabel}.reason is required`);
    for (const action of entry.actions) {
      if (!actions.includes(action)) throw new Error(`${entryLabel} has unknown action ${action}`);
      if (declared.has(action)) throw new Error(`${entryLabel} duplicates action ${action}`);
      declared.add(action);
    }
  }
  const missing = actions.filter((action) => !declared.has(action));
  if (missing.length > 0)
    throw new Error(`${label}.actionCoverage is missing canonical write actions: ${missing.join(", ")}`);
  const stale = [...declared].filter((action) => !actions.includes(action));
  if (stale.length > 0) throw new Error(`${label}.actionCoverage has stale actions: ${stale.join(", ")}`);
  return measured;
}

function g1HasReceipt(receipts, operation, metric, limit, now) {
  return receipts.some(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `cost:g1:${operation}:${metric}`,
        kind: "g1-cost-budget",
        minimumLimit: limit,
        now,
      }).ok,
  );
}

export async function measureG1WriteCostScaling(rootDir, scales) {
  const moduleUrl = pathToFileURL(path.join(rootDir, "packages/daemon/test/fixtures/g1-write-cost-scaling.ts")).href;
  const { measureWriteCostScaling, G1_METRICS } = await import(moduleUrl);
  // One scale after the other: host-side reads are counted by process-wide probe counters, which a
  // concurrently seeding or measuring scale would add its own work to.
  const small = await measureWriteCostScaling(scales.small),
    large = await measureWriteCostScaling(scales.large);
  const operations = Object.keys(small.counts);
  if (operations.sort().join() !== Object.keys(large.counts).sort().join())
    throw new Error("G1 scales must measure exactly the same operations");
  return { small, large, operations, metrics: G1_METRICS };
}

export async function evaluateG1WriteCostScaling({
  rootDir,
  budgetPath = path.join(rootDir, "tools/gates/cost-budget.json"),
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
  measured = null,
} = {}) {
  const probe = measured ?? (await measureG1WriteCostScaling(rootDir, G1_SCALES));
  const { operations, metrics } = probe;
  const budget = readG1BudgetFile(budgetPath, operations, metrics);
  const actionCoverage = readActionCoverage(
    JSON.parse(readFileSync(budgetPath, "utf8")).writeCostScaling,
    await canonicalWriteActions(rootDir),
    operations,
    `${budgetPath}.writeCostScaling`,
  );
  const receipts = loadReceipts(receiptsDir);
  const errors = [];
  const actualSmall = {};
  for (const operation of operations) {
    actualSmall[operation] = probe.small.counts[operation];
    for (const metric of metrics) {
      const measuredSmall = probe.small.counts[operation]?.[metric],
        measuredLarge = probe.large.counts[operation]?.[metric];
      if (!Number.isSafeInteger(measuredSmall) || !Number.isSafeInteger(measuredLarge))
        throw new Error(`G1 measurement is missing ${operation}.${metric}`);

      // 200-scale absolute ratchet: reused from the existing G37 baseline/budget/receipt pattern.
      if (
        budget.budgets[operation][metric] > budget.baseline[operation][metric] &&
        !g1HasReceipt(receipts, operation, metric, budget.budgets[operation][metric], now)
      )
        errors.push(
          `${operation}.${metric}: budget rose from ${budget.baseline[operation][metric]} to ` +
            `${budget.budgets[operation][metric]} without a valid g1-cost-budget receipt`,
        );
      if (measuredSmall > budget.budgets[operation][metric])
        errors.push(
          `${operation}.${metric}: measured ${measuredSmall} at ${G1_SCALES.small} events exceeds budget ` +
            `${budget.budgets[operation][metric]}`,
        );

      // Scale-invariance: 2000-scale must not exceed 200-scale plus the fixed per-metric margin,
      // unless a live (non-expired) knownScaling exemption names this exact pair.
      const exemption = budget.knownScaling.find((entry) => entry.operation === operation && entry.metric === metric),
        withinMargin = measuredLarge <= measuredSmall + G1_MARGINS[metric];
      if (exemption) {
        if (Date.parse(exemption.expiresAt) <= now.getTime())
          errors.push(
            `${operation}.${metric}: knownScaling exemption expired at ${exemption.expiresAt} ` +
              `(deletion task ${exemption.deletionTaskId}); renew or fix and remove it`,
          );
        else if (withinMargin)
          errors.push(
            `${operation}.${metric}: knownScaling exemption is stale (measured ${measuredSmall}->${measuredLarge} ` +
              `is already within the margin); remove the exemption`,
          );
      } else if (!withinMargin)
        errors.push(
          `${operation}.${metric}: measured ${measuredSmall} at ${G1_SCALES.small} events grew to ` +
            `${measuredLarge} at ${G1_SCALES.large} events, ` +
            `exceeding the +${G1_MARGINS[metric]} margin with no knownScaling exemption`,
        );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    actualSmall,
    actualLarge: probe.large.counts,
    baseline: budget.baseline,
    budgets: budget.budgets,
    knownScaling: budget.knownScaling,
    actionCoverage,
    scales: G1_SCALES,
    operations,
    metrics,
  };
}

// A linear batch can do a*N-b work (e.g. N-1 derived member IDs plus the terminal ID).
// Allow 10% per-item variation for that constant term and encoded revision lengths. This is
// independent of, and does not relax, any existing G1 ceiling or history-scaling margin.
const COLLECTION_LINEAR_TOLERANCE = 1.1;

export function evaluateCollectionCosts(measured) {
  const errors = [];
  if (Object.keys(measured).length === 0) throw new Error("collection measurements must not be empty");
  for (const [id, { small, large }] of Object.entries(measured)) {
    if (
      !Number.isSafeInteger(small?.size) ||
      small.size < 1 ||
      !Number.isSafeInteger(large?.size) ||
      large.size <= small.size
    )
      throw new Error(`${id}: collection scales must be positive integers with small < large`);
    const metrics = Object.keys(small.counts ?? {}),
      // A probe of writer-held work declares `growth: "constant"`: the larger collection may not cost more.
      constant = measured[id].growth === "constant",
      maxGrowth = constant ? 1 : (large.size / small.size) * COLLECTION_LINEAR_TOLERANCE;
    if (
      metrics.length === 0 ||
      metrics.sort().join() !==
        Object.keys(large.counts ?? {})
          .sort()
          .join()
    )
      throw new Error(`${id}: both collection scales must measure the same nonempty metric set`);
    for (const metric of metrics) {
      const a = small.counts[metric],
        b = large.counts[metric];
      if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0)
        throw new Error(`${id}.${metric}: counts must be nonnegative safe integers`);
      if (b > a * maxGrowth)
        errors.push(
          `${id}.${metric}: ${a} at ${small.size} grew to ${b} at ${large.size} (${a === 0 ? "infinite" : (b / a).toFixed(2)}x), exceeding the ${constant ? "constant-cost" : `${maxGrowth}x linear-growth`} limit`,
        );
    }
  }
  return { ok: errors.length === 0, errors, measured };
}

function parseArgs(argv) {
  const options = {
    phase: process.env.G38_PHASE,
    backend: process.env.G38_BACKEND,
    dimension: process.env.G38_DIMENSION,
    output: process.env.G38_OUTPUT,
    resultsDir: process.env.G38_RESULTS,
    requiredBackends: process.env.G38_REQUIRED_BACKENDS?.split(",").filter(Boolean),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.rootDir = argv[++index];
    else if (arg === "--budget") options.budgetPath = argv[++index];
    else if (arg === "--fixture") options.fixturePath = argv[++index];
    else if (arg === "--receipts") options.receiptsDir = argv[++index];
    else if (arg === "--phase") options.phase = argv[++index];
    else if (arg === "--backend") options.backend = argv[++index];
    else if (arg === "--dimension") options.dimension = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--results") options.resultsDir = argv[++index];
    else if (arg === "--required-backends") options.requiredBackends = argv[++index].split(",").filter(Boolean);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), defaultRoot = repoRoot()) {
  try {
    const options = parseArgs(argv);
    const rootDir = options.rootDir ?? defaultRoot;
    if (![undefined, "legacy", "read", "read-summary"].includes(options.phase)) throw new Error("invalid G38 phase");
    if (options.phase === "read" || options.phase === "read-summary") return await runReadLane({ rootDir, ...options });
    const budgetPath = options.budgetPath ?? path.join(rootDir, "tools/gates/cost-budget.json"),
      section = parseJsonFile(budgetPath).writeCostScaling;
    // Reject new unregistered canonical writes before opening ledgers or starting workers.
    readActionCoverage(
      section,
      await canonicalWriteActions(rootDir),
      Object.keys(section.baseline),
      `${budgetPath}.writeCostScaling`,
    );
    const result = await evaluateCostBudget({ rootDir, ...options });
    for (const metric of METRICS) console.log(`${metric}: ${result.actual[metric]}/${result.budgets[metric]}`);
    const g1 = await evaluateG1WriteCostScaling({
      rootDir,
      budgetPath: options.budgetPath,
      receiptsDir: options.receiptsDir,
    });
    for (const operation of g1.operations)
      for (const metric of g1.metrics)
        console.log(
          `G1 ${operation}.${metric}: ${g1.actualSmall[operation][metric]}/${g1.budgets[operation][metric]} ` +
            `at ${g1.scales.small}, ${g1.actualLarge[operation][metric]} at ${g1.scales.large}`,
        );
    const collections = evaluateCollectionCosts(await measureCollectionCosts(rootDir));
    for (const [id, { small, large, growth }] of Object.entries(collections.measured))
      for (const metric of Object.keys(small.counts))
        console.log(
          `G38 ${id}.${metric}: ${small.counts[metric]} at ${small.size}, ${large.counts[metric]} at ${large.size} (max ${growth === "constant" ? 1 : (large.size / small.size) * COLLECTION_LINEAR_TOLERANCE}x)`,
        );
    const errors = [...result.errors, ...g1.errors, ...collections.errors];
    if (errors.length > 0) {
      for (const error of errors) console.error(`G38 cost-budget: ${error}`);
      return 1;
    }
    if (options.phase !== "legacy" && (await runReadLane({ rootDir, ...options })) !== 0) return 1;
    console.log("G38 cost-budget: pass");
    return 0;
  } catch (error) {
    console.error(`G38 cost-budget: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
